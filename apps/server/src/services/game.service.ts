import {
  DEFAULT_GAME_CONFIG,
  GAME_TEAM_COLORS,
  countryName,
  flagEmoji,
  fullName,
  gameConfigSchema,
  teamTitle,
  type GameAdminView,
  type GameBotUser,
  type GameCandidate,
  type GameConfig,
  type GameLaunch,
  type GamePersonView,
  type GamePlayerRow,
  type GameRoundView,
  type GameScreenView,
  type GameStateView,
  type GameTaskInput,
  type GameTaskText,
  type GameTaskView,
  type GameTeamAdmin,
  type GameTeamDesign,
  type GameTeamUpdate,
  type GameTeamView,
  type GameVoteRequest,
  type Role,
} from '@sof/shared';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike, type Tx } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import { getSettings } from './settings.service.ts';
import type { UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;
type StateRow = typeof schema.gameState.$inferSelect;
type TeamRow = typeof schema.gameTeams.$inferSelect;
type TaskRow = typeof schema.gameTasks.$inferSelect;

// ---------- состояние и доступ ----------

/** Строка состояния игры; создаётся при первом обращении. `lock` - в транзакции, под блокировкой. */
async function stateRow(db: DbLike, lock = false): Promise<StateRow> {
  const read = async () => {
    const q = db.select().from(schema.gameState).where(eq(schema.gameState.id, 1));
    return (lock ? await q.for('update') : await q)[0];
  };
  // Вставляем, только если строки нет: триггер «на оператор» шлёт «game» всем даже на пустой INSERT … DO NOTHING.
  const row = await read();
  if (row) return row;
  await db.insert(schema.gameState).values({ id: 1, config: DEFAULT_GAME_CONFIG, screenToken: randomToken(18) }).onConflictDoNothing();
  return (await read())!;
}

/** Настройки поверх значений по умолчанию: новые поля не ломают старую строку. */
function configOf(row: StateRow): GameConfig {
  const parsed = gameConfigSchema.safeParse({ ...DEFAULT_GAME_CONFIG, ...(row.config as object) });
  return parsed.success ? parsed.data : DEFAULT_GAME_CONFIG;
}

/** Какой сейчас запуск: выключена, тестовый или для всех. */
export const launchOf = (config: GameConfig): GameLaunch => (!config.enabled ? 'off' : config.adminsOnly ? 'test' : 'live');

const isHost = (roles: readonly string[]) => roles.some((r) => r === 'admin' || r === 'superadmin' || r === 'host');

/** Кто видит игру в мини-апке: выключена - никто; тестовый режим - админы, ведущие и тест-лист. */
export function gameVisible(config: GameConfig, roles: readonly string[], userId: number): boolean {
  return config.enabled && (!config.adminsOnly || isHost(roles) || config.testerIds.includes(userId));
}

export async function gameFeature(db: DbLike, roles: readonly Role[], userId: number): Promise<boolean> {
  return gameVisible(configOf(await stateRow(db)), roles, userId);
}

async function teamRows(db: DbLike): Promise<TeamRow[]> {
  return db.select().from(schema.gameTeams).orderBy(asc(schema.gameTeams.sort), asc(schema.gameTeams.id));
}

/**
 * Номер команды-заглушки («Команда 3») - по порядку создания, а не по порядку выступлений:
 * ведущий перемешал выступления - у команд не должны поменяться имена, которые уже ушли в бот.
 */
function teamNumbers(teams: TeamRow[]): Map<number, number> {
  return new Map([...teams].sort((a, b) => a.id - b.id).map((t, i) => [t.id, i + 1]));
}

function teamView(t: TeamRow, number: number, extra: { captainName: string | null; size: number; points: number | null }): GameTeamView {
  return {
    id: t.id,
    number,
    title: teamTitle({ name: t.name, number }),
    placeholder: !t.name?.trim(),
    countryCode: t.countryCode,
    countryName: countryName(t.countryCode),
    flag: t.flag || flagEmoji(t.countryCode),
    color: t.color,
    ...extra,
  };
}

/**
 * Тайна до «Показать задания»: страну и флаг команде даёт ведущий - игроки и экран их пока не видят
 * (страну, которую выбрал капитан, команда и так знает - её не прячем).
 */
const countrySecret = (row: StateRow, config: GameConfig) => !row.tasksRevealedAt && config.countryBy === 'host';
const withoutCountry = <T extends GameTeamView>(v: T): T => ({ ...v, countryCode: null, countryName: null, flag: null });

async function taskRows(db: DbLike): Promise<TaskRow[]> {
  return db.select().from(schema.gameTasks).orderBy(asc(schema.gameTasks.sort), asc(schema.gameTasks.id));
}

const taskText = (t: TaskRow): GameTaskText => ({ title: t.title, context: t.context, text: t.text });

/** Очки и голосовавшие по командам (все раунды). */
async function totals(db: DbLike): Promise<Map<number, { points: number; voters: number }>> {
  const rows = await db.execute<{ team_id: string; points: number; voters: number }>(sql`
    select team_id, sum(points)::int as points, count(distinct user_id)::int as voters from game_votes group by team_id`);
  return new Map(rows.rows.map((r) => [Number(r.team_id), { points: r.points, voters: r.voters }]));
}

/** Состав команд: размер, парни/девушки, имена капитанов. */
async function teamStats(db: DbLike) {
  const rows = await db.execute<{ team_id: string; size: number; males: number; females: number }>(sql`
    select gp.team_id, count(*)::int as size,
           count(*) filter (where p.gender = 'm')::int as males,
           count(*) filter (where p.gender = 'f')::int as females
      from game_players gp join participants p on p.id = gp.participant_id
     where gp.team_id is not null and gp.answer = 'yes' and p.status = 'active'
     group by gp.team_id`);
  return new Map(rows.rows.map((r) => [Number(r.team_id), r]));
}

async function captainNames(db: DbLike, teams: TeamRow[]): Promise<Map<number, string>> {
  const ids = teams.flatMap((t) => (t.captainId ? [t.captainId] : []));
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(schema.participants).where(inArray(schema.participants.id, ids));
  return new Map(rows.map((p) => [p.id, fullName(p)]));
}

/** Раунд с истёкшим таймером закрываем при первом же обращении (задача очереди может опоздать). */
async function closeExpired(db: DbLike): Promise<void> {
  // Сначала проверяем: пустой UPDATE тоже будит триггер, и каждое чтение (экран - раз в секунду) рассылало бы «game» всем.
  const due = and(eq(schema.gameRounds.status, 'open'), isNotNull(schema.gameRounds.closesAt), sql`${schema.gameRounds.closesAt} <= now()`);
  const [expired] = await db.select({ id: schema.gameRounds.id }).from(schema.gameRounds).where(due).limit(1);
  if (!expired) return;
  await db
    .update(schema.gameRounds)
    .set({ status: 'closed', closedAt: sql`${schema.gameRounds.closesAt}` })
    .where(and(eq(schema.gameRounds.status, 'open'), isNotNull(schema.gameRounds.closesAt), sql`${schema.gameRounds.closesAt} <= now()`));
}

async function openRound(db: DbLike) {
  await closeExpired(db);
  const [r] = await db.select().from(schema.gameRounds).where(eq(schema.gameRounds.status, 'open'));
  return r ?? null;
}

async function roundVoters(db: DbLike, roundId: number): Promise<number> {
  const [r] = await db.execute<{ n: number }>(sql`select count(distinct user_id)::int as n from game_votes where round_id = ${roundId}`).then((x) => x.rows);
  return r?.n ?? 0;
}

function roundView(r: typeof schema.gameRounds.$inferSelect, voters: number): GameRoundView {
  return { id: r.id, teamId: r.teamId, status: r.status as 'open' | 'closed', closesAt: r.closesAt?.toISOString() ?? null, voters };
}

// ---------- кому приглашение ----------

/** Участники, которым положено приглашение: активные, и (по настройке) отмеченные сегодня на входе. */
async function eligibleIds(db: DbLike, config: GameConfig, ids?: number[]): Promise<Set<number>> {
  const settings = await getSettings(db);
  const tz = settings.eventTimezone;
  // Тестовый запуск: только участники аккаунтов из тест-листа и без отметки на входе - репетиция может быть в любой день.
  const test = launchOf(config) === 'test';
  if (test && config.testerIds.length === 0) return new Set();
  const rows = await db.execute<{ id: string }>(sql`
    select p.id from participants p
     where p.status = 'active'
       ${ids ? sql`and p.id in (${sql.join((ids.length ? ids : [-1]).map((i) => sql`${i}`), sql`, `)})` : sql``}
       ${
         test
           ? sql`and (p.owner_user_id in (${sql.join(config.testerIds.map((i) => sql`${i}`), sql`, `)})
                  or p.holder_user_id in (${sql.join(config.testerIds.map((i) => sql`${i}`), sql`, `)}))`
           : config.audience === 'arrived_today'
           ? sql`and exists (
               select 1 from check_ins ci join checkpoints c on c.id = ci.checkpoint_id
                where ci.participant_id = p.id and c.kind = 'entrance' and ci.revoked_at is null
                  and (ci.created_at at time zone ${tz})::date = (now() at time zone ${tz})::date)`
           : sql``
       }`);
  return new Set(rows.rows.map((r) => Number(r.id)));
}

/** Тест-лист без регистрации на конференцию: в команду записать нельзя, голосовать - можно. */
export async function votersOnlyTesters(db: DbLike): Promise<number[]> {
  const config = configOf(await stateRow(db));
  if (launchOf(config) !== 'test' || config.testerIds.length === 0) return [];
  const rows = await db.execute<{ id: string }>(sql`
    select u.id from users u
     where u.id in (${sql.join(config.testerIds.map((i) => sql`${i}`), sql`, `)})
       and not exists (select 1 from participants p where p.status = 'active' and (p.owner_user_id = u.id or p.holder_user_id = u.id))`);
  return rows.rows.map((r) => Number(r.id));
}

/** Аккаунты, которым слать приглашение: кому положено и кто ещё не ответил, - по держателю QR-кода (иначе владельцу). */
export async function inviteAudience(db: DbLike): Promise<Map<number, { id: number; name: string }[]>> {
  const config = configOf(await stateRow(db));
  const eligible = await eligibleIds(db, config);
  if (eligible.size === 0) return new Map();
  const people = await db
    .select({ p: schema.participants, answered: schema.gamePlayers.participantId })
    .from(schema.participants)
    .leftJoin(schema.gamePlayers, eq(schema.gamePlayers.participantId, schema.participants.id))
    .where(inArray(schema.participants.id, [...eligible]));
  const out = new Map<number, { id: number; name: string }[]>();
  for (const { p, answered } of people) {
    if (answered) continue;
    const uid = p.holderUserId ?? p.ownerUserId;
    out.set(uid, [...(out.get(uid) ?? []), { id: p.id, name: fullName(p) }]);
  }
  // Тестовый запуск: приглашение - только тест-листу (QR-код друга у постороннего - тому не пишем).
  if (launchOf(config) === 'test') {
    const allowed = new Set(config.testerIds);
    for (const uid of [...out.keys()]) if (!allowed.has(uid)) out.delete(uid);
  }
  return out;
}

// ---------- мини-апка ----------

async function family(db: DbLike, userId: number) {
  return db
    .select()
    .from(schema.participants)
    .where(
      and(
        eq(schema.participants.status, 'active'),
        sql`(${schema.participants.ownerUserId} = ${userId} or ${schema.participants.holderUserId} = ${userId})`,
      ),
    )
    .orderBy(asc(schema.participants.id));
}

export async function gameStateFor(ctx: Pick<AppContext, 'db'>, user: UserRow, roles: readonly Role[]): Promise<GameStateView> {
  const row = await stateRow(ctx.db);
  const config = configOf(row);
  const visible = gameVisible(config, roles, user.id);
  const teams = await teamRows(ctx.db);
  const showPoints = row.resultsShown || config.showResults;
  const [stats, caps, points, people, round] = await Promise.all([
    teamStats(ctx.db),
    captainNames(ctx.db, teams),
    showPoints ? totals(ctx.db) : Promise.resolve(new Map<number, { points: number; voters: number }>()),
    family(ctx.db, user.id),
    openRound(ctx.db),
  ]);
  const players = people.length
    ? await ctx.db.select().from(schema.gamePlayers).where(inArray(schema.gamePlayers.participantId, people.map((p) => p.id)))
    : [];
  const eligible = await eligibleIds(ctx.db, config, people.map((p) => p.id));
  const captainOf = new Map(teams.flatMap((t) => (t.captainId ? [[t.captainId, t.id] as const] : [])));
  const personViews: GamePersonView[] = people.map((p) => {
    const gp = players.find((x) => x.participantId === p.id);
    return {
      participantId: p.id,
      fullName: fullName(p),
      answer: (gp?.answer as 'yes' | 'no' | undefined) ?? null,
      teamId: gp?.answer === 'yes' ? gp.teamId : null,
      captain: captainOf.has(p.id),
      eligible: eligible.has(p.id),
    };
  });
  const ownTeamIds = config.forbidOwnTeam ? [...new Set(personViews.flatMap((p) => (p.teamId ? [p.teamId] : [])))] : [];
  const myVotes: Record<number, number> = {};
  if (round) {
    const votes = await ctx.db
      .select()
      .from(schema.gameVotes)
      .where(and(eq(schema.gameVotes.roundId, round.id), eq(schema.gameVotes.userId, user.id)));
    for (const v of votes) myVotes[v.teamId] = v.points;
  }
  const captainTeam = teams.find((t) => t.captainId && people.some((p) => p.id === t.captainId));
  const nums = teamNumbers(teams);
  const secret = countrySecret(row, config);
  const tasks = visible ? await taskRows(ctx.db) : [];
  const teamTasks: Record<number, GameTaskText> = {};
  if (row.tasksRevealedAt) {
    for (const t of teams) {
      const task = t.taskId ? tasks.find((x) => x.id === t.taskId) : undefined;
      if (task && personViews.some((p) => p.teamId === t.id)) teamTasks[t.id] = taskText(task);
    }
  }
  // Страну выбирает капитан: из стран свободных заданий (и своего), если у заданий есть страны; иначе любую.
  const taskCountries = tasks.filter((x) => x.countryCode && (!teams.some((t) => t.taskId === x.id) || x.id === captainTeam?.taskId));
  const captainCountry = config.countryBy === 'captain';
  return {
    visible,
    testLaunch: launchOf(config) === 'test',
    mode: config.mode,
    pointsPerTeam: config.pointsPerTeam,
    budget: config.budget,
    forbidOwnTeam: config.forbidOwnTeam,
    signupOpen: row.signupOpen,
    allowChangeAnswer: config.allowChangeAnswer,
    distributed: row.distributedAt !== null,
    designLocked: designLocked(row, config),
    resultsShown: row.resultsShown,
    startsAt: config.startsAt,
    teams: visible
      ? teams.map((t) => {
          const v = teamView(t, nums.get(t.id)!, {
            captainName: t.captainId ? (caps.get(t.captainId) ?? null) : null,
            size: stats.get(t.id)?.size ?? 0,
            points: showPoints ? (points.get(t.id)?.points ?? 0) : null,
          });
          return secret ? withoutCountry(v) : v;
        })
      : [],
    people: visible ? personViews : [],
    ownTeamIds,
    round: visible && round ? { ...roundView(round, 0), myVotes } : null,
    pendingDesign: (captainTeam?.proposal as GameTeamDesign | null) ?? null,
    revealed: row.tasksRevealedAt !== null,
    teamTasks,
    captainCountry,
    countries: captainCountry && tasks.some((x) => x.countryCode) ? [...new Set(taskCountries.map((x) => x.countryCode!))] : null,
    texts: {
      intro: config.mode === 'per_team' ? config.introPerTeam : config.introBudget.replaceAll('{budget}', String(config.budget)),
      signupTitle: config.signupTitle,
      signupText: config.signupText,
      waitHint: config.waitHint,
    },
    serverTime: new Date().toISOString(),
  };
}

const designLocked = (row: StateRow, config: GameConfig) => row.designLocked || (!!config.designUntil && new Date(config.designUntil) <= new Date());

/** «Будешь участвовать?» - за себя или за кого-то из своих (семья, друзья). */
export async function answerGame(ctx: Ctx, user: UserRow, roles: readonly Role[], participantId: number, yes: boolean): Promise<GameStateView> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const config = configOf(row);
    if (!gameVisible(config, roles, user.id)) throw notFound('Игра пока недоступна');
    if (!row.signupOpen) throw badRequest('signup_closed', 'Запись на игру закрыта');
    const people = await family(tx, user.id);
    const p = people.find((x) => x.id === participantId);
    if (!p) throw notFound('Участник не найден');
    if (!(await eligibleIds(tx, config, [p.id])).has(p.id)) {
      throw badRequest(
        'not_eligible',
        launchOf(config) === 'test'
          ? 'Идёт тестовый запуск - записаться могут только люди из тест-листа'
          : config.audience === 'arrived_today'
            ? 'Сначала отметьтесь на входе - потом можно записаться в игру'
            : 'Записаться нельзя',
      );
    }
    const [current] = await tx.select().from(schema.gamePlayers).where(eq(schema.gamePlayers.participantId, p.id)).for('update');
    // Тот же ответ ещё раз (старая кнопка в боте, двойное нажатие) - ничего не меняем и не будим приложения.
    if (current && current.answer === (yes ? 'yes' : 'no')) return;
    if (current && !config.allowChangeAnswer) throw badRequest('answer_locked', 'Ответ уже записан - поменять его может ведущий');
    // Команды собраны - молча выйти из своей команды кнопкой нельзя (особенно старой кнопкой посреди игры).
    if (current?.answer === 'yes' && current.teamId && !yes && row.distributedAt) {
      throw badRequest('answer_locked', 'Команды уже собраны - выйти из игры можно у ведущего');
    }
    let teamId = yes ? (current?.teamId ?? null) : null;
    // Записался после распределения - сразу в самую маленькую команду (с учётом пола).
    const lateJoin = yes && row.distributedAt !== null && teamId === null;
    if (lateJoin) teamId = await pickTeam(tx, config, p.gender as 'm' | 'f');
    await tx
      .insert(schema.gamePlayers)
      .values({ participantId: p.id, answer: yes ? 'yes' : 'no', teamId, assignedAt: teamId ? new Date() : null })
      .onConflictDoUpdate({
        target: schema.gamePlayers.participantId,
        set: { answer: yes ? 'yes' : 'no', teamId, answeredAt: new Date(), assignedAt: teamId ? new Date() : null },
      });
    // Передумал капитан - команда без капитана, ведущий назначит другого.
    if (!yes) await tx.update(schema.gameTeams).set({ captainId: null, updatedAt: new Date() }).where(eq(schema.gameTeams.captainId, p.id));
    if (lateJoin && teamId) await enqueue(ctx.boss, 'game.assigned', { participantIds: [p.id] }, { tx });
  });
  return gameStateFor(ctx, user, roles);
}

