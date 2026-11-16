import {
  ageOrNull,
  fullName,
  hasPermission,
  parseTicketCode,
  type Category,
  type CheckInEvent,
  type CheckInInfo,
  type CheckInOutcome,
  type CheckInResult,
  type CheckpointKind,
  type CheckpointView,
  type LookupRequest,
  type LookupResponse,
  type ManifestResponse,
  type ParticipantCard,
  type PaymentFindRequest,
  type PaymentFindResponse,
  type ParticipantStatus,
  type PaymentStatus,
  type Settings,
  type StaffRecentScan,
  type StaffStats,
} from '@sof/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { codeHash } from '../lib/crypto.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import { effectiveAllowUnpaid, eventDayKey, getSettings, isBeforeEvent } from './settings.service.ts';
import { ageRefDate, asTier, isUnder16, tiersVersion } from './tiers.ts';

type ParticipantRow = typeof schema.participants.$inferSelect;
type Ctx = Pick<AppContext, 'db' | 'boss' | 'config'>;

const PAID: readonly string[] = ['paid', 'exempt'];
/** На вход пускаем и с чеком на проверке: чек прислали - проверим после конференции. */
const ENTRY_OK: readonly string[] = [...PAID, 'pending'];

// ---------- точки ----------

export function toCheckpointView(c: typeof schema.checkpoints.$inferSelect): CheckpointView {
  return {
    id: c.id,
    kind: c.kind as CheckpointKind,
    name: c.name,
    activityId: c.activityId,
    day: c.day,
    isActive: c.isActive,
    countsInStats: c.countsInStats,
  };
}

export async function listCheckpoints(db: DbLike, opts: { activeOnly?: boolean } = {}): Promise<CheckpointView[]> {
  const rows = await db.query.checkpoints.findMany({
    where: opts.activeOnly ? eq(schema.checkpoints.isActive, true) : undefined,
    orderBy: [asc(schema.checkpoints.id)],
  });
  return rows.map(toCheckpointView);
}

// ---------- карточки ----------

async function checkInInfos(
  db: DbLike,
  checkpointId: number,
  participantIds: number[],
): Promise<Map<number, CheckInInfo>> {
  const map = new Map<number, CheckInInfo>();
  if (participantIds.length === 0) return map;
  const rows = await db
    .select({ checkIn: schema.checkIns, scanner: schema.users })
    .from(schema.checkIns)
    .innerJoin(schema.users, eq(schema.users.id, schema.checkIns.scannedBy))
    .where(
      and(
        eq(schema.checkIns.checkpointId, checkpointId),
        inArray(schema.checkIns.participantId, participantIds),
        sql`${schema.checkIns.revokedAt} is null`,
      ),
    );
  for (const r of rows) {
    map.set(r.checkIn.participantId, {
      id: r.checkIn.id,
      at: r.checkIn.createdAt.toISOString(),
      byName: userDisplayName(r.scanner),
    });
  }
  return map;
}

function toCard(p: ParticipantRow, checkIn: CheckInInfo | null, settings: Settings): ParticipantCard {
  return {
    id: p.id,
    fullName: fullName(p),
    birthDate: p.birthDate,
    age: ageOrNull(p.birthDate),
    category: p.category as Category,
    status: p.status as ParticipantStatus,
    paymentStatus: p.paymentStatus as PaymentStatus,
    tier: asTier(p.tier),
    breakfast: p.breakfast,
    amountDue: p.amountDue,
    amountPaid: p.amountPaid,
    under16: isUnder16(settings, p.birthDate),
    familyId: p.ownerUserId,
    checkIn,
  };
}

