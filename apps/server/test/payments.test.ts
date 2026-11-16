import { randomUUID } from 'node:crypto';
import { adminParticipantCreateSchema, registrationSubmitSchema, type ParticipantInputRaw } from '@sof/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { createParticipant, reissue } from '../src/services/admin.service.ts';
import { findForPayment } from '../src/services/checkin.service.ts';
import { autoLinkByUsername } from '../src/services/link.service.ts';
import {
  cancelDraftReceipt,
  confirmReceipt,
  createReceipt,
  listReceipts,
  markPaid,
  reviewReceipt,
  toggleReceiptPerson,
  undoPayment,
} from '../src/services/payment.service.ts';
import { submitRegistration } from '../src/services/registration.service.ts';
import { upsertTelegramUser } from '../src/services/users.service.ts';
import { makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

const person = (lastName: string, over: Partial<ParticipantInputRaw> = {}): ParticipantInputRaw => ({
  lastName,
  firstName: 'Аня',
  birthDate: '1995-01-01',
  gender: 'f',
  city: 'Минск',
  church: 'Благодать',
  phone: '+375291112233',
  relation: 'self',
  tier: 'fee35',
  paymentMethod: 'transfer',
  ...over,
});

let fileSeq = 0;
const file = () => ({ fileId: `f${++fileSeq}`, fileUniqueId: `u${fileSeq}`, kind: 'photo' as const });

/** Аня (я, 35, перевод), Петя (10, наличные), Ваня (45, перевод). */
async function family() {
  const user = await makeUser(env);
  await submitRegistration(
    env,
    user,
    registrationSubmitSchema.parse({
      idempotencyKey: randomUUID(),
      consent: { pd: true, documentVersion: 'x' },
      participants: [
        // Свой номер у каждого аккаунта: одинаковые «Я» с одним номером - это уже дубль.
        person('Семьина', { phone: `+37529${String(user.id % 10_000_000).padStart(7, '0')}` }),
        person('Семьин', { firstName: 'Петя', gender: 'm', relation: 'friend', tier: 'fee10', paymentMethod: 'cash' }),
        person('Семьин', { firstName: 'Ваня', gender: 'm', relation: 'friend', tier: 'fee35', breakfast: true }),
      ],
    }),
  );
  const rows = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id), orderBy: (p, { asc }) => [asc(p.id)] });
  return { user, anya: rows[0]!, petya: rows[1]!, vanya: rows[2]! };
}

const status = async (id: number) => (await env.db.query.participants.findFirst({ where: eq(schema.participants.id, id) }))!;