/**
 * Голос сохраняется сразу, по ходу нажатий (мини-апка шлёт его с задержкой после последнего нажатия):
 * «после каждой команды» - 1…N этой команде (пустой список - убрать голос); «общий запас» - раздать между командами
 * не больше запаса, сколько роздано к закрытию раунда - столько и засчитано.
 */
export async function voteGame(ctx: Ctx, user: UserRow, roles: readonly Role[], req: GameVoteRequest): Promise<GameStateView> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx);
    const config = configOf(row);
    if (!gameVisible(config, roles, user.id)) throw notFound('Игра пока недоступна');
    await closeExpired(tx);
    // Разделяемая блокировка: раунд не закроют посреди голоса, а голоса разных людей не ждут друг друга.
    const [round] = await tx.select().from(schema.gameRounds).where(eq(schema.gameRounds.id, req.roundId)).for('share');
    if (!round || round.status !== 'open') throw conflict('round_closed', 'Голосование уже закрыто');
    // Два запроса одного человека (частые нажатия, второе устройство) - строго по очереди.
    await tx.execute(sql`select pg_advisory_xact_lock(${round.id}::int, ${user.id}::int)`);
    const votes = req.votes.filter((v) => v.points > 0);
    const people = await family(tx, user.id);
    const own = config.forbidOwnTeam && people.length
      ? new Set(
          (
            await tx
              .select({ teamId: schema.gamePlayers.teamId })
              .from(schema.gamePlayers)
              .where(and(inArray(schema.gamePlayers.participantId, people.map((p) => p.id)), eq(schema.gamePlayers.answer, 'yes')))
          ).flatMap((r) => (r.teamId ? [r.teamId] : [])),
        )
      : new Set<number>();
    if (round.teamId !== null) {
      const v = votes[0];
      if (votes.length > 1 || (v && v.teamId !== round.teamId)) throw badRequest('bad_vote', 'Сейчас голосуем за другую команду');
      if (v && v.points > config.pointsPerTeam) throw badRequest('bad_vote', `От 1 до ${config.pointsPerTeam}`);
      if (v && own.has(round.teamId)) throw forbidden('За свою команду голосовать нельзя');
    } else {
      const teamIds = new Set((await teamRows(tx)).map((t) => t.id));
      if (new Set(votes.map((v) => v.teamId)).size !== votes.length || votes.some((v) => !teamIds.has(v.teamId))) {
        throw badRequest('bad_vote', 'Проверьте команды');
      }
      if (votes.some((v) => own.has(v.teamId))) throw forbidden('За свою команду голосовать нельзя');
      const sum = votes.reduce((s, v) => s + v.points, 0);
      if (sum > config.budget) throw badRequest('budget', `Можно раздать не больше ${config.budget} - сейчас ${sum}`);
    }
    await tx.delete(schema.gameVotes).where(and(eq(schema.gameVotes.roundId, round.id), eq(schema.gameVotes.userId, user.id)));
    if (votes.length) await tx.insert(schema.gameVotes).values(votes.map((v) => ({ roundId: round.id, userId: user.id, teamId: v.teamId, points: v.points })));
  });
  return gameStateFor(ctx, user, roles);
}

