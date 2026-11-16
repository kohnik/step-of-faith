import {
  ageOrNull,
  fullName,
  hasPermission,
  type ActivityInput,
  type ActivityKind,
  type ActivityConflict,
  type ActivityRegisterOutcome,
  type ActivityRegisterResponse,
  type ActivitySwitchResponse,
  type ActivityRegistrationRow,
  type ActivityStatus,
  type Meal,
  type ActivityUpdate,
  type ActivityView,
  type Category,
  type CheckpointView,
  type RegistrationMode,
  type StaffEnrollResponse,
} from '@sof/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { esc, fmtDateTime } from '../bot/format.ts';
import { toCheckpointView } from './checkin.service.ts';
import { getSettings } from './settings.service.ts';
import { activeFamilyIds, assertFamilyMember } from './registration.service.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import type { UserRow } from './users.service.ts';

type ActivityRow = typeof schema.activities.$inferSelect;
type Ctx = Pick<AppContext, 'db' | 'boss'>;

interface Counts {
  registered: number;
  waitlist: number;
  interest: number;
}

type BlockRow = typeof schema.seminarBlocks.$inferSelect;

function toView(
  a: ActivityRow,
  counts: Counts,
  my: ActivityView['my'] = [],
  myInterest = false,
  block: BlockRow | null = null,
  forParticipant = false,
): ActivityView {
  // Тема семинара: до публикации залов участник зала не видит - его раздадут по числу записавшихся.
  const hideRoom = forParticipant && block !== null && !block.roomsPublishedAt;
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    location: hideRoom ? null : a.location,
    host: a.host,
    kind: a.kind as ActivityKind,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    registrationMode: a.registrationMode as RegistrationMode,
    capacity: a.capacity,
    registeredCount: counts.registered,
    waitlistCount: counts.waitlist,
    waitlistEnabled: a.waitlistEnabled,
    registrationOpensAt: a.registrationOpensAt?.toISOString() ?? null,
    registrationClosesAt: a.registrationClosesAt?.toISOString() ?? null,
    minAge: a.minAge,
    maxAge: a.maxAge,
    status: a.status as ActivityStatus,
    meal: (a.meal as Meal | null) ?? null,
    interestCount: counts.interest,
    createdBy: a.createdBy,
    roomId: hideRoom ? null : a.roomId,
    block: block
      ? { id: block.id, title: block.title, registrationOpen: block.registrationOpen, roomsPublished: block.roomsPublishedAt !== null }
      : null,
    my,
    myInterest,
  };
}

async function countsFor(db: DbLike, ids: number[]): Promise<Map<number, Counts>> {
  const map = new Map<number, Counts>();
  if (ids.length === 0) return map;
  const rows = await db.execute<{ id: string; registered: number; waitlist: number; interest: number }>(sql`
    select a.id,
      (select count(*) from activity_registrations r where r.activity_id = a.id and r.status = 'registered')::int as registered,
      (select count(*) from activity_registrations r where r.activity_id = a.id and r.status = 'waitlist')::int as waitlist,
      (select count(*) from activity_interest i where i.activity_id = a.id)::int as interest
    from activities a where a.id in ${sql.raw(`(${ids.map(Number).join(',')})`)}`);
  for (const r of rows.rows) map.set(Number(r.id), { registered: r.registered, waitlist: r.waitlist, interest: r.interest });
  return map;
}

