import {
  CATEGORY_LABELS,
  PAYMENT_STATUS_LABELS,
  REG_PAYMENT_METHOD_LABELS,
  ageOrNull,
  fullName,
  type AdminCheckInRow,
  type AdminParticipantCreate,
  type AdminParticipantDetail,
  type AdminParticipantRow,
  type AdminParticipantUpdate,
  type AuditEntry,
  type BulkParticipantsRequest,
  type Category,
  type CheckInMethod,
  type CheckpointInput,
  type CheckpointView,
  type DuplicateGroup,
  type Gender,
  type ParticipantStatus,
  type PaymentStatus,
  type Relation,
  type RegPaymentMethod,
  type ScanLogRow,
  type Settings,
} from '@sof/shared';
import ExcelJS from 'exceljs';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { esc } from '../bot/format.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.ts';
import { ticketUrls, ticketView, userDisplayName } from '../lib/format.ts';
import type { Config } from '../config.ts';
import { personKey } from '../lib/person-key.ts';
import { activityRegistrations } from './activity.service.ts';
import { toCheckpointView } from './checkin.service.ts';
import { listReceipts } from './payment.service.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import { enqueueTicketsUpdated, issueTicket, reissueTicket, revokeActiveTicket } from './tickets.service.ts';
import { getSettings } from './settings.service.ts';
import {
  amountForTier,
  asTier,
  breakfastOverWarning,
  initialPaymentStatus,
  isUnder16,
  tierOverWarning,
  withBreakfast,
} from './tiers.ts';
import { linkNewParticipants } from './link.service.ts';
import { listPayments, reconcilePayments, recordPayment } from './ledger.service.ts';
import { createLocalUser } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss' | 'config'>;

// ---------- таблица участников ----------

type RawRow = {
  id: string;
  owner_user_id: string;
  last_name: string;
  first_name: string;
  middle_name: string | null;
  birth_date: string | null;
  gender: string;
  city: string | null;
  church: string | null;
  phone: string | null;
  telegram_username: string | null;
  relation: string;
  category: string;
  status: string;
  tier: string | null;
  breakfast: boolean;
  payment_method: string | null;
  holder_name: string | null;
  chat_user_id: string;
  payment_status: string;
  amount_due: string | null;
  amount_paid: string;
  paid_at: Date | null;
  payment_note: string | null;
  arrived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  ticket_code: string | null;
  web_token: string | null;
  owner_display_name: string | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  owner_username: string | null;
  arrived_by_name: string | null;
  arrived_by_username: string | null;
  owner_tg_id: string | null;
  owner_phone: string | null;
  payment_ref: string;
  family_size: number;
  possible_duplicate: boolean;
  sponsor_offer: boolean;
  on_site: boolean;
  lists: string[] | null;
};