async function logScan(
  db: DbLike,
  e: {
    clientEventId?: string | null;
    checkpointId: number | null;
    rawCode?: string | null;
    participantId?: number | null;
    outcome: string;
    staffUserId: number;
    deviceId?: string | null;
    clientTs?: string | null;
  },
) {
  await db.insert(schema.scanLog).values({
    clientEventId: e.clientEventId ?? null,
    checkpointId: e.checkpointId,
    rawCode: e.rawCode?.slice(0, 200) ?? null,
    participantId: e.participantId ?? null,
    outcome: e.outcome,
    staffUserId: e.staffUserId,
    deviceId: e.deviceId ?? null,
    clientTs: e.clientTs ? new Date(e.clientTs) : null,
  });
}

type Resolved =
  | { kind: 'invalid'; raw: string }
  | { kind: 'unknown'; canonical: string }
  | { kind: 'ticket'; canonical: string; codeStatus: 'active' | 'revoked'; participant: ParticipantRow | undefined; participantId: number }
  | { kind: 'by_id'; participant: ParticipantRow | undefined };

/** Код из QR (или id из поиска) → участник. Ничего не пишет - журналирует вызывающий. */
async function resolveSubject(db: DbLike, code: string | null | undefined, participantId: number | null | undefined): Promise<Resolved> {
  if (code) {
    const canonical = parseTicketCode(code);
    if (!canonical) return { kind: 'invalid', raw: code };
    const ticket = await db.query.tickets.findFirst({ where: eq(schema.tickets.code, canonical) });
    if (!ticket) return { kind: 'unknown', canonical };
    const participant = await db.query.participants.findFirst({ where: eq(schema.participants.id, ticket.participantId) });
    return { kind: 'ticket', canonical, codeStatus: ticket.status as 'active' | 'revoked', participant, participantId: ticket.participantId };
  }
  const participant = participantId
    ? await db.query.participants.findFirst({ where: eq(schema.participants.id, participantId) })
    : undefined;
  return { kind: 'by_id', participant };
}

/** Остальные активные люди того же аккаунта (записаны вместе). */
async function familyOf(db: DbLike, p: ParticipantRow): Promise<ParticipantRow[]> {
  return db.query.participants.findMany({
    where: and(
      eq(schema.participants.ownerUserId, p.ownerUserId),
      eq(schema.participants.status, 'active'),
      sql`${schema.participants.id} <> ${p.id}`,
    ),
    orderBy: [asc(schema.participants.id)],
  });
}

/** Карточка по отсканированному коду или по id (ручной поиск), вместе с семьёй. Неудачные сканы - в журнал входа. */
export async function lookup(ctx: Ctx, staff: StaffPrincipal, req: LookupRequest): Promise<LookupResponse> {
  const settings = await getSettings(ctx.db);
  const r = await resolveSubject(ctx.db, req.code, req.participantId);
  const base = { checkpointId: req.checkpointId, staffUserId: staff.user.id };
  if (r.kind === 'invalid') {
    await logScan(ctx.db, { ...base, rawCode: r.raw, outcome: 'invalid_code' });
    return { found: false, reason: 'invalid_code' };
  }
  if (r.kind === 'unknown') {
    await logScan(ctx.db, { ...base, rawCode: r.canonical, outcome: 'unknown_code' });
    return { found: false, reason: 'unknown_code' };
  }
  if (r.kind === 'ticket' && r.codeStatus === 'revoked') {
    await logScan(ctx.db, { ...base, rawCode: r.canonical, participantId: r.participantId, outcome: 'revoked_ticket' });
  }
  const participant = r.participant;
  if (!participant) return { found: false, reason: 'not_found' };

  const family = await familyOf(ctx.db, participant);
  const infos = await checkInInfos(ctx.db, req.checkpointId, [participant.id, ...family.map((f) => f.id)]);
  return {
    found: true,
    codeStatus: r.kind === 'ticket' ? r.codeStatus : 'by_id',
    card: toCard(participant, infos.get(participant.id) ?? null, settings),
    family: family.map((f) => toCard(f, infos.get(f.id) ?? null, settings)),
    paymentsEnabled: settings.paymentsEnabled,
    allowUnpaidEntry: effectiveAllowUnpaid(settings),
    tiers: settings.tiers,
  };
}

