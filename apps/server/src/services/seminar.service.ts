import {
  ageOrNull,
  fullName,
  type ActivityStatus,
  type RoomInput,
  type RoomView,
  type SeminarBlockInput,
  type SeminarBlockUpdate,
  type SeminarBlockView,
  type SeminarChangedRow,
  type SeminarMoveInput,
  type SeminarsPublic,
  type SeminarsSummary,
  type SeminarTopicInput,
  type SeminarTopicRow,
  type SeminarTopicView,
  type SeminarUnplacedRow,
  type SeminarVotesInput,
} from '@sof/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.ts';
import { createActivity, deleteActivity, listActivities, scheduleReminder, updateActivity } from './activity.service.ts';
import { activeFamilyIds, assertFamilyMember } from './registration.service.ts';
import { getSettings, patchSettings } from './settings.service.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import type { UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;
type RoomRow = typeof schema.rooms.$inferSelect;
type BlockRow = typeof schema.seminarBlocks.$inferSelect;

const toRoom = (r: RoomRow): RoomView => ({ id: r.id, name: r.name, capacity: r.capacity, note: r.note, sort: r.sort });

// ---------- залы ----------

export async function listRooms(db: DbLike): Promise<RoomView[]> {
  const rows = await db.query.rooms.findMany({ orderBy: [asc(schema.rooms.sort), asc(schema.rooms.name)] });
  return rows.map(toRoom);
}

const roomTaken = (err: unknown) =>
  isUniqueViolation(err, 'rooms_name_uq') ? conflict('room_exists', 'Зал с таким названием уже есть') : err;

export async function createRoom(db: DbLike, input: RoomInput): Promise<RoomView> {
  try {
    const [row] = await db
      .insert(schema.rooms)
      .values({ name: input.name, capacity: input.capacity, note: input.note ?? null, sort: input.sort })
      .returning();
    return toRoom(row!);
  } catch (err) {
    throw roomTaken(err);
  }
}

export async function updateRoom(db: DbLike, id: number, patch: Partial<RoomInput>): Promise<RoomView> {
  try {
    const [row] = await db
      .update(schema.rooms)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
        ...(patch.note !== undefined ? { note: patch.note ?? null } : {}),
        ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
      })
      .where(eq(schema.rooms.id, id))
      .returning();
    if (!row) throw notFound('Зал не найден');
    // Переименовали - у опубликованных тем и мероприятий в этом зале обновится и подпись места.
    if (patch.name !== undefined) {
      await db.update(schema.activities).set({ location: row.name }).where(eq(schema.activities.roomId, id));
    }
    return toRoom(row);
  } catch (err) {
    throw roomTaken(err);
  }
}

export async function deleteRoom(db: DbLike, id: number): Promise<void> {
  const [row] = await db.delete(schema.rooms).where(eq(schema.rooms.id, id)).returning();
  if (!row) throw notFound('Зал не найден');
}


// ---------- распределение: темы по залам ----------

export interface PlanSession {
  id: number;
  topicId: number | null;
  plannedRoomId: number | null;
  /** Зал уже опубликован: остаётся за сеансом, если админ не отдал его другому вручную. */
  keepRoomId?: number | null;
  /** Тема скрыта - сама зал не получает (только если админ поставил вручную). */
  hidden: boolean;
}

export interface PlanBlock {
  id: number;
  rooms: RoomView[];
  sessions: PlanSession[];
}

/** Ключ темы для рейтинга: общая тема или (у старых сеансов без темы) сам сеанс. */
const topicKey = (s: { id: number; topicId: number | null }) => s.topicId ?? -s.id;

/**
 * Залы сеансам. Потоки - по времени. Ручные залы админа остаются; остальные сеансы получают свободные залы
 * по убыванию вместимости: где больше людей - тот зал больше (пока людей нет - по голосам за тему).
 * Самая популярная по голосам тема идёт один раз - в первом потоке, где ей достаётся самый большой зал.
 */
export function planRooms(
  blocks: PlanBlock[],
  votes: Map<number, number>,
  order: Map<number, number> = new Map(),
  load: Map<number, number> = new Map(),
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const rank = (a: number, b: number) => (votes.get(b) ?? 0) - (votes.get(a) ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0) || a - b;
  const keys = [...new Set(blocks.flatMap((b) => b.sessions.filter((s) => !s.hidden).map(topicKey)))].sort(rank);
  const once = blocks.length > 1 ? keys[0] : undefined;
  blocks.forEach((b, i) => {
    const roomIds = new Set(b.rooms.map((r) => r.id));
    const used = new Set<number>();
    for (const s of b.sessions) {
      out.set(s.id, null);
      if (s.plannedRoomId !== null && roomIds.has(s.plannedRoomId) && !used.has(s.plannedRoomId)) {
        out.set(s.id, s.plannedRoomId);
        used.add(s.plannedRoomId);
      }
    }
    for (const s of b.sessions) {
      const keep = s.keepRoomId ?? null;
      if (out.get(s.id) === null && keep !== null && roomIds.has(keep) && !used.has(keep)) {
        out.set(s.id, keep);
        used.add(keep);
      }
    }
    const free = b.rooms.filter((r) => !used.has(r.id)).sort((x, y) => y.capacity - x.capacity || x.sort - y.sort);
    const waiting = b.sessions
      .filter((s) => !s.hidden && out.get(s.id) === null && !(i > 0 && topicKey(s) === once))
      .sort((x, y) => (load.get(y.id) ?? 0) - (load.get(x.id) ?? 0) || rank(topicKey(x), topicKey(y)));
    for (const s of waiting) {
      const room = free.shift();
      if (!room) break;
      out.set(s.id, room.id);
    }
  });
  return out;
}

// ---------- распределение: люди по сеансам ----------

export interface PlanStream {
  blockId: number;
  /** Сеансы потока, у которых есть зал. */
  sessions: { id: number; topicId: number; capacity: number }[];
}

export interface PlanPerson {
  id: number;
  /** Аккаунт семьи: одинаковый выбор одной семьи раскладываем вместе. */
  family: number;
  topics: number[];
  /** Уже стоит в потоке: поток → тема. */
  fixed: Map<number, number>;
}

/**
 * Каждому - по одной выбранной теме в каждом свободном потоке, разные темы. Сначала тех, у кого вариантов
 * меньше (например, выбравших тему, что идёт один раз), потом остальных - туда, где залы заполнены меньше
 * (считаем Σ занято²/мест), а перебор - самое дорогое. После - несколько проходов улучшения.
 * Возвращает только новые места: человек → [{поток, сеанс}].
 */