export async function listActivities(
  ctx: Pick<AppContext, 'db'>,
  opts: { userId?: number; includeDrafts?: boolean; createdBy?: number; ids?: number[] } = {},
): Promise<ActivityView[]> {
  const conds = [];
  if (!opts.includeDrafts) {
    conds.push(sql`${schema.activities.status} <> 'draft'`);
    // Темы скрытого блока семинаров участникам не показываем (их собственный статус не трогаем).
    conds.push(
      sql`(${schema.activities.blockId} is null or ${schema.activities.blockId} not in (select id from seminar_blocks where hidden))`,
    );
  }
  if (opts.createdBy) conds.push(eq(schema.activities.createdBy, opts.createdBy));
  if (opts.ids) conds.push(inArray(schema.activities.id, opts.ids.length ? opts.ids : [-1]));
  const rows = await ctx.db.query.activities.findMany({
    where: conds.length ? and(...conds) : undefined,
    orderBy: (a, { asc }) => [asc(a.startsAt), asc(a.id)],
  });
  const counts = await countsFor(ctx.db, rows.map((r) => r.id));

  const my = new Map<number, ActivityView['my']>();
  const interest = new Set<number>();
  if (opts.userId) {
    const family = await activeFamilyIds(ctx, [opts.userId]);
    if (family.length) {
      const regs = await ctx.db
        .select()
        .from(schema.activityRegistrations)
        .where(
          and(
            inArray(schema.activityRegistrations.participantId, family),
            sql`${schema.activityRegistrations.status} in ('registered', 'waitlist')`,
          ),
        );
      for (const r of regs) {
        const list = my.get(r.activityId) ?? [];
        list.push({ participantId: r.participantId, status: r.status as 'registered' | 'waitlist' });
        my.set(r.activityId, list);
      }
    }
    const ints = await ctx.db
      .select({ activityId: schema.activityInterest.activityId })
      .from(schema.activityInterest)
      .where(eq(schema.activityInterest.userId, opts.userId));
    for (const i of ints) interest.add(i.activityId);
  }
  const blockIds = [...new Set(rows.map((r) => r.blockId).filter((b): b is number => b !== null))];
  const blocks = new Map<number, BlockRow>();
  if (blockIds.length) {
    for (const b of await ctx.db.query.seminarBlocks.findMany({ where: inArray(schema.seminarBlocks.id, blockIds) })) blocks.set(b.id, b);
  }
  return rows.map((a) =>
    toView(
      a,
      counts.get(a.id) ?? { registered: 0, waitlist: 0, interest: 0 },
      my.get(a.id) ?? [],
      interest.has(a.id),
      a.blockId ? (blocks.get(a.blockId) ?? null) : null,
      opts.userId !== undefined,
    ),
  );
}

/** Зал из справочника по названию места - чтобы мероприятие попало в колонку зала. */
export async function roomIdByName(db: DbLike, location: string | null | undefined): Promise<number | null> {
  const name = location?.trim();
  if (!name) return null;
  const room = await db.query.rooms.findFirst({ where: sql`lower(${schema.rooms.name}) = ${name.toLowerCase()}` });
  return room?.id ?? null;
}

/** Открыта ли запись. На семинары сами не записываются: выбирают темы, а по сеансам ставит распределение. */
async function signupOpen(ctx: Pick<AppContext, 'db'>, activityId: number): Promise<boolean> {
  const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, activityId) });
  if (a?.blockId) return false;
  return (await getSettings(ctx.db)).activityRegistrationOpen;
}

/** userId - запрос участника: скрытое (черновик) ему не показываем, даже по прямому id. */
export async function getActivityView(ctx: Pick<AppContext, 'db'>, id: number, userId?: number): Promise<ActivityView> {
  const [view] = await listActivities(ctx, { ids: [id], includeDrafts: userId === undefined, userId });
  if (!view) throw notFound('Активность не найдена');
  return view;
}

function validateTimes(a: { startsAt: string | Date; endsAt: string | Date; minAge?: number | null; maxAge?: number | null }) {
  if (new Date(a.endsAt) < new Date(a.startsAt)) throw badRequest('invalid_time', 'Окончание раньше начала');
  if (a.minAge != null && a.maxAge != null && a.minAge > a.maxAge) {
    throw badRequest('invalid_age', 'Минимальный возраст больше максимального');
  }
}

export async function scheduleReminder(ctx: Ctx, a: ActivityRow): Promise<void> {
  if (a.status !== 'published') return;
  const at = new Date(a.startsAt.getTime() - 15 * 60_000);
  if (at.getTime() <= Date.now()) return;
  await enqueue(
    ctx.boss,
    'activity.reminder',
    { activityId: a.id, startsAt: a.startsAt.toISOString() },
    { startAfter: at, singletonKey: `reminder:${a.id}:${a.startsAt.toISOString()}` },
  );
}

export async function createActivity(ctx: Ctx, input: ActivityInput, actor: StaffPrincipal): Promise<ActivityView> {
  validateTimes(input);
  const [row] = await ctx.db
    .insert(schema.activities)
    .values({
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      host: input.host ?? null,
      kind: input.kind,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      registrationMode: input.registrationMode,
      capacity: input.registrationMode === 'required' ? (input.capacity ?? null) : null,
      waitlistEnabled: input.waitlistEnabled,
      registrationOpensAt: input.registrationOpensAt ? new Date(input.registrationOpensAt) : null,
      registrationClosesAt: input.registrationClosesAt ? new Date(input.registrationClosesAt) : null,
      minAge: input.minAge ?? null,
      maxAge: input.maxAge ?? null,
      status: input.status,
      meal: input.meal ?? null,
      roomId: await roomIdByName(ctx.db, input.location),
      createdBy: actor.user.id,
    })
    .returning();
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'activity.create', entity: 'activity', entityId: row!.id, after: row });
  await scheduleReminder(ctx, row!);
  return getActivityView(ctx, row!.id);
}