/** Капитан оформляет команду: название церкви, страна, цвет. С проверкой - уходит ведущему на одобрение. */
export async function designTeam(ctx: Ctx, user: UserRow, roles: readonly Role[], teamId: number, design: GameTeamDesign): Promise<GameStateView> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx);
    const config = configOf(row);
    if (!gameVisible(config, roles, user.id)) throw notFound('Игра пока недоступна');
    if (designLocked(row, config)) throw badRequest('design_locked', 'Оформление команд уже закрыто');
    const [team] = await tx.select().from(schema.gameTeams).where(eq(schema.gameTeams.id, teamId)).for('update');
    const people = await family(tx, user.id);
    if (!team || !team.captainId || !people.some((p) => p.id === team.captainId)) throw forbidden('Оформить команду может только её капитан');
    if (design.color && design.color.toLowerCase() !== team.color.toLowerCase()) {
      const others = await tx.select({ color: schema.gameTeams.color }).from(schema.gameTeams).where(sql`${schema.gameTeams.id} <> ${teamId}`);
      if (others.some((o) => o.color.toLowerCase() === design.color!.toLowerCase())) throw conflict('color_taken', 'Этот цвет уже у другой команды - выберите другой');
    }
    // Страну даёт ведущий - капитан меняет только название и цвет.
    const byCaptain = config.countryBy === 'captain';
    if (byCaptain && !design.countryCode) throw badRequest('country_required', 'Выберите страну');
    const countryCode = byCaptain ? design.countryCode! : team.countryCode;
    if (byCaptain && countryCode !== team.countryCode) await checkTaskCountry(tx, teamId, countryCode);
    const value = { name: design.name, countryCode, color: design.color ?? null };
    if (config.reviewNames) {
      await tx.update(schema.gameTeams).set({ proposal: value, updatedAt: new Date() }).where(eq(schema.gameTeams.id, teamId));
    } else {
      await tx
        .update(schema.gameTeams)
        .set({ name: design.name, countryCode, flag: byCaptain ? null : team.flag, ...(design.color ? { color: design.color } : {}), proposal: null, updatedAt: new Date() })
        .where(eq(schema.gameTeams.id, teamId));
      if (byCaptain && countryCode !== team.countryCode) await attachTaskByCountry(tx, teamId, countryCode);
    }
    await audit(tx, { actorUserId: user.id, action: 'game.team_design', entity: 'game_team', entityId: teamId, before: team, after: value });
  });
  return gameStateFor(ctx, user, roles);
}

// ---------- задания ----------

/** Если у заданий есть страны, капитан выбирает только страну свободного задания (или своего). */
async function checkTaskCountry(tx: Tx, teamId: number, countryCode: string | null): Promise<void> {
  const tasks = await taskRows(tx);
  if (!countryCode || !tasks.some((t) => t.countryCode)) return;
  const taken = new Map((await teamRows(tx)).flatMap((t) => (t.taskId && t.id !== teamId ? [[t.taskId, t.id] as const] : [])));
  if (!tasks.some((t) => t.countryCode === countryCode && !taken.has(t.id))) {
    throw conflict('country_taken', 'Для этой страны нет свободного задания - выберите другую');
  }
}

/** Выбрали страну - команде её задание (если для страны есть свободное). Задание другой страны снимаем. */
async function attachTaskByCountry(tx: Tx, teamId: number, countryCode: string | null): Promise<void> {
  const tasks = await taskRows(tx);
  const teams = await teamRows(tx);
  const team = teams.find((t) => t.id === teamId);
  const current = tasks.find((t) => t.id === team?.taskId);
  if (current && (!current.countryCode || current.countryCode === countryCode)) return;
  const taken = new Set(teams.flatMap((t) => (t.taskId && t.id !== teamId ? [t.taskId] : [])));
  const task = countryCode ? tasks.find((t) => t.countryCode === countryCode && !taken.has(t.id)) : undefined;
  await tx.update(schema.gameTeams).set({ taskId: task?.id ?? null, updatedAt: new Date() }).where(eq(schema.gameTeams.id, teamId));
}

function taskView(t: TaskRow, teams: TeamRow[]): GameTaskView {
  return {
    id: t.id,
    title: t.title,
    context: t.context,
    text: t.text,
    countryCode: t.countryCode,
    countryName: countryName(t.countryCode),
    flag: flagEmoji(t.countryCode),
    teamId: teams.find((x) => x.taskId === t.id)?.id ?? null,
  };
}

export async function createTask(ctx: Ctx, actor: StaffPrincipal, input: GameTaskInput): Promise<void> {
  const [maxSort] = await ctx.db.select({ s: sql<number>`coalesce(max(${schema.gameTasks.sort}), 0)::int` }).from(schema.gameTasks);
  const [t] = await ctx.db
    .insert(schema.gameTasks)
    .values({ title: input.title, context: input.context, text: input.text, countryCode: input.countryCode, sort: (maxSort?.s ?? 0) + 10 })
    .returning();
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'game.task_create', entity: 'game_task', entityId: t!.id, after: input });
}

/** Правка задания; поменяли страну у выданного - команда получает новую страну. */
export async function updateTask(ctx: Ctx, actor: StaffPrincipal, id: number, input: GameTaskInput): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.gameTasks).where(eq(schema.gameTasks.id, id)).for('update');
    if (!before) throw notFound('Задание не найдено');
    await tx.update(schema.gameTasks).set({ ...input, updatedAt: new Date() }).where(eq(schema.gameTasks.id, id));
    if (input.countryCode && input.countryCode !== before.countryCode) {
      await tx.update(schema.gameTeams).set({ countryCode: input.countryCode, flag: null, updatedAt: new Date() }).where(eq(schema.gameTeams.taskId, id));
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'game.task_update', entity: 'game_task', entityId: id, before, after: input });
  });
}