/**
 * Касса: человек по QR-коду (или id) вместе с семьёй - только для оплаты.
 * Ничего не пишет в журнал сканов и не трогает отметки входа: QR-код остаётся просто ссылкой на человека.
 */
export async function findForPayment(db: DbLike, req: PaymentFindRequest): Promise<PaymentFindResponse> {
  const settings = await getSettings(db);
  const r = await resolveSubject(db, req.code, req.participantId);
  if (r.kind === 'invalid') return { found: false, reason: 'invalid_code' };
  if (r.kind === 'unknown') return { found: false, reason: 'unknown_code' };
  const participant = r.participant;
  if (!participant) return { found: false, reason: 'not_found' };
  const family = await familyOf(db, participant);
  return {
    found: true,
    codeStatus: r.kind === 'ticket' ? r.codeStatus : 'by_id',
    card: toCard(participant, null, settings),
    family: family.map((f) => toCard(f, null, settings)),
    tiers: settings.tiers,
  };
}

// ---------- отметки ----------

type CheckInRow = {
  outcome: 'new' | 'retry' | 'event_id_reused' | 'duplicate';
  check_in_id: string;
  checked_at: Date;
  by_staff: string;
  revoked: boolean;
};

async function staffName(db: DbLike, userId: number): Promise<string> {
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  return u ? userDisplayName(u) : '-';
}