export function planPeople(
  streams: PlanStream[],
  people: PlanPerson[],
  baseLoad: Map<number, number>,
): Map<number, { blockId: number; sessionId: number }[]> {
  const load = new Map(baseLoad);
  const cap = new Map<number, number>();
  const blockOf = new Map<number, number>();
  const sessionAt = new Map<string, number>();
  for (const st of streams) {
    for (const s of st.sessions) {
      cap.set(s.id, s.capacity);
      blockOf.set(s.id, st.blockId);
      sessionAt.set(`${st.blockId}:${s.topicId}`, s.id);
    }
  }

  const groups = new Map<string, { ids: number[]; free: number[]; topics: number[] }>();
  for (const p of people) {
    const taken = new Set(p.fixed.values());
    const topics = [...new Set(p.topics)].filter((t) => !taken.has(t)).sort((a, b) => a - b);
    const free = streams.map((s) => s.blockId).filter((b) => !p.fixed.has(b));
    if (topics.length === 0 || free.length === 0) continue;
    const key = `${p.family}|${topics.join(',')}|${free.join(',')}`;
    const g = groups.get(key) ?? { ids: [], free, topics };
    g.ids.push(p.id);
    groups.set(key, g);
  }

  const optionsFor = (free: number[], topics: number[]): number[][] => {
    const all: number[][] = [];
    const left = new Set(topics);
    const picked: number[] = [];
    const walk = (i: number) => {
      if (i === free.length) {
        all.push([...picked]);
        return;
      }
      walk(i + 1);
      for (const t of [...left]) {
        const sid = sessionAt.get(`${free[i]}:${t}`);
        if (sid === undefined) continue;
        left.delete(t);
        picked.push(sid);
        walk(i + 1);
        picked.pop();
        left.add(t);
      }
    };
    walk(0);
    const most = Math.max(0, ...all.map((o) => o.length));
    return most === 0 ? [] : all.filter((o) => o.length === most);
  };

  const units = [...groups.values()]
    .map((g) => ({ ...g, options: optionsFor(g.free, g.topics), chosen: null as number[] | null }))
    .filter((u) => u.options.length > 0)
    .sort((a, b) => a.options.length - b.options.length || b.ids.length - a.ids.length || a.ids[0]! - b.ids[0]!);

  const cost = (option: number[], n: number) => {
    let c = 0;
    for (const sid of option) {
      const l = load.get(sid) ?? 0;
      const k = cap.get(sid)!;
      const over = Math.max(0, l + n - k) - Math.max(0, l - k);
      c += over * 1000 + ((l + n) ** 2 - l ** 2) / k;
    }
    return c;
  };
  const apply = (option: number[], n: number) => {
    for (const sid of option) load.set(sid, (load.get(sid) ?? 0) + n);
  };
  const best = (u: (typeof units)[number]) => {
    let pick = u.options[0]!;
    let min = Infinity;
    for (const o of u.options) {
      const c = cost(o, u.ids.length);
      if (c < min) {
        min = c;
        pick = o;
      }
    }
    return pick;
  };

  for (const u of units) {
    u.chosen = best(u);
    apply(u.chosen, u.ids.length);
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const u of units) {
      apply(u.chosen!, -u.ids.length);
      const next = best(u);
      if (next.join() !== u.chosen!.join()) changed = true;
      u.chosen = next;
      apply(next, u.ids.length);
    }
    if (!changed) break;
  }

  const out = new Map<number, { blockId: number; sessionId: number }[]>();
  for (const u of units) {
    for (const pid of u.ids) out.set(pid, u.chosen!.map((sid) => ({ blockId: blockOf.get(sid)!, sessionId: sid })));
  }
  return out;
}

// ---------- данные для распределения ----------

interface SessionStat {
  id: number;
  blockId: number;
  topicId: number | null;
  title: string;
  host: string | null;
  description: string | null;
  status: string;
  registered: number;
  plannedRoomId: number | null;
  roomId: number | null;
  hidden: boolean;
  sort: number;
}

async function sessionStats(db: DbLike, blockIds: number[]): Promise<SessionStat[]> {
  if (blockIds.length === 0) return [];
  const rows = await db.execute<{
    id: string;
    block_id: string;
    topic_id: string | null;
    title: string;
    host: string | null;
    description: string | null;
    status: string;
    planned_room_id: string | null;
    room_id: string | null;
    registered: number;
    hidden: boolean | null;
    sort: number | null;
  }>(sql`
    select a.id, a.block_id, a.topic_id, a.title, a.host, a.description, a.status, a.planned_room_id, a.room_id,
           (select count(*) from activity_registrations r where r.activity_id = a.id and r.status = 'registered')::int as registered,
           t.hidden, t.sort
      from activities a left join seminar_topics t on t.id = a.topic_id
     where a.block_id in ${sql.raw(`(${blockIds.map(Number).join(',')})`)} and a.status <> 'cancelled'
     order by coalesce(t.sort, 0), a.topic_id nulls last, a.id`);
  return rows.rows.map((r) => ({
    id: Number(r.id),
    blockId: Number(r.block_id),
    topicId: r.topic_id === null ? null : Number(r.topic_id),
    title: r.title,
    host: r.host,
    description: r.description,
    status: r.status,
    registered: r.registered,
    plannedRoomId: r.planned_room_id === null ? null : Number(r.planned_room_id),
    roomId: r.room_id === null ? null : Number(r.room_id),
    hidden: r.hidden ?? false,
    sort: r.sort ?? 0,
  }));
}

/** Голоса за темы - только активных участников. */
async function topicVotes(db: DbLike): Promise<Map<number, number>> {
  const rows = await db.execute<{ topic_id: string; n: number }>(sql`
    select v.topic_id, count(*)::int as n
      from seminar_votes v join participants p on p.id = v.participant_id and p.status = 'active'
     group by v.topic_id`);
  return new Map(rows.rows.map((r) => [Number(r.topic_id), r.n]));
}

/**
 * Кто что выбрал и где уже стоит: выбор активных участников (видимые темы), семья (кому пишем),
 * записи на сеансы - поток → тема.
 */