export function canEditActivity(actor: StaffPrincipal, a: ActivityRow): boolean {
  return hasPermission(actor.roles, 'activities:all') || (hasPermission(actor.roles, 'activities:own') && a.createdBy === actor.user.id);
}

export async function updateActivity(
  ctx: Ctx,
  id: number,
  patch: ActivityUpdate,
  actor: StaffPrincipal,
): Promise<ActivityView> {
  const roomId = patch.location !== undefined ? await roomIdByName(ctx.db, patch.location) : undefined;
  const after = await ctx.db.transaction(async (tx) => {
    // «До» читаем под блокировкой внутри транзакции: параллельная правка (другой админ, организатор
    // с открытой формой) не откатит только что сохранённое - пишем присланное поверх свежего состояния.
    // Та же блокировка, что у записи/отмены: лимит и лист ожидания меняются согласованно.
    const [before] = await tx.select().from(schema.activities).where(eq(schema.activities.id, id)).for('update');
    if (!before) throw notFound('Активность не найдена');
    if (!canEditActivity(actor, before)) throw forbidden('Можно менять только свои активности');

    const next = {
      title: patch.title ?? before.title,
      description: patch.description !== undefined ? patch.description : before.description,
      location: patch.location !== undefined ? patch.location : before.location,
      host: patch.host !== undefined ? patch.host : before.host,
      kind: patch.kind ?? before.kind,
      startsAt: patch.startsAt ? new Date(patch.startsAt) : before.startsAt,
      endsAt: patch.endsAt ? new Date(patch.endsAt) : before.endsAt,
      registrationMode: patch.registrationMode ?? before.registrationMode,
      capacity: patch.capacity !== undefined ? patch.capacity : before.capacity,
      waitlistEnabled: patch.waitlistEnabled ?? before.waitlistEnabled,
      registrationOpensAt:
        patch.registrationOpensAt !== undefined
          ? patch.registrationOpensAt
            ? new Date(patch.registrationOpensAt)
            : null
          : before.registrationOpensAt,
      registrationClosesAt:
        patch.registrationClosesAt !== undefined
          ? patch.registrationClosesAt
            ? new Date(patch.registrationClosesAt)
            : null
          : before.registrationClosesAt,
      minAge: patch.minAge !== undefined ? patch.minAge : before.minAge,
      maxAge: patch.maxAge !== undefined ? patch.maxAge : before.maxAge,
      status: patch.status ?? before.status,
      meal: patch.meal !== undefined ? patch.meal : before.meal,
      roomId: roomId !== undefined ? roomId : before.roomId,
    };
    validateTimes(next);

    const [row] = await tx
      .update(schema.activities)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(schema.activities.id, id))
      .returning();
    if (next.capacity !== before.capacity || next.status !== before.status) {
      const res = await tx.execute<{ pid: string }>(sql`select promote_waitlist(${id}) as pid`);
      const promoted = res.rows.map((r) => Number(r.pid)).filter(Boolean);
      if (promoted.length) await enqueue(ctx.boss, 'activity.promoted', { activityId: id, participantIds: promoted }, { tx });
    }
    const moved = row!.startsAt.getTime() !== before.startsAt.getTime();
    if (row!.status === 'cancelled' && before.status !== 'cancelled') {
      await enqueue(ctx.boss, 'activity.changed', { activityId: id, change: 'cancelled' }, { tx });
    } else if (moved && row!.status === 'published') {
      await enqueue(ctx.boss, 'activity.changed', { activityId: id, change: 'moved' }, { tx });
    } else if (
      // Сменили зал у идущего по программе мероприятия - записанным и собравшимся важно знать.
      (row!.location ?? '') !== (before.location ?? '') &&
      row!.status === 'published' &&
      row!.endsAt.getTime() > Date.now()
    ) {
      await enqueue(ctx.boss, 'activity.changed', { activityId: id, change: 'place' }, { tx });
    }
    if (row!.title !== before.title) {
      await tx.update(schema.checkpoints).set({ name: row!.title }).where(eq(schema.checkpoints.activityId, id));
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'activity.update', entity: 'activity', entityId: id, before, after: row });
    return row!;
  });
  await scheduleReminder(ctx, after);
  return getActivityView(ctx, id);
}

