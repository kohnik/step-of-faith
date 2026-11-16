import { fullName, hasPermission, type DonationRequest, type MoneyKind, type PaymentEntryView, type PaymentMethod, type PaymentStatus, type Tier } from '@sof/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike, type Tx } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import { firstTime } from '../lib/once.ts';
import type { StaffPrincipal } from './sessions.service.ts';

type Source = 'desk' | 'receipt' | 'manual' | 'money' | 'merch';

/** Записать зачисление в журнал оплат (сумма - сколько добавили сейчас, не итог). */
export async function recordPayment(
  tx: Tx,
  entry: {
    participantId: number | null;
    amount: number;
    method: PaymentMethod;
    source: Source;
    acceptedBy: number | null;
    receiptId?: number | null;
    kind?: MoneyKind;
    donorName?: string | null;
    comment?: string | null;
    category?: string | null;
    merchOrderId?: number | null;
  },
): Promise<number | null> {
  if (!(entry.amount > 0.005)) return null;
  const [row] = await tx
    .insert(schema.payments)
    .values({
      kind: entry.kind ?? 'fee',
      donorName: entry.donorName ?? null,
      comment: entry.comment ?? null,
      category: entry.category ?? null,
      merchOrderId: entry.merchOrderId ?? null,
      participantId: entry.participantId,
      amount: entry.amount.toFixed(2),
      method: entry.method,
      source: entry.source,
      receiptId: entry.receiptId ?? null,
      acceptedBy: entry.acceptedBy,
    })
    .returning({ id: schema.payments.id });
  return row?.id ?? null;
}

/**
 * Свести журнал с итогом у участника после правки «внесено» не через приём (отмена приёма, правка в админке,
 * «Снять оплату»): лишнее - отменяем с конца, недостающее - дописываем строкой.
 * Так суммы журнала по способам всегда сходятся с `amount_paid`.
 */
export async function reconcilePayments(
  tx: Tx,
  participantId: number,
  targetPaid: number,
  actorUserId: number | null,
  fallbackMethod: PaymentMethod,
  source: Source = 'manual',
): Promise<void> {
  const active = await tx
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.participantId, participantId), eq(schema.payments.kind, 'fee'), isNull(schema.payments.undoneAt)))
    .orderBy(desc(schema.payments.id));
  let sum = active.reduce((s, p) => s + Number(p.amount), 0);
  let method = fallbackMethod;
  for (const p of active) {
    if (sum <= targetPaid + 0.005) break;
    await tx.update(schema.payments).set({ undoneAt: new Date(), undoneBy: actorUserId }).where(eq(schema.payments.id, p.id));
    sum -= Number(p.amount);
    method = p.method as PaymentMethod;
  }
  await recordPayment(tx, { participantId, amount: targetPaid - sum, method, source, acceptedBy: actorUserId });
}

