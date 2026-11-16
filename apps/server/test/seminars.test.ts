import { randomUUID } from 'node:crypto';
import type { RoomView } from '@sof/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Api } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { runJob } from '../src/jobs/workers.ts';
import { registerForActivity } from '../src/services/activity.service.ts';
import {
  changedPeople,
  createBlock,
  createTopic,
  deleteTopic,
  distributeSeminars,
  getBlock,
  listRooms,
  moveSeminarPerson,
  planPeople,
  planRooms,
  publicSeminars,
  publishSeminars,
  saveSeminarVotes,
  seminarsSummary,
  setAllBlocksRegistration,
  setSeminarAutoPlan,
  unplacedPeople,
  type PlanPerson,
} from '../src/services/seminar.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

const room = (id: number, name: string, capacity: number): RoomView => ({ id, name, capacity, note: null, sort: id });

// Как на конференции: в первом потоке есть Основной зал, во втором - нет.
const STREAM1 = [
  room(1, 'Основной зал церкви', 1000),
  room(2, '324 ауд. ТИ', 170),
  room(3, 'Малый зал церкви', 120),
  room(4, 'Столовая ТИ', 80),
  room(5, '325 ауд. ТИ', 70),
  room(6, '220 ауд. ТИ', 64),
  room(7, '221 ауд. ТИ', 60),
];
const STREAM2 = STREAM1.slice(1);
// Сеанс темы t в потоке b: id = b * 100 + t.
const sessions = (b: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: b * 100 + i + 1, topicId: i + 1, plannedRoomId: null as number | null, keepRoomId: null as number | null, hidden: false }));

describe('залы по голосам', () => {
  it('самая популярная тема - один раз, в первом потоке, в самом большом зале; остальные - в обоих', () => {
    const votes = new Map([
      [1, 50],
      [2, 400],
      [3, 120],
      [4, 300],
      [5, 90],
      [6, 30],
      [7, 10],
    ]);
    const plan = planRooms(
      [
        { id: 1, rooms: STREAM1, sessions: sessions(1, 7) },
        { id: 2, rooms: STREAM2, sessions: sessions(2, 7) },
      ],
      votes,
    );
    expect(plan.get(102)).toBe(1); // 400 голосов → Основной зал
    expect(plan.get(202)).toBeNull(); // во втором потоке её нет
    expect(plan.get(104)).toBe(2); // 300 → 324 ауд. в обоих потоках
    expect(plan.get(204)).toBe(2);
    expect(plan.get(103)).toBe(3);
    expect(plan.get(203)).toBe(3);
    expect(plan.get(107)).toBe(7);
    expect(plan.get(207)).toBe(7);
  });

  it('ручной зал админа остаётся, остальные раскладываются вокруг', () => {
    const s1 = sessions(1, 3);
    s1[2]!.plannedRoomId = 1;
    const plan = planRooms([{ id: 1, rooms: STREAM1.slice(0, 2), sessions: s1 }], new Map([[1, 300]]));
    expect(plan.get(103)).toBe(1);
    expect(plan.get(101)).toBe(2);
    expect(plan.get(102)).toBeNull();
  });

  it('опубликованный зал остаётся за сеансом, даже если голоса поменялись; ручной зал админа важнее', () => {
    const s1 = sessions(1, 3);
    s1[0]!.keepRoomId = 2;
    s1[1]!.keepRoomId = 1;
    const plan = planRooms([{ id: 1, rooms: STREAM1.slice(0, 2), sessions: s1 }], new Map([[1, 300], [3, 200]]));
    expect([plan.get(101), plan.get(102), plan.get(103)]).toEqual([2, 1, null]);
    s1[2]!.plannedRoomId = 1;
    const manual = planRooms([{ id: 1, rooms: STREAM1.slice(0, 2), sessions: s1 }], new Map([[1, 300]]));
    expect([manual.get(101), manual.get(102), manual.get(103)]).toEqual([2, null, 1]);
  });

  it('залы по числу людей в сеансе: 19 человек - в малый зал, 42 - в большой; пока людей нет - по голосам', () => {
    const rooms = [room(2, '324 ауд. ТИ', 170), room(7, '221 ауд. ТИ', 60)];
    const block = { id: 1, rooms, sessions: sessions(1, 2) };
    const votes = new Map([[1, 131], [2, 87]]);
    expect([...planRooms([block], votes)]).toEqual([[101, 2], [102, 7]]);
    expect([...planRooms([block], votes, new Map(), new Map([[101, 19], [102, 42]]))]).toEqual([[101, 7], [102, 2]]);
  });
});