async function processOne(
  ctx: Ctx,
  staff: StaffPrincipal,
  ev: CheckInEvent,
  settings: Settings,
  checkpoints: Map<number, typeof schema.checkpoints.$inferSelect>,
): Promise<CheckInResult> {
  const reply = (outcome: CheckInOutcome, extra: Partial<CheckInResult> = {}): CheckInResult => ({
    clientEventId: ev.clientEventId,
    outcome,
    checkInId: null,
    checkedAt: null,
    byName: null,
    ...extra,
  });
  // Человек мог быть удалён (очистка базы), а событие ждало в офлайн-очереди: ссылку на него
  // в журнал не пишем, иначе внешний ключ уронит всю пачку и очередь устройства встанет.
  const subject = await ctx.db.query.participants.findFirst({ where: eq(schema.participants.id, ev.participantId) });
  const log = (outcome: string, participantId: number | null = subject ? ev.participantId : null) =>
    logScan(ctx.db, {
      clientEventId: ev.clientEventId,
      checkpointId: checkpoints.has(ev.checkpointId) ? ev.checkpointId : null,
      rawCode: ev.code ?? null,
      participantId,
      outcome,
      staffUserId: staff.user.id,
      deviceId: ev.deviceId,
      clientTs: ev.clientTs,
    });

  // Повтор уже записанного события отвечаем как повтор, даже если с тех пор что-то поменялось.
  const already = await ctx.db.query.checkIns.findFirst({ where: eq(schema.checkIns.clientEventId, ev.clientEventId) });

  const cp = checkpoints.get(ev.checkpointId);
  // Кассир или админ пропустил без подтверждённой оплаты - это пишем в журнал действий.
  let overrodeUnpaid = false;
  if (!already) {
    if (!cp || !cp.isActive) {
      await log('checkpoint_inactive');
      return reply('checkpoint_inactive');
    }
    // До начала конференции вход не отмечаем (сканирование в это время - про оплату).
    // Защита и от старых версий приложения, и от отметок, накопленных без связи.
    if (cp.kind === 'entrance' && isBeforeEvent(settings)) {
      await log('before_event');
      return reply('before_event');
    }
    if (!hasPermission(staff.roles, 'checkin:write')) {
      // Организатор отмечает только на точках своих активностей.
      const act = cp.activityId
        ? await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, cp.activityId) })
        : undefined;
      if (!act || act.createdBy !== staff.user.id) {
        await log('forbidden');
        return reply('forbidden');
      }
    }
    if (ev.code) {
      const canonical = parseTicketCode(ev.code);
      const ticket = canonical
        ? await ctx.db.query.tickets.findFirst({ where: eq(schema.tickets.code, canonical) })
        : undefined;
      if (!ticket || ticket.participantId !== ev.participantId) {
        await log('not_found');
        return reply('not_found');
      }
      if (ticket.status !== 'active') {
        await log('revoked_ticket');
        return reply('revoked_ticket');
      }
    }
    const p = subject;
    if (!p) {
      await log('not_found', null);
      return reply('not_found');
    }
    if (p.status !== 'active') {
      await log('cancelled_participant');
      return reply('cancelled_participant');
    }
    const override = ev.overrideUnpaid && hasPermission(staff.roles, 'payments:write');
    let unpaidEntrance = cp.kind === 'entrance' && !effectiveAllowUnpaid(settings) && !ENTRY_OK.includes(p.paymentStatus);
    if (unpaidEntrance) {
      // Уже отмечен здесь (например, кассир пропустил без оплаты) - повторный скан это «уже отмечен», а не «на кассу».
      const [mark] = await ctx.db
        .select({ id: schema.checkIns.id })
        .from(schema.checkIns)
        .where(
          and(eq(schema.checkIns.checkpointId, cp.id), eq(schema.checkIns.participantId, p.id), sql`${schema.checkIns.revokedAt} is null`),
        )
        .limit(1);
      if (mark) unpaidEntrance = false;
    }
    if (unpaidEntrance && !override) {
      await log('unpaid');
      return reply('unpaid');
    }
    overrodeUnpaid = unpaidEntrance;
  }

  // Уже записанное событие при удалённом человеке - просто повтор, без новой отметки.
  if (!subject) {
    await log('not_found', null);
    return reply('not_found');
  }
  const firstArrival = cp?.kind === 'entrance' && cp.countsInStats && !already ? subject.arrivedAt == null : false;

  const res = await ctx.db.execute<CheckInRow>(sql`
    select * from check_in(
      ${ev.clientEventId}::uuid, ${ev.checkpointId}::int, ${ev.participantId}::bigint, ${staff.user.id}::bigint,
      ${ev.deviceId}, ${ev.clientTs}::timestamptz, ${ev.method}, ${ev.offline}
    )`);
  const row = res.rows[0]!;
  if (row.outcome === 'retry' && row.revoked) {
    // Повтор события, которое уже отменили, - не «отмечен»: человек на входе не отмечен.
    await log('check_in_undone');
    return reply('check_in_undone');
  }
  await log(row.outcome);
  if (row.outcome === 'new' && overrodeUnpaid) {
    await audit(ctx.db, {
      actorUserId: staff.user.id,
      action: 'checkin.override_unpaid',
      entity: 'participant',
      entityId: ev.participantId,
      after: { paymentStatus: subject.paymentStatus, checkpointId: ev.checkpointId, checkInId: Number(row.check_in_id) },
    });
  }

  if (row.outcome === 'new' && firstArrival) {
    await enqueue(ctx.boss, 'checkin.welcome', { participantId: ev.participantId }, { singletonKey: `welcome:${ev.participantId}` });
  }
  const byStaff = Number(row.by_staff);
  return reply(row.outcome, {
    checkInId: Number(row.check_in_id),
    checkedAt: new Date(row.checked_at).toISOString(),
    byName: byStaff === staff.user.id ? staff.name : await staffName(ctx.db, byStaff),
  });
}