describe('payments: every person pays separately', () => {
  it('записал троих, платит только за себя: чек-черновик → только себя → на проверку', async () => {
    const { user, anya, petya, vanya } = await family();
    const res = await createReceipt(env, user, file());
    expect(res.status).toBe('draft');
    if (res.status !== 'draft') return;
    // Заранее отмечены те, кто выбрал перевод.
    expect(res.people.filter((p) => p.included).map((p) => p.id)).toEqual([anya.id, vanya.id]);
    // Черновик админу не виден и статусы не меняет.
    expect((await listReceipts(env)).some((r) => r.id === res.receiptId)).toBe(false);
    expect((await status(anya.id)).paymentStatus).toBe('unpaid');

    await toggleReceiptPerson(env, user, res.receiptId, vanya.id);
    const sent = await confirmReceipt(env, user, res.receiptId);
    expect(sent.status).toBe('sent');
    expect([(await status(anya.id)).paymentStatus, (await status(petya.id)).paymentStatus, (await status(vanya.id)).paymentStatus]).toEqual([
      'pending',
      'unpaid',
      'unpaid',
    ]);
    // Отправленный чек галочками уже не меняется.
    expect((await toggleReceiptPerson(env, user, res.receiptId, vanya.id)).status).toBe('locked');
    // Потом отдельно платят за Ваню: в новом чеке можно выбрать Петю и Ваню, отмечен Ваня (перевод).
    const second = await createReceipt(env, user, file());
    if (second.status !== 'draft') throw new Error('expected draft');
    expect(second.people.map((p) => [p.id, p.included])).toEqual([
      [petya.id, false],
      [vanya.id, true],
    ]);
    await confirmReceipt(env, user, second.receiptId);
    expect((await status(vanya.id)).paymentStatus).toBe('pending');
  });

  it('способ оплаты - как заплатили на самом деле: прислал чек - перевод, внёс на кассе - наличные', async () => {
    const { user, anya, petya } = await family();
    expect((await status(petya.id)).paymentMethod).toBe('cash');
    const res = await createReceipt(env, user, file());
    if (res.status !== 'draft') throw new Error('expected draft');
    // В чеке только Петя, который при регистрации выбрал «наличными».
    for (const p of res.people) if (p.included !== (p.id === petya.id)) await toggleReceiptPerson(env, user, res.receiptId, p.id);
    await confirmReceipt(env, user, res.receiptId);
    expect(await status(petya.id)).toMatchObject({ paymentStatus: 'pending', paymentMethod: 'transfer' });

    expect((await status(anya.id)).paymentMethod).toBe('transfer');
    const cashier = await makeStaff(env, ['cashier'], 'Касса');
    await markPaid(env, cashier, { participantIds: [anya.id], method: 'cash', amount: null, note: null });
    expect(await status(anya.id)).toMatchObject({ paymentStatus: 'paid', paymentMethod: 'cash' });
  });

  it('пустой черновик отправить нельзя; отмена удаляет черновик', async () => {
    const { user, anya, vanya } = await family();
    const res = await createReceipt(env, user, file());
    if (res.status !== 'draft') throw new Error('expected draft');
    await toggleReceiptPerson(env, user, res.receiptId, anya.id);
    await toggleReceiptPerson(env, user, res.receiptId, vanya.id);
    expect((await confirmReceipt(env, user, res.receiptId)).status).toBe('empty');
    expect(await cancelDraftReceipt(env, user, res.receiptId)).toBe(true);
    expect((await confirmReceipt(env, user, res.receiptId)).status).toBe('not_found');
  });

  it('друг, узнанный по нику, платит сам - в его чеке только он', async () => {
    const owner = await makeUser(env);
    await submitRegistration(
      env,
      owner,
      registrationSubmitSchema.parse({
        idempotencyKey: randomUUID(),
        consent: { pd: true, documentVersion: 'x' },
        participants: [person('Хозяйкина'), person('Друзьин', { firstName: 'Олег', gender: 'm', relation: 'friend', telegramUsername: 'oleg_pays' })],
      }),
    );
    const oleg = await upsertTelegramUser(env.db, { id: 7_900_001, first_name: 'Олег', username: 'oleg_pays' });
    await autoLinkByUsername(env, oleg);
    const res = await createReceipt(env, oleg, file());
    expect(res.status).toBe('sent');
    if (res.status !== 'sent') return;
    expect(res.people.map((p) => p.fullName)).toEqual(['Друзьин Олег']);
  });

  it('человек без Telegram принёс наличные: касса отмечает его, записавшему уходит уведомление', async () => {
    const admin = await makeStaff(env, ['admin'], 'Админ');
    const noTg = await createParticipant(
      env,
      adminParticipantCreateSchema.parse({
        lastName: 'Безтелеграмов',
        firstName: 'Сергей',
        birthDate: '1990-01-01',
        gender: 'm',
        city: 'Минск',
        relation: 'self',
        tier: 'fee35',
        paymentMethod: 'cash',
      }),
      admin,
    );
    expect(noTg.paymentStatus).toBe('unpaid');
    const cashier = await makeStaff(env, ['cashier'], 'Касса');
    const res = await markPaid(env, cashier, { participantIds: [noTg.id], method: 'cash', amount: null, note: null });
    expect(res.people[0]).toMatchObject({ paymentStatus: 'paid', amountPaid: '35.00' });

    const { anya } = await family();
    await markPaid(env, cashier, { participantIds: [anya.id], method: 'cash', amount: null, note: null });
    const jobs = await env.pool.query(`select data from pgboss.job where name = 'payment.confirmed'`);
    expect(jobs.rows.some((j) => j.data.participantIds.includes(anya.id))).toBe(true);
  });

  it('внёс меньше - «частично», на входе не пускают; доплатил - «оплачено»', async () => {
    const { petya, vanya } = await family();
    const cashier = await makeStaff(env, ['cashier'], 'Касса');
    const part = await markPaid(env, cashier, { participantIds: [vanya.id], method: 'cash', amount: '20', note: null });
    expect(part.people[0]).toMatchObject({ paymentStatus: 'partial', amountPaid: '20.00' });
    const rest = await markPaid(env, cashier, { participantIds: [vanya.id], method: 'cash', amount: null, note: null });
    expect(rest.people[0]).toMatchObject({ paymentStatus: 'paid', amountPaid: '45.00' });
    // Уже оплаченного второй раз не отмечаем.
    expect((await markPaid(env, cashier, { participantIds: [vanya.id], method: 'cash', amount: null, note: null })).updated).toBe(0);
    expect((await status(petya.id)).paymentStatus).toBe('unpaid');
  });

  it('админ принимает чек частично: второй возвращается в «не оплачено»', async () => {
    const { user, anya, vanya } = await family();
    const res = await createReceipt(env, user, file());
    if (res.status !== 'draft') throw new Error('expected draft');
    await confirmReceipt(env, user, res.receiptId);
    const admin = await makeStaff(env, ['admin'], 'Админ');
    await reviewReceipt(env, res.receiptId, admin, 'accept', { participantIds: [anya.id] });
    expect((await status(anya.id)).paymentStatus).toBe('paid');
    expect((await status(anya.id)).amountPaid).toBe('35.00');
    expect((await status(vanya.id)).paymentStatus).toBe('unpaid');
  });

  it('отклонённый чек возвращает «частично», если что-то уже внесено', async () => {
    const { user, vanya } = await family();
    const cashier = await makeStaff(env, ['cashier'], 'Касса');
    await markPaid(env, cashier, { participantIds: [vanya.id], method: 'cash', amount: '5', note: null });
    const res = await createReceipt(env, user, file());
    if (res.status !== 'draft') throw new Error('expected draft');
    await confirmReceipt(env, user, res.receiptId);
    const admin = await makeStaff(env, ['admin'], 'Админ');
    await reviewReceipt(env, res.receiptId, admin, 'reject', { reason: 'не тот чек' });
    expect((await status(vanya.id)).paymentStatus).toBe('partial');
  });

  it('кассир отменяет свой приём; чужой - нельзя, админ - может', async () => {
    const { anya, petya } = await family();
    const cashier = await makeStaff(env, ['cashier'], 'Касса');
    const other = await makeStaff(env, ['cashier'], 'Другая касса');
    await markPaid(env, cashier, { participantIds: [petya.id], method: 'cash', amount: null, note: null });
    await expect(undoPayment(env, other, petya.id)).rejects.toMatchObject({ statusCode: 403 });
    await undoPayment(env, cashier, petya.id);
    expect((await status(petya.id)).paymentStatus).toBe('unpaid');
    expect((await status(petya.id)).amountPaid).toBe('0.00');

    await markPaid(env, cashier, { participantIds: [anya.id], method: 'transfer', amount: null, note: null });
    const admin = await makeStaff(env, ['admin'], 'Админ');
    await undoPayment(env, admin, anya.id);
    expect((await status(anya.id)).paymentStatus).toBe('unpaid');
  });

  it('касса по QR-коду: находит человека и семью, журнал входа и отметки не трогает', async () => {
    const { anya, petya, vanya } = await family();
    const ticket = (await env.db.query.tickets.findFirst({ where: eq(schema.tickets.participantId, petya.id) }))!;
    const count = async () => {
      const r = await env.pool.query('select (select count(*) from scan_log)::int as logs, (select count(*) from check_ins)::int as checks');
      return r.rows[0] as { logs: number; checks: number };
    };
    const before = await count();

    const found = await findForPayment(env.db, { code: ` ${ticket.code.toLowerCase()} ` });
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.codeStatus).toBe('active');
    expect(found.card.id).toBe(petya.id);
    expect(found.card.amountDue).toBe('10.00');
    expect(found.family.map((f) => f.id)).toEqual([anya.id, vanya.id]);

    expect((await findForPayment(env.db, { code: 'не наш QR' })).found).toBe(false);
    expect(await findForPayment(env.db, { code: 'SF-0000000000' })).toMatchObject({ found: false });

    // Перевыпущенный код: человека всё равно узнаём (оплату принять можно), но помечаем.
    const admin = await makeStaff(env, ['admin'], 'Админ');
    await reissue(env, petya.id, admin);
    const old = await findForPayment(env.db, { code: ticket.code });
    expect(old).toMatchObject({ found: true, codeStatus: 'revoked', card: { id: petya.id } });

    expect(await count()).toEqual(before);
  });
});