export async function deleteTask(ctx: Ctx, actor: StaffPrincipal, id: number): Promise<void> {
  const [before] = await ctx.db.delete(schema.gameTasks).where(eq(schema.gameTasks.id, id)).returning();
  if (!before) throw notFound('Задание не найдено');
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'game.task_delete', entity: 'game_task', entityId: id, before });
}

/**
 * Раздать свободные задания командам без задания - случайно. Команде со страной - задание её страны
 * (или без страны); команде без страны - любое, и страна задания ставится ей.
 */
export async function assignTasks(ctx: Ctx, actor: StaffPrincipal): Promise<{ assigned: number; left: number }> {
  return ctx.db.transaction(async (tx) => {
    await stateRow(tx, true);
    const teams = await teamRows(tx);
    const free = shuffle((await taskRows(tx)).filter((t) => !teams.some((x) => x.taskId === t.id)));
    let assigned = 0;
    // Сначала команды со страной: им подходит меньше заданий.
    const waiting = shuffle(teams.filter((t) => !t.taskId)).sort((a, b) => Number(!a.countryCode) - Number(!b.countryCode));
    for (const team of waiting) {
      const i = free.findIndex((t) => (team.countryCode ? t.countryCode === team.countryCode || !t.countryCode : true));
      if (i < 0) continue;
      const [task] = free.splice(i, 1);
      await tx
        .update(schema.gameTeams)
        .set({ taskId: task!.id, ...(task!.countryCode && !team.countryCode ? { countryCode: task!.countryCode, flag: null } : {}), updatedAt: new Date() })
        .where(eq(schema.gameTeams.id, team.id));
      assigned++;
    }
    const left = teams.filter((t) => !t.taskId).length - assigned;
    await audit(tx, { actorUserId: actor.user.id, action: 'game.tasks_assign', entity: 'game', entityId: 1, after: { assigned, left } });
    return { assigned, left };
  });
}

// ---------- ход игры: начать, показать задания, на сцене ----------

/** «Начать игру»: запись и оформление закрываются, на экране - заставка игры. Отмена - только снять отметку. */
export async function startGame(ctx: Ctx, actor: StaffPrincipal, started: boolean): Promise<void> {
  await stateRow(ctx.db);
  await ctx.db
    .update(schema.gameState)
    .set(started ? { startedAt: new Date(), signupOpen: false, designLocked: true, updatedAt: new Date() } : { startedAt: null, updatedAt: new Date() })
    .where(eq(schema.gameState.id, 1));
  await audit(ctx.db, { actorUserId: actor.user.id, action: started ? 'game.start' : 'game.unstart', entity: 'game', entityId: 1 });
}

/** «Показать задания»: команды видят своё задание, страну и флаг; по желанию - задание каждой команде в бот. */
export async function revealTasks(ctx: Ctx, actor: StaffPrincipal, revealed: boolean, notify: boolean): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    await tx.update(schema.gameState).set({ tasksRevealedAt: revealed ? (row.tasksRevealedAt ?? new Date()) : null, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
    if (revealed && notify && !row.tasksRevealedAt) await enqueue(ctx.boss, 'game.tasks_revealed', {}, { tx });
    await audit(tx, { actorUserId: actor.user.id, action: revealed ? 'game.reveal' : 'game.unreveal', entity: 'game', entityId: 1, after: { notify } });
  });
}

/** Кто выступает: его флаг и задание на большом экране; null - убрать со сцены. */
export async function setStage(ctx: Ctx, actor: StaffPrincipal, teamId: number | null): Promise<void> {
  if (teamId !== null) {
    const [t] = await ctx.db.select({ id: schema.gameTeams.id }).from(schema.gameTeams).where(eq(schema.gameTeams.id, teamId));
    if (!t) throw notFound('Команда не найдена');
  }
  const row = await stateRow(ctx.db);
  if (row.stageTeamId === teamId) return;
  await ctx.db.update(schema.gameState).set({ stageTeamId: teamId, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'game.stage', entity: 'game', entityId: 1, after: { teamId } });
}