async function seatState(db: DbLike) {
  const votes = await db.execute<{ participant_id: string; topic_id: string; family: string; created_at: Date }>(sql`
    select v.participant_id, v.topic_id, coalesce(p.holder_user_id, p.owner_user_id) as family, v.created_at
      from seminar_votes v
      join participants p on p.id = v.participant_id and p.status = 'active'
      join seminar_topics t on t.id = v.topic_id and not t.hidden
     order by v.participant_id, v.created_at, v.topic_id`);
  const regs = await db.execute<{
    participant_id: string;
    activity_id: string;
    block_id: string;
    topic_id: string | null;
    status: string;
    planned: boolean;
    updated_at: Date;
  }>(sql`
    select ar.participant_id, ar.activity_id, a.block_id, a.topic_id, ar.status, ar.planned, ar.updated_at
      from activity_registrations ar
      join activities a on a.id = ar.activity_id and a.block_id is not null and a.status <> 'cancelled'
      join participants p on p.id = ar.participant_id and p.status = 'active'
     where ar.status in ('registered', 'waitlist')`);
  const chosen = new Map<number, number[]>();
  const family = new Map<number, number>();
  /** Когда человек последний раз менял выбор. */
  const votedAt = new Map<number, number>();
  for (const r of votes.rows) {
    const pid = Number(r.participant_id);
    chosen.set(pid, [...(chosen.get(pid) ?? []), Number(r.topic_id)]);
    family.set(pid, Number(r.family));
    votedAt.set(pid, Math.max(votedAt.get(pid) ?? 0, new Date(r.created_at).getTime()));
  }
  const seats = new Map<number, Map<number, number>>();
  const load = new Map<number, number>();
  const list = regs.rows.map((r) => ({
    participantId: Number(r.participant_id),
    activityId: Number(r.activity_id),
    blockId: Number(r.block_id),
    topicId: r.topic_id === null ? -Number(r.activity_id) : Number(r.topic_id),
    registered: r.status === 'registered',
    planned: r.planned,
    updatedAt: new Date(r.updated_at).getTime(),
  }));
  for (const r of list) {
    const map = seats.get(r.participantId) ?? new Map<number, number>();
    map.set(r.blockId, r.topicId);
    seats.set(r.participantId, map);
    if (r.registered) load.set(r.activityId, (load.get(r.activityId) ?? 0) + 1);
  }
  return { chosen, family, votedAt, seats, load, regs: list };
}

type SeatState = Awaited<ReturnType<typeof seatState>>;

/**
 * Передумал: сидит на теме, которую больше не выбирает. Место поставило распределение - или его поставили вручную,
 * а человек поменял выбор уже после этого. Кто снял все отметки, не считается: место остаётся.
 */
function changedMind(state: SeatState, r: SeatState['regs'][number]): boolean {
  const topics = state.chosen.get(r.participantId) ?? [];
  if (topics.length === 0 || topics.includes(r.topicId)) return false;
  return r.planned || (state.votedAt.get(r.participantId) ?? 0) > r.updatedAt;
}

/** Проголосовал, но в потоке без места, хотя есть выбранная тема, которую ему ещё не дали. */
function isUnplaced(blockId: number, topics: number[], seats: Map<number, number> | undefined): boolean {
  if (seats?.has(blockId)) return false;
  const given = new Set(seats?.values() ?? []);
  return topics.some((t) => !given.has(t));
}

async function visibleBlocks(db: DbLike): Promise<BlockRow[]> {
  return db.query.seminarBlocks.findMany({
    where: eq(schema.seminarBlocks.hidden, false),
    orderBy: [asc(schema.seminarBlocks.startsAt), asc(schema.seminarBlocks.id)],
  });
}

async function blockRooms(db: DbLike, blockIds: number[]): Promise<Map<number, RoomView[]>> {
  const out = new Map<number, RoomView[]>();
  if (blockIds.length === 0) return out;
  const rows = await db
    .select({ blockId: schema.seminarBlockRooms.blockId, room: schema.rooms })
    .from(schema.seminarBlockRooms)
    .innerJoin(schema.rooms, eq(schema.rooms.id, schema.seminarBlockRooms.roomId))
    .where(inArray(schema.seminarBlockRooms.blockId, blockIds))
    .orderBy(asc(schema.rooms.sort), asc(schema.rooms.name));
  for (const r of rows) out.set(r.blockId, [...(out.get(r.blockId) ?? []), toRoom(r.room)]);
  return out;
}

/**
 * Залы сеансов: видимые потоки - вместе (правило «самая популярная - один раз»), скрытые - каждый сам по себе.
 * Залы - по числу людей в сеансе; `planFor` пересчитывает их для другой раскладки людей (распределение).
 */
async function roomPlan(db: DbLike, blocks: BlockRow[]) {
  const ids = blocks.map((b) => b.id);
  const [rooms, sessions, votes, topics] = await Promise.all([
    blockRooms(db, ids),
    sessionStats(db, ids),
    topicVotes(db),
    db.select({ id: schema.seminarTopics.id, sort: schema.seminarTopics.sort }).from(schema.seminarTopics),
  ]);
  const order = new Map(topics.map((t) => [t.id, t.sort]));
  // После публикации залы не тасуем: у открытых сеансов зал остаётся, люди его уже знают.
  const toPlan = (b: BlockRow): PlanBlock => ({
    id: b.id,
    rooms: rooms.get(b.id) ?? [],
    sessions: sessions
      .filter((s) => s.blockId === b.id)
      .map((s) => ({ ...s, keepRoomId: b.roomsPublishedAt !== null && s.status === 'published' ? s.roomId : null })),
  });
  const planFor = (load: Map<number, number>) => {
    const plan = planRooms(blocks.filter((b) => !b.hidden).map(toPlan), votes, order, load);
    for (const b of blocks.filter((x) => x.hidden)) for (const [k, v] of planRooms([toPlan(b)], votes, order, load)) plan.set(k, v);
    return plan;
  };
  const plan = planFor(new Map(sessions.map((s) => [s.id, s.registered])));
  return { rooms, sessions, votes, plan, planFor };
}

// ---------- потоки (админка) ----------

