import { randomUUID } from 'node:crypto';
import type { AdminMerchOrderView, MemberLinkView, MerchStats, MoneyResponse, PaymentEntryView } from '@sof/shared';
import { canUseAdminWeb, permissionsFor, ROLES } from '@sof/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { moneyBreakdown } from '../src/services/dashboard.service.ts';
import { listPayments } from '../src/services/ledger.service.ts';
import { addSize, adminProducts, cancelOrderByStaff, createOrder, createProduct, markOrderPaid, merchStats, repayDebt } from '../src/services/merch.service.ts';
import { addMoneyEntry, cancelMoneyEntry, moneySummary } from '../src/services/money.service.ts';
import { createSession } from '../src/services/sessions.service.ts';
import { redeemInvite } from '../src/services/staff.service.ts';
import { getRoles } from '../src/services/users.service.ts';
import { invalidateSettingsCache, patchSettings } from '../src/services/settings.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
  await patchSettings(env.db, { merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true }, (await makeUser(env)).id);
  invalidateSettingsCache();
});
afterAll(async () => {
  await app?.close();
  await env?.teardown();
});

const bearer = async (userId: number) => `Bearer ${(await createSession(env.db, userId, 'web', 1)).token}`;
const call = async (userId: number, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: await bearer(userId) } });

/** Футболка: один цвет, размер L - `stock` шт., 1000 ₽. */
async function tee(stock = 5) {
  const admin = await makeStaff(env, ['admin'], 'Админ');
  const p = await createProduct(env, { title: 'Футболка', subtitle: null, descriptionMd: '', price: 1000, badge: null, sort: 0, published: true }, admin);
  const withSize = await addSize(env, p.colors[0]!.id, { size: 'L', stock, sort: 0 }, admin);
  return { admin, productId: p.id, variantId: withSize.colors[0]!.sizes[0]!.id };
}
const left = async (productId: number) => (await adminProducts(env.db, [productId]))[0]!.colors[0]!.sizes[0]!.left;
const merchRows = async (orderId: number) => (await env.db.select().from(schema.payments).where(eq(schema.payments.merchOrderId, orderId))).sort((a, b) => a.id - b.id);