export async function registerForActivity(
  ctx: Pick<AppContext, 'db'>,
  user: UserRow,
  activityId: number,
  participantId: number,
): Promise<ActivityRegisterResponse> {
  await assertFamilyMember(ctx, user.id, participantId);
  // До конференции запись закрыта: организатор открывает её выключателем, иначе первые займут всё за месяц.
  if (!(await signupOpen(ctx, activityId))) {
    return { outcome: 'not_open', activity: await getActivityView(ctx, activityId, user.id), conflict: null };
  }
  const res = await ctx.db.execute<{ r: ActivityRegisterOutcome }>(
    sql`select register_activity(${activityId}::bigint, ${participantId}::bigint, ${user.id}::bigint) as r`,
  );
  const outcome = res.rows[0]!.r;
  if (outcome === 'not_found') throw notFound('Активность или участник не найдены');
  const conflict = outcome === 'time_conflict' ? await findConflict(ctx, activityId, participantId) : null;
  return { outcome, activity: await getActivityView(ctx, activityId, user.id), conflict };
}

/** На что человек уже записан в то же время, что и activityId. */
async function findConflict(
  ctx: Pick<AppContext, 'db'>,
  activityId: number,
  participantId: number,
): Promise<ActivityConflict | null> {
  const res = await ctx.db.execute<{ id: string; title: string; starts_at: Date; ends_at: Date }>(sql`
    select o.id, o.title, o.starts_at, o.ends_at
      from activity_registrations ar
      join activities o on o.id = ar.activity_id
      join activities a on a.id = ${activityId}
     where ar.participant_id = ${participantId}
       and ar.status in ('registered', 'waitlist')
       and o.id <> a.id
       and o.status = 'published'
       and o.starts_at < a.ends_at and a.starts_at < o.ends_at
     order by o.starts_at
     limit 1`);
  const r = res.rows[0];
  return r
    ? { activityId: Number(r.id), title: r.title, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString() }
    : null;
}

/**
 * Перезапись с fromActivityId на activityId. Переходим только на свободное место; если мест нет -
 * ничего не меняется. Место в старой активности сразу достаётся первому из листа ожидания.
 */
export async function switchActivity(
  ctx: Ctx,
  user: UserRow,
  activityId: number,
  participantId: number,
  fromActivityId: number,
): Promise<ActivitySwitchResponse> {
  await assertFamilyMember(ctx, user.id, participantId);
  if (!(await signupOpen(ctx, activityId))) {
    const [activity, fromActivity] = await Promise.all([
      getActivityView(ctx, activityId, user.id),
      getActivityView(ctx, fromActivityId, user.id),
    ]);
    return { outcome: 'not_open', activity, fromActivity };
  }
  const outcome = await ctx.db.transaction(async (tx) => {
    const res = await tx.execute<{ outcome: ActivityRegisterOutcome; promoted: string[] }>(
      sql`select * from switch_activity(${fromActivityId}::bigint, ${activityId}::bigint, ${participantId}::bigint, ${user.id}::bigint)`,
    );
    const row = res.rows[0]!;
    const promoted = (row.promoted ?? []).map(Number);
    if (promoted.length) {
      await enqueue(ctx.boss, 'activity.promoted', { activityId: fromActivityId, participantIds: promoted }, { tx });
    }
    return row.outcome;
  });
  if (outcome === 'not_found') throw notFound('Активность или участник не найдены');
  const [activity, fromActivity] = await Promise.all([
    getActivityView(ctx, activityId, user.id),
    getActivityView(ctx, fromActivityId, user.id),
  ]);
  return { outcome, activity, fromActivity };
}

export async function cancelActivityRegistration(
  ctx: Ctx,
  user: UserRow,
  activityId: number,
  participantId: number,
): Promise<ActivityView> {
  await assertFamilyMember(ctx, user.id, participantId);
  await ctx.db.transaction(async (tx) => {
    const res = await tx.execute<{ promoted: string[] }>(
      sql`select promoted from cancel_activity_registration(${activityId}::bigint, ${participantId}::bigint)`,
    );
    const promoted = (res.rows[0]?.promoted ?? []).map(Number);
    if (promoted.length) await enqueue(ctx.boss, 'activity.promoted', { activityId, participantIds: promoted }, { tx });
  });
  return getActivityView(ctx, activityId, user.id);
}