export async function listBlocks(db: DbLike): Promise<SeminarBlockView[]> {
  const blocks = await db.query.seminarBlocks.findMany({ orderBy: [asc(schema.seminarBlocks.startsAt), asc(schema.seminarBlocks.id)] });
  const { rooms, sessions, votes, plan } = await roomPlan(db, blocks);
  const state = await seatState(db);
  const changedAt = await db.execute<{ block_id: string; at: Date }>(sql`
    select a.block_id, max(ar.updated_at) as at
      from activity_registrations ar join activities a on a.id = ar.activity_id
     where a.block_id is not null
     group by a.block_id`);
  const lastChange = new Map(changedAt.rows.map((r) => [Number(r.block_id), new Date(r.at)]));
  return blocks.map((b) => {
    const blockRoomsList = rooms.get(b.id) ?? [];
    const roomById = new Map(blockRoomsList.map((r) => [r.id, r]));
    const rows: SeminarTopicRow[] = sessions
      .filter((s) => s.blockId === b.id)
      .map((s) => {
        const roomId = plan.get(s.id) ?? null;
        const capacity = roomId !== null ? roomById.get(roomId)!.capacity : 0;
        return {
          id: s.id,
          topicId: s.topicId,
          votes: s.topicId !== null ? (votes.get(s.topicId) ?? 0) : 0,
          hidden: s.hidden,
          title: s.title,
          host: s.host,
          description: s.description,
          status: s.status as ActivityStatus,
          registered: s.registered,
          plannedRoomId: s.plannedRoomId,
          roomId,
          publishedRoomId: s.roomId,
          overflow: roomId !== null ? Math.max(0, s.registered - capacity) : s.registered,
        };
      });
    const used = new Set(rows.map((r) => r.roomId).filter((x): x is number => x !== null));
    // Есть что публиковать: сеанс откроется или закроется, сменит зал, или люди поменялись после публикации.
    const published = b.roomsPublishedAt;
    const changed =
      rows.some((r) => (r.roomId !== null) !== (r.status === 'published') || (r.roomId !== null && r.roomId !== r.publishedRoomId)) ||
      (published !== null && (lastChange.get(b.id)?.getTime() ?? 0) > published.getTime());
    let unplaced = 0;
    if (!b.hidden) {
      for (const [pid, topics] of state.chosen) if (isUnplaced(b.id, topics, state.seats.get(pid))) unplaced++;
    }
    return {
      id: b.id,
      title: b.title,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      registrationOpen: b.registrationOpen,
      roomsPublishedAt: published?.toISOString() ?? null,
      hidden: b.hidden,
      rooms: blockRoomsList,
      topics: rows,
      freeRoomIds: blockRoomsList.filter((r) => !used.has(r.id)).map((r) => r.id),
      dirty: !b.hidden && changed,
      unplaced,
    };
  });
}

export async function getBlock(db: DbLike, id: number): Promise<SeminarBlockView> {
  const view = (await listBlocks(db)).find((b) => b.id === id);
  if (!view) throw notFound('Поток семинаров не найден');
  return view;
}

async function setBlockRooms(db: DbLike, blockId: number, roomIds: number[]): Promise<void> {
  await db.delete(schema.seminarBlockRooms).where(eq(schema.seminarBlockRooms.blockId, blockId));
  const unique = [...new Set(roomIds)];
  if (unique.length) await db.insert(schema.seminarBlockRooms).values(unique.map((roomId) => ({ blockId, roomId })));
}

/** У каждой темы - сеанс в каждом потоке (черновик: участники его не видят до публикации распределения). */
async function ensureSessions(ctx: Ctx, actor: StaffPrincipal): Promise<void> {
  const [topics, blocks, existing] = await Promise.all([
    ctx.db.select().from(schema.seminarTopics),
    ctx.db.select().from(schema.seminarBlocks),
    ctx.db
      .select({ blockId: schema.activities.blockId, topicId: schema.activities.topicId })
      .from(schema.activities)
      .where(sql`${schema.activities.blockId} is not null and ${schema.activities.topicId} is not null`),
  ]);
  const have = new Set(existing.map((e) => `${e.blockId}:${e.topicId}`));
  for (const b of blocks) {
    for (const t of topics) {
      if (have.has(`${b.id}:${t.id}`)) continue;
      const created = await createActivity(
        ctx,
        {
          title: t.title,
          description: t.description,
          location: null,
          host: t.host,
          kind: 'Семинар',
          startsAt: b.startsAt.toISOString(),
          endsAt: b.endsAt.toISOString(),
          registrationMode: 'required',
          capacity: null,
          waitlistEnabled: false,
          registrationOpensAt: null,
          registrationClosesAt: null,
          minAge: null,
          maxAge: null,
          status: 'draft',
        },
        actor,
      );
      await ctx.db.update(schema.activities).set({ blockId: b.id, topicId: t.id }).where(eq(schema.activities.id, created.id));
    }
  }
}

export async function createBlock(ctx: Ctx, input: SeminarBlockInput, actor: StaffPrincipal): Promise<SeminarBlockView> {
  // Строго позже начала: у блока нулевой длины темы не пересекались бы и можно было взять все сразу.
  if (new Date(input.endsAt) <= new Date(input.startsAt)) throw badRequest('invalid_time', 'Окончание должно быть позже начала');
  const [row] = await ctx.db
    .insert(schema.seminarBlocks)
    .values({
      title: input.title,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      registrationOpen: input.registrationOpen,
      hidden: input.hidden,
    })
    .returning();
  await setBlockRooms(ctx.db, row!.id, input.roomIds);
  await ensureSessions(ctx, actor);
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'seminar_block.create', entity: 'seminar_block', entityId: row!.id, after: row });
  return getBlock(ctx.db, row!.id);
}

/**
 * Общий выключатель «Голосование за семинары открыто»: открыть или закрыть сразу во всех потоках.
 * Отдельного флага нет - общий выключатель показывает, открыт ли хоть один поток, и не может с ними разойтись.
 */
export async function setAllBlocksRegistration(ctx: Ctx, open: boolean, actor: StaffPrincipal): Promise<SeminarBlockView[]> {
  await ctx.db.transaction(async (tx) => {
    const changed = await tx
      .update(schema.seminarBlocks)
      .set({ registrationOpen: open })
      .where(ne(schema.seminarBlocks.registrationOpen, open))
      .returning({ id: schema.seminarBlocks.id });
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'seminar_block.registration_all',
      entity: 'seminar_block',
      entityId: null,
      after: { open, blockIds: changed.map((b) => b.id) },
    });
  });
  return listBlocks(ctx.db);
}

/** Сменили время потока - переносим и сеансы (записавшимся придёт сообщение о переносе, как у мероприятий). */
export async function updateBlock(ctx: Ctx, id: number, patch: SeminarBlockUpdate, actor: StaffPrincipal): Promise<SeminarBlockView> {
  const before = await ctx.db.query.seminarBlocks.findFirst({ where: eq(schema.seminarBlocks.id, id) });
  if (!before) throw notFound('Поток семинаров не найден');
  const startsAt = patch.startsAt ? new Date(patch.startsAt) : before.startsAt;
  const endsAt = patch.endsAt ? new Date(patch.endsAt) : before.endsAt;
  if (endsAt <= startsAt) throw badRequest('invalid_time', 'Окончание должно быть позже начала');
  await ctx.db
    .update(schema.seminarBlocks)
    .set({
      title: patch.title ?? before.title,
      startsAt,
      endsAt,
      registrationOpen: patch.registrationOpen ?? before.registrationOpen,
      hidden: patch.hidden ?? before.hidden,
    })
    .where(eq(schema.seminarBlocks.id, id));
  if (patch.roomIds) await setBlockRooms(ctx.db, id, patch.roomIds);
  if (startsAt.getTime() !== before.startsAt.getTime() || endsAt.getTime() !== before.endsAt.getTime()) {
    const topics = await ctx.db.query.activities.findMany({ where: eq(schema.activities.blockId, id) });
    for (const t of topics) {
      await updateActivity(ctx, t.id, { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, actor);
    }
  }
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'seminar_block.update', entity: 'seminar_block', entityId: id, before, after: patch });
  return getBlock(ctx.db, id);
}