/** Задания открыты: каждому аккаунту - задание его команды (одно сообщение на аккаунт и команду). */
export async function revealedTaskMessages(db: DbLike): Promise<{ userId: number; teamId: number; label: string; task: GameTaskText }[]> {
  const [teams, tasks, labels] = await Promise.all([teamRows(db), taskRows(db), teamLabels(db)]);
  const rows = await db
    .select({ owner: schema.participants.ownerUserId, holder: schema.participants.holderUserId, teamId: schema.gamePlayers.teamId })
    .from(schema.gamePlayers)
    .innerJoin(schema.participants, eq(schema.participants.id, schema.gamePlayers.participantId))
    .where(and(eq(schema.gamePlayers.answer, 'yes'), eq(schema.participants.status, 'active'), isNotNull(schema.gamePlayers.teamId)));
  const seen = new Set<string>();
  const out: { userId: number; teamId: number; label: string; task: GameTaskText }[] = [];
  for (const r of rows) {
    const team = teams.find((t) => t.id === r.teamId);
    const task = team?.taskId ? tasks.find((t) => t.id === team.taskId) : undefined;
    if (!team || !task) continue;
    const userId = r.holder ?? r.owner;
    const key = `${userId}:${team.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ userId, teamId: team.id, label: labels.get(team.id) ?? '', task: taskText(task) });
  }
  return out;
}

// ---------- распределение ----------

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

type Slot = { id: number; size: number; m: number; f: number };

/** Куда поставить человека: в самую маленькую команду, при равенстве - где меньше людей его пола; дальше - случайно. */
function bestTeam(slots: Slot[], gender: 'm' | 'f', config: GameConfig): Slot | null {
  const open = slots.filter((s) => config.maxTeamSize === null || s.size < config.maxTeamSize);
  if (open.length === 0) return null;
  const key = (s: Slot) => [s.size, config.balanceGender ? s[gender] : 0];
  const best = open.reduce((acc, s) => {
    const [a0, a1] = key(acc[0]!);
    const [b0, b1] = key(s);
    if (b0! < a0! || (b0 === a0 && b1! < a1!)) return [s];
    if (b0 === a0 && b1 === a1) return [...acc, s];
    return acc;
  }, [open[0]!]);
  return best[Math.floor(Math.random() * best.length)]!;
}

async function slotsNow(tx: Tx): Promise<Slot[]> {
  const teams = await teamRows(tx);
  const stats = await teamStats(tx);
  return teams.map((t) => ({ id: t.id, size: stats.get(t.id)?.size ?? 0, m: stats.get(t.id)?.males ?? 0, f: stats.get(t.id)?.females ?? 0 }));
}

async function pickTeam(tx: Tx, config: GameConfig, gender: 'm' | 'f'): Promise<number | null> {
  return bestTeam(await slotsNow(tx), gender, config)?.id ?? null;
}

/**
 * Распределить всех «участвую» по командам поровну: и по числу людей, и парней с девушками.
 * Капитаны, назначенные заранее, остаются в своих командах. Командам без капитана - случайный (по настройке).
 */
export async function distribute(ctx: Ctx, actor: StaffPrincipal | null): Promise<{ assigned: number; unassigned: number }> {
  const result = await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const config = configOf(row);
    const teams = await teamRows(tx);
    if (teams.length === 0) throw badRequest('no_teams', 'Сначала создайте команды');
    const players = await tx
      .select({ id: schema.gamePlayers.participantId, gender: schema.participants.gender })
      .from(schema.gamePlayers)
      .innerJoin(schema.participants, eq(schema.participants.id, schema.gamePlayers.participantId))
      .where(and(eq(schema.gamePlayers.answer, 'yes'), eq(schema.participants.status, 'active')));
    const captainTeam = new Map(teams.flatMap((t) => (t.captainId ? [[t.captainId, t.id] as const] : [])));
    const slots: Slot[] = teams.map((t) => ({ id: t.id, size: 0, m: 0, f: 0 }));
    const place = new Map<number, number | null>();
    const add = (pid: number, gender: 'm' | 'f', slot: Slot | null) => {
      place.set(pid, slot?.id ?? null);
      if (slot) {
        slot.size += 1;
        slot[gender] += 1;
      }
    };
    // Капитаны - первыми, в свои команды.
    for (const p of players) {
      const tid = captainTeam.get(p.id);
      if (tid) add(p.id, p.gender as 'm' | 'f', slots.find((s) => s.id === tid)!);
    }
    // Остальные - парни и девушки вперемешку, чтобы пол распределялся ровно с первого человека.
    const rest = players.filter((p) => !place.has(p.id));
    const males = shuffle(rest.filter((p) => p.gender === 'm'));
    const females = shuffle(rest.filter((p) => p.gender !== 'm'));
    const order: typeof rest = [];
    while (males.length || females.length) {
      if (males.length) order.push(males.shift()!);
      if (females.length) order.push(females.shift()!);
    }
    for (const p of order) add(p.id, p.gender as 'm' | 'f', bestTeam(slots, p.gender as 'm' | 'f', config));

    const now = new Date();
    await tx.update(schema.gamePlayers).set({ teamId: null, assignedAt: null }).where(eq(schema.gamePlayers.answer, 'yes'));
    for (const slot of slots) {
      const ids = [...place.entries()].filter(([, t]) => t === slot.id).map(([pid]) => pid);
      if (ids.length) await tx.update(schema.gamePlayers).set({ teamId: slot.id, assignedAt: now }).where(inArray(schema.gamePlayers.participantId, ids));
    }
    // Капитан - тот, кого выбрали заранее, иначе случайный игрок команды.
    for (const t of teams) {
      const members = [...place.entries()].filter(([, tid]) => tid === t.id).map(([pid]) => pid);
      const keep = t.captainId && members.includes(t.captainId) ? t.captainId : null;
      const captainId = keep ?? (config.randomCaptain && members.length ? members[Math.floor(Math.random() * members.length)]! : null);
      if (captainId !== t.captainId) await tx.update(schema.gameTeams).set({ captainId, updatedAt: now }).where(eq(schema.gameTeams.id, t.id));
    }
    await tx.update(schema.gameState).set({ distributedAt: now, updatedAt: now }).where(eq(schema.gameState.id, 1));
    const assigned = [...place.entries()].filter(([, t]) => t !== null).map(([pid]) => pid);
    if (assigned.length) await enqueue(ctx.boss, 'game.assigned', { participantIds: assigned }, { tx });
    await audit(tx, { actorUserId: actor?.user.id ?? null, action: 'game.distribute', entity: 'game', entityId: 1, after: { assigned: assigned.length } });
    return { assigned: assigned.length, unassigned: place.size - assigned.length };
  });
  return result;
}

// ---------- админка: ведущий ----------

export async function gameAdminView(ctx: Pick<AppContext, 'db'> & { config?: { ADMIN_URL: string } }): Promise<GameAdminView> {
  const row = await stateRow(ctx.db);
  const config = configOf(row);
  await closeExpired(ctx.db);
  const teams = await teamRows(ctx.db);
  const [stats, caps, points, players, rounds, audience] = await Promise.all([
    teamStats(ctx.db),
    captainNames(ctx.db, teams),
    totals(ctx.db),
    ctx.db
      .select({ gp: schema.gamePlayers, p: schema.participants })
      .from(schema.gamePlayers)
      .innerJoin(schema.participants, eq(schema.participants.id, schema.gamePlayers.participantId))
      .where(eq(schema.participants.status, 'active'))
      .orderBy(asc(schema.participants.lastName), asc(schema.participants.firstName)),
    ctx.db.execute<{ id: string; team_id: string | null; status: string; opened_at: Date; closes_at: Date | null; closed_at: Date | null; voters: number; points: number }>(sql`
      select r.id, r.team_id, r.status, r.opened_at, r.closes_at, r.closed_at,
             count(distinct v.user_id)::int as voters, coalesce(sum(v.points), 0)::int as points
        from game_rounds r left join game_votes v on v.round_id = r.id
       group by r.id order by r.opened_at`),
    eligibleIds(ctx.db, config),
  ]);
  const captainIds = new Set(teams.flatMap((t) => (t.captainId ? [t.captainId] : [])));
  const nums = teamNumbers(teams);
  const tasks = await taskRows(ctx.db);
  return {
    launch: launchOf(config),
    config,
    signupOpen: row.signupOpen,
    distributedAt: row.distributedAt?.toISOString() ?? null,
    designLocked: designLocked(row, config),
    resultsShown: row.resultsShown,
    screenToken: row.screenToken,
    screenUrl: ctx.config ? `${ctx.config.ADMIN_URL.replace(/\/$/, '')}/screen/${row.screenToken}` : null,
    startedAt: row.startedAt?.toISOString() ?? null,
    tasksRevealedAt: row.tasksRevealedAt?.toISOString() ?? null,
    stageTeamId: row.stageTeamId,
    tasks: tasks.map((t) => taskView(t, teams)),
    teams: teams.map((t): GameTeamAdmin => {
      const s = stats.get(t.id);
      return {
        ...teamView(t, nums.get(t.id)!, { captainName: t.captainId ? (caps.get(t.captainId) ?? null) : null, size: s?.size ?? 0, points: null }),
        sort: t.sort,
        taskId: t.taskId,
        captainId: t.captainId,
        males: s?.males ?? 0,
        females: s?.females ?? 0,
        proposal: (t.proposal as GameTeamDesign | null) ?? null,
        points: points.get(t.id)?.points ?? 0,
        voters: points.get(t.id)?.voters ?? 0,
      };
    }),
    players: players.map(({ gp, p }): GamePlayerRow => ({
      participantId: p.id,
      fullName: fullName(p),
      gender: p.gender as 'm' | 'f',
      answer: gp.answer as 'yes' | 'no',
      teamId: gp.teamId,
      captain: captainIds.has(p.id),
      answeredAt: gp.answeredAt.toISOString(),
    })),
    rounds: rounds.rows.map((r) => ({
      id: Number(r.id),
      teamId: r.team_id === null ? null : Number(r.team_id),
      status: r.status as 'open' | 'closed',
      closesAt: r.closes_at ? new Date(r.closes_at).toISOString() : null,
      voters: r.voters,
      openedAt: new Date(r.opened_at).toISOString(),
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      points: r.points,
    })),
    audience: audience.size,
    testers: await botUsers(ctx.db, config.testerIds),
  };
}

/** Аккаунты бота по id - имя, @ник, сколько участников. */
async function botUsers(db: DbLike, ids: number[]): Promise<GameBotUser[]> {
  if (ids.length === 0) return [];
  const rows = await db.execute<{ id: string; username: string | null; name: string; participants: number; in_game: number }>(sql`
    select u.id, u.username,
           coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.display_name, 'Без имени') as name,
           (select count(*)::int from participants p where p.status = 'active' and (p.owner_user_id = u.id or p.holder_user_id = u.id)) as participants,
           (select count(*)::int from participants p join game_players gp on gp.participant_id = p.id
             where p.status = 'active' and gp.answer = 'yes' and (p.owner_user_id = u.id or p.holder_user_id = u.id)) as in_game
      from users u where u.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  const byId = new Map(rows.rows.map((r) => [Number(r.id), r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ userId: id, name: r.name, username: r.username, participants: r.participants, inGame: r.in_game }] : [];
  });
}