function toRow(config: Config, settings: Settings, r: RawRow): AdminParticipantRow {
  const urls = r.web_token ? ticketUrls(config, r.web_token) : null;
  const person = { lastName: r.last_name, firstName: r.first_name, middleName: r.middle_name };
  return {
    id: Number(r.id),
    lastName: r.last_name,
    firstName: r.first_name,
    middleName: r.middle_name,
    fullName: fullName(person),
    birthDate: r.birth_date,
    age: ageOrNull(r.birth_date),
    gender: r.gender as Gender,
    city: r.city,
    church: r.church,
    phone: r.phone,
    telegramUsername: r.telegram_username,
    relation: r.relation as Relation,
    category: r.category as Category,
    status: r.status as ParticipantStatus,
    tier: asTier(r.tier),
    breakfast: r.breakfast,
    paymentMethod: (r.payment_method as RegPaymentMethod | null) ?? null,
    under16: isUnder16(settings, r.birth_date),
    holderName: r.holder_name,
    chatUserId: Number(r.chat_user_id),
    paymentStatus: r.payment_status as PaymentStatus,
    amountDue: r.amount_due,
    amountPaid: r.amount_paid,
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    paymentNote: r.payment_note,
    arrivedAt: r.arrived_at ? new Date(r.arrived_at).toISOString() : null,
    arrivedBy: r.arrived_by_name ? { name: r.arrived_by_name, username: r.arrived_by_username } : null,
    ticketCode: r.ticket_code,
    ticketWebUrl: urls?.webUrl ?? null,
    ticketImageUrl: urls?.imageUrl ?? null,
    familyId: Number(r.owner_user_id),
    familySize: r.family_size,
    ownerName: userDisplayName({
      displayName: r.owner_display_name,
      firstName: r.owner_first_name,
      lastName: r.owner_last_name,
      username: r.owner_username,
    }),
    ownerUsername: r.owner_username,
    ownerTgId: r.owner_tg_id == null ? null : Number(r.owner_tg_id),
    ownerPhone: r.owner_phone,
    paymentRef: r.payment_ref,
    possibleDuplicate: r.possible_duplicate,
    sponsorOffer: r.sponsor_offer,
    onSite: r.on_site,
    lists: (r.lists ?? []).map(Number),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

type RowsCtx = { db: DbLike; config: Config };

export async function participantRows(ctx: RowsCtx, where: SQL = sql`true`): Promise<AdminParticipantRow[]> {
  const res = await ctx.db.execute<RawRow>(sql`
    with dup_keys as (
      select person_key from participants where status = 'active'
       group by person_key having count(distinct owner_user_id) > 1
    ), dup_phones as (
      select right(regexp_replace(phone, '\D', '', 'g'), 10) as ph from participants
       where status = 'active' and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
       group by 1 having count(distinct owner_user_id) > 1
    ), fam as (
      select owner_user_id, count(*)::int as n from participants where status = 'active' group by owner_user_id
    )
    select p.id, p.owner_user_id, p.last_name, p.first_name, p.middle_name, p.birth_date::text as birth_date,
           p.gender, p.city, p.church, p.phone, p.telegram_username, p.relation, p.category, p.status,
           p.tier, p.breakfast, p.payment_method, p.payment_status, p.amount_due, p.amount_paid,
           p.paid_at, p.payment_note, p.arrived_at, p.created_at, p.updated_at, p.sponsor_offer, p.on_site,
           t.code as ticket_code, t.web_token,
           u.display_name as owner_display_name, u.first_name as owner_first_name, u.last_name as owner_last_name,
           u.username as owner_username, u.tg_id as owner_tg_id, u.phone as owner_phone, u.payment_ref,
           coalesce(fam.n, 0) as family_size,
           coalesce(h.display_name, nullif(concat_ws(' ', h.first_name, h.last_name), ''), '@' || h.username) as holder_name,
           coalesce(p.holder_user_id, p.owner_user_id) as chat_user_id,
           (select array_agg(m.list_id order by m.list_id) from participant_list_members m where m.participant_id = p.id) as lists,
           arr.by_name as arrived_by_name, arr.by_username as arrived_by_username,
           (p.status = 'active' and (
              p.person_key in (select person_key from dup_keys)
              or right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) in (select ph from dup_phones)
           )) as possible_duplicate
      from participants p
      join users u on u.id = p.owner_user_id
      left join users h on h.id = p.holder_user_id
      left join tickets t on t.participant_id = p.id and t.status = 'active'
      left join fam on fam.owner_user_id = p.owner_user_id
      -- Кто отметил на входе (первая неотменённая отметка).
      left join lateral (
        select coalesce(su.display_name, nullif(concat_ws(' ', su.first_name, su.last_name), ''), '@' || su.username) as by_name, su.username as by_username
          from check_ins ci
          join checkpoints cp on cp.id = ci.checkpoint_id and cp.kind = 'entrance'
          join users su on su.id = ci.scanned_by
         where ci.participant_id = p.id and ci.revoked_at is null
         order by ci.created_at
         limit 1
      ) arr on true
     where ${where}
     order by p.id`);
  const settings = await getSettings(ctx.db);
  return res.rows.map((r) => toRow(ctx.config, settings, r));
}

export async function participantRow(ctx: RowsCtx, id: number): Promise<AdminParticipantRow> {
  const [row] = await participantRows(ctx, sql`p.id = ${id}`);
  if (!row) throw notFound('Участник не найден');
  return row;
}

// ---------- журналы ----------

export async function checkInRows(db: DbLike, where: SQL = sql`true`, limit = 2000): Promise<AdminCheckInRow[]> {
  const res = await db.execute<{
    id: string;
    checkpoint_id: number;
    checkpoint_name: string;
    participant_id: string;
    last_name: string;
    first_name: string;
    middle_name: string | null;
    created_at: Date;
    display_name: string | null;
    s_first: string | null;
    s_last: string | null;
    s_username: string | null;
    method: string;
    offline: boolean;
    device_id: string | null;
    revoked_at: Date | null;
  }>(sql`
    select ci.id, ci.checkpoint_id, c.name as checkpoint_name, ci.participant_id,
           p.last_name, p.first_name, p.middle_name, ci.created_at,
           s.display_name, s.first_name as s_first, s.last_name as s_last, s.username as s_username,
           ci.method, ci.offline, ci.device_id, ci.revoked_at
      from check_ins ci
      join checkpoints c on c.id = ci.checkpoint_id
      join participants p on p.id = ci.participant_id
      join users s on s.id = ci.scanned_by
     where ${where}
     order by ci.created_at desc
     limit ${limit}`);
  return res.rows.map((r) => ({
    id: Number(r.id),
    checkpointId: r.checkpoint_id,
    checkpointName: r.checkpoint_name,
    participantId: Number(r.participant_id),
    fullName: fullName({ lastName: r.last_name, firstName: r.first_name, middleName: r.middle_name }),
    at: new Date(r.created_at).toISOString(),
    byName: userDisplayName({ displayName: r.display_name, firstName: r.s_first, lastName: r.s_last, username: r.s_username }),
    byUsername: r.s_username,
    method: r.method as CheckInMethod,
    offline: r.offline,
    deviceId: r.device_id,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  }));
}

export async function scanLogRows(db: DbLike, where: SQL = sql`true`, limit = 1000): Promise<ScanLogRow[]> {
  const res = await db.execute<{
    id: string;
    checkpoint_name: string | null;
    raw_code: string | null;
    participant_id: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    outcome: string;
    display_name: string | null;
    s_first: string | null;
    s_last: string | null;
    s_username: string | null;
    device_id: string | null;
    created_at: Date;
  }>(sql`
    select sl.id, c.name as checkpoint_name, sl.raw_code, sl.participant_id,
           p.last_name, p.first_name, p.middle_name, sl.outcome,
           s.display_name, s.first_name as s_first, s.last_name as s_last, s.username as s_username,
           sl.device_id, sl.created_at
      from scan_log sl
      left join checkpoints c on c.id = sl.checkpoint_id
      left join participants p on p.id = sl.participant_id
      left join users s on s.id = sl.staff_user_id
     where ${where}
     order by sl.created_at desc
     limit ${limit}`);
  return res.rows.map((r) => ({
    id: Number(r.id),
    checkpointName: r.checkpoint_name,
    rawCode: r.raw_code,
    participantId: r.participant_id == null ? null : Number(r.participant_id),
    fullName: r.last_name ? fullName({ lastName: r.last_name, firstName: r.first_name ?? '', middleName: r.middle_name }) : null,
    outcome: r.outcome,
    staffName:
      r.display_name || r.s_first || r.s_username
        ? userDisplayName({ displayName: r.display_name, firstName: r.s_first, lastName: r.s_last, username: r.s_username })
        : null,
    staffUsername: r.s_username,
    deviceId: r.device_id,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function auditRows(db: DbLike, filter: { entity?: string; entityId?: string } = {}, limit = 500): Promise<AuditEntry[]> {
  const conds = [sql`true`];
  if (filter.entity) conds.push(sql`a.entity = ${filter.entity}`);
  if (filter.entityId) conds.push(sql`a.entity_id = ${filter.entityId}`);
  const res = await db.execute<{
    id: string;
    action: string;
    entity: string;
    entity_id: string | null;
    before: unknown;
    after: unknown;
    created_at: Date;
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    actor_user_id: string | null;
  }>(sql`
    select a.id, a.action, a.entity, a.entity_id, a.before, a.after, a.created_at, a.actor_user_id,
           u.display_name, u.first_name, u.last_name, u.username
      from audit_log a left join users u on u.id = a.actor_user_id
     where ${sql.join(conds, sql` and `)}
     order by a.created_at desc, a.id desc
     limit ${limit}`);
  return res.rows.map((r) => ({
    id: Number(r.id),
    actorName: r.actor_user_id
      ? userDisplayName({ displayName: r.display_name, firstName: r.first_name, lastName: r.last_name, username: r.username })
      : null,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    before: r.before,
    after: r.after,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

// ---------- карточка участника ----------

export async function participantDetail(ctx: Ctx, id: number): Promise<AdminParticipantDetail> {
  const participant = await participantRow(ctx, id);
  const [family, checkIns, regs, receipts, consents, auditEntries] = await Promise.all([
    participantRows(ctx, sql`p.owner_user_id = ${participant.familyId} and p.id <> ${id}`),
    checkInRows(ctx.db, sql`ci.participant_id = ${id}`, 100),
    ctx.db.execute<{ activity_id: string; title: string; starts_at: Date; status: string }>(sql`
      select ar.activity_id, a.title, a.starts_at, ar.status
        from activity_registrations ar join activities a on a.id = ar.activity_id
       where ar.participant_id = ${id} order by a.starts_at`),
    ctx.db.execute<{ id: string }>(sql`select id from payment_receipts where ${id} = any(participant_ids)`),
    ctx.db.execute<{ kind: string; document_version: string; given_at: Date; display_name: string | null; first_name: string | null; last_name: string | null; username: string | null }>(sql`
      select c.kind, c.document_version, c.given_at, u.display_name, u.first_name, u.last_name, u.username
        from consents c join users u on u.id = c.given_by_user_id where c.participant_id = ${id} order by c.given_at`),
    auditRows(ctx.db, { entity: 'participant', entityId: String(id) }, 100),
  ]);
  return {
    participant,
    family,
    checkIns,
    activities: regs.rows.map((r) => ({
      activityId: Number(r.activity_id),
      title: r.title,
      startsAt: new Date(r.starts_at).toISOString(),
      status: r.status,
    })),
    receipts: await listReceipts(ctx, undefined, receipts.rows.map((r) => Number(r.id))),
    payments: await listPayments(ctx.db, { participantId: id }),
    consents: consents.rows.map((c) => ({
      kind: c.kind as 'pd' | 'photo',
      documentVersion: c.document_version,
      givenAt: new Date(c.given_at).toISOString(),
      givenByName: userDisplayName({ displayName: c.display_name, firstName: c.first_name, lastName: c.last_name, username: c.username }),
    })),
    audit: auditEntries,
  };
}

// ---------- изменения ----------

async function cancelRegistrations(ctx: Ctx, tx: DbLike, participantId: number) {
  await tx.delete(schema.counselingBookings).where(eq(schema.counselingBookings.participantId, participantId));
  const regs = await tx
    .select({ activityId: schema.activityRegistrations.activityId })
    .from(schema.activityRegistrations)
    .where(
      and(
        eq(schema.activityRegistrations.participantId, participantId),
        sql`${schema.activityRegistrations.status} in ('registered', 'waitlist')`,
      ),
    )
    // Активности блокируем по возрастанию id, как switch_activity, - иначе встречные транзакции взаимоблокируются.
    .orderBy(schema.activityRegistrations.activityId);
  for (const { activityId } of regs) {
    const res = await tx.execute<{ promoted: string[] }>(
      sql`select promoted from cancel_activity_registration(${activityId}::bigint, ${participantId}::bigint)`,
    );
    const promoted = (res.rows[0]?.promoted ?? []).map(Number);
    if (promoted.length) {
      await enqueue(ctx.boss, 'activity.promoted', { activityId, participantIds: promoted }, { tx: tx as never });
    }
  }
}

export async function updateParticipant(
  ctx: Ctx,
  id: number,
  patch: AdminParticipantUpdate,
  actor: StaffPrincipal,
): Promise<AdminParticipantRow> {
  const settings = await getSettings(ctx.db);
  const placed = await ctx.db.transaction(async (tx) => {
    const before = await tx.query.participants.findFirst({ where: eq(schema.participants.id, id) });
    if (!before) throw notFound('Участник не найден');
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as typeof before;
    const tier = asTier(next.tier);
    // Завтрак - только к платному варианту: перевели на «Без взноса» - снимаем.
    next.breakfast = withBreakfast(tier, next.breakfast);
    // Сменили вариант или завтрак, а сумму и статус руками не трогали - пересчитываем по цене (если ещё не платил).
    if (tier && ((patch.tier !== undefined && patch.tier !== before.tier) || next.breakfast !== before.breakfast)) {
      if (patch.amountDue === undefined) next.amountDue = amountForTier(settings, tier, next.breakfast);
      if (patch.paymentStatus === undefined && ['unpaid', 'exempt'].includes(before.paymentStatus)) {
        next.paymentStatus = initialPaymentStatus(settings, tier, next.breakfast);
      } else if (patch.paymentStatus === undefined && ['paid', 'partial'].includes(before.paymentStatus)) {
        // Уже вносил деньги: статус - по внесённому. Внёс 35, а теперь с завтраком 45 - «частично», доплата 10.
        const due = Number(next.amountDue ?? 0);
        const paid = Number(next.amountPaid ?? 0);
        next.paymentStatus = due === 0 ? 'exempt' : paid >= due ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
      }
    }
    // Отметили «Оплачено» без суммы - считаем, что внесено ровно к оплате.
    if (next.paymentStatus === 'paid' && before.paymentStatus !== 'paid' && patch.amountPaid === undefined && Number(next.amountPaid) === 0) {
      next.amountPaid = next.amountDue ?? '0';
    }
    const usernameChanged = patch.telegramUsername !== undefined && patch.telegramUsername !== before.telegramUsername;
    const set: Partial<typeof schema.participants.$inferInsert> = {
      lastName: next.lastName,
      firstName: next.firstName,
      middleName: next.middleName ?? null,
      birthDate: next.birthDate,
      gender: next.gender,
      city: next.city,
      church: next.church ?? null,
      phone: next.phone ?? null,
      telegramUsername: next.telegramUsername ?? null,
      tier: next.tier ?? null,
      breakfast: next.breakfast,
      paymentMethod: next.paymentMethod ?? null,
      category: next.category,
      status: next.status,
      paymentStatus: next.paymentStatus,
      amountDue: next.amountDue ?? null,
      amountPaid: next.amountPaid,
      paymentNote: next.paymentNote ?? null,
      sponsorOffer: next.sponsorOffer,
      personKey: personKey(next),
      updatedAt: new Date(),
    };
    if (next.paymentStatus === 'paid' && before.paymentStatus !== 'paid' && !before.paidAt) set.paidAt = new Date();
    try {
      await tx.update(schema.participants).set(set).where(eq(schema.participants.id, id));
    } catch (err) {
      if (isUniqueViolation(err, 'participants_person_uq')) {
        throw conflict('duplicate_person', 'В этой семье уже есть такой участник');
      }
      throw err;
    }
    if (Number(next.amountPaid ?? 0) !== Number(before.amountPaid ?? 0)) {
      await reconcilePayments(tx, id, Number(next.amountPaid ?? 0), actor.user.id, ledgerMethod(next.paymentMethod));
    }
    // Человек узнаёт об отмене сразу, а не на входе; при возврате получает новый QR-код.
    const recipient = before.holderUserId ?? before.ownerUserId;
    if (before.status === 'active' && next.status === 'cancelled') {
      await revokeActiveTicket(tx, id, 'cancelled_by_admin');
      await cancelRegistrations(ctx, tx, id);
      await enqueue(
        ctx.boss,
        'notify.text',
        {
          kind: 'registration.cancelled',
          userId: recipient,
          text:
            `❗️ <b>Регистрация отменена</b>\n${esc(fullName(before))} - организаторы отменили регистрацию, QR-код больше не действует.\n\n` +
            '👉 Если это ошибка - нажмите «Задать вопрос» в меню бота.',
        },
        { tx },
      );
    } else if (before.status === 'cancelled' && next.status === 'active') {
      await issueTicket(tx, id);
      await enqueue(ctx.boss, 'tickets.send', { userId: recipient, participantIds: [id], reason: 'restored' }, { tx });
    } else if (before.status === 'active' && next.status === 'active') {
      // Поменялось то, что видно на QR и в подписи к нему (вариант, завтрак, ФИО, категория), - пришлём актуальный.
      const onQr = (r: typeof before) => [r.tier, r.breakfast, r.lastName, r.firstName, r.middleName ?? null, r.category].join('|');
      if (onQr(next) !== onQr(before)) await enqueueTicketsUpdated(tx, ctx.boss, before);
    }
    if (usernameChanged && next.telegramUsername && before.holderUserId === null) await linkNewParticipants(ctx, tx, [id]);
    await audit(tx, { actorUserId: actor.user.id, action: 'participant.update', entity: 'participant', entityId: id, before, after: set });
    // Человек занял место в варианте или завтрак (сменили, добавили или вернули участие) - проверим лимиты.
    const back = before.status !== 'active';
    return {
      tier: next.status === 'active' && (next.tier !== before.tier || back) ? tier : null,
      breakfast: next.status === 'active' && next.breakfast && (!before.breakfast || back),
    };
  });
  const row = await participantRow(ctx, id);
  const warning = (
    await Promise.all([
      placed.tier ? tierOverWarning(ctx.db, settings, placed.tier) : undefined,
      placed.breakfast ? breakfastOverWarning(ctx.db, settings) : undefined,
    ])
  )
    .filter(Boolean)
    .join('. ');
  return warning ? { ...row, warning } : row;
}

/**
 * Удалить участника совсем - дубль, тестовая запись, ошибка. Может админ и суперадмин; если есть оплата или чек - нельзя (только «Отменён»).
 * Перед удалением вся карточка (анкета, коды QR, оплата, отметки на входе) сохраняется в журнал действий -
 * так видно, кто, когда и кого удалил, и сколько было оплачено. Записи на мероприятия освобождаются
 * (лист ожидания продвигается), место в варианте участия тоже. QR-код перестаёт действовать; человеку ничего не пишем.
 */
export async function deleteParticipant(ctx: Ctx, id: number, actor: StaffPrincipal): Promise<{ deleted: true }> {
  await ctx.db.transaction(async (tx) => {
    const [p] = await tx.select().from(schema.participants).where(eq(schema.participants.id, id)).for('update');
    if (!p) throw notFound('Участник не найден');
    // Деньги и чеки не теряем: с ними человек удалился бы вместе с записями об оплате.
    const money = await tx.execute<{ pays: number; receipts: number }>(sql`
      select (select count(*) from payments where participant_id = ${id} and undone_at is null)::int as pays,
             (select count(*) from payment_receipts where ${id}::bigint = any(participant_ids) and status <> 'draft')::int as receipts`);
    if (Number(p.amountPaid ?? 0) > 0 || (money.rows[0]?.pays ?? 0) > 0 || (money.rows[0]?.receipts ?? 0) > 0) {
      throw conflict('has_money', 'У человека есть оплата или чек - удалить нельзя, они бы пропали. Поставьте статус «Отменён».');
    }
    const tickets = await tx.select().from(schema.tickets).where(eq(schema.tickets.participantId, id));
    const checkIns = await tx.select().from(schema.checkIns).where(eq(schema.checkIns.participantId, id));
    // Мероприятия и душепопечение - как при отмене: лист ожидания продвигается, людям из него приходит сообщение.
    await cancelRegistrations(ctx, tx, id);
    await tx.delete(schema.activityRegistrations).where(eq(schema.activityRegistrations.participantId, id));
    // Журнал сканов оставляем (кто и когда сканировал), только без ссылки на удалённого.
    await tx.update(schema.scanLog).set({ participantId: null }).where(eq(schema.scanLog.participantId, id));
    await tx.delete(schema.checkIns).where(eq(schema.checkIns.participantId, id));
    await tx.delete(schema.consents).where(eq(schema.consents.participantId, id));
    await tx.delete(schema.tickets).where(eq(schema.tickets.participantId, id));
    // Из чеков человека убираем; чек, в котором больше никого не осталось, закрываем.
    await tx.execute(sql`
      update payment_receipts set participant_ids = array_remove(participant_ids, ${id}::bigint)
       where ${id}::bigint = any(participant_ids)`);
    await tx.execute(sql`
      update payment_receipts
         set status = 'rejected', reject_reason = 'Участника удалили из регистрации', reviewed_by = ${actor.user.id}, reviewed_at = now()
       where cardinality(participant_ids) = 0 and status in ('draft', 'pending')`);
    // Неиспользованные ссылки «передать QR-код» на этого человека больше не нужны.
    await tx.execute(sql`delete from one_time_tokens where purpose = 'ticket_claim' and payload->>'participantId' = ${String(id)}`);
    await tx.delete(schema.participants).where(eq(schema.participants.id, id));
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'participant.delete',
      entity: 'participant',
      entityId: id,
      before: {
        participant: p,
        tickets: tickets.map((t) => ({ code: t.code, status: t.status })),
        checkIns: checkIns.map((c) => ({ checkpointId: c.checkpointId, at: c.createdAt, revoked: c.revokedAt !== null })),
      },
    });
  });
  return { deleted: true };
}

/** Ручная регистрация (у человека нет Telegram): отдельный аккаунт-заглушка, билет печатается. */
/** Способ для журнала оплат при правке в админке: как человек собирался платить, по умолчанию - наличные. */
const ledgerMethod = (m: string | null | undefined): 'cash' | 'transfer' => (m === 'transfer' ? 'transfer' : 'cash');

export async function createParticipant(
  ctx: Ctx,
  input: AdminParticipantCreate,
  actor: StaffPrincipal,
): Promise<AdminParticipantRow> {
  const settings = await getSettings(ctx.db);
  const breakfast = withBreakfast(input.tier, input.breakfast);
  const paymentStatus =
    input.paymentStatus === 'unpaid' ? initialPaymentStatus(settings, input.tier, breakfast) : input.paymentStatus;
  const amountDue = input.amountDue ?? amountForTier(settings, input.tier, breakfast);
  const id = await ctx.db.transaction(async (tx) => {
    const owner = await createLocalUser(tx, fullName(input));
    const [row] = await tx
      .insert(schema.participants)
      .values({
        ownerUserId: owner.id,
        lastName: input.lastName,
        firstName: input.firstName,
        middleName: input.middleName ?? null,
        birthDate: input.birthDate,
        gender: input.gender,
        city: input.city,
        church: input.church ?? null,
        phone: input.phone ?? null,
        telegramUsername: input.telegramUsername ?? null,
        relation: input.relation,
        category: input.category,
        tier: input.tier,
        breakfast,
        paymentMethod: input.paymentMethod ?? null,
        paymentStatus,
        amountDue,
        amountPaid: paymentStatus === 'paid' ? amountDue : '0',
        paymentNote: input.note ?? null,
        paidAt: paymentStatus === 'paid' ? new Date() : null,
        personKey: personKey(input),
        registeredByStaff: true,
      })
      .returning({ id: schema.participants.id });
    await issueTicket(tx, row!.id);
    if (paymentStatus === 'paid') {
      await recordPayment(tx, { participantId: row!.id, amount: Number(amountDue ?? 0), method: ledgerMethod(input.paymentMethod), source: 'manual', acceptedBy: actor.user.id });
    }
    if (input.telegramUsername) await linkNewParticipants(ctx, tx, [row!.id]);
    await audit(tx, { actorUserId: actor.user.id, action: 'participant.create', entity: 'participant', entityId: row!.id, after: input });
    return row!.id;
  });
  const row = await participantRow(ctx, id);
  const warning = (
    await Promise.all([tierOverWarning(ctx.db, settings, input.tier), breakfast ? breakfastOverWarning(ctx.db, settings) : undefined])
  )
    .filter(Boolean)
    .join('. ');
  return warning ? { ...row, warning } : row;
}

/**
 * Массовые действия. Оплату не трогаем у тех, кому она не нужна («без взноса»), и у тех, у кого статус и так такой:
 * иначе «Снять оплату» превратило бы бесплатных в неоплативших и их не пустили бы на вход.
 */
export async function bulkUpdate(ctx: Ctx, req: BulkParticipantsRequest, actor: StaffPrincipal): Promise<{ updated: number }> {
  // «Чек на проверке» массово не трогаем: его решают во вкладке «Чеки», иначе чек повиснет в очереди.
  return ctx.db.transaction(async (tx) => {
    let set: Partial<typeof schema.participants.$inferInsert>;
    let which: SQL | undefined;
    if (req.action === 'mark_paid') {
      set = {
        paymentStatus: 'paid',
        paidAt: sql`coalesce(${schema.participants.paidAt}, now())` as never,
        amountPaid: sql`coalesce(${schema.participants.amountDue}, ${schema.participants.amountPaid})` as never,
      };
      which = sql`${schema.participants.paymentStatus} not in ('paid', 'exempt', 'pending')`;
    } else if (req.action === 'mark_unpaid') {
      set = { paymentStatus: 'unpaid', paidAt: null, amountPaid: '0' };
      which = sql`${schema.participants.paymentStatus} not in ('unpaid', 'exempt', 'pending')`;
    } else {
      set = { category: req.category };
    }
    const where = and(inArray(schema.participants.id, req.ids), eq(schema.participants.status, 'active'), which);
    const before = await tx.select().from(schema.participants).where(where);
    const rows = await tx
      .update(schema.participants)
      .set({ ...set, updatedAt: new Date() })
      .where(where)
      .returning({ id: schema.participants.id, paymentStatus: schema.participants.paymentStatus, amountPaid: schema.participants.amountPaid });
    // В историю каждого человека - своя запись.
    for (const r of rows) {
      const b = before.find((x) => x.id === r.id);
      if (req.action !== 'set_category') await reconcilePayments(tx, r.id, Number(r.amountPaid ?? 0), actor.user.id, ledgerMethod(b?.paymentMethod));
      await audit(tx, {
        actorUserId: actor.user.id,
        action: `participant.bulk.${req.action}`,
        entity: 'participant',
        entityId: r.id,
        before: b ? { paymentStatus: b.paymentStatus, amountPaid: b.amountPaid, category: b.category } : undefined,
        after: req.action === 'set_category' ? { category: req.category } : { paymentStatus: r.paymentStatus, amountPaid: r.amountPaid },
      });
    }
    return { updated: rows.length };
  });
}

export async function reissue(ctx: Ctx, id: number, actor: StaffPrincipal) {
  const p = await ctx.db.query.participants.findFirst({ where: eq(schema.participants.id, id) });
  if (!p) throw notFound('Участник не найден');
  if (p.status !== 'active') throw badRequest('participant_cancelled', 'Участник отменён');
  const ticket = await ctx.db.transaction(async (tx) => {
    const t = await reissueTicket(tx, id, 'reissued_by_admin');
    const recipient = p.holderUserId ?? p.ownerUserId;
    await enqueue(ctx.boss, 'tickets.send', { userId: recipient, participantIds: [id], reason: 'reissued' }, { tx });
    await audit(tx, { actorUserId: actor.user.id, action: 'ticket.reissue', entity: 'participant', entityId: id });
    return t;
  });
  return ticketView(ctx.config, ticket);
}

export async function duplicateGroups(ctx: Ctx): Promise<DuplicateGroup[]> {
  const rows = (await participantRows(ctx, sql`p.status = 'active'`)).filter((r) => r.possibleDuplicate);
  const groups = new Map<string, AdminParticipantRow[]>();
  for (const r of rows) {
    const key = personKey(r);
    const phone = (r.phone ?? '').replace(/\D/g, '').slice(-10);
    const k = rows.some((o) => o.id !== r.id && personKey(o) === key) ? key : `phone:${phone}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1).map(([key, participants]) => ({ key, participants }));
}

// ---------- выгрузки ----------

/**
 * Время для ячейки Excel. ExcelJS пишет дату как есть в UTC - в таблице было бы на 3 часа раньше.
 * Отдаём «настенное» время конференции, упакованное в UTC.
 */
export function excelTime(value: string | Date, tz: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((x) => [x.type, Number(x.value)]),
  );
  const n = (k: string) => parts[k] ?? 0;
  return new Date(Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')));
}

export function sheet(wb: ExcelJS.Workbook, name: string, columns: { header: string; key: string; width: number }[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

/**
 * Выгрузка участников (идёт в бухгалтерию): все активные и отменённые, за которых пришли деньги.
 * Отменённые без оплаты не нужны: человек отменил и зарегистрировался заново - была бы вторая строка.
 */
export async function exportParticipantsXlsx(ctx: Ctx): Promise<Buffer> {
  const [rows, settings] = await Promise.all([participantRows(ctx, sql`(p.status = 'active' or p.amount_paid > 0)`), getSettings(ctx.db)]);
  const PAYMENT_KEYS = new Set(['payment', 'amountDue', 'amountPaid', 'paymentRef', 'paymentMethod', 'sponsor']);
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Участники', [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Фамилия', key: 'lastName', width: 18 },
    { header: 'Имя', key: 'firstName', width: 14 },
    { header: 'Отчество', key: 'middleName', width: 16 },
    { header: 'Дата рождения', key: 'birthDate', width: 14 },
    { header: 'Возраст', key: 'age', width: 9 },
    { header: 'Пол', key: 'gender', width: 6 },
    { header: 'До 16', key: 'under16', width: 7 },
    { header: 'Населённый пункт', key: 'city', width: 16 },
    { header: 'Церковь', key: 'church', width: 20 },
    { header: 'Телефон', key: 'phone', width: 16 },
    { header: 'Ник Telegram', key: 'telegramUsername', width: 16 },
    { header: 'Вариант', key: 'tier', width: 22 },
    { header: 'Завтрак', key: 'breakfast', width: 9 },
    { header: 'Способ оплаты', key: 'paymentMethod', width: 14 },
    { header: 'Категория', key: 'category', width: 14 },
    { header: 'Статус', key: 'status', width: 10 },
    { header: 'Оплата', key: 'payment', width: 16 },
    { header: 'К оплате', key: 'amountDue', width: 10 },
    { header: 'Оплачено', key: 'amountPaid', width: 10 },
    { header: 'Пришёл', key: 'arrivedAt', width: 18 },
    { header: 'QR-код', key: 'ticketCode', width: 16 },
    { header: 'Аккаунт', key: 'ownerName', width: 20 },
    { header: 'Username', key: 'ownerUsername', width: 16 },
    { header: 'Код оплаты', key: 'paymentRef', width: 12 },
    { header: 'Семья', key: 'familySize', width: 7 },
    { header: 'Возможный дубль', key: 'dup', width: 10 },
    { header: 'Готов оплатить за другого', key: 'sponsor', width: 12 },
    { header: 'Короткая анкета', key: 'onSite', width: 12 },
    { header: 'Зарегистрирован', key: 'createdAt', width: 18 },
  ].filter((c) => settings.paymentsEnabled || !PAYMENT_KEYS.has(c.key)));
  for (const r of rows) {
    ws.addRow({
      ...r,
      gender: r.gender === 'm' ? 'М' : 'Ж',
      category: CATEGORY_LABELS[r.category],
      status: r.status === 'active' ? 'Активен' : 'Отменён',
      payment: PAYMENT_STATUS_LABELS[r.paymentStatus],
      under16: r.under16 ? 'да' : '',
      telegramUsername: r.telegramUsername ? `@${r.telegramUsername}` : '',
      tier: r.tier ? settings.tiers[r.tier].short : '',
      breakfast: r.breakfast ? 'да' : '',
      paymentMethod: r.paymentMethod ? REG_PAYMENT_METHOD_LABELS[r.paymentMethod] : '',
      amountDue: r.amountDue == null ? '' : Number(r.amountDue),
      amountPaid: Number(r.amountPaid),
      arrivedAt: r.arrivedAt ? excelTime(r.arrivedAt, settings.eventTimezone) : '',
      ownerUsername: r.ownerUsername ? `@${r.ownerUsername}` : '',
      dup: r.possibleDuplicate ? 'да' : '',
      sponsor: r.sponsorOffer ? 'да' : '',
      onSite: r.onSite ? 'да' : '',
      createdAt: excelTime(r.createdAt, settings.eventTimezone),
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const RECEIPT_STATUS_LABELS = { pending: 'На проверке', accepted: 'Принят', rejected: 'Отклонён' } as const;

/**
 * Чеки в Excel - только переданные (то, что отобрано фильтром или отмечено в таблице).
 * «Прислан» - дата и время по часам конференции: сверять с выпиской из банка.
 */
export async function exportReceiptsXlsx(ctx: Ctx, ids: number[]): Promise<Buffer> {
  const [receipts, settings] = await Promise.all([listReceipts(ctx, undefined, ids), getSettings(ctx.db)]);
  const tz = settings.eventTimezone;
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Чеки', [
    { header: '№ чека', key: 'id', width: 9 },
    { header: 'Сумма, руб.', key: 'amount', width: 12 },
    { header: 'Прислан', key: 'createdAt', width: 18 },
    { header: 'Кто прислал', key: 'userName', width: 24 },
    { header: 'Код оплаты', key: 'paymentRef', width: 12 },
    { header: 'Статус', key: 'status', width: 13 },
    { header: 'За кого', key: 'people', width: 36 },
    { header: 'Комментарий', key: 'comment', width: 28 },
    { header: 'Проверил', key: 'reviewerName', width: 20 },
    { header: 'Проверен', key: 'reviewedAt', width: 18 },
    { header: 'Причина отказа', key: 'rejectReason', width: 28 },
    // В конце: колонки выше привычны для сверки с выпиской.
    { header: 'Вид', key: 'kind', width: 16 },
  ]);
  ws.getColumn('amount').numFmt = '0.00';
  ws.getColumn('createdAt').numFmt = 'dd.mm.yyyy hh:mm';
  ws.getColumn('reviewedAt').numFmt = 'dd.mm.yyyy hh:mm';
  for (const r of [...receipts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    ws.addRow({
      id: r.id,
      amount: r.amount == null ? '' : Number(r.amount),
      createdAt: excelTime(r.createdAt, tz),
      userName: r.userName,
      paymentRef: r.paymentRef,
      status: RECEIPT_STATUS_LABELS[r.status],
      kind: r.kind === 'merch' ? `Мерч ${r.merchOrder?.code ?? ''}`.trim() : r.kind === 'donation' ? 'Пожертвование' : 'Взнос',
      people: r.participants.map((p) => p.fullName).join(', '),
      comment: r.comment ?? '',
      reviewerName: r.reviewerName ?? '',
      reviewedAt: r.reviewedAt ? excelTime(r.reviewedAt, tz) : '',
      rejectReason: r.rejectReason ?? '',
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const METHOD_XLSX = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' } as const;
const SOURCE_XLSX = { desk: 'Касса', receipt: 'Чек перевода', manual: 'Правка в админке', money: 'Банкир', merch: 'Мерч' } as const;
const KIND_XLSX = { fee: 'Взнос', donation: 'Пожертвование', merch: 'Мерч', income: 'Приход', payout: 'Выдача' } as const;

/** Журнал оплат в Excel: выбранные строки, по времени. `all` - журнал банкира: со всеми видами (мерч, приход, выдачи). */
export async function exportPaymentsXlsx(ctx: Ctx, ids: number[], { all = false } = {}): Promise<Buffer> {
  const [rows, settings] = await Promise.all([
    listPayments(ctx.db, { ids, ...(all ? { kinds: ['fee', 'donation', 'merch', 'income', 'payout'] as const } : {}) }),
    getSettings(ctx.db),
  ]);
  const tz = settings.eventTimezone;
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Оплаты', [
    { header: 'Время', key: 'createdAt', width: 18 },
    { header: 'Вид', key: 'kind', width: 14 },
    { header: 'Кто / кому', key: 'fullName', width: 32 },
    { header: 'Сумма, руб.', key: 'amount', width: 12 },
    { header: 'Способ', key: 'method', width: 12 },
    { header: 'Откуда', key: 'source', width: 18 },
    { header: 'Принял(а)', key: 'acceptedBy', width: 24 },
    { header: 'Чек №', key: 'receiptId', width: 8 },
    { header: 'Комментарий', key: 'comment', width: 28 },
    { header: 'Категория', key: 'category', width: 16 },
    { header: 'Отменено', key: 'undoneAt', width: 18 },
    { header: 'Причина отмены', key: 'undoReason', width: 24 },
  ]);
  ws.getColumn('amount').numFmt = '0.00';
  ws.getColumn('createdAt').numFmt = 'dd.mm.yyyy hh:mm';
  ws.getColumn('undoneAt').numFmt = 'dd.mm.yyyy hh:mm';
  for (const r of [...rows].reverse()) {
    ws.addRow({
      createdAt: excelTime(r.createdAt, tz),
      kind: KIND_XLSX[r.kind],
      fullName: r.fullName,
      comment: r.comment ?? '',
      // Выдача - со знаком минус: сумма столбца в Excel сразу даёт остаток.
      amount: r.kind === 'payout' ? -Number(r.amount) : Number(r.amount),
      method: METHOD_XLSX[r.method],
      source: SOURCE_XLSX[r.source],
      acceptedBy: r.acceptedByName ?? '',
      receiptId: r.receiptId ?? '',
      undoneAt: r.undoneAt ? excelTime(r.undoneAt, tz) : '',
      category: r.category ?? (r.merchOrderCode ? `Заказ ${r.merchOrderCode}` : ''),
      undoReason: r.undoReason ?? '',
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function exportActivityXlsx(ctx: Ctx, activityId: number): Promise<{ title: string; body: Buffer }> {
  const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, activityId) });
  if (!a) throw notFound('Активность не найдена');
  const rows = await activityRegistrations(ctx, activityId);
  const tz = (await getSettings(ctx.db)).eventTimezone;
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Записавшиеся', [
    { header: '№', key: 'n', width: 5 },
    { header: 'ФИО', key: 'fullName', width: 32 },
    { header: 'Возраст', key: 'age', width: 9 },
    { header: 'Категория', key: 'category', width: 14 },
    { header: 'Статус', key: 'status', width: 16 },
    { header: 'Время записи', key: 'queuedAt', width: 18 },
  ]);
  const statusLabel = { registered: 'Записан(а)', waitlist: 'Лист ожидания', cancelled: 'Отменил(а)' };
  rows.forEach((r, i) =>
    ws.addRow({
      n: i + 1,
      ...r,
      category: CATEGORY_LABELS[r.category],
      status: statusLabel[r.status],
      queuedAt: excelTime(r.queuedAt, tz),
    }),
  );
  return { title: a.title, body: Buffer.from(await wb.xlsx.writeBuffer()) };
}

/** Списки семинаров блока: лист на тему - тема, ведущий, зал, время и записавшиеся по порядку записи. */
export async function exportSeminarBlockXlsx(ctx: Ctx, blockId: number): Promise<{ title: string; body: Buffer }> {
  const block = await ctx.db.query.seminarBlocks.findFirst({ where: eq(schema.seminarBlocks.id, blockId) });
  if (!block) throw notFound('Блок семинаров не найден');
  const tz = (await getSettings(ctx.db)).eventTimezone;
  const topics = await ctx.db.query.activities.findMany({
    where: eq(schema.activities.blockId, blockId),
    orderBy: [schema.activities.id],
  });
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const t of topics) {
    // Имя листа в Excel: до 31 символа, без []:*?/\ и без повторов.
    const base = t.title.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Тема';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 26)} ${n}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    ws.addRow([t.title]).font = { bold: true, size: 14 };
    ws.addRow([[t.host, t.location ?? 'зал не назначен', time.format(t.startsAt)].filter(Boolean).join(' · ')]);
    ws.addRow([]);
    const header = ws.addRow(['№', 'ФИО', 'Возраст', 'Категория', 'Статус', 'Время записи']);
    header.font = { bold: true };
    ws.columns = [{ width: 5 }, { width: 34 }, { width: 9 }, { width: 14 }, { width: 14 }, { width: 18 }];
    const rows = (await activityRegistrations(ctx, t.id)).filter((r) => r.status !== 'cancelled');
    const statusLabel = { registered: 'Записан(а)', waitlist: 'Лист ожидания', cancelled: 'Отменил(а)' };
    rows.forEach((r, i) => ws.addRow([i + 1, r.fullName, r.age, CATEGORY_LABELS[r.category], statusLabel[r.status], excelTime(r.queuedAt, tz)]));
    ws.getColumn(6).numFmt = 'dd.mm.yyyy hh:mm';
  }
  if (topics.length === 0) wb.addWorksheet('Пусто').addRow(['В блоке пока нет тем']);
  return { title: block.title, body: Buffer.from(await wb.xlsx.writeBuffer()) };
}

// ---------- точки отметки ----------

export async function createCheckpoint(ctx: Ctx, input: CheckpointInput, actor: StaffPrincipal): Promise<CheckpointView> {
  const [row] = await ctx.db
    .insert(schema.checkpoints)
    .values({
      kind: input.kind,
      name: input.name,
      activityId: input.activityId ?? null,
      day: input.day ?? null,
      isActive: input.isActive,
      countsInStats: input.kind !== 'training',
    })
    .returning();
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'checkpoint.create', entity: 'checkpoint', entityId: row!.id, after: row });
  return toCheckpointView(row!);
}

/** Дни конференции по часам события: `YYYY-MM-DD` от начала до конца включительно. */
export function eventDays(settings: Settings): string[] {
  if (!settings.eventStartsAt || !settings.eventEndsAt) return [];
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: settings.eventTimezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Set<string>();
  const end = new Date(settings.eventEndsAt).getTime();
  // Шаг - 6 часов: ни один календарный день не проскочим даже при переводе часов.
  for (let t = new Date(settings.eventStartsAt).getTime(); t <= end; t += 6 * 3600_000) days.add(fmt.format(new Date(t)));
  days.add(fmt.format(new Date(end)));
  return [...days].sort();
}

/**
 * Точка входа на каждый день конференции. Отметка разрешена одна на точку, поэтому с одной общей точкой
 * на 2-й день все были бы «Уже отмечен». Сканер сам берёт точку сегодняшнего дня. Уже созданные дни не дублирует.
 */
export async function ensureDailyEntrances(ctx: Ctx, actor: StaffPrincipal): Promise<CheckpointView[]> {
  const settings = await getSettings(ctx.db);
  const days = eventDays(settings);
  if (days.length === 0) throw badRequest('no_event_dates', 'Сначала укажите в «Настройках» начало и конец конференции');
  const existing = await ctx.db.query.checkpoints.findMany({ where: eq(schema.checkpoints.kind, 'entrance') });
  const label = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' });
  for (const day of days) {
    if (existing.some((c) => c.day === day)) continue;
    await createCheckpoint(ctx, { kind: 'entrance', name: `Вход · ${label.format(new Date(`${day}T12:00:00Z`))}`, day, isActive: true }, actor);
  }
  const all = await ctx.db.query.checkpoints.findMany({ orderBy: [schema.checkpoints.id] });
  return all.map(toCheckpointView);
}

export async function updateCheckpoint(
  ctx: Ctx,
  id: number,
  input: Partial<CheckpointInput>,
  actor: StaffPrincipal,
): Promise<CheckpointView> {
  const [row] = await ctx.db
    .update(schema.checkpoints)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.day !== undefined && { day: input.day ?? null }),
      ...(input.kind !== undefined && { kind: input.kind, countsInStats: input.kind !== 'training' }),
    })
    .where(eq(schema.checkpoints.id, id))
    .returning();
  if (!row) throw notFound('Точка не найдена');
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'checkpoint.update', entity: 'checkpoint', entityId: id, after: input });
  return toCheckpointView(row);
}