/** Удалить поток вместе с сеансами; записавшимся - сообщение. */
export async function deleteBlock(ctx: Ctx, id: number, actor: StaffPrincipal): Promise<void> {
  const block = await ctx.db.query.seminarBlocks.findFirst({ where: eq(schema.seminarBlocks.id, id) });
  if (!block) throw notFound('Поток семинаров не найден');
  // Одной транзакцией: если какой-то сеанс удалить нельзя, поток не остаётся удалённым наполовину.
  await ctx.db.transaction(async (tx) => {
    const inTx = { ...ctx, db: tx as unknown as typeof ctx.db };
    const topics = await tx.query.activities.findMany({ where: eq(schema.activities.blockId, id) });
    for (const t of topics) await deleteActivity(inTx, actor, t.id);
    await tx.delete(schema.seminarBlocks).where(eq(schema.seminarBlocks.id, id));
    await audit(tx, { actorUserId: actor.user.id, action: 'seminar_block.delete', entity: 'seminar_block', entityId: id, before: block });
  });
}

/** Админ поставил сеанс в другой зал (или вернул выбор боту). Участники увидят после публикации. */
export async function setPlannedRoom(db: DbLike, topicId: number, roomId: number | null): Promise<SeminarBlockView> {
  const t = await db.query.activities.findFirst({ where: eq(schema.activities.id, topicId) });
  if (!t || t.blockId === null) throw notFound('Сеанс не найден');
  const blockId = t.blockId;
  if (roomId !== null) {
    const allowed = await db.query.seminarBlockRooms.findFirst({
      where: and(eq(schema.seminarBlockRooms.blockId, blockId), eq(schema.seminarBlockRooms.roomId, roomId)),
    });
    if (!allowed) throw badRequest('room_not_in_block', 'Этого зала нет в потоке - добавьте его в настройках потока');
    // Зал уже стоит у другого сеанса вручную - освобождаем его там (меняем местами по смыслу).
    await db
      .update(schema.activities)
      .set({ plannedRoomId: null })
      .where(and(eq(schema.activities.blockId, blockId), eq(schema.activities.plannedRoomId, roomId)));
  }
  await db.update(schema.activities).set({ plannedRoomId: roomId }).where(eq(schema.activities.id, topicId));
  return getBlock(db, blockId);
}

// ---------- темы (админка) ----------

export async function seminarsSummary(db: DbLike): Promise<SeminarsSummary> {
  const [topics, votes, blocks, people, state, settings] = await Promise.all([
    db.query.seminarTopics.findMany({ orderBy: [asc(schema.seminarTopics.sort), asc(schema.seminarTopics.id)] }),
    topicVotes(db),
    listBlocks(db),
    db.execute<{ n: number }>(sql`select count(*)::int as n from participants where status = 'active'`),
    seatState(db),
    getSettings(db),
  ]);
  const visible = blocks.filter((b) => !b.hidden);
  const views: SeminarTopicView[] = topics.map((t) => ({
    id: t.id,
    title: t.title,
    host: t.host,
    description: t.description,
    hidden: t.hidden,
    sort: t.sort,
    votes: votes.get(t.id) ?? 0,
  }));
  const published = visible.length > 0 && visible.every((b) => b.roomsPublishedAt !== null);
  return {
    topics: views,
    open: visible.some((b) => b.registrationOpen),
    picks: Math.min(visible.length, views.filter((t) => !t.hidden).length),
    participants: people.rows[0]!.n,
    voters: state.chosen.size,
    publishedAt: published ? visible.map((b) => b.roomsPublishedAt!).sort()[0]! : null,
    dirty: visible.some((b) => b.dirty),
    changed: changedIds(state, new Set(visible.map((b) => b.id))).length,
    autoPlan: settings.seminarAutoPlan,
  };
}

export async function createTopic(ctx: Ctx, input: SeminarTopicInput, actor: StaffPrincipal): Promise<SeminarsSummary> {
  const next = (await ctx.db.execute<{ next: number }>(sql`select coalesce(max(sort), 0)::int + 1 as next from seminar_topics`)).rows[0]!.next;
  const [row] = await ctx.db
    .insert(schema.seminarTopics)
    .values({ title: input.title, host: input.host ?? null, description: input.description ?? null, hidden: input.hidden, sort: next })
    .returning();
  await ensureSessions(ctx, actor);
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'seminar_topic.create', entity: 'seminar_topic', entityId: row!.id, after: row });
  return seminarsSummary(ctx.db);
}

/** Название, спикер и описание правятся в теме - и сразу во всех её сеансах. */
export async function updateTopic(ctx: Ctx, id: number, patch: Partial<SeminarTopicInput>, actor: StaffPrincipal): Promise<SeminarsSummary> {
  const before = await ctx.db.query.seminarTopics.findFirst({ where: eq(schema.seminarTopics.id, id) });
  if (!before) throw notFound('Тема не найдена');
  const [row] = await ctx.db
    .update(schema.seminarTopics)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.host !== undefined ? { host: patch.host ?? null } : {}),
      ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
      ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
    })
    .where(eq(schema.seminarTopics.id, id))
    .returning();
  if (patch.title !== undefined || patch.host !== undefined || patch.description !== undefined) {
    const sessions = await ctx.db.query.activities.findMany({ where: eq(schema.activities.topicId, id) });
    for (const s of sessions) {
      await updateActivity(ctx, s.id, { title: row!.title, host: row!.host, description: row!.description }, actor);
    }
  }
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'seminar_topic.update', entity: 'seminar_topic', entityId: id, before, after: row });
  return seminarsSummary(ctx.db);
}

/** Удалить тему вместе с сеансами; записавшимся - сообщение, голоса за неё снимаются. */
export async function deleteTopic(ctx: Ctx, id: number, actor: StaffPrincipal): Promise<SeminarsSummary> {
  const topic = await ctx.db.query.seminarTopics.findFirst({ where: eq(schema.seminarTopics.id, id) });
  if (!topic) throw notFound('Тема не найдена');
  await ctx.db.transaction(async (tx) => {
    const inTx = { ...ctx, db: tx as unknown as typeof ctx.db };
    const sessions = await tx.query.activities.findMany({ where: eq(schema.activities.topicId, id) });
    for (const s of sessions) await deleteActivity(inTx, actor, s.id);
    await tx.delete(schema.seminarTopics).where(eq(schema.seminarTopics.id, id));
    await audit(tx, { actorUserId: actor.user.id, action: 'seminar_topic.delete', entity: 'seminar_topic', entityId: id, before: topic });
  });
  // Удалили дубль темы, у которой был сеанс только в одном потоке, - у оставшихся тем сеансы во всех потоках.
  await ensureSessions(ctx, actor);
  return seminarsSummary(ctx.db);
}