describe('роли: банкир и продавец', () => {
  it('банкир умеет всё, что кассир, и деньги; продавец - только мерч; админ - всё', () => {
    const cashier = permissionsFor(['cashier']);
    const banker = permissionsFor(['banker']);
    for (const p of cashier) expect(banker).toContain(p);
    expect(banker).toEqual(expect.arrayContaining(['money:manage', 'staff:invite_cashier', 'merch:stats']));
    expect(banker).not.toContain('merch:sell');
    // Продавец: мерч и то, что есть у всех («Участник команды»).
    expect(permissionsFor(['seller'])).toEqual(['dashboard:read', 'merch:stock', 'merch:sell', 'merch:stats', 'feedback:read']);
    expect(permissionsFor(['admin'])).toEqual(expect.arrayContaining(['money:manage', 'staff:invite_cashier', 'merch:stock', 'merch:sell', 'merch:stats']));
    expect(cashier).not.toContain('merch:sell');
  });

  it('«Участник команды» - только посмотреть: сводка, отзывы, статистика мерча; это есть у всех ролей', async () => {
    const base = permissionsFor(['member']);
    expect(base).toEqual(['dashboard:read', 'merch:stats', 'feedback:read']);
    for (const role of ROLES) for (const p of base) expect(permissionsFor([role])).toContain(p);
    expect(canUseAdminWeb(['member'])).toBe(true);

    const member = await makeStaff(env, ['member']);
    for (const url of ['/api/admin/dashboard', '/api/admin/feedback', '/api/admin/merch/stats']) {
      expect((await call(member.user.id, 'GET', url)).statusCode, url).toBe(200);
    }
    // Личные данные и действия - нет: участники, журнал бота (телефоны недоступных), деньги, настройки.
    for (const url of ['/api/admin/participants', '/api/admin/bot-log', '/api/admin/bot-log/unreachable', '/api/admin/money', '/api/admin/audit']) {
      expect((await call(member.user.id, 'GET', url)).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { authorization: await bearer(member.user.id) }, payload: { merchVisible: false } })).statusCode).toBe(403);
  });

  it('многоразовая ссылка «Участник команды»: одна на всех, показать снова, сменить, отключить', async () => {
    const boss = await makeStaff(env, ['superadmin'], 'Главный');
    const tokenOf = (link: string) => link.split('start=staff_')[1]!;
    const created = (await call(boss.user.id, 'POST', '/api/admin/staff/member-link', {})).json<MemberLinkView>();
    expect(created.link).toContain('start=staff_');
    // Повторно - та же ссылка, её можно показать снова.
    expect((await call(boss.user.id, 'GET', '/api/admin/staff/member-link')).json<{ link: MemberLinkView }>().link.link).toBe(created.link);
    expect((await call(boss.user.id, 'POST', '/api/admin/staff/member-link', { reset: false })).json<MemberLinkView>().link).toBe(created.link);

    const [a, b] = [await makeUser(env, 'Аня'), await makeUser(env, 'Боря')];
    expect(await redeemInvite(env, tokenOf(created.link), a)).toBe('member');
    expect(await redeemInvite(env, tokenOf(created.link), b)).toBe('member');
    expect(await getRoles(env.db, a.id)).toEqual(['member']);
    expect((await call(boss.user.id, 'GET', '/api/admin/staff/member-link')).json<{ link: MemberLinkView }>().link.uses).toBe(2);

    // Сменили - старая не работает, вступившие остались.
    const fresh = (await call(boss.user.id, 'POST', '/api/admin/staff/member-link', { reset: true })).json<MemberLinkView>();
    expect(fresh.link).not.toBe(created.link);
    await expect(redeemInvite(env, tokenOf(created.link), await makeUser(env))).rejects.toMatchObject({ code: 'link_expired' });
    expect(await getRoles(env.db, b.id)).toEqual(['member']);

    // Отключили - ссылки нет, по ней не вступить.
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/staff/member-link', headers: { authorization: await bearer(boss.user.id) } });
    expect(del.statusCode).toBe(200);
    expect((await call(boss.user.id, 'GET', '/api/admin/staff/member-link')).json<{ link: MemberLinkView | null }>().link).toBeNull();
    await expect(redeemInvite(env, tokenOf(fresh.link), await makeUser(env))).rejects.toMatchObject({ code: 'link_expired' });

    // Банкир (приглашает кассиров) тоже может; участник команды - нет.
    const banker = await makeStaff(env, ['banker']);
    expect((await call(banker.user.id, 'POST', '/api/admin/staff/member-link', {})).statusCode).toBe(200);
    const member = await makeStaff(env, ['member']);
    expect((await call(member.user.id, 'GET', '/api/admin/staff/member-link')).statusCode).toBe(403);
  });

  it('доступ по API: кассир - без денег и мерча; продавец - без денег; банкир - без склада', async () => {
    const cashier = await makeStaff(env, ['cashier']);
    const seller = await makeStaff(env, ['seller']);
    const banker = await makeStaff(env, ['banker']);
    expect((await call(cashier.user.id, 'GET', '/api/admin/money')).statusCode).toBe(403);
    expect((await call(cashier.user.id, 'GET', '/api/admin/merch/orders')).statusCode).toBe(403);
    expect((await call(seller.user.id, 'GET', '/api/admin/money')).statusCode).toBe(403);
    expect((await call(seller.user.id, 'GET', '/api/admin/merch/orders')).statusCode).toBe(200);
    expect((await call(seller.user.id, 'GET', '/api/admin/merch/stats')).statusCode).toBe(200);
    expect((await call(seller.user.id, 'GET', '/api/admin/participants')).statusCode).toBe(403);
    expect((await call(banker.user.id, 'GET', '/api/admin/money')).statusCode).toBe(200);
    expect((await call(banker.user.id, 'GET', '/api/admin/merch/stats')).statusCode).toBe(200);
    expect((await call(banker.user.id, 'POST', '/api/admin/merch/save', {})).statusCode).toBe(403);
    expect((await call(banker.user.id, 'GET', '/api/staff/money')).statusCode).toBe(200);
    expect((await call(cashier.user.id, 'GET', '/api/staff/money')).statusCode).toBe(403);
  });

  it('банкир приглашает только кассира и видит в «Команде» только кассиров', async () => {
    const banker = await makeStaff(env, ['banker'], 'Банкир');
    await makeStaff(env, ['cashier'], 'Кассир Вера');
    await makeStaff(env, ['admin'], 'Админ Пётр');
    const ok = await call(banker.user.id, 'POST', '/api/admin/staff/invites', { role: 'cashier' });
    expect(ok.statusCode).toBe(200);
    for (const role of ['admin', 'banker', 'seller', 'superadmin']) {
      expect((await call(banker.user.id, 'POST', '/api/admin/staff/invites', { role })).statusCode).toBe(403);
    }
    const list = (await call(banker.user.id, 'GET', '/api/admin/staff')).json() as { roles: string[] }[];
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) expect(s.roles).toContain('cashier');
  });
});