describe('люди по сеансам', () => {
  const streams = [
    { blockId: 1, sessions: [{ id: 101, topicId: 1, capacity: 1000 }, { id: 102, topicId: 2, capacity: 50 }, { id: 103, topicId: 3, capacity: 50 }] },
    { blockId: 2, sessions: [{ id: 202, topicId: 2, capacity: 50 }, { id: 203, topicId: 3, capacity: 50 }] },
  ];
  const person = (id: number, topics: number[], family = id): PlanPerson => ({ id, family, topics, fixed: new Map() });

  it('каждому по теме в каждом потоке, разные; тема «один раз» - в первом потоке', () => {
    const people = [person(1, [1, 2]), person(2, [3, 1]), person(3, [2, 3]), person(4, [2, 3]), person(5, [2, 3]), person(6, [2, 3])];
    const plan = planPeople(streams, people, new Map());
    expect(plan.get(1)).toEqual([
      { blockId: 1, sessionId: 101 },
      { blockId: 2, sessionId: 202 },
    ]);
    expect(plan.get(2)).toEqual([
      { blockId: 1, sessionId: 101 },
      { blockId: 2, sessionId: 203 },
    ]);
    for (const id of [3, 4, 5, 6]) {
      const seats = plan.get(id)!;
      expect(seats.map((s) => s.blockId)).toEqual([1, 2]);
      expect(new Set(seats.map((s) => s.sessionId % 100)).size).toBe(2);
    }
    // Выбравшие 2 и 3 делятся поровну: по двое в каждом потоке на каждой теме.
    const count = (sid: number) => [...plan.values()].flat().filter((s) => s.sessionId === sid).length;
    expect(count(102)).toBe(2);
    expect(count(103)).toBe(2);
  });

  it('семья с одинаковым выбором - вместе; кто уже стоит в потоке - получает другой', () => {
    const fixed = new Map([[1, 3]]);
    const plan = planPeople(
      streams,
      [person(1, [2, 3], 9), person(2, [2, 3], 9), { id: 3, family: 3, topics: [2, 3], fixed }],
      new Map(),
    );
    expect(plan.get(1)).toEqual(plan.get(2));
    expect(plan.get(3)).toEqual([{ blockId: 2, sessionId: 202 }]);
  });

  it('не влезают - перебор поровну, а не в одном зале', () => {
    const tight = [
      { blockId: 1, sessions: [{ id: 102, topicId: 2, capacity: 3 }, { id: 103, topicId: 3, capacity: 3 }] },
      { blockId: 2, sessions: [{ id: 202, topicId: 2, capacity: 3 }, { id: 203, topicId: 3, capacity: 3 }] },
    ];
    const people = Array.from({ length: 8 }, (_, i) => person(i + 1, [2, 3]));
    const plan = planPeople(tight, people, new Map());
    const count = (sid: number) => [...plan.values()].flat().filter((s) => s.sessionId === sid).length;
    expect([count(102), count(103), count(202), count(203)]).toEqual([4, 4, 4, 4]);
  });
});