// ---------- распределение и публикация (админка) ----------

/**
 * Разложить проголосовавших по сеансам. Без reset - тех, у кого в каком-то потоке ещё нет места, тех, кто передумал,
 * и тех, чей сеанс остался без зала (остальных не трогаем). reset - заново всех, кроме ручных переносов админа.
 */
export async function distributeSeminars(ctx: Ctx, reset: boolean, actor: StaffPrincipal): Promise<{ placed: number }> {
  await ensureSessions(ctx, actor);
  return planSeats(ctx.db, reset, actor.user.id);
}

/**
 * Автоматическое распределение (настройка, по умолчанию включено) - после каждого выбора тем и правок тем, потоков и залов.
 * До публикации - заново всех: участники мест ещё не видят, а залы подстраиваются под людей. После - только новых,
 * передумавших и оставшихся без зала: остальные уже получили сообщение со своим залом.
 */
export async function autoPlanSeminars(ctx: Pick<AppContext, 'db' | 'log'>, actorUserId: number | null): Promise<void> {
  try {
    if (!(await getSettings(ctx.db)).seminarAutoPlan) return;
    const blocks = await visibleBlocks(ctx.db);
    if (blocks.length === 0) return;
    await planSeats(ctx.db, blocks.every((b) => b.roomsPublishedAt === null), actorUserId, true);
  } catch (err) {
    // Выбор уже сохранён: не вышло разложить сейчас - разложит следующий выбор или кнопка «Распределить».
    ctx.log.error({ err }, 'seminar auto plan failed');
  }
}

export async function setSeminarAutoPlan(ctx: Pick<AppContext, 'db' | 'log'>, on: boolean, actor: StaffPrincipal): Promise<SeminarsSummary> {
  await patchSettings(ctx.db, { seminarAutoPlan: on }, actor.user.id);
  if (on) await autoPlanSeminars(ctx, actor.user.id);
  return seminarsSummary(ctx.db);
}

async function planSeats(db: Ctx['db'], reset: boolean, actorUserId: number | null, auto = false): Promise<{ placed: number }> {
  return db.transaction(async (tx) => {
    // Два распределения одновременно не раздают одно и то же дважды.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('seminar_plan'))`);
    const blocks = await visibleBlocks(tx);
    const visibleIds = new Set(blocks.map((b) => b.id));
    const { rooms, sessions, plan: current, planFor } = await roomPlan(tx, blocks);
    const state = await seatState(tx);
    // Заново: места, поставленные распределением, считаем свободными; ручные переносы остаются.
    // Без reset пересаживаем передумавших (и тех, кого переносили вручную, но они потом выбрали другое)
    // и тех, чей сеанс остался без зала - например, у потока убрали зал.
    const movable = state.regs.filter(
      (r) =>
        visibleIds.has(r.blockId) &&
        ((reset && r.planned) || changedMind(state, r) || (r.planned && (current.get(r.activityId) ?? null) === null)),
    );
    const moving = new Set(movable);
    const load = new Map(state.load);
    const fixedOf = new Map<number, Map<number, number>>();
    for (const r of state.regs) {
      if (!visibleIds.has(r.blockId)) continue;
      if (moving.has(r)) {
        if (r.registered) load.set(r.activityId, (load.get(r.activityId) ?? 0) - 1);
        continue;
      }
      const map = fixedOf.get(r.participantId) ?? new Map<number, number>();
      map.set(r.blockId, r.topicId);
      fixedOf.set(r.participantId, map);
    }
    const streamsFor = (plan: Map<number, number | null>): PlanStream[] =>
      blocks.map((b) => {
        const byId = new Map((rooms.get(b.id) ?? []).map((r) => [r.id, r]));
        return {
          blockId: b.id,
          sessions: sessions
            .filter((s) => s.blockId === b.id && s.topicId !== null && (plan.get(s.id) ?? null) !== null)
            .map((s) => ({ id: s.id, topicId: s.topicId!, capacity: byId.get(plan.get(s.id)!)!.capacity })),
        };
      });
    const people: PlanPerson[] = [...state.chosen].map(([pid, topics]) => ({
      id: pid,
      family: state.family.get(pid)!,
      topics,
      fixed: fixedOf.get(pid) ?? new Map(),
    }));
    // Залы зависят от того, сколько людей в сеансе, а люди - от вместимости залов:
    // раскладываем, пересчитываем залы по новой раскладке и повторяем, пока залы не перестанут меняться.
    let plan = current;
    let result = planPeople(streamsFor(plan), people, load);
    for (let round = 0; round < 3; round++) {
      const after = new Map(load);
      for (const seats of result.values()) for (const st of seats) after.set(st.sessionId, (after.get(st.sessionId) ?? 0) + 1);
      const next = planFor(after);
      if ([...next].every(([id, room]) => plan.get(id) === room)) break;
      plan = next;
      result = planPeople(streamsFor(plan), people, load);
    }
    const wanted = new Set([...result].flatMap(([pid, seats]) => seats.map((s) => `${pid}:${s.sessionId}`)));
    // Совпало с прежним местом - не трогаем: сообщение после публикации получат только те, у кого поменялось.
    const stale = movable.filter((r) => !(r.registered && wanted.has(`${r.participantId}:${r.activityId}`)));
    const staleSet = new Set(stale);
    const kept = new Set(movable.filter((r) => !staleSet.has(r)).map((r) => `${r.participantId}:${r.activityId}`));
    for (let i = 0; i < stale.length; i += 500) {
      const pairs = stale.slice(i, i + 500).map((r) => `(${Number(r.participantId)}, ${Number(r.activityId)})`);
      await tx.execute(sql`
        update activity_registrations set status = 'cancelled', updated_at = now()
         where (participant_id, activity_id) in (values ${sql.raw(pairs.join(', '))})`);
    }
    const rows = [...result]
      .flatMap(([participantId, seats]) => seats.map((s) => ({ participantId, activityId: s.sessionId })))
      .filter((r) => !kept.has(`${r.participantId}:${r.activityId}`));
    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(schema.activityRegistrations)
        .values(rows.slice(i, i + 500).map((r) => ({ ...r, status: 'registered', planned: true, registeredBy: actorUserId })))
        .onConflictDoUpdate({
          target: [schema.activityRegistrations.activityId, schema.activityRegistrations.participantId],
          set: { status: 'registered', planned: true, registeredBy: actorUserId, updatedAt: sql`now()`, queuedAt: sql`clock_timestamp()` },
        });
    }
    // Автоматическое распределение после каждого выбора - в журнал, только если что-то поменялось.
    if (!auto || rows.length > 0 || stale.length > 0) {
      await audit(tx, {
        actorUserId,
        action: 'seminar.plan',
        entity: 'seminar_block',
        entityId: null,
        after: { reset, auto, people: result.size, added: rows.length, removed: stale.length },
      });
    }
    return { placed: result.size };
  });
}