/** Пачка отметок (онлайн - по одной, из офлайн-очереди - пачкой). Ответ на каждую. */
export async function processCheckIns(ctx: Ctx, staff: StaffPrincipal, events: CheckInEvent[]): Promise<CheckInResult[]> {
  const settings = await getSettings(ctx.db);
  const cps = await ctx.db.query.checkpoints.findMany();
  const byId = new Map(cps.map((c) => [c.id, c]));
  const results: CheckInResult[] = [];
  for (const ev of events) results.push(await processOne(ctx, staff, redirectOfflineEntrance(ev, byId, settings), settings, byId));
  return results;
}

/**
 * Отметка, сделанная без связи на вход, который потом выключили (перешли на входы по дням, пока сканер
 * был офлайн), - на включённый вход того же дня. Иначе сервер отклонил бы её и человек пропал бы из пришедших.
 */
function redirectOfflineEntrance(
  ev: CheckInEvent,
  byId: Map<number, typeof schema.checkpoints.$inferSelect>,
  settings: Settings,
): CheckInEvent {
  const cp = byId.get(ev.checkpointId);
  if (!ev.offline || !cp || cp.isActive || cp.kind !== 'entrance') return ev;
  const day = eventDayKey(ev.clientTs ? new Date(ev.clientTs) : new Date(), settings.eventTimezone);
  const active = [...byId.values()].filter((c) => c.kind === 'entrance' && c.isActive);
  const target = active.find((c) => c.day === day) ?? active.find((c) => c.day === null);
  return target ? { ...ev, checkpointId: target.id } : ev;
}

/**
 * Мягкая отмена. Сканер может отменить только свою отметку в течение 10 минут
 * (ошибся человеком), остальное - админ.
 */