/** Журнал оплат для админки и кассы: новые сверху. `acceptedBy` - только принятые этим человеком. */
export async function listPayments(
  db: DbLike,
  opts: { acceptedBy?: number; ids?: number[]; participantId?: number; kinds?: readonly MoneyKind[]; withInactive?: boolean } = {},
): Promise<PaymentEntryView[]> {
  // По умолчанию - только взносы и пожертвования (касса, «Оплаты и чеки», карточка участника); все виды - журнал банкира.
  const kinds = opts.kinds ?? ['fee', 'donation'];
  const rows = await db.execute<{
    id: string;
    kind: PaymentEntryView['kind'];
    participant_id: string | null;
    donor_name: string | null;
    comment: string | null;
    category: string | null;
    merch_order_id: string | null;
    merch_code: string | null;
    undo_reason: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    tier: Tier | null;
    amount: string;
    method: PaymentMethod;
    source: PaymentEntryView['source'];
    receipt_id: string | null;
    accepted_by: string | null;
    created_at: Date;
    undone_at: Date | null;
    payment_status: PaymentStatus | null;
    amount_due: string | null;
    amount_paid: string | null;
    a_display: string | null;
    a_first: string | null;
    a_last: string | null;
    a_username: string | null;
    u_display: string | null;
    u_first: string | null;
    u_last: string | null;
    u_username: string | null;
    buyer: string | null;
    on_site: boolean | null;
    o_display: string | null;
    o_first: string | null;
    o_last: string | null;
    o_username: string | null;
  }>(sql`
    select pm.id, pm.kind, pm.participant_id, pm.donor_name, pm.comment, pm.category, pm.merch_order_id, mo.code as merch_code, pm.undo_reason, p.last_name, p.first_name, p.middle_name, p.tier, pm.amount, pm.method, pm.source,
           pm.receipt_id, pm.accepted_by, pm.created_at, pm.undone_at, p.payment_status, p.amount_due, p.amount_paid,
           a.display_name as a_display, a.first_name as a_first, a.last_name as a_last, a.username as a_username,
           u.display_name as u_display, u.first_name as u_first, u.last_name as u_last, u.username as u_username,
           coalesce(nullif(trim(concat_ws(' ', bp.last_name, bp.first_name)), ''), mo.buyer_name) as buyer,
           mo.note in ('Продажа на месте', 'Продажа в долг') as on_site,
           o.display_name as o_display, o.first_name as o_first, o.last_name as o_last, o.username as o_username
      from payments pm
      left join participants p on p.id = pm.participant_id
      left join users a on a.id = pm.accepted_by
      left join users u on u.id = pm.undone_by
      left join merch_orders mo on mo.id = pm.merch_order_id
      left join participants bp on bp.id = mo.buyer_participant_id
      left join users o on o.id = mo.user_id
     where pm.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
       and (pm.participant_id is null or p.status = 'active' or pm.kind = 'donation' or ${opts.participantId !== undefined || !!opts.withInactive})
       ${opts.acceptedBy !== undefined ? sql`and pm.accepted_by = ${opts.acceptedBy}` : sql``}
       ${opts.participantId !== undefined ? sql`and pm.participant_id = ${opts.participantId}` : sql``}
       ${opts.ids ? sql`and pm.id in (${sql.join((opts.ids.length ? opts.ids : [-1]).map((x) => sql`${x}`), sql`, `)})` : sql``}
     order by pm.created_at desc, pm.id desc`);
  const name = (d: string | null, f: string | null, l: string | null, u: string | null) =>
    userDisplayName({ displayName: d, firstName: f, lastName: l, username: u });
  // Мерч: покупатель, которого записал продавец, иначе тот, кто бронировал в приложении.
  // Продажа на месте без имени - «Покупатель» (заказ там оформлен на продавца).
  const merchBuyer = (r: (typeof rows.rows)[number]) => {
    if (r.merch_code == null) return 'Без имени';
    if (r.buyer) return r.buyer;
    if (!r.on_site && (r.o_display || r.o_first || r.o_username)) return name(r.o_display, r.o_first, r.o_last, r.o_username);
    return 'Покупатель';
  };
  return rows.rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    participantId: r.participant_id == null ? null : Number(r.participant_id),
    fullName:
      r.last_name != null && r.first_name != null
        ? fullName({ lastName: r.last_name, firstName: r.first_name, middleName: r.middle_name })
        : (r.donor_name ?? merchBuyer(r)),
    comment: r.comment,
    category: r.category,
    merchOrderId: r.merch_order_id == null ? null : Number(r.merch_order_id),
    merchOrderCode: r.merch_code,
    undoReason: r.undo_reason,
    tier: r.tier,
    amount: Number(r.amount).toFixed(2),
    method: r.method,
    source: r.source,
    receiptId: r.receipt_id == null ? null : Number(r.receipt_id),
    acceptedById: r.accepted_by == null ? null : Number(r.accepted_by),
    acceptedByName: r.accepted_by == null ? null : name(r.a_display, r.a_first, r.a_last, r.a_username),
    createdAt: new Date(r.created_at).toISOString(),
    undoneAt: r.undone_at ? new Date(r.undone_at).toISOString() : null,
    undoneByName: r.undone_at && (r.u_display || r.u_first || r.u_username) ? name(r.u_display, r.u_first, r.u_last, r.u_username) : null,
    paymentStatus: r.payment_status,
    amountDue: r.amount_due,
    amountPaid: r.amount_paid,
  }));
}

/** Сколько минут кассир может отменить свой приём сам (дальше - админ). */
export const UNDO_MINUTES = 15;

/** Пожертвование на кассе: от участника (по QR-коду) или без него. Повтор того же запроса не записывается дважды. */
export async function addDonation(
  ctx: Pick<AppContext, 'db'>,
  staff: StaffPrincipal,
  req: DonationRequest,
): Promise<{ id: number | null; duplicate?: true }> {
  return ctx.db.transaction(async (tx) => {
    if (!(await firstTime(tx, `don:${req.requestId}`))) return { id: null, duplicate: true as const };
    if (req.participantId) {
      const [p] = await tx.select({ id: schema.participants.id }).from(schema.participants).where(eq(schema.participants.id, req.participantId));
      if (!p) throw notFound('Участник не найден');
    }
    const id = await recordPayment(tx, {
      kind: 'donation',
      participantId: req.participantId ?? null,
      donorName: req.participantId ? null : (req.donorName ?? null),
      comment: req.comment ?? null,
      amount: Number(req.amount),
      method: req.method,
      source: 'desk',
      acceptedBy: staff.user.id,
    });
    await audit(tx, { actorUserId: staff.user.id, action: 'donation.add', entity: 'payment', entityId: id, after: req });
    return { id };
  });
}

/** Отменить пожертвование: своё - в течение 15 минут, админ (participants:write) - всегда. */
export async function undoDonation(ctx: Pick<AppContext, 'db'>, staff: StaffPrincipal, paymentId: number): Promise<{ ok: true }> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).for('update');
    if (!row || row.kind !== 'donation') throw notFound('Пожертвование не найдено');
    if (row.undoneAt) return;
    const own = row.acceptedBy === staff.user.id && row.createdAt.getTime() > Date.now() - UNDO_MINUTES * 60_000;
    if (!own && !hasPermission(staff.roles, 'participants:write') && !hasPermission(staff.roles, 'money:manage')) {
      throw forbidden(`Отменить можно только своё пожертвование в течение ${UNDO_MINUTES} минут - дальше через админку`);
    }
    await tx.update(schema.payments).set({ undoneAt: new Date(), undoneBy: staff.user.id }).where(eq(schema.payments.id, paymentId));
    await audit(tx, { actorUserId: staff.user.id, action: 'donation.undo', entity: 'payment', entityId: paymentId, before: row });
  });
  return { ok: true };
}