/** Админ переносит человека на другой сеанс потока (или убирает из потока). Повторное «Распределить» перенос не трогает. */
export async function moveSeminarPerson(ctx: Ctx, input: SeminarMoveInput, actor: StaffPrincipal): Promise<{ ok: true }> {
  const p = await ctx.db.query.participants.findFirst({ where: eq(schema.participants.id, input.participantId) });
  if (!p || p.status !== 'active') throw notFound('Участник не найден');
  const sessions = await ctx.db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(and(eq(schema.activities.blockId, input.blockId), ne(schema.activities.status, 'cancelled')));
  const ids = sessions.map((s) => s.id);
  if (input.activityId !== null && !ids.includes(input.activityId)) throw badRequest('session_not_in_block', 'Этот семинар не из этого потока');
  await ctx.db.transaction(async (tx) => {
    const others = ids.filter((id) => id !== input.activityId);
    if (others.length) {
      await tx
        .update(schema.activityRegistrations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(schema.activityRegistrations.participantId, input.participantId),
            inArray(schema.activityRegistrations.activityId, others),
            inArray(schema.activityRegistrations.status, ['registered', 'waitlist']),
          ),
        );
    }
    if (input.activityId !== null) {
      await tx
        .insert(schema.activityRegistrations)
        .values({ activityId: input.activityId, participantId: input.participantId, status: 'registered', planned: false, registeredBy: actor.user.id })
        .onConflictDoUpdate({
          target: [schema.activityRegistrations.activityId, schema.activityRegistrations.participantId],
          set: { status: 'registered', planned: false, registeredBy: actor.user.id, updatedAt: sql`now()` },
        });
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'seminar.move', entity: 'participant', entityId: input.participantId, after: input });
  });
  return { ok: true };
}

function changedIds(state: SeatState, visibleIds: Set<number>): number[] {
  return [...new Set(state.regs.filter((r) => r.registered && visibleIds.has(r.blockId) && changedMind(state, r)).map((r) => r.participantId))];
}