export async function setInterest(ctx: Pick<AppContext, 'db'>, user: UserRow, activityId: number, on: boolean) {
  if (on) {
    await ctx.db.insert(schema.activityInterest).values({ activityId, userId: user.id }).onConflictDoNothing();
  } else {
    await ctx.db
      .delete(schema.activityInterest)
      .where(and(eq(schema.activityInterest.activityId, activityId), eq(schema.activityInterest.userId, user.id)));
  }
  return getActivityView(ctx, activityId, user.id);
}

export async function activityRegistrations(ctx: Pick<AppContext, 'db'>, activityId: number): Promise<ActivityRegistrationRow[]> {
  const rows = await ctx.db.execute<{
    participant_id: string;
    last_name: string;
    first_name: string;
    middle_name: string | null;
    birth_date: string | null;
    category: string;
    status: string;
    queued_at: Date;
    attended: boolean;
  }>(sql`
    select ar.participant_id, p.last_name, p.first_name, p.middle_name, p.birth_date::text as birth_date, p.category,
           ar.status, ar.queued_at,
           exists (
             select 1 from check_ins ci join checkpoints c on c.id = ci.checkpoint_id
              where c.activity_id = ar.activity_id and ci.participant_id = ar.participant_id and ci.revoked_at is null
           ) as attended
      from activity_registrations ar join participants p on p.id = ar.participant_id
     where ar.activity_id = ${activityId}
     order by case ar.status when 'registered' then 0 when 'waitlist' then 1 else 2 end, ar.queued_at, ar.id`);
  return rows.rows.map((r) => ({
    participantId: Number(r.participant_id),
    fullName: fullName({ lastName: r.last_name, firstName: r.first_name, middleName: r.middle_name }),
    age: ageOrNull(r.birth_date),
    category: r.category as Category,
    status: r.status as ActivityRegistrationRow['status'],
    queuedAt: new Date(r.queued_at).toISOString(),
    attended: r.attended,
  }));
}

/** Активность, которой этот сотрудник может управлять (своя или любая при activities:all). */
async function editableActivity(ctx: Pick<AppContext, 'db'>, actor: StaffPrincipal, activityId: number): Promise<ActivityRow> {
  const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, activityId) });
  if (!a) throw notFound('Активность не найдена');
  if (!canEditActivity(actor, a)) throw forbidden('Можно записывать только на свои активности');
  return a;
}

/**
 * Волонтёр записывает человека сам - для тех, у кого нет своего Telegram. Правила те же, что у
 * участника: места, лист ожидания, пересечение по времени, возраст, окно записи.
 */
export async function staffEnroll(
  ctx: Ctx,
  actor: StaffPrincipal,
  activityId: number,
  participantId: number,
): Promise<StaffEnrollResponse> {
  await editableActivity(ctx, actor, activityId);
  const res = await ctx.db.execute<{ r: ActivityRegisterOutcome }>(
    sql`select register_activity(${activityId}::bigint, ${participantId}::bigint, ${actor.user.id}::bigint) as r`,
  );
  const outcome = res.rows[0]!.r;
  if (outcome === 'not_found') throw notFound('Человек не найден или его регистрация отменена');
  if (outcome === 'registered' || outcome === 'waitlist') {
    await audit(ctx.db, {
      actorUserId: actor.user.id,
      action: 'activity.staff_enroll',
      entity: 'activity',
      entityId: activityId,
      after: { participantId, outcome },
    });
  }
  const conflict = outcome === 'time_conflict' ? await findConflict(ctx, activityId, participantId) : null;
  return { outcome, conflict, rows: await activityRegistrations(ctx, activityId) };
}

export async function staffUnenroll(
  ctx: Ctx,
  actor: StaffPrincipal,
  activityId: number,
  participantId: number,
): Promise<ActivityRegistrationRow[]> {
  await editableActivity(ctx, actor, activityId);
  await ctx.db.transaction(async (tx) => {
    const res = await tx.execute<{ promoted: string[] }>(
      sql`select promoted from cancel_activity_registration(${activityId}::bigint, ${participantId}::bigint)`,
    );
    const promoted = (res.rows[0]?.promoted ?? []).map(Number);
    if (promoted.length) await enqueue(ctx.boss, 'activity.promoted', { activityId, participantIds: promoted }, { tx });
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'activity.staff_unenroll',
      entity: 'activity',
      entityId: activityId,
      after: { participantId },
    });
  });
  return activityRegistrations(ctx, activityId);
}

