import { randomUUID } from 'node:crypto';
import type { PaymentEntryView } from '@sof/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { bulkUpdate, updateParticipant } from '../src/services/admin.service.ts';
import { dashboard } from '../src/services/dashboard.service.ts';
import { addDonation, listPayments, undoDonation } from '../src/services/ledger.service.ts';
import { createReceipt, confirmReceipt, markPaid, reviewReceipt, undoPayment } from '../src/services/payment.service.ts';
import { createSession } from '../src/services/sessions.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
});
afterAll(async () => {
  await app?.close();
  await env?.teardown();
});

const bearer = async (userId: number) => `Bearer ${(await createSession(env.db, userId, 'web', 1)).token}`;
const unpaid = async (amountDue = '35.00', paymentMethod: 'cash' | 'transfer' = 'cash') => {
  const owner = await makeUser(env);
  return { owner, ...(await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue, amountPaid: '0', paymentMethod, tier: 'fee35' })) };
};
const active = (rows: PaymentEntryView[], pid: number) => rows.filter((r) => r.participantId === pid && !r.undoneAt && r.kind === 'fee');

describe('журнал оплат', () => {
  it('касса: наличные - строка с суммой, способом и кассиром; отмена - помечена, в итоги не идёт', async () => {
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Оля');
    const { participant: p } = await unpaid();
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: '20', note: null, requestId: randomUUID() });
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: '15', note: null, requestId: randomUUID() });
    let mine = await listPayments(env.db, { acceptedBy: cashier.user.id });
    expect(active(mine, p.id).map((r) => [r.amount, r.method, r.source, r.acceptedByName])).toEqual([
      ['15.00', 'cash', 'desk', 'Кассир Оля'],
      ['20.00', 'cash', 'desk', 'Кассир Оля'],
    ]);
    // Отмена последнего приёма: в журнале остаётся, но отменён - внесено снова 20.
    await undoPayment(env, cashier, p.id);
    mine = await listPayments(env.db, { acceptedBy: cashier.user.id });
    expect(active(mine, p.id).map((r) => r.amount)).toEqual(['20.00']);
    expect(mine.find((r) => r.participantId === p.id && r.undoneAt)).toMatchObject({ amount: '15.00', undoneByName: 'Кассир Оля' });
  });

  it('чек перевода - строка «перевод» с номером чека; сводка делит деньги по способам и по кассирам', async () => {
    const admin = await makeStaff(env, ['admin'], 'Админ Катя');
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Петя');
    const { owner, participant: t } = await unpaid('35.00', 'transfer');
    const draft = await createReceipt(env, owner, { fileId: 'lf1', fileUniqueId: `lu${t.id}`, kind: 'photo' });
    if (draft.status !== 'draft' && draft.status !== 'sent') throw new Error('чек не создался');
    // Один человек в семье - чек сразу уходит на проверку; несколько - подтверждаем черновик.
    if (draft.status === 'draft') await confirmReceipt(env, owner, draft.receiptId);
    await reviewReceipt(env, draft.receiptId, admin, 'accept', {});
    const { participant: c } = await unpaid('10.00');
    await markPaid(env, cashier, { participantIds: [c.id], method: 'cash', amount: null, note: null, requestId: randomUUID() });

    const all = await listPayments(env.db);
    expect(active(all, t.id)).toEqual([expect.objectContaining({ amount: '35.00', method: 'transfer', source: 'receipt', receiptId: draft.receiptId })]);
    expect(active(all, c.id)).toEqual([expect.objectContaining({ amount: '10.00', method: 'cash', source: 'desk' })]);

    const d = await dashboard(env);
    const cash = d.money.byMethod.find((m) => m.method === 'cash')!;
    const transfer = d.money.byMethod.find((m) => m.method === 'transfer')!;
    // Сумма по журналу сходится с «получено» по участникам.
    expect(Number(cash.amount) + Number(transfer.amount)).toBeCloseTo(Number(d.money.received));
    expect(d.money.byCashier.find((x) => x.name === 'Кассир Петя')).toMatchObject({ cash: '10.00', other: '0.00', people: 1 });
  });

  it('правка суммы в админке и «Снять оплату» сводят журнал с итогом', async () => {
    const admin = await makeStaff(env, ['admin'], 'Админ Гена');
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Ира');
    const { participant: p } = await unpaid('35.00');
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: '35', note: null, requestId: randomUUID() });
    // Поправили «внесено» до 30 - лишние 5 не должны висеть в наличных.
    await updateParticipant(env, p.id, { amountPaid: '30' }, admin);
    let rows = active(await listPayments(env.db), p.id);
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBe(30);
    await bulkUpdate(env, { action: 'mark_unpaid', ids: [p.id] }, admin);
    rows = active(await listPayments(env.db), p.id);
    expect(rows).toHaveLength(0);
  });

  it('кассир видит журнал оплат и список участников; «мои приёмы» - только свои', async () => {
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Аня');
    const other = await makeStaff(env, ['cashier'], 'Кассир Боря');
    const { participant: p } = await unpaid('10.00');
    const { participant: q } = await unpaid('10.00');
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: null, note: null, requestId: randomUUID() });
    await markPaid(env, other, { participantIds: [q.id], method: 'cash', amount: null, note: null, requestId: randomUUID() });
    const auth = await bearer(cashier.user.id);
    const ledger = await app.inject({ method: 'GET', url: '/api/admin/payments', headers: { authorization: auth } });
    expect(ledger.statusCode).toBe(200);
    expect((ledger.json() as PaymentEntryView[]).some((r) => r.participantId === q.id)).toBe(true);
    const list = await app.inject({ method: 'GET', url: '/api/admin/participants', headers: { authorization: auth } });
    expect(list.statusCode).toBe(200);
    const staffSession = `Bearer ${(await createSession(env.db, cashier.user.id, 'miniapp', 1)).token}`;
    const mine = await app.inject({ method: 'GET', url: '/api/staff/payments/mine', headers: { authorization: staffSession } });
    expect(mine.statusCode).toBe(200);
    const ids = (mine.json() as PaymentEntryView[]).map((r) => r.participantId);
    expect(ids).toContain(p.id);
    expect(ids).not.toContain(q.id);
    // Править участников кассир по-прежнему не может.
    const edit = await app.inject({ method: 'PATCH', url: `/api/admin/participants/${p.id}`, payload: { city: 'Брест' }, headers: { authorization: auth } });
    expect(edit.statusCode).toBe(403);
  });

  it('«Без сдачи»: дал 50 за взнос 10 - взнос 10 и пожертвование 40; «получено взносов» не растёт от пожертвований', async () => {
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Алина');
    const { participant: p } = await unpaid('10.00');
    const before = await dashboard(env);
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: '10', donation: '40', note: null, requestId: randomUUID() });
    const rows = (await listPayments(env.db)).filter((r) => r.participantId === p.id);
    expect(rows.map((r) => [r.kind, r.amount, r.method]).sort()).toEqual([
      ['donation', '40.00', 'cash'],
      ['fee', '10.00', 'cash'],
    ]);
    const after = await dashboard(env);
    expect(Number(after.money.received) - Number(before.money.received)).toBeCloseTo(10);
    expect(Number(after.money.donations.amount) - Number(before.money.donations.amount)).toBeCloseTo(40);
    expect(after.money.byCashier.find((c) => c.name === 'Кассир Алина')).toMatchObject({ cash: '10.00', donations: '40.00', people: 1 });
  });

  it('пожертвование без QR-кода: с именем, повтор запроса не задваивается, отменить можно только своё и в течение 15 минут', async () => {
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Лена');
    const other = await makeStaff(env, ['cashier'], 'Кассир Саша');
    const requestId = randomUUID();
    const body = { participantId: null, donorName: 'Дима', amount: '15', method: 'cash' as const, comment: 'на миссию', requestId };
    const first = await addDonation(env, cashier, body);
    const again = await addDonation(env, cashier, body);
    expect(again).toMatchObject({ duplicate: true });
    const mine = (await listPayments(env.db, { acceptedBy: cashier.user.id })).filter((r) => r.kind === 'donation');
    expect(mine).toEqual([expect.objectContaining({ id: first.id, fullName: 'Дима', amount: '15.00', participantId: null, comment: 'на миссию' })]);
    await expect(undoDonation(env, other, first.id!)).rejects.toMatchObject({ statusCode: 403 });
    await undoDonation(env, cashier, first.id!);
    const undone = (await listPayments(env.db)).find((r) => r.id === first.id)!;
    expect(undone.undoneAt).not.toBeNull();
  });

  it('отмена приёма «без сдачи» отменяет и пожертвование из того же приёма; отдельное пожертвование остаётся', async () => {
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Отмена');
    const { participant: p } = await unpaid('10.00');
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: '10', donation: '40', note: null, requestId: randomUUID() });
    const extra = await addDonation(env, cashier, { participantId: p.id, donorName: null, amount: '5', method: 'cash', comment: null, requestId: randomUUID() });
    await undoPayment(env, cashier, p.id);
    const rows = (await listPayments(env.db)).filter((r) => r.participantId === p.id);
    expect(rows.filter((r) => !r.undoneAt).map((r) => [r.kind, r.amount])).toEqual([['donation', '5.00']]);
    expect(rows.find((r) => r.id === extra.id)!.undoneAt).toBeNull();
  });

  it('«без сдачи», а взнос уже оплачен - отказ с подсказкой, деньги не теряются молча', async () => {
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Повтор');
    const { participant: p } = await unpaid('10.00');
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: null, note: null, requestId: randomUUID() });
    await expect(
      markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: '10', donation: '40', note: null, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'already_paid' });
  });

  it('пожертвование отменившего регистрацию остаётся в итогах - деньги-то получены', async () => {
    const admin = await makeStaff(env, ['admin'], 'Админ Отмена');
    const cashier = await makeStaff(env, ['cashier'], 'Кассир Итог');
    const { participant: p } = await unpaid('10.00');
    await addDonation(env, cashier, { participantId: p.id, donorName: null, amount: '25', method: 'cash', comment: null, requestId: randomUUID() });
    const before = await dashboard(env);
    await updateParticipant(env, p.id, { status: 'cancelled' }, admin);
    const after = await dashboard(env);
    expect(after.money.donations.amount).toBe(before.money.donations.amount);
    expect((await listPayments(env.db)).some((r) => r.participantId === p.id && r.kind === 'donation')).toBe(true);
  });
});