/** Поиск аккаунтов бота для тест-листа: по @нику, имени в Telegram или ФИО участника. */
export async function searchBotUsers(ctx: Pick<AppContext, 'db'>, q: string): Promise<GameBotUser[]> {
  const raw = q.trim().replace(/^@/, '').toLowerCase();
  if (raw.length < 2) return [];
  const like = `%${raw.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await ctx.db.execute<{ id: string }>(sql`
    select u.id from users u
     where u.tg_id is not null and (
       lower(coalesce(u.username, '')) like ${like}
       or lower(concat_ws(' ', u.first_name, u.last_name, u.display_name)) like ${like}
       or exists (select 1 from participants p where p.status = 'active' and (p.owner_user_id = u.id or p.holder_user_id = u.id)
                    and lower(concat_ws(' ', p.last_name, p.first_name)) like ${like}))
     order by u.last_seen_at desc nulls last limit 15`);
  return botUsers(ctx.db, rows.rows.map((r) => Number(r.id)));
}

const SCHEDULED = ['signupOpensAt', 'signupClosesAt', 'distributeAt'] as const;

/** Сохранить настройки игры; запись и распределение по времени - задачами очереди (сверяются со временем при запуске). */
export async function saveGameConfig(ctx: Ctx, actor: StaffPrincipal, config: GameConfig): Promise<GameAdminView> {
  const t = (v: string | null) => (v ? Date.parse(v) : null);
  const [opens, closes, dist] = [t(config.signupOpensAt), t(config.signupClosesAt), t(config.distributeAt)];
  if (opens !== null && closes !== null && closes <= opens) throw badRequest('bad_times', 'Запись должна закрываться позже, чем открывается');
  if (opens !== null && dist !== null && dist <= opens) throw badRequest('bad_times', 'Распределять по командам - после открытия записи');
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const before = configOf(row);
    await tx.update(schema.gameState).set({ config, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
    for (const key of SCHEDULED) {
      const at = config[key];
      if (at && at !== before[key] && new Date(at) > new Date()) {
        await enqueue(ctx.boss, 'game.schedule', { key, at }, { tx, startAfter: new Date(at) });
      }
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'game.config', entity: 'game', entityId: 1, before, after: config });
  });
  return gameAdminView(ctx);
}

/** Задача по расписанию: открыть или закрыть запись, распределить. Время поменяли - ничего не делаем. */
export async function runScheduled(ctx: Ctx, key: (typeof SCHEDULED)[number], at: string): Promise<void> {
  const row = await stateRow(ctx.db);
  const config = configOf(row);
  if (config[key] !== at) return;
  if (key === 'signupOpensAt' && !row.signupOpen && config.enabled) await setSignup(ctx, null, true);
  if (key === 'signupClosesAt' && row.signupOpen) await setSignup(ctx, null, false);
  if (key === 'distributeAt' && row.distributedAt === null) await distribute(ctx, null);
}

/** Открыть запись - разослать приглашение всем, кому положено и кто ещё не ответил. */
export async function setSignup(ctx: Ctx, actor: StaffPrincipal | null, open: boolean): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    // Игра выключена - приглашение ушло бы людям, а «Участвую» ответило бы «игра недоступна».
    if (open && !configOf(row).enabled) throw badRequest('game_disabled', 'Сначала включите игру в «Настройках»');
    await tx.update(schema.gameState).set({ signupOpen: open, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
    if (open) await enqueue(ctx.boss, 'game.invite', {}, { tx });
    await audit(tx, { actorUserId: actor?.user.id ?? null, action: open ? 'game.signup_open' : 'game.signup_close', entity: 'game', entityId: 1 });
  });
}

/** Ещё раз разослать приглашение тем, кто так и не ответил (например, новым отметившимся). */
export async function reinvite(ctx: Ctx): Promise<void> {
  await enqueue(ctx.boss, 'game.invite', {});
}

export async function setGameFlags(ctx: Ctx, actor: StaffPrincipal, flags: { designLocked?: boolean; resultsShown?: boolean }): Promise<void> {
  await stateRow(ctx.db);
  await ctx.db.update(schema.gameState).set({ ...flags, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'game.flags', entity: 'game', entityId: 1, after: flags });
}

export async function newScreenToken(ctx: Ctx, actor: StaffPrincipal): Promise<void> {
  await stateRow(ctx.db);
  await ctx.db.update(schema.gameState).set({ screenToken: randomToken(18), updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'game.screen_token', entity: 'game', entityId: 1 });
}

/** Сколько команд: не хватает - добавляем заглушки, лишние - убираем с конца (их игроки остаются без команды). */
export async function setTeamCount(ctx: Ctx, actor: StaffPrincipal, count: number): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > 60) throw badRequest('bad_count', 'От 1 до 60 команд');
  await ctx.db.transaction(async (tx) => {
    await stateRow(tx, true);
    const teams = await teamRows(tx);
    if (teams.length < count) {
      const maxSort = teams.at(-1)?.sort ?? 0;
      await tx.insert(schema.gameTeams).values(
        Array.from({ length: count - teams.length }, (_, i) => ({
          sort: maxSort + (i + 1) * 10,
          color: GAME_TEAM_COLORS[(teams.length + i) % GAME_TEAM_COLORS.length]!,
        })),
      );
    } else if (teams.length > count) {
      // Убираем команды с последними номерами («Команда 13», «Команда 12»…), а не последние по порядку выступлений.
      const byId = [...teams].sort((a, b) => a.id - b.id);
      await tx.delete(schema.gameTeams).where(inArray(schema.gameTeams.id, byId.slice(count).map((t) => t.id)));
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'game.team_count', entity: 'game', entityId: 1, before: { count: teams.length }, after: { count } });
  });
}

export async function updateTeam(ctx: Ctx, actor: StaffPrincipal, teamId: number, patch: GameTeamUpdate): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx);
    const [team] = await tx.select().from(schema.gameTeams).where(eq(schema.gameTeams.id, teamId)).for('update');
    if (!team) throw notFound('Команда не найдена');
    if (patch.captainId) {
      const [p] = await tx.select().from(schema.participants).where(eq(schema.participants.id, patch.captainId));
      if (!p || p.status !== 'active') throw notFound('Участник не найден');
      // Капитан - игрок этой команды: заранее назначенного сразу записываем «участвую».
      await tx.update(schema.gameTeams).set({ captainId: null }).where(eq(schema.gameTeams.captainId, patch.captainId));
      await tx
        .insert(schema.gamePlayers)
        .values({ participantId: p.id, answer: 'yes', teamId, assignedAt: new Date() })
        .onConflictDoUpdate({ target: schema.gamePlayers.participantId, set: { answer: 'yes', teamId, assignedAt: new Date() } });
    }
    const set: GameTeamUpdate = { ...patch };
    if (patch.taskId) {
      const [task] = await tx.select().from(schema.gameTasks).where(eq(schema.gameTasks.id, patch.taskId));
      if (!task) throw notFound('Задание не найдено');
      // Задание было у другой команды - переходит к этой.
      await tx.update(schema.gameTeams).set({ taskId: null, updatedAt: new Date() }).where(and(eq(schema.gameTeams.taskId, task.id), sql`${schema.gameTeams.id} <> ${teamId}`));
      if (task.countryCode) Object.assign(set, { countryCode: task.countryCode, flag: null });
    }
    await tx.update(schema.gameTeams).set({ ...set, updatedAt: new Date() }).where(eq(schema.gameTeams.id, teamId));
    // Команды уже разосланы - новому капитану сразу «ты капитан» (до распределения узнает вместе со всеми).
    if (patch.captainId && patch.captainId !== team.captainId && row.distributedAt) {
      await enqueue(ctx.boss, 'game.assigned', { participantIds: [patch.captainId] }, { tx });
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'game.team_update', entity: 'game_team', entityId: teamId, before: team, after: patch });
  });
}

/** Решение по названию от капитана. */
export async function reviewProposal(ctx: Ctx, actor: StaffPrincipal, teamId: number, approve: boolean): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [team] = await tx.select().from(schema.gameTeams).where(eq(schema.gameTeams.id, teamId)).for('update');
    if (!team?.proposal) throw notFound('Предложения нет');
    const p = team.proposal as { name: string; countryCode: string | null; color: string | null };
    const countryCode = p.countryCode ?? team.countryCode;
    await tx
      .update(schema.gameTeams)
      .set(
        approve
          ? { name: p.name, countryCode, flag: countryCode === team.countryCode ? team.flag : null, ...(p.color ? { color: p.color } : {}), proposal: null, updatedAt: new Date() }
          : { proposal: null, updatedAt: new Date() },
      )
      .where(eq(schema.gameTeams.id, teamId));
    if (approve && countryCode !== team.countryCode) await attachTaskByCountry(tx, teamId, countryCode);
    await audit(tx, { actorUserId: actor.user.id, action: approve ? 'game.proposal_ok' : 'game.proposal_no', entity: 'game_team', entityId: teamId, after: p });
  });
}

export async function reorderTeams(ctx: Ctx, actor: StaffPrincipal, ids: number[] | 'shuffle'): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const teams = await teamRows(tx);
    const order = ids === 'shuffle' ? shuffle(teams.map((t) => t.id)) : ids;
    if (order.length !== teams.length || !teams.every((t) => order.includes(t.id))) throw badRequest('bad_order', 'Список команд изменился - обновите страницу');
    for (const [i, id] of order.entries()) await tx.update(schema.gameTeams).set({ sort: (i + 1) * 10 }).where(eq(schema.gameTeams.id, id));
    await audit(tx, { actorUserId: actor.user.id, action: 'game.reorder', entity: 'game', entityId: 1, after: { order } });
  });
}

/** Перенести игрока в другую команду (или убрать из команды). */
export async function movePlayer(ctx: Ctx, actor: StaffPrincipal, participantId: number, teamId: number | null): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [p] = await tx.select({ status: schema.participants.status }).from(schema.participants).where(eq(schema.participants.id, participantId));
    if (!p || p.status !== 'active') throw notFound('Участник не найден');
    // Нет ответа (нет телефона, не успел) - ведущий записывает сам.
    const [gp] = await tx.select().from(schema.gamePlayers).where(eq(schema.gamePlayers.participantId, participantId)).for('update');
    if (teamId !== null) {
      const [t] = await tx.select({ id: schema.gameTeams.id }).from(schema.gameTeams).where(eq(schema.gameTeams.id, teamId));
      if (!t) throw notFound('Команда не найдена');
    }
    await tx
      .insert(schema.gamePlayers)
      .values({ participantId, answer: 'yes', teamId, assignedAt: teamId ? new Date() : null })
      .onConflictDoUpdate({ target: schema.gamePlayers.participantId, set: { teamId, answer: 'yes', assignedAt: teamId ? new Date() : null } });
    // Ушёл из команды капитан - у команды капитана больше нет.
    if (gp && gp.teamId !== teamId) await tx.update(schema.gameTeams).set({ captainId: null }).where(eq(schema.gameTeams.captainId, participantId));
    if (teamId) await enqueue(ctx.boss, 'game.assigned', { participantIds: [participantId] }, { tx });
    await audit(tx, { actorUserId: actor.user.id, action: 'game.move', entity: 'participant', entityId: participantId, before: { teamId: gp?.teamId ?? null, answer: gp?.answer ?? null }, after: { teamId } });
  });
}

/** Случайный капитан из игроков команды (кроме нынешнего). */
export async function randomCaptain(ctx: Ctx, actor: StaffPrincipal, teamId: number): Promise<void> {
  const [team] = await ctx.db.select().from(schema.gameTeams).where(eq(schema.gameTeams.id, teamId));
  if (!team) throw notFound('Команда не найдена');
  const members = await ctx.db
    .select({ id: schema.gamePlayers.participantId })
    .from(schema.gamePlayers)
    .innerJoin(schema.participants, eq(schema.participants.id, schema.gamePlayers.participantId))
    .where(and(eq(schema.gamePlayers.teamId, teamId), eq(schema.gamePlayers.answer, 'yes'), eq(schema.participants.status, 'active')));
  const pool = members.map((m) => m.id).filter((id) => id !== team.captainId);
  if (pool.length === 0) throw badRequest('no_members', 'В команде пока некого выбрать');
  const captainId = pool[Math.floor(Math.random() * pool.length)]!;
  await ctx.db.update(schema.gameTeams).set({ captainId, updatedAt: new Date() }).where(eq(schema.gameTeams.id, teamId));
  await enqueue(ctx.boss, 'game.assigned', { participantIds: [captainId] });
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'game.random_captain', entity: 'game_team', entityId: teamId, after: { captainId } });
}

/** Открыть голосование: за команду (после её выступления) или общее - на весь запас. Открытый раньше раунд закрывается. */
export async function openGameRound(ctx: Ctx, actor: StaffPrincipal, teamId: number | null, seconds?: number | null): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const config = configOf(row);
    if (config.mode === 'per_team' && teamId === null) throw badRequest('need_team', 'Выберите команду, за которую голосуем');
    if (config.mode === 'budget' && teamId !== null) throw badRequest('budget_round', 'В режиме «общий запас» голосуют сразу за все команды');
    if (teamId !== null) {
      const [t] = await tx.select({ id: schema.gameTeams.id }).from(schema.gameTeams).where(eq(schema.gameTeams.id, teamId));
      if (!t) throw notFound('Команда не найдена');
    }
    await tx.update(schema.gameRounds).set({ status: 'closed', closedAt: new Date() }).where(eq(schema.gameRounds.status, 'open'));
    const length = seconds === undefined ? config.roundSeconds : seconds;
    const closesAt = length ? new Date(Date.now() + length * 1000) : null;
    // За эту команду (или общий раунд) уже голосовали - открываем тот же раунд: голоса не задвоятся, их можно поменять.
    const [earlier] = await tx
      .select()
      .from(schema.gameRounds)
      .where(teamId === null ? sql`${schema.gameRounds.teamId} is null` : eq(schema.gameRounds.teamId, teamId))
      .orderBy(sql`${schema.gameRounds.id} desc`)
      .limit(1);
    const [round] = earlier
      ? await tx
          .update(schema.gameRounds)
          .set({ status: 'open', closesAt, closedAt: null, openedBy: actor.user.id })
          .where(eq(schema.gameRounds.id, earlier.id))
          .returning()
      : await tx.insert(schema.gameRounds).values({ teamId, closesAt, openedBy: actor.user.id }).returning();
    if (closesAt) await enqueue(ctx.boss, 'game.round_close', { roundId: round!.id, closesAt: closesAt.toISOString() }, { tx, startAfter: closesAt });
    if (config.notifyRounds) await enqueue(ctx.boss, 'game.round_notify', { roundId: round!.id }, { tx });
    await audit(tx, { actorUserId: actor.user.id, action: 'game.round_open', entity: 'game', entityId: round!.id, after: { teamId, closesAt } });
  });
}

export async function closeGameRound(ctx: Pick<AppContext, 'db'>, actor: StaffPrincipal | null): Promise<void> {
  await ctx.db.update(schema.gameRounds).set({ status: 'closed', closedAt: new Date() }).where(eq(schema.gameRounds.status, 'open'));
  if (actor) await audit(ctx.db, { actorUserId: actor.user.id, action: 'game.round_close', entity: 'game', entityId: 1 });
}

/** +N секунд к открытому раунду (или таймер, если его не было). */
export async function extendGameRound(ctx: Ctx, actor: StaffPrincipal, seconds: number): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [round] = await tx.select().from(schema.gameRounds).where(eq(schema.gameRounds.status, 'open')).for('update');
    if (!round) throw conflict('no_round', 'Сейчас голосование не открыто');
    const base = round.closesAt && round.closesAt > new Date() ? round.closesAt.getTime() : Date.now();
    const closesAt = new Date(base + seconds * 1000);
    await tx.update(schema.gameRounds).set({ closesAt }).where(eq(schema.gameRounds.id, round.id));
    await enqueue(ctx.boss, 'game.round_close', { roundId: round.id, closesAt: closesAt.toISOString() }, { tx, startAfter: closesAt });
    await audit(tx, { actorUserId: actor.user.id, action: 'game.round_extend', entity: 'game', entityId: round.id, after: { closesAt } });
  });
}

/** Задача очереди: закрыть раунд, если его таймер не продлевали. */
export async function closeRoundIfDue(ctx: Pick<AppContext, 'db'>, roundId: number, closesAt: string): Promise<void> {
  await ctx.db
    .update(schema.gameRounds)
    .set({ status: 'closed', closedAt: new Date() })
    .where(and(eq(schema.gameRounds.id, roundId), eq(schema.gameRounds.status, 'open'), eq(schema.gameRounds.closesAt, new Date(closesAt))));
}

/** Репетиция: стереть голоса и раунды. */
export async function resetVotes(ctx: Pick<AppContext, 'db'>, actor: StaffPrincipal): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.delete(schema.gameRounds);
    await tx.update(schema.gameState).set({ resultsShown: false, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
    await audit(tx, { actorUserId: actor.user.id, action: 'game.reset_votes', entity: 'game', entityId: 1 });
  });
}

/**
 * Стереть ход игры, оставив команды заглушками: ответы, распределение, капитанов, названия, голоса.
 * `keepSetup` - подготовку ведущего (названия, страны, задания, цвета) не трогаем: стираем только ход теста.
 */
async function wipeToPlaceholders(tx: Tx, keepSetup = false): Promise<void> {
  await tx.delete(schema.gameRounds);
  await tx.delete(schema.gamePlayers);
  const teams = [...(await teamRows(tx))].sort((a, b) => a.id - b.id);
  for (const [i, t] of teams.entries()) {
    await tx
      .update(schema.gameTeams)
      .set(
        keepSetup
          ? { captainId: null, proposal: null, updatedAt: new Date() }
          : { name: null, countryCode: null, flag: null, captainId: null, proposal: null, taskId: null, color: GAME_TEAM_COLORS[i % GAME_TEAM_COLORS.length]!, updatedAt: new Date() },
      )
      .where(eq(schema.gameTeams.id, t.id));
  }
  await tx
    .update(schema.gameState)
    .set({ distributedAt: null, resultsShown: false, designLocked: false, signupOpen: false, startedAt: null, tasksRevealedAt: null, stageTeamId: null, updatedAt: new Date() })
    .where(eq(schema.gameState.id, 1));
}

/**
 * Запуск: выключить, тестовый (только тест-лист) или настоящий (для всех).
 * `wipe` - перед запуском стереть данные прошлого прогона: тестовые голоса и названия не должны попасть в настоящую игру.
 */
export async function setLaunch(
  ctx: Ctx,
  actor: StaffPrincipal,
  mode: GameLaunch,
  opts: { wipe?: boolean; invite?: boolean; keepSetup?: boolean } = {},
): Promise<void> {
  const wipe = opts.wipe ?? false;
  // Запуск = сразу приглашения «Будешь участвовать?» (если не попросили иначе).
  const invite = mode !== 'off' && (opts.invite ?? true);
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const before = configOf(row);
    // Тест без тест-листа - репетиция только для админов и ведущих: приглашения не уходят никому.
    if (wipe) await wipeToPlaceholders(tx, opts.keepSetup ?? false);
    const config: GameConfig = { ...before, enabled: mode !== 'off', adminsOnly: mode === 'off' ? before.adminsOnly : mode === 'test' };
    // Выключаем - запись закрываем, чтобы никто не застрял с «запись открыта» в невидимой игре.
    await tx
      .update(schema.gameState)
      .set({ config, ...(mode === 'off' ? { signupOpen: false } : invite ? { signupOpen: true } : {}), updatedAt: new Date() })
      .where(eq(schema.gameState.id, 1));
    if (invite) await enqueue(ctx.boss, 'game.invite', {}, { tx });
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'game.launch',
      entity: 'game',
      entityId: 1,
      before: { launch: launchOf(before) },
      after: { launch: mode, wipe, invite, keepSetup: opts.keepSetup ?? false },
    });
  });
}

/** Тест-лист: добавить аккаунт бота (человек хотя бы раз открыл бота). */
export async function addTester(ctx: Ctx, actor: StaffPrincipal, userId: number): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const config = configOf(row);
    const [u] = await tx.select({ id: schema.users.id, tgId: schema.users.tgId }).from(schema.users).where(eq(schema.users.id, userId));
    if (!u?.tgId) throw notFound('Этот человек ещё не открывал бота');
    if (config.testerIds.includes(userId)) return;
    if (config.testerIds.length >= 200) throw badRequest('too_many_testers', 'В тест-листе уже 200 человек');
    await tx.update(schema.gameState).set({ config: { ...config, testerIds: [...config.testerIds, userId] }, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
    // Тест уже идёт и запись открыта - новому человеку приглашение сразу (остальным не повторяем).
    if (launchOf(config) === 'test' && row.signupOpen) await enqueue(ctx.boss, 'game.invite', { userIds: [userId] }, { tx });
    await audit(tx, { actorUserId: actor.user.id, action: 'game.tester_add', entity: 'user', entityId: userId });
  });
}

export async function removeTester(ctx: Ctx, actor: StaffPrincipal, userId: number): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const config = configOf(row);
    await tx
      .update(schema.gameState)
      .set({ config: { ...config, testerIds: config.testerIds.filter((id) => id !== userId) }, updatedAt: new Date() })
      .where(eq(schema.gameState.id, 1));
    await audit(tx, { actorUserId: actor.user.id, action: 'game.tester_remove', entity: 'user', entityId: userId });
  });
}

/**
 * Записать всех тестировщиков в игру («участвую») - не ждать, пока каждый нажмёт кнопку в боте.
 * После распределения новые сразу попадают в самые маленькие команды.
 */
export async function enrollTesters(ctx: Ctx, actor: StaffPrincipal): Promise<{ enrolled: number }> {
  return ctx.db.transaction(async (tx) => {
    const row = await stateRow(tx, true);
    const config = configOf(row);
    if (config.testerIds.length === 0) throw badRequest('no_testers', 'Тест-лист пуст');
    const ids = [...(await eligibleIds(tx, { ...config, enabled: true, adminsOnly: true }))];
    if (ids.length === 0) throw badRequest('no_players', 'У людей из тест-листа нет регистраций - записать в команду некого (голосовать они могут)');
    const people = await tx
      .select({ id: schema.participants.id, gender: schema.participants.gender, answer: schema.gamePlayers.answer, teamId: schema.gamePlayers.teamId })
      .from(schema.participants)
      .leftJoin(schema.gamePlayers, eq(schema.gamePlayers.participantId, schema.participants.id))
      .where(inArray(schema.participants.id, ids));
    const assigned: number[] = [];
    let enrolled = 0;
    for (const p of people) {
      if (p.answer === 'yes') continue;
      const teamId = row.distributedAt ? await pickTeam(tx, config, p.gender as 'm' | 'f') : null;
      await tx
        .insert(schema.gamePlayers)
        .values({ participantId: p.id, answer: 'yes', teamId, assignedAt: teamId ? new Date() : null })
        .onConflictDoUpdate({ target: schema.gamePlayers.participantId, set: { answer: 'yes', teamId, answeredAt: new Date(), assignedAt: teamId ? new Date() : null } });
      enrolled += 1;
      if (teamId) assigned.push(p.id);
    }
    if (assigned.length) await enqueue(ctx.boss, 'game.assigned', { participantIds: assigned }, { tx });
    await audit(tx, { actorUserId: actor.user.id, action: 'game.enroll_testers', entity: 'game', entityId: 1, after: { enrolled } });
    return { enrolled };
  });
}

/** Настройки из админки: запуск и тест-лист меняются своими кнопками на «Пульте», здесь их не трогаем. */
export async function saveGameSettings(ctx: Ctx, actor: StaffPrincipal, config: GameConfig): Promise<GameAdminView> {
  const current = configOf(await stateRow(ctx.db));
  return saveGameConfig(ctx, actor, { ...config, enabled: current.enabled, adminsOnly: current.adminsOnly, testerIds: current.testerIds });
}

/**
 * Начать заново. `teams` - удалить все команды (с ними голоса и раунды), игроки остаются записанными без команд;
 * `all` - ещё и ответы «участвую / не участвую», запись закрыта. Настройки не трогаем.
 */
export async function resetGame(ctx: Pick<AppContext, 'db'>, actor: StaffPrincipal, scope: 'teams' | 'all'): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await stateRow(tx, true);
    await tx.delete(schema.gameRounds);
    await tx.delete(schema.gameTeams);
    if (scope === 'all') await tx.delete(schema.gamePlayers);
    else await tx.update(schema.gamePlayers).set({ teamId: null, assignedAt: null });
    await tx
      .update(schema.gameState)
      .set({ distributedAt: null, resultsShown: false, designLocked: false, startedAt: null, tasksRevealedAt: null, stageTeamId: null, ...(scope === 'all' ? { signupOpen: false } : {}), updatedAt: new Date() })
      .where(eq(schema.gameState.id, 1));
    await audit(tx, { actorUserId: actor.user.id, action: 'game.reset', entity: 'game', entityId: 1, after: { scope } });
  });
}

/** Сбросить распределение: все «участвую» - без команды, капитаны сняты. Ответы остаются. */
export async function resetDistribution(ctx: Pick<AppContext, 'db'>, actor: StaffPrincipal): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.update(schema.gamePlayers).set({ teamId: null, assignedAt: null });
    await tx.update(schema.gameTeams).set({ captainId: null });
    await tx.update(schema.gameState).set({ distributedAt: null, updatedAt: new Date() }).where(eq(schema.gameState.id, 1));
    await audit(tx, { actorUserId: actor.user.id, action: 'game.reset_distribution', entity: 'game', entityId: 1 });
  });
}

/** Поиск участника для ведущего: назначить капитаном или записать в игру того, кто не ответил сам. */
export async function gameCandidates(ctx: Pick<AppContext, 'db'>, q: string): Promise<GameCandidate[]> {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3);
  if (words.length === 0) return [];
  const rows = await ctx.db
    .select({ p: schema.participants, answer: schema.gamePlayers.answer, teamId: schema.gamePlayers.teamId })
    .from(schema.participants)
    .leftJoin(schema.gamePlayers, eq(schema.gamePlayers.participantId, schema.participants.id))
    .where(
      and(
        eq(schema.participants.status, 'active'),
        ...words.map(
          (w) =>
            sql`lower(concat_ws(' ', ${schema.participants.lastName}, ${schema.participants.firstName}, ${schema.participants.middleName})) like ${`%${w.replace(/[%_\\]/g, '\\$&')}%`}`,
        ),
      ),
    )
    .orderBy(asc(schema.participants.lastName), asc(schema.participants.firstName))
    .limit(20);
  return rows.map(({ p, answer, teamId }) => ({
    participantId: p.id,
    fullName: fullName(p),
    gender: p.gender as 'm' | 'f',
    answer: (answer as 'yes' | 'no' | null) ?? null,
    teamId: answer === 'yes' ? teamId : null,
  }));
}

// ---------- большой экран ----------

export async function gameScreen(ctx: Pick<AppContext, 'db'>, token: string): Promise<GameScreenView> {
  const row = await stateRow(ctx.db);
  if (!token || token !== row.screenToken) throw notFound('Ссылка на экран устарела - возьмите новую у ведущего');
  const config = configOf(row);
  const teams = await teamRows(ctx.db);
  const [stats, points, round, settings, total] = await Promise.all([
    teamStats(ctx.db),
    totals(ctx.db),
    openRound(ctx.db),
    getSettings(ctx.db),
    ctx.db.execute<{ n: number }>(sql`select count(distinct user_id)::int as n from game_votes`).then((r) => r.rows[0]?.n ?? 0),
  ]);
  const nums = teamNumbers(teams);
  const secret = countrySecret(row, config);
  const views = teams.map((t) => {
    const v = {
      ...teamView(t, nums.get(t.id)!, { captainName: null, size: stats.get(t.id)?.size ?? 0, points: points.get(t.id)?.points ?? 0 }),
      points: points.get(t.id)?.points ?? 0,
      voters: points.get(t.id)?.voters ?? 0,
    };
    return secret ? withoutCountry(v) : v;
  });
  // На сцене - всегда с флагом и заданием: ведущий сам вывел команду.
  const stageTeam = row.stageTeamId ? teams.find((t) => t.id === row.stageTeamId) : undefined;
  const stageTask = stageTeam?.taskId ? (await taskRows(ctx.db)).find((t) => t.id === stageTeam.taskId) : undefined;
  return {
    phase: row.tasksRevealedAt ? 'revealed' : row.startedAt ? 'started' : 'lobby',
    stage: stageTeam
      ? {
          team: teamView(stageTeam, nums.get(stageTeam.id)!, { captainName: null, size: stats.get(stageTeam.id)?.size ?? 0, points: null }),
          task: stageTask ? taskText(stageTask) : null,
        }
      : null,
    mode: config.mode,
    eventName: settings.eventName,
    teams: views,
    round: round ? { ...roundView(round, await roundVoters(ctx.db, round.id)), team: views.find((v) => v.id === round.teamId) ?? null } : null,
    resultsShown: row.resultsShown,
    totalVoters: total,
    serverTime: new Date().toISOString(),
    hint: config.screenHint,
  };
}

// ---------- для рассылок ----------

const escHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Подпись команды в сообщениях: «🇰🇪 Церковь „Надежда“ (Кения)». */
export async function teamLabels(db: DbLike): Promise<Map<number, string>> {
  const [teams, row] = await Promise.all([teamRows(db), stateRow(db)]);
  const nums = teamNumbers(teams);
  // До «Показать задания» страну и флаг, которые дал ведущий, в сообщениях не раскрываем.
  const secret = countrySecret(row, configOf(row));
  return new Map(
    teams.map((t) => {
      const flag = secret ? null : t.flag || flagEmoji(t.countryCode);
      const country = secret ? null : countryName(t.countryCode);
      // Название придумал капитан - в HTML-сообщении бота экранируем, иначе Telegram отклонит сообщение.
      const title = escHtml(teamTitle({ name: t.name, number: nums.get(t.id)! }));
      return [t.id, `${flag ? `${flag} ` : ''}«${title}»${country ? ` (${country})` : ''}`];
    }),
  );
}

export async function gameConfigNow(db: DbLike): Promise<GameConfig> {
  return configOf(await stateRow(db));
}

/** Игроки «участвую» с командами - для уведомлений о раунде. */
export async function yesPlayersAccounts(db: DbLike): Promise<number[]> {
  const rows = await db
    .select({ owner: schema.participants.ownerUserId, holder: schema.participants.holderUserId })
    .from(schema.gamePlayers)
    .innerJoin(schema.participants, eq(schema.participants.id, schema.gamePlayers.participantId))
    .where(and(eq(schema.gamePlayers.answer, 'yes'), eq(schema.participants.status, 'active')));
  return [...new Set(rows.map((r) => r.holder ?? r.owner))];
}