/** Кто поменял выбор после распределения: где сидит сейчас и что выбрал теперь. */
export async function changedPeople(db: DbLike): Promise<SeminarChangedRow[]> {
  const blocks = await visibleBlocks(db);
  const visibleIds = new Set(blocks.map((b) => b.id));
  const state = await seatState(db);
  const ids = changedIds(state, visibleIds);
  if (ids.length === 0) return [];
  const [people, topics] = await Promise.all([
    db.query.participants.findMany({ where: inArray(schema.participants.id, ids) }),
    db.select({ id: schema.seminarTopics.id, title: schema.seminarTopics.title }).from(schema.seminarTopics),
  ]);
  const title = new Map(topics.map((t) => [t.id, t.title]));
  const order = new Map(blocks.map((b, i) => [b.id, i]));
  return people
    .map((p) => {
      const seats = state.regs
        .filter((r) => r.participantId === p.id && r.registered && visibleIds.has(r.blockId))
        .sort((a, b) => order.get(a.blockId)! - order.get(b.blockId)!);
      const wants = state.chosen.get(p.id) ?? [];
      return {
        participantId: p.id,
        fullName: fullName(p),
        age: ageOrNull(p.birthDate),
        now: seats.map((r) => title.get(r.topicId) ?? ''),
        dropped: seats.filter((r) => changedMind(state, r)).map((r) => title.get(r.topicId) ?? ''),
        wants: wants.map((t) => title.get(t) ?? ''),
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
}

/** Кто проголосовал, но в этом потоке без места. */
export async function unplacedPeople(db: DbLike, blockId: number): Promise<SeminarUnplacedRow[]> {
  const block = await db.query.seminarBlocks.findFirst({ where: eq(schema.seminarBlocks.id, blockId) });
  if (!block) throw notFound('Поток семинаров не найден');
  const state = await seatState(db);
  const ids = [...state.chosen].filter(([pid, topics]) => isUnplaced(blockId, topics, state.seats.get(pid))).map(([pid]) => pid);
  if (ids.length === 0) return [];
  const [people, topics] = await Promise.all([
    db.query.participants.findMany({ where: inArray(schema.participants.id, ids) }),
    db.select({ id: schema.seminarTopics.id, title: schema.seminarTopics.title }).from(schema.seminarTopics),
  ]);
  const title = new Map(topics.map((t) => [t.id, t.title]));
  return people
    .map((p) => ({
      participantId: p.id,
      fullName: fullName(p),
      age: ageOrNull(p.birthDate),
      topics: (state.chosen.get(p.id) ?? []).map((t) => title.get(t) ?? ''),
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));
}

/**
 * Опубликовать распределение: сеансы с залом открываются участникам (зал, вместимость), без зала - прячутся;
 * голосование остаётся как было (закрывают переключателем). Сообщение - каждому аккаунту, у кого что-то поменялось (в первый раз - всем распределённым).
 */
export async function publishSeminars(ctx: Ctx, actor: StaffPrincipal): Promise<SeminarsSummary> {
  await ensureSessions(ctx, actor);
  const published = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('seminar_plan'))`);
    const blocks = await visibleBlocks(tx);
    if (blocks.length === 0) throw badRequest('no_streams', 'Нет ни одного видимого потока семинаров');
    const { rooms, sessions, plan } = await roomPlan(tx, blocks);
    const last = blocks.every((b) => b.roomsPublishedAt !== null)
      ? new Date(Math.min(...blocks.map((b) => b.roomsPublishedAt!.getTime())))
      : null;
    const changedRoom: number[] = [];
    const opened: number[] = [];
    for (const s of sessions) {
      const room = (rooms.get(s.blockId) ?? []).find((r) => r.id === plan.get(s.id)) ?? null;
      if (room) {
        await tx
          .update(schema.activities)
          .set({ status: 'published', roomId: room.id, location: room.name, capacity: room.capacity, updatedAt: new Date() })
          .where(eq(schema.activities.id, s.id));
        if (s.roomId !== room.id || s.status !== 'published') changedRoom.push(s.id);
        opened.push(s.id);
      } else if (s.status === 'published' || s.roomId !== null) {
        await tx
          .update(schema.activities)
          .set({ status: 'draft', roomId: null, location: null, updatedAt: new Date() })
          .where(eq(schema.activities.id, s.id));
        changedRoom.push(s.id);
      }
    }
    const ids = sessions.map((s) => s.id);
    let people: number[] = [];
    if (ids.length) {
      const res = await tx.execute<{ pid: string }>(sql`
        select distinct ar.participant_id as pid
          from activity_registrations ar
         where ar.activity_id in ${sql.raw(`(${ids.join(',')})`)}
           and (${last === null ? sql`ar.status = 'registered'` : sql`ar.updated_at > ${last}`}
                ${changedRoom.length ? sql`or (ar.status = 'registered' and ar.activity_id in ${sql.raw(`(${changedRoom.join(',')})`)})` : sql``})`);
      people = res.rows.map((r) => Number(r.pid));
    }
    await tx
      .update(schema.seminarBlocks)
      // Выбор не закрываем: кто передумает, попадёт в «Поменяли выбор», его пересадят следующим распределением.
      .set({ roomsPublishedAt: sql`now()` })
      .where(inArray(schema.seminarBlocks.id, blocks.map((b) => b.id)));
    if (people.length) await enqueue(ctx.boss, 'seminar.assigned', { participantIds: people }, { tx });
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'seminar.publish',
      entity: 'seminar_block',
      entityId: null,
      after: { sessions: opened, notified: people.length },
    });
    return opened;
  });
  // Напоминание за 15 минут - у открытых сеансов (повторы склеиваются по ключу).
  for (const id of published) {
    const row = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, id) });
    if (row) await scheduleReminder(ctx, row);
  }
  return seminarsSummary(ctx.db);
}

// ---------- участник ----------

const EMPTY: SeminarsPublic = { open: false, published: false, picks: 0, topics: [], votes: [], sessions: [], waiting: [] };

/** Голосование за темы и (после публикации) свои сеансы с залами. Нет видимых потоков - пусто. */
export async function publicSeminars(ctx: Pick<AppContext, 'db'>, userId: number): Promise<SeminarsPublic> {
  const blocks = await visibleBlocks(ctx.db);
  if (blocks.length === 0) return EMPTY;
  const topics = await ctx.db.query.seminarTopics.findMany({
    where: eq(schema.seminarTopics.hidden, false),
    orderBy: [asc(schema.seminarTopics.sort), asc(schema.seminarTopics.id)],
  });
  if (topics.length === 0) return EMPTY;
  const family = await activeFamilyIds(ctx, [userId]);
  // Семинары - только зарегистрированным: остальные сначала регистрируются.
  if (family.length === 0) return EMPTY;
  const votes = family.length
    ? await ctx.db
        .select()
        .from(schema.seminarVotes)
        .where(inArray(schema.seminarVotes.participantId, family))
        .orderBy(asc(schema.seminarVotes.createdAt), asc(schema.seminarVotes.topicId))
    : [];
  const visibleTopic = new Set(topics.map((t) => t.id));
  const published = blocks.some((b) => b.roomsPublishedAt !== null);
  let sessions: SeminarsPublic['sessions'] = [];
  if (published && family.length) {
    const ids = await ctx.db
      .select({ id: schema.activities.id })
      .from(schema.activities)
      .where(
        and(
          inArray(schema.activities.blockId, blocks.map((b) => b.id)),
          eq(schema.activities.status, 'published'),
        ),
      );
    sessions = (await listActivities(ctx, { userId, ids: ids.map((r) => r.id) })).filter((a) =>
      a.my.some((m) => m.status === 'registered'),
    );
  }
  // Как changedMind в админке: сидит на теме, которую больше не выбирает, и поменял выбор после того, как посадили.
  const waiting = published && family.length
    ? await ctx.db.execute<{ pid: string }>(sql`
        select distinct ar.participant_id as pid
          from activity_registrations ar
          join activities a on a.id = ar.activity_id and a.status <> 'cancelled'
                           and a.block_id in ${sql.raw(`(${blocks.map((b) => Number(b.id)).join(',')})`)}
         where ar.participant_id in ${sql.raw(`(${family.map(Number).join(',')})`)}
           and ar.status = 'registered'
           and exists (select 1 from seminar_votes v join seminar_topics t on t.id = v.topic_id and not t.hidden
                        where v.participant_id = ar.participant_id)
           and not exists (select 1 from seminar_votes v where v.participant_id = ar.participant_id and v.topic_id = a.topic_id)
           and (ar.planned or (select max(v.created_at) from seminar_votes v where v.participant_id = ar.participant_id) > ar.updated_at)`)
    : { rows: [] };
  return {
    open: blocks.some((b) => b.registrationOpen),
    published,
    picks: Math.min(blocks.length, topics.length),
    topics: topics.map((t) => ({ id: t.id, title: t.title, host: t.host, description: t.description })),
    votes: family.map((participantId) => ({
      participantId,
      topicIds: votes.filter((v) => v.participantId === participantId && visibleTopic.has(v.topicId)).map((v) => v.topicId),
    })),
    sessions,
    waiting: waiting.rows.map((r) => Number(r.pid)),
  };
}

/** Выбор тем за человека из семьи: заменяет прежний выбор целиком. */
export async function saveSeminarVotes(ctx: Pick<AppContext, 'db' | 'log'>, user: UserRow, input: SeminarVotesInput): Promise<SeminarsPublic> {
  const p = await assertFamilyMember(ctx, user.id, input.participantId);
  if (p.status !== 'active') throw notFound('Участник не найден');
  const state = await publicSeminars(ctx, user.id);
  if (!state.open) throw conflict('voting_closed', 'Выбор тем закрыт');
  const topicIds = [...new Set(input.topicIds)];
  if (topicIds.length > state.picks) throw badRequest('too_many_topics', `Можно выбрать не больше ${state.picks}`);
  const known = new Set(state.topics.map((t) => t.id));
  if (topicIds.some((t) => !known.has(t))) throw notFound('Тема не найдена');
  await ctx.db.transaction(async (tx) => {
    await tx.delete(schema.seminarVotes).where(eq(schema.seminarVotes.participantId, input.participantId));
    if (topicIds.length) {
      await tx.insert(schema.seminarVotes).values(topicIds.map((topicId) => ({ participantId: input.participantId, topicId, userId: user.id })));
    }
  });
  await autoPlanSeminars(ctx, user.id);
  return publicSeminars(ctx, user.id);
}