/**
 * Удалить мероприятие совсем. Записавшимся (и отметившим «Пойду») - сообщение, если оно ещё не прошло.
 * Если на нём уже отмечали людей - нельзя: история отметок важна, такое мероприятие только отменяют.
 */
export async function deleteActivity(ctx: Ctx, actor: StaffPrincipal, activityId: number): Promise<{ notified: number }> {
  const a = await editableActivity(ctx, actor, activityId);
  const tz = (await getSettings(ctx.db)).eventTimezone;
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${schema.activities} where id = ${activityId} for update`);
    const cpIds = (
      await tx.select({ id: schema.checkpoints.id }).from(schema.checkpoints).where(eq(schema.checkpoints.activityId, activityId))
    ).map((c) => c.id);
    if (cpIds.length) {
      const [marked] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.checkIns)
        .where(and(inArray(schema.checkIns.checkpointId, cpIds), sql`${schema.checkIns.revokedAt} is null`));
      if ((marked?.n ?? 0) > 0) {
        throw badRequest('has_checkins', 'На мероприятии уже отмечали людей - его можно только отменить');
      }
    }

    // Кому сообщить: записанные и ждущие (по держателю QR-кода или владельцу) и те, кто нажал «Пойду».
    const byUser = new Map<number, string[]>();
    if (a.status === 'published' && a.endsAt.getTime() > Date.now()) {
      const regs = await tx
        .select({ p: schema.participants })
        .from(schema.activityRegistrations)
        .innerJoin(schema.participants, eq(schema.participants.id, schema.activityRegistrations.participantId))
        .where(
          and(
            eq(schema.activityRegistrations.activityId, activityId),
            inArray(schema.activityRegistrations.status, ['registered', 'waitlist']),
            eq(schema.participants.status, 'active'),
          ),
        );
      for (const { p } of regs) {
        const uid = p.holderUserId ?? p.ownerUserId;
        byUser.set(uid, [...(byUser.get(uid) ?? []), p.firstName]);
      }
      const interested = await tx
        .select({ userId: schema.activityInterest.userId })
        .from(schema.activityInterest)
        .where(eq(schema.activityInterest.activityId, activityId));
      for (const { userId } of interested) if (!byUser.has(userId)) byUser.set(userId, []);
    }

    if (cpIds.length) {
      await tx.delete(schema.checkIns).where(inArray(schema.checkIns.checkpointId, cpIds));
      await tx.delete(schema.scanLog).where(inArray(schema.scanLog.checkpointId, cpIds));
      await tx.delete(schema.checkpoints).where(inArray(schema.checkpoints.id, cpIds));
    }
    await tx.delete(schema.activityInterest).where(eq(schema.activityInterest.activityId, activityId));
    await tx.delete(schema.activityRegistrations).where(eq(schema.activityRegistrations.activityId, activityId));
    await tx.delete(schema.activities).where(eq(schema.activities.id, activityId));

    const when = fmtDateTime(a.startsAt, tz);
    for (const [userId, names] of byUser) {
      await enqueue(
        ctx.boss,
        'notify.text',
        {
          kind: 'activity.changed',
          userId,
          text:
            `❗️ «<b>${esc(a.title)}</b>» убрали из программы\n${esc(when)}` +
            (names.length > 1 ? `\n👤 Были записаны: ${names.map(esc).join(', ')}` : ''),
        },
        { tx },
      );
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'activity.delete', entity: 'activity', entityId: activityId, before: a });
    return { notified: byUser.size };
  });
}

/** Точка отметки для активности - создаётся по первому запросу. */
export async function ensureActivityCheckpoint(
  ctx: Pick<AppContext, 'db'>,
  activityId: number,
  actor: StaffPrincipal,
): Promise<CheckpointView> {
  const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, activityId) });
  if (!a) throw notFound('Активность не найдена');
  if (!canEditActivity(actor, a) && !hasPermission(actor.roles, 'checkin:write')) throw forbidden();
  const existing = await ctx.db.query.checkpoints.findFirst({ where: eq(schema.checkpoints.activityId, activityId) });
  if (existing) return toCheckpointView(existing);
  const [cp] = await ctx.db
    .insert(schema.checkpoints)
    .values({ kind: 'activity', name: a.title, activityId, day: null })
    .returning();
  return toCheckpointView(cp!);
}