describe('голосование, распределение и публикация', () => {
  it('от выбора тем до сообщения с залами', async () => {
    const admin = await makeStaff(env, ['admin']);
    // Ручной режим: распределяет только кнопка.
    await setSeminarAutoPlan(env, false, admin);
    const rooms = await listRooms(env.db);
    const big = rooms.find((r) => r.name === 'Основной зал церкви')!;
    const mid = rooms.find((r) => r.name === '324 ауд. ТИ')!;
    const small = rooms.find((r) => r.name === '221 ауд. ТИ')!;
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const b1 = await createBlock(env, { title: 'Поток 1', startsAt: at(48), endsAt: at(49), roomIds: [big.id, mid.id, small.id], registrationOpen: false, hidden: false }, admin);
    const b2 = await createBlock(env, { title: 'Поток 2', startsAt: at(50), endsAt: at(51), roomIds: [mid.id, small.id], registrationOpen: false, hidden: false }, admin);
    let summary = await createTopic(env, { title: 'После смерти', host: 'Поднюк', description: null, hidden: false }, admin);
    summary = await createTopic(env, { title: 'Апологетика', host: null, description: null, hidden: false }, admin);
    summary = await createTopic(env, { title: 'Дофамин', host: null, description: null, hidden: false }, admin);
    const [death, apol, dopa] = summary.topics.map((t) => t.id) as [number, number, number];
    // У каждой темы - сеанс в каждом потоке, участникам пока не виден.
    expect((await getBlock(env.db, b1.id)).topics.map((t) => t.topicId)).toEqual([death, apol, dopa]);
    expect((await getBlock(env.db, b2.id)).topics.every((t) => t.status === 'draft')).toBe(true);
    expect(summary.picks).toBe(2);

    const owner = await makeUser(env);
    const { participant: me } = await makeParticipant(env, owner);
    const { participant: kid } = await makeParticipant(env, owner, { firstName: 'Ребёнок' });
    const stranger = await makeUser(env);
    const { participant: other } = await makeParticipant(env, stranger);

    // Закрыто - выбрать нельзя; сам на сеанс записаться нельзя никогда.
    await expect(saveSeminarVotes(env, owner, { participantId: me.id, topicIds: [death] })).rejects.toMatchObject({ code: 'voting_closed' });
    await setAllBlocksRegistration(env, true, admin);
    await expect(saveSeminarVotes(env, owner, { participantId: me.id, topicIds: [death, apol, dopa] })).rejects.toMatchObject({
      code: 'too_many_topics',
    });
    await expect(saveSeminarVotes(env, owner, { participantId: other.id, topicIds: [death] })).rejects.toMatchObject({ statusCode: 404 });
    let pub = await saveSeminarVotes(env, owner, { participantId: me.id, topicIds: [apol] });
    pub = await saveSeminarVotes(env, owner, { participantId: me.id, topicIds: [death, apol] });
    pub = await saveSeminarVotes(env, owner, { participantId: kid.id, topicIds: [apol, dopa] });
    expect(pub.votes.find((v) => v.participantId === me.id)!.topicIds.sort()).toEqual([death, apol].sort());
    expect(pub.topics.map((t) => t.title)).toEqual(['После смерти', 'Апологетика', 'Дофамин']);
    await saveSeminarVotes(env, stranger, { participantId: other.id, topicIds: [death, dopa] });
    const session = (await getBlock(env.db, b1.id)).topics[0]!;
    expect((await registerForActivity(env, owner, session.id, me.id).catch(() => ({ outcome: 'not_open' }))).outcome).toBe('not_open');

    // Самая популярная тема («После смерти», 2 голоса) - только в первом потоке, в Основном зале.
    const s1 = await getBlock(env.db, b1.id);
    const s2 = await getBlock(env.db, b2.id);
    const sessionOf = (b: typeof s1, topicId: number) => b.topics.find((t) => t.topicId === topicId)!;
    expect(sessionOf(s1, death).roomId).toBe(big.id);
    expect(sessionOf(s2, death).roomId).toBeNull();

    expect((await distributeSeminars(env, false, admin)).placed).toBe(3);
    const seatsOf = async (pid: number) =>
      (
        await env.db
          .select({ id: schema.activityRegistrations.activityId })
          .from(schema.activityRegistrations)
          .where(and(eq(schema.activityRegistrations.participantId, pid), eq(schema.activityRegistrations.status, 'registered')))
      )
        .map((r) => r.id)
        .sort();
    expect(await seatsOf(me.id)).toEqual([sessionOf(s1, death).id, sessionOf(s2, apol).id].sort());
    expect(await seatsOf(other.id)).toEqual([sessionOf(s1, death).id, sessionOf(s2, dopa).id].sort());
    const kidSeats = await seatsOf(kid.id);
    expect(kidSeats).toHaveLength(2);
    expect((await unplacedPeople(env.db, b1.id)).length).toBe(0);

    // До публикации участник своих сеансов не видит.
    expect((await publicSeminars(env, owner.id)).sessions).toEqual([]);
    expect((await seminarsSummary(env.db)).dirty).toBe(true);

    await publishSeminars(env, admin);
    const jobs = await env.pool.query(`select data from pgboss.job where name = 'seminar.assigned' order by created_on`);
    expect(jobs.rows.at(-1)!.data.participantIds.sort()).toEqual([me.id, kid.id, other.id].sort());
    // Сообщение - одно на аккаунт, вся семья: время, тема, зал.
    const calls: { method: string; p: Record<string, unknown> }[] = [];
    const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
    tg.config.use(async (_prev, method, payload) => {
      calls.push({ method, p: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: 1, type: 'private' }, text: '' } } as never;
    });
    await runJob({ ...env, tg }, 'seminar.assigned', { participantIds: [kid.id] }, randomUUID());
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    const text = sent[0]!.p.text as string;
    expect(text).toContain('Ваши семинары');
    expect(text).toContain('«<b>После смерти</b>» · Основной зал церкви');
    expect(text).toContain('Ребёнок');

    const after = await publicSeminars(env, owner.id);
    expect(after.open).toBe(true); // публикация выбор не закрывает: передумавших пересаживают потом
    expect(after.sessions.find((a) => a.id === sessionOf(s1, death).id)!.location).toBe('Основной зал церкви');
    const hidden = await env.db.query.activities.findFirst({ where: eq(schema.activities.id, sessionOf(s2, death).id) });
    expect(hidden!.status).toBe('draft');
    expect((await seminarsSummary(env.db)).dirty).toBe(false);

    // Админ перенёс ребёнка - «Распределить заново» перенос не трогает, повторная публикация - только ему.
    const target = kidSeats.includes(sessionOf(s2, apol).id) ? sessionOf(s2, dopa).id : sessionOf(s2, apol).id;
    await moveSeminarPerson(env, { participantId: kid.id, blockId: b2.id, activityId: target }, admin);
    await distributeSeminars(env, true, admin);
    expect(await seatsOf(kid.id)).toContain(target);
    expect((await seminarsSummary(env.db)).dirty).toBe(true);
    await publishSeminars(env, admin);
    const again = await env.pool.query(`select data from pgboss.job where name = 'seminar.assigned' order by created_on`);
    expect(again.rows.at(-1)!.data.participantIds).toContain(kid.id);
    expect(again.rows.at(-1)!.data.participantIds).not.toContain(other.id);

    // Голосование и выбор живут в отдельных таблицах - записи на сеансы только через распределение.
    const regs = await env.db.query.activityRegistrations.findMany({
      where: inArray(schema.activityRegistrations.participantId, [me.id, other.id]),
    });
    expect(regs.every((r) => r.planned)).toBe(true);
  });

  it('удалили дубль темы из одного потока - у оставшейся темы сеанс появляется во всех потоках', async () => {
    const admin = await makeStaff(env, ['admin']);
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const a = await createBlock(env, { title: 'Дубли 1', startsAt: at(80), endsAt: at(81), roomIds: [], registrationOpen: false, hidden: false }, admin);
    const b = await createBlock(env, { title: 'Дубли 2', startsAt: at(82), endsAt: at(83), roomIds: [], registrationOpen: false, hidden: false }, admin);
    const keep = (await createTopic(env, { title: 'Тема-оригинал', host: null, description: null, hidden: false }, admin)).topics.at(-1)!;
    const dup = (await createTopic(env, { title: 'Тема-дубль', host: null, description: null, hidden: false }, admin)).topics.at(-1)!;
    // Как после правки названия в одном потоке: во втором потоке сеанс висит на дубле.
    const sessionB = (await getBlock(env.db, b.id)).topics.find((t) => t.topicId === keep.id)!;
    await env.db.delete(schema.activities).where(eq(schema.activities.id, sessionB.id));
    await env.db.update(schema.activities).set({ topicId: dup.id }).where(and(eq(schema.activities.blockId, a.id), eq(schema.activities.topicId, dup.id)));
    await deleteTopic(env, dup.id, admin);
    for (const blockId of [a.id, b.id]) {
      expect((await getBlock(env.db, blockId)).topics.some((t) => t.topicId === keep.id)).toBe(true);
    }
  });

  it('передумал после «Распределить» - повторное «Распределить» пересаживает только его', async () => {
    const admin = await makeStaff(env, ['admin']);
    await setSeminarAutoPlan(env, false, admin);
    const rooms = await listRooms(env.db);
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const roomIds = rooms.slice(1, 4).map((r) => r.id);
    // Своя пара потоков позже остальных: прошлые потоки выключаем, чтобы считать только эти.
    await env.db.update(schema.seminarBlocks).set({ hidden: true });
    const b1 = await createBlock(env, { title: 'Смена 1', startsAt: at(100), endsAt: at(101), roomIds, registrationOpen: true, hidden: false }, admin);
    const b2 = await createBlock(env, { title: 'Смена 2', startsAt: at(102), endsAt: at(103), roomIds, registrationOpen: true, hidden: false }, admin);
    await env.db.update(schema.seminarTopics).set({ hidden: true });
    const t = async (title: string) => (await createTopic(env, { title, host: null, description: null, hidden: false }, admin)).topics.at(-1)!.id;
    const [x, y, z] = [await t('Икс'), await t('Игрек'), await t('Зет')];
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner);
    const other = await makeUser(env);
    const { participant: q } = await makeParticipant(env, other);
    await saveSeminarVotes(env, owner, { participantId: p.id, topicIds: [x, y] });
    await saveSeminarVotes(env, other, { participantId: q.id, topicIds: [x, y] });
    await distributeSeminars(env, false, admin);
    const topicsOf = async (pid: number) => {
      const regs = await env.db
        .select({ topicId: schema.activities.topicId })
        .from(schema.activityRegistrations)
        .innerJoin(schema.activities, eq(schema.activities.id, schema.activityRegistrations.activityId))
        .where(
          and(
            eq(schema.activityRegistrations.participantId, pid),
            eq(schema.activityRegistrations.status, 'registered'),
            inArray(schema.activities.blockId, [b1.id, b2.id]),
          ),
        );
      return regs.map((r) => r.topicId).sort();
    };
    expect(await topicsOf(p.id)).toEqual([x, y].sort());
    const before = await env.db.query.activityRegistrations.findMany({ where: eq(schema.activityRegistrations.participantId, q.id) });

    // Выбор ещё открыт: первый поменял «Игрек» на «Зет».
    await saveSeminarVotes(env, owner, { participantId: p.id, topicIds: [x, z] });
    await distributeSeminars(env, false, admin);
    expect(await topicsOf(p.id)).toEqual([x, z].sort());
    // Второго не трогали.
    const after = await env.db.query.activityRegistrations.findMany({ where: eq(schema.activityRegistrations.participantId, q.id) });
    expect(after.map((r) => r.updatedAt.getTime())).toEqual(before.map((r) => r.updatedAt.getTime()));

    // После публикации выбор открыт: второй передумал - место за ним, пока не пересадят; админ видит его в списке.
    await publishSeminars(env, admin);
    const firstSeats = await topicsOf(q.id);
    await saveSeminarVotes(env, other, { participantId: q.id, topicIds: [x, z] });
    expect(await topicsOf(q.id)).toEqual(firstSeats);
    expect((await seminarsSummary(env.db)).changed).toBe(1);
    const changed = await changedPeople(env.db);
    expect(changed.map((c) => c.participantId)).toEqual([q.id]);
    expect(changed[0]!.dropped).toEqual(['Игрек']);
    expect(changed[0]!.wants.sort()).toEqual(['Зет', 'Икс']);
    expect((await publicSeminars(env, other.id)).waiting).toEqual([q.id]);
    expect((await publicSeminars(env, owner.id)).waiting).toEqual([]);

    // «Распределить» пересаживает, «Опубликовать» - сообщение только ему.
    await distributeSeminars(env, false, admin);
    expect(await topicsOf(q.id)).toEqual([x, z].sort());
    expect((await seminarsSummary(env.db)).changed).toBe(0);
    expect((await publicSeminars(env, other.id)).waiting).toEqual([]);
    await publishSeminars(env, admin);
    const jobs = await env.pool.query(`select data from pgboss.job where name = 'seminar.assigned' order by created_on`);
    // Залы после публикации не тасуются от голосов: первому сообщение не нужно.
    expect(jobs.rows.at(-1)!.data.participantIds).toEqual([q.id]);

    // Админ вручную посадил его на тему не из выбора - это не «передумал»; а вот новый выбор после этого - да.
    const target = [await getBlock(env.db, b1.id), await getBlock(env.db, b2.id)].flatMap((b) =>
      b.topics.filter((t) => t.topicId === y && t.status === 'published').map((t) => ({ blockId: b.id, activityId: t.id })),
    )[0]!;
    await moveSeminarPerson(env, { participantId: q.id, ...target }, admin);
    expect((await seminarsSummary(env.db)).changed).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    await saveSeminarVotes(env, other, { participantId: q.id, topicIds: [x, z] });
    expect((await seminarsSummary(env.db)).changed).toBe(1);
  });

  it('«Распределять автоматически»: выбрал темы - место сразу, передумал - пересадили; у потока убрали залы - место без зала освобождается', async () => {
    const admin = await makeStaff(env, ['admin']);
    const rooms = await listRooms(env.db);
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const roomIds = rooms.slice(1, 4).map((r) => r.id);
    await env.db.update(schema.seminarBlocks).set({ hidden: true });
    const b1 = await createBlock(env, { title: 'Авто 1', startsAt: at(200), endsAt: at(201), roomIds, registrationOpen: true, hidden: false }, admin);
    const b2 = await createBlock(env, { title: 'Авто 2', startsAt: at(202), endsAt: at(203), roomIds, registrationOpen: true, hidden: false }, admin);
    await env.db.update(schema.seminarTopics).set({ hidden: true });
    const t = async (title: string) => (await createTopic(env, { title, host: null, description: null, hidden: false }, admin)).topics.at(-1)!.id;
    const [x, y, z] = [await t('Альфа'), await t('Бета'), await t('Гамма')];
    expect((await setSeminarAutoPlan(env, true, admin)).autoPlan).toBe(true);
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner);
    const seats = async () =>
      (
        await env.db
          .select({ blockId: schema.activities.blockId, topicId: schema.activities.topicId })
          .from(schema.activityRegistrations)
          .innerJoin(schema.activities, eq(schema.activities.id, schema.activityRegistrations.activityId))
          .where(and(eq(schema.activityRegistrations.participantId, p.id), eq(schema.activityRegistrations.status, 'registered')))
      )
        .map((r) => `${r.blockId}:${r.topicId}`)
        .sort();

    // Без кнопки: «Альфа» идёт один раз (в первом потоке), «Бета» - во втором.
    await saveSeminarVotes(env, owner, { participantId: p.id, topicIds: [x, y] });
    expect(await seats()).toEqual([`${b1.id}:${x}`, `${b2.id}:${y}`]);
    await saveSeminarVotes(env, owner, { participantId: p.id, topicIds: [x, z] });
    expect(await seats()).toEqual([`${b1.id}:${x}`, `${b2.id}:${z}`]);

    // Выключили - новый выбор ждёт кнопку.
    await setSeminarAutoPlan(env, false, admin);
    await saveSeminarVotes(env, owner, { participantId: p.id, topicIds: [y, z] });
    expect(await seats()).toEqual([`${b1.id}:${x}`, `${b2.id}:${z}`]);
    await distributeSeminars(env, false, admin);
    expect(await seats()).toEqual([`${b1.id}:${y}`, `${b2.id}:${z}`]);

    // У второго потока убрали все залы: «Гамма» там без зала - место освобождается, человек «без места», а не «не влезает».
    await env.db.delete(schema.seminarBlockRooms).where(eq(schema.seminarBlockRooms.blockId, b2.id));
    expect((await getBlock(env.db, b2.id)).topics.find((r) => r.topicId === z)!.overflow).toBe(1);
    await distributeSeminars(env, false, admin);
    expect(await seats()).toEqual([`${b1.id}:${y}`]);
    const after = await getBlock(env.db, b2.id);
    expect(after.topics.every((r) => r.overflow === 0)).toBe(true);
    expect(after.unplaced).toBe(1);
  });
});