describe('деньги: выдать, принять, отменить', () => {
  it('выдача и приход в журнале и сводке; двойное нажатие не задваивает; отмена с причиной', async () => {
    const banker = await makeStaff(env, ['banker'], 'Алина');
    const before = await moneySummary(env.db);
    const requestId = randomUUID();
    const payout = { requestId, kind: 'payout' as const, amount: '2500', method: 'cash' as const, counterparty: 'Иван (закупки)', comment: 'Вода и стаканы', category: 'Закупки' };
    const first = await addMoneyEntry(env, banker, payout);
    expect(first.id).toBeTypeOf('number');
    expect(await addMoneyEntry(env, banker, payout)).toMatchObject({ duplicate: true });
    await addMoneyEntry(env, banker, { requestId: randomUUID(), kind: 'income', amount: '1000', method: 'transfer', counterparty: 'Спонсор', comment: 'На аренду' });

    const after = await moneySummary(env.db);
    expect(Number(after.payout) - Number(before.payout)).toBe(2500);
    expect(Number(after.income.income) - Number(before.income.income)).toBe(1000);
    expect(Number(after.balance) - Number(before.balance)).toBe(-1500);
    expect(after.payoutsByCategory.find((c) => c.category === 'Закупки')?.amount).toBe('2500.00');

    const view = (await call(banker.user.id, 'GET', '/api/admin/money')).json() as MoneyResponse;
    const row = view.entries.find((e) => e.id === first.id)!;
    expect(row).toMatchObject({ kind: 'payout', amount: '2500.00', category: 'Закупки', source: 'money' });

    const bad = await call(banker.user.id, 'POST', `/api/admin/money/${first.id}/cancel`, { reason: '' });
    expect(bad.statusCode).toBe(400);
    await cancelMoneyEntry(env, banker, first.id!, 'Ошиблась суммой');
    const cancelled = (await listPayments(env.db, { ids: [first.id!], kinds: ['payout'], withInactive: true }))[0]!;
    expect(cancelled.undoReason).toBe('Ошиблась суммой');
    expect(cancelled.undoneAt).not.toBeNull();
    expect(Number((await moneySummary(env.db)).payout)).toBe(Number(before.payout));
  });

  it('выдачи и мерч не попадают ни в «Сводку» взносов, ни в «Мои оплаты» кассира', async () => {
    const banker = await makeStaff(env, ['banker']);
    const seller = await makeStaff(env, ['seller']);
    const dashBefore = await moneyBreakdown(env.db);
    await addMoneyEntry(env, banker, { requestId: randomUUID(), kind: 'payout', amount: '700', method: 'cash', counterparty: 'Петя', comment: 'Такси' });
    const { variantId } = await tee();
    await createOrder(env, seller.user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' }, { staffSale: seller, method: 'cash' });
    const dashAfter = await moneyBreakdown(env.db);
    expect(dashAfter.byMethod).toEqual(dashBefore.byMethod);
    expect(dashAfter.donations).toEqual(dashBefore.donations);
    expect(await listPayments(env.db, { acceptedBy: banker.user.id })).toHaveLength(0);
    const mine = (await call(banker.user.id, 'GET', '/api/staff/payments/mine')).json() as PaymentEntryView[];
    expect(mine).toHaveLength(0);
  });

  it('взнос и мерч из «Денег» не отменить - у них свои места', async () => {
    const banker = await makeStaff(env, ['banker']);
    const seller = await makeStaff(env, ['seller']);
    const { variantId } = await tee();
    const order = await createOrder(env, seller.user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' }, { staffSale: seller, method: 'cash' });
    const [pay] = await merchRows(order.id);
    await expect(cancelMoneyEntry(env, banker, pay!.id, 'Ошибка')).rejects.toMatchObject({ code: 'cancel_merch' });
  });
});

describe('мерч: продажа, долг, возврат, статистика', () => {
  it('бронь оплачена - запись в журнале денег; отмена оплаченной - возврат, вещь вернулась', async () => {
    const { admin, productId, variantId } = await tee(3);
    const order = await createOrder(env, admin.user, { requestId: randomUUID(), items: [{ variantId, qty: 2 }], paymentMethod: 'cash' });
    const seller = await makeStaff(env, ['seller'], 'Продавец Оля');
    await markOrderPaid(env, order.id, 'transfer', seller);
    expect(await merchRows(order.id)).toMatchObject([{ kind: 'merch', source: 'merch', amount: '2000.00', method: 'transfer', acceptedBy: seller.user.id }]);
    expect(await left(productId)).toBe(1);

    const cancelled = await cancelOrderByStaff(env, order.id, 'Не подошёл размер', seller);
    expect(cancelled).toMatchObject({ status: 'cancelled', paidAmount: '0.00' });
    const [row] = await merchRows(order.id);
    expect(row!.undoneAt).not.toBeNull();
    expect(row!.undoReason).toBe('Возврат: Не подошёл размер');
    expect(await left(productId)).toBe(3);
  });

  it('в долг: покупатель обязателен, вещь списана, часть внесена; погашение частями закрывает долг', async () => {
    const { productId, variantId } = await tee(5);
    const seller = await makeStaff(env, ['seller'], 'Продавец');
    const sell = (body: Record<string, unknown>) =>
      call(seller.user.id, 'POST', '/api/admin/merch/sell', { requestId: randomUUID(), items: [{ variantId, qty: 2 }], method: 'cash', ...body });

    const noBuyer = await sell({ debt: true });
    expect(noBuyer.statusCode).toBe(400);
    expect((await sell({ debt: true, buyerName: 'Маша' })).statusCode).toBe(400);

    const res = await sell({ debt: true, paidNow: '500', buyerName: 'Маша Иванова', buyerPhone: '+79990001122' });
    expect(res.statusCode).toBe(200);
    const order = res.json() as AdminMerchOrderView;
    expect(order).toMatchObject({ status: 'owed', total: '2000.00', paidAmount: '500.00', buyerName: 'Маша Иванова', buyerPhone: '+79990001122', note: 'Продажа в долг' });
    expect(await left(productId)).toBe(3);
    expect(await merchRows(order.id)).toMatchObject([{ amount: '500.00', method: 'cash' }]);

    const stats1 = (await call(seller.user.id, 'GET', '/api/admin/merch/stats')).json() as MerchStats;
    expect(Number(stats1.debt.amount)).toBeGreaterThanOrEqual(1500);

    const tooMuch = await call(seller.user.id, 'POST', `/api/admin/merch/orders/${order.id}/repay`, { amount: '1600', method: 'cash' });
    expect(tooMuch.statusCode).toBe(400);
    const part = (await call(seller.user.id, 'POST', `/api/admin/merch/orders/${order.id}/repay`, { amount: '1000', method: 'transfer' })).json() as AdminMerchOrderView;
    expect(part).toMatchObject({ status: 'owed', paidAmount: '1500.00' });
    const done = await repayDebt(env, order.id, 500, 'cash', seller);
    expect(done).toMatchObject({ status: 'issued', paidAmount: '2000.00' });
    expect((await merchRows(order.id)).map((r) => r.amount)).toEqual(['500.00', '1000.00', '500.00']);
    await expect(repayDebt(env, order.id, 1, 'cash', seller)).rejects.toMatchObject({ code: 'not_owed' });
  });

  it('в долг участнику из базы: имя и телефон берутся из карточки; отмена долга - возврат внесённого', async () => {
    const { productId, variantId } = await tee(2);
    const seller = await makeStaff(env, ['seller']);
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner, { lastName: 'Смирнова', firstName: 'Анна', phone: '+79001234567' });
    const res = await call(seller.user.id, 'POST', '/api/admin/merch/sell', {
      requestId: randomUUID(),
      items: [{ variantId, qty: 1 }],
      method: 'cash',
      debt: true,
      buyerParticipantId: participant.id,
    });
    const order = res.json() as AdminMerchOrderView;
    expect(order).toMatchObject({ status: 'owed', paidAmount: '0.00', buyerParticipantId: participant.id, buyerName: 'Смирнова Анна', buyerPhone: '+79001234567' });
    const found = (await call(seller.user.id, 'GET', '/api/admin/merch/buyers?q=смирн')).json() as { id: number }[];
    expect(found.map((f) => f.id)).toContain(participant.id);
    const byPhone = (await call(seller.user.id, 'GET', '/api/admin/merch/buyers?q=1234567')).json() as { id: number }[];
    expect(byPhone.map((f) => f.id)).toContain(participant.id);
    expect(await merchRows(order.id)).toHaveLength(0);
    const repaid = await repayDebt(env, order.id, 300, 'cash', seller);
    const [entry] = await listPayments(env.db, { kinds: ['merch'], withInactive: true, ids: (await merchRows(repaid.id)).map((r) => r.id) });
    expect(entry).toMatchObject({ fullName: 'Смирнова Анна', merchOrderCode: order.code, kind: 'merch' });
    await cancelOrderByStaff(env, order.id, null, seller);
    const rows = await merchRows(order.id);
    expect(rows[0]!.undoReason).toBe('Возврат: заказ отменён');
    expect(await left(productId)).toBe(2);
  });

  it('статистика: штуки, выручка по способам и продавцам, что заканчивается', async () => {
    const { variantId } = await tee(4);
    const seller = await makeStaff(env, ['seller'], 'Продавец Статистика');
    const before = await merchStats(env.db);
    await createOrder(env, seller.user, { requestId: randomUUID(), items: [{ variantId, qty: 2 }], paymentMethod: 'cash' }, { staffSale: seller, method: 'card' });
    const after = await merchStats(env.db);
    expect(after.soldQty - before.soldQty).toBe(2);
    expect(Number(after.revenue) - Number(before.revenue)).toBe(2000);
    expect(after.bySeller.find((s) => s.userId === seller.user.id)).toMatchObject({ amount: '2000.00', count: 1 });
    expect(after.lowStock.find((s) => s.variantId === variantId)).toMatchObject({ left: 2, stock: 4 });
    expect(after.byMethod.find((m) => m.method === 'card')).toBeTruthy();
  });
});
