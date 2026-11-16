import type { MoneyEntryRequest, MoneyKind, MoneyResponse, MoneySummary, PaymentMethod } from '@sof/shared';
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { firstTime } from '../lib/once.ts';
import { listPayments, recordPayment } from './ledger.service.ts';
import type { StaffPrincipal } from './sessions.service.ts';

export const ALL_KINDS: readonly MoneyKind[] = ['fee', 'donation', 'merch', 'income', 'payout'];

/**
 * Банкир: выдать деньги (payout) или записать прочий приход (income) - в общий журнал денег.
 * Повтор того же запроса (двойное нажатие, плохая связь) второй раз не записывает.
 */
export async function addMoneyEntry(ctx: Pick<AppContext, 'db'>, staff: StaffPrincipal, req: MoneyEntryRequest): Promise<{ id: number | null; duplicate?: true }> {
  return ctx.db.transaction(async (tx) => {
    if (!(await firstTime(tx, `money:${req.requestId}`))) return { id: null, duplicate: true as const };
    const id = await recordPayment(tx, {
      participantId: null,
      kind: req.kind,
      amount: Number(req.amount),
      method: req.method,
      source: 'money',
      acceptedBy: staff.user.id,
      donorName: req.counterparty,
      comment: req.comment,
      category: req.category?.trim() || null,
    });
    await audit(tx, {
      actorUserId: staff.user.id,
      action: req.kind === 'payout' ? 'money.payout' : 'money.income',
      entity: 'payment',
      entityId: id,
      after: { amount: req.amount, method: req.method, counterparty: req.counterparty, comment: req.comment, category: req.category ?? null },
    });
    return { id };
  });
}

/**
 * Отменить запись банкира (выдачу, приход) или пожертвование - с причиной. Запись остаётся в журнале зачёркнутой.
 * Взносы отменяются из карточки участника (там пересчитывается «внесено»), мерч - отменой заказа (возврат).
 */
export async function cancelMoneyEntry(ctx: Pick<AppContext, 'db'>, staff: StaffPrincipal, id: number, reason: string): Promise<{ ok: true }> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.payments).where(eq(schema.payments.id, id)).for('update');
    if (!row) throw notFound('Запись не найдена');
    if (row.undoneAt) return;
    if (row.kind === 'fee') throw badRequest('cancel_fee', 'Взнос отменяется в карточке участника - там пересчитается, сколько он внёс');
    if (row.kind === 'merch') throw badRequest('cancel_merch', 'Оплата мерча отменяется отменой заказа (возврат) - в разделе «Мерч»');
    await tx.update(schema.payments).set({ undoneAt: new Date(), undoneBy: staff.user.id, undoReason: reason }).where(eq(schema.payments.id, id));
    await audit(tx, { actorUserId: staff.user.id, action: 'money.cancel', entity: 'payment', entityId: id, before: row, after: { reason } });
  });
  return { ok: true };
}

/** Сводка банкира по всему журналу (без отменённого): приход по источникам, расход, остаток - всего и по способам. */
export async function moneySummary(db: DbLike): Promise<MoneySummary> {
  const rows = await db.execute<{ kind: MoneyKind; method: PaymentMethod; amount: string; count: number }>(sql`
    select kind, method, sum(amount)::text as amount, count(*)::int as count
      from payments where undone_at is null group by kind, method`);
  const cats = await db.execute<{ category: string | null; amount: string; count: number }>(sql`
    select nullif(trim(category), '') as category, sum(amount)::text as amount, count(*)::int as count
      from payments where undone_at is null and kind = 'payout'
     group by nullif(trim(category), '') order by sum(amount) desc`);
  const sum = (pred: (r: (typeof rows.rows)[number]) => boolean) => rows.rows.filter(pred).reduce((s, r) => s + Number(r.amount), 0);
  const isIn = (k: MoneyKind) => k !== 'payout';
  const totalIn = sum((r) => isIn(r.kind));
  const out = sum((r) => r.kind === 'payout');
  const methods: PaymentMethod[] = ['cash', 'transfer', 'card'];
  return {
    income: {
      fee: sum((r) => r.kind === 'fee').toFixed(2),
      donation: sum((r) => r.kind === 'donation').toFixed(2),
      merch: sum((r) => r.kind === 'merch').toFixed(2),
      income: sum((r) => r.kind === 'income').toFixed(2),
      total: totalIn.toFixed(2),
    },
    payout: out.toFixed(2),
    balance: (totalIn - out).toFixed(2),
    byMethod: methods
      .map((m) => {
        const i = sum((r) => r.method === m && isIn(r.kind));
        const o = sum((r) => r.method === m && r.kind === 'payout');
        return { method: m, in: i.toFixed(2), out: o.toFixed(2), balance: (i - o).toFixed(2) };
      })
      .filter((m) => Number(m.in) > 0 || Number(m.out) > 0 || m.method !== 'card'),
    payoutsByCategory: cats.rows.map((c) => ({ category: c.category ?? 'Прочее', amount: Number(c.amount).toFixed(2), count: c.count })),
  };
}

/** Раздел «Деньги»: сводка и весь журнал (все виды, с отменёнными). */
export async function moneyView(db: DbLike): Promise<MoneyResponse> {
  // Все виды и все люди: деньги отменивших регистрацию тоже были получены - сводка их считает, журнал показывает.
  const [summary, entries] = await Promise.all([moneySummary(db), listPayments(db, { kinds: ALL_KINDS, withInactive: true })]);
  return { summary, entries };
}