export async function revokeCheckIn(ctx: Pick<AppContext, 'db'>, staff: StaffPrincipal, checkInId: number): Promise<void> {
  const ci = await ctx.db.query.checkIns.findFirst({ where: eq(schema.checkIns.id, checkInId) });
  if (!ci) throw notFound('Отметка не найдена');
  const own = ci.scannedBy === staff.user.id && Date.now() - ci.createdAt.getTime() < 10 * 60_000;
  if (!hasPermission(staff.roles, 'checkin:revoke') && !own) {
    throw forbidden('Отменить можно только свою отметку в течение 10 минут');
  }
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select revoke_check_in(${checkInId}::bigint, ${staff.user.id}::bigint)`);
    await audit(tx, { actorUserId: staff.user.id, action: 'checkin.revoke', entity: 'check_in', entityId: checkInId, before: ci });
  });
}

/**
 * Отмена по номеру события: сканер нажал «Отменить», когда отметка ещё числилась в офлайн-очереди,
 * но запрос до этого мог дойти до сервера (тайм-аут). Нет такой отметки - ничего не делаем.
 */
export async function revokeCheckInByEvent(ctx: Pick<AppContext, 'db'>, staff: StaffPrincipal, clientEventId: string): Promise<{ revoked: boolean }> {
  const ci = await ctx.db.query.checkIns.findFirst({ where: eq(schema.checkIns.clientEventId, clientEventId) });
  if (!ci || ci.revokedAt) return { revoked: false };
  await revokeCheckIn(ctx, staff, ci.id);
  return { revoked: true };
}

// ---------- локальная база сканера ----------

let manifestCache: { version: string; body: ManifestResponse } | null = null;

/** Формат базы сканера: сменился - телефоны перекачают её целиком (f2: возраст вместо даты рождения; f3: завтрак). */
const MANIFEST_FORMAT = 'f3';

export async function manifestVersion(db: DbLike): Promise<string> {
  const settings = await getSettings(db);
  const res = await db.execute<{ v: string }>(sql`
    select md5(concat_ws('|',
      (select coalesce(max(updated_at)::text, '') || ':' || count(*) from participants),
      (select coalesce(max(greatest(created_at, coalesce(revoked_at, created_at)))::text, '') || ':' || count(*) from tickets),
      (select coalesce(max(greatest(created_at, coalesce(revoked_at, created_at)))::text, '') || ':' || count(*) from check_ins),
      (select coalesce(max(created_at)::text, '') || ':' || count(*) || ':' || count(*) filter (where is_active) from checkpoints),
      ${`${MANIFEST_FORMAT}p${settings.paymentsEnabled ? 1 : 0}u${settings.allowUnpaidEntry ? 1 : 0}t${tiersVersion(settings)}a${ageRefDate(settings)}`}::text
    )) as v`);
  return res.rows[0]!.v;
}

export async function buildManifest(ctx: Ctx): Promise<ManifestResponse> {
  const version = await manifestVersion(ctx.db);
  if (manifestCache?.version === version) return manifestCache.body;

  const settings = await getSettings(ctx.db);
  const salt = ctx.config.CODE_HASH_SALT;
  const [people, codes, checks] = await Promise.all([
    ctx.db.query.participants.findMany({ where: eq(schema.participants.status, 'active') }),
    ctx.db
      .select({ code: schema.tickets.code, pid: schema.tickets.participantId, st: schema.tickets.status })
      .from(schema.tickets),
    ctx.db
      .select({ checkIn: schema.checkIns, scanner: schema.users })
      .from(schema.checkIns)
      .innerJoin(schema.users, eq(schema.users.id, schema.checkIns.scannedBy))
      .innerJoin(schema.checkpoints, eq(schema.checkpoints.id, schema.checkIns.checkpointId))
      .where(and(sql`${schema.checkIns.revokedAt} is null`, eq(schema.checkpoints.isActive, true))),
  ]);
  const body: ManifestResponse = {
    version,
    generatedAt: new Date().toISOString(),
    salt,
    codes: codes.map((c) => ({ h: codeHash(salt, c.code), pid: c.pid, st: c.st as 'active' | 'revoked' })),
    participants: people.map((p) => ({
      id: p.id,
      fullName: fullName(p),
      age: ageOrNull(p.birthDate),
      under16: isUnder16(settings, p.birthDate),
      category: p.category as Category,
      status: p.status as ParticipantStatus,
      paymentStatus: p.paymentStatus as PaymentStatus,
      tier: asTier(p.tier),
      breakfast: p.breakfast,
      amountDue: p.amountDue,
      familyId: p.ownerUserId,
    })),
    checkIns: checks.map((r) => ({
      checkpointId: r.checkIn.checkpointId,
      participantId: r.checkIn.participantId,
      at: r.checkIn.createdAt.toISOString(),
      byName: userDisplayName(r.scanner),
    })),
    paymentsEnabled: settings.paymentsEnabled,
    allowUnpaidEntry: effectiveAllowUnpaid(settings),
    eventTimezone: settings.eventTimezone,
    tiers: settings.tiers,
    ageOn: ageRefDate(settings),
  };
  manifestCache = { version, body };
  return body;
}

// ---------- ручной поиск и статистика ----------

/** checkpointId не задан - без отметок (запись на семинар волонтёром). */
export async function searchParticipants(db: DbLike, q: string, checkpointId: number | null): Promise<ParticipantCard[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const code = parseTicketCode(query);
  let rows: ParticipantRow[];
  if (code) {
    const t = await db.query.tickets.findFirst({ where: eq(schema.tickets.code, code) });
    rows = t ? await db.query.participants.findMany({ where: eq(schema.participants.id, t.participantId) }) : [];
  } else {
    const digits = query.replace(/\D/g, '');
    const words = query
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/\s+/)
      // Слово из ФИО - где есть буквы; «+375», «29», «750-32-91» - куски телефона, их ищем по цифрам ниже.
      .filter((w) => /\p{L}/u.test(w));
    const conds = words.map((w) => {
      const like = `${w.replace(/[%_\\]/g, '')}%`;
      return sql`(replace(lower(${schema.participants.lastName}), 'ё', 'е') like ${like}
        or replace(lower(${schema.participants.firstName}), 'ё', 'е') like ${like}
        or replace(lower(coalesce(${schema.participants.middleName}, '')), 'ё', 'е') like ${like})`;
    });
    if (digits.length >= 4) {
      conds.push(sql`regexp_replace(coalesce(${schema.participants.phone}, ''), '\D', '', 'g') like ${`%${digits}%`}`);
    }
    if (conds.length === 0) return [];
    rows = await db.query.participants.findMany({
      where: sql.join(conds, sql` and `),
      orderBy: [asc(schema.participants.lastName), asc(schema.participants.firstName)],
      limit: 20,
    });
  }
  const [infos, settings] = await Promise.all([
    checkpointId ? checkInInfos(db, checkpointId, rows.map((r) => r.id)) : new Map<number, CheckInInfo>(),
    getSettings(db),
  ]);
  return rows.map((r) => toCard(r, infos.get(r.id) ?? null, settings));
}

/** История сканера: мои последние сканы на точке, включая неудачные. Хранится на сервере - не пропадает при закрытии. */
export async function staffRecent(db: DbLike, checkpointId: number, staffUserId: number, limit = 10): Promise<StaffRecentScan[]> {
  const res = await db.execute<{
    id: string;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    tier: string | null;
    breakfast: boolean | null;
    outcome: string;
    revoked: boolean;
    created_at: Date;
    check_in_id: string | null;
    can_undo: boolean;
  }>(sql`
    select sl.id, p.last_name, p.first_name, p.middle_name, p.tier, p.breakfast, sl.outcome, sl.created_at,
           coalesce(ci.revoked_at is not null, false) as revoked,
           ci.id as check_in_id,
           (ci.id is not null and ci.revoked_at is null and ci.scanned_by = ${staffUserId}
             and ci.created_at > now() - interval '10 minutes'
             and sl.outcome in ('new', 'retry')) as can_undo
      from scan_log sl
      left join participants p on p.id = sl.participant_id
      left join check_ins ci on ci.client_event_id = sl.client_event_id
     where sl.staff_user_id = ${staffUserId} and (sl.checkpoint_id = ${checkpointId} or sl.checkpoint_id is null)
     order by sl.created_at desc, sl.id desc
     limit ${limit}`);
  return res.rows.map((r) => ({
    id: Number(r.id),
    fullName: r.last_name ? fullName({ lastName: r.last_name, firstName: r.first_name ?? '', middleName: r.middle_name }) : null,
    tier: asTier(r.tier),
    breakfast: r.breakfast ?? false,
    outcome: r.outcome,
    revoked: r.revoked,
    at: new Date(r.created_at).toISOString(),
    checkInId: r.check_in_id == null ? null : Number(r.check_in_id),
    canUndo: r.can_undo,
  }));
}

export async function staffStats(db: DbLike, checkpointId: number, staffUserId: number): Promise<StaffStats> {
  const cp = await db.query.checkpoints.findFirst({ where: eq(schema.checkpoints.id, checkpointId) });
  if (!cp) throw notFound('Точка не найдена');
  const res = await db.execute<{ checked_in: number; last_hour: number; by_me: number }>(sql`
    select count(*)::int as checked_in,
           count(*) filter (where created_at > now() - interval '1 hour')::int as last_hour,
           count(*) filter (where scanned_by = ${staffUserId})::int as by_me
      from check_ins where checkpoint_id = ${checkpointId} and revoked_at is null`);
  let expected: number;
  if (cp.kind === 'activity' && cp.activityId) {
    const r = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from activity_registrations where activity_id = ${cp.activityId} and status = 'registered'`);
    expected = r.rows[0]?.n ?? 0;
  } else {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from participants where status = 'active'`);
    expected = r.rows[0]?.n ?? 0;
  }
  const s = res.rows[0]!;
  return { checkpointId, checkedIn: s.checked_in, expected, lastHour: s.last_hour, byMe: s.by_me };
}
