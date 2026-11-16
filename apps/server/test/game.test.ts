import { DEFAULT_GAME_CONFIG, type GameAdminView, type GameConfig } from '@sof/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Api } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import {
  answerGame,
  assignTasks,
  closeRoundIfDue,
  createTask,
  revealTasks,
  setStage,
  startGame,
  designTeam,
  distribute,
  gameAdminView,
  gameCandidates,
  gameScreen,
  gameStateFor,
  inviteAudience,
  movePlayer,
  openGameRound,
  reorderTeams,
  addTester,
  enrollTesters,
  resetGame,
  saveGameSettings,
  setLaunch,
  searchBotUsers,
  resetVotes,
  saveGameConfig,
  setSignup,
  setTeamCount,
  updateTeam,
  voteGame,
  votersOnlyTesters,
} from '../src/services/game.service.ts';
import { runJob } from '../src/jobs/workers.ts';
import { createSession } from '../src/services/sessions.service.ts';
import type { StaffPrincipal } from '../src/services/sessions.service.ts';
import type { UserRow } from '../src/services/users.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
let host: StaffPrincipal;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
  host = await makeStaff(env, ['host'], 'Ведущий');
});
afterAll(async () => {
  await app?.close();
  await env?.teardown();
});

const config = (over: Partial<GameConfig> = {}): GameConfig => ({ ...DEFAULT_GAME_CONFIG, enabled: true, adminsOnly: false, audience: 'registered', ...over });

/** Чистая игра перед каждым тестом. */
beforeEach(async () => {
  await env.db.delete(schema.gameRounds);
  await env.db.delete(schema.gamePlayers);
  await env.db.delete(schema.gameTeams);
  await env.db.delete(schema.gameTasks);
  await env.db.delete(schema.gameState);
});

/** Человек со своим аккаунтом, ответивший «участвую». */
async function player(gender: 'm' | 'f', yes = true): Promise<{ user: UserRow; pid: number }> {
  const user = await makeUser(env);
  const { participant } = await makeParticipant(env, user, { gender });
  await answerGame(env, user, [], participant.id, yes);
  return { user, pid: participant.id };
}

describe('игра: набор и распределение', () => {
  it('поровну по размеру и по полу; капитан, назначенный заранее, остаётся в своей команде', async () => {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 4);
    await setSignup(env, host, true);
    const men = await Promise.all(Array.from({ length: 10 }, () => player('m')));
    const women = await Promise.all(Array.from({ length: 6 }, () => player('f')));
    await player('m', false); // «не участвую» - в команды не попадает
    let view = await gameAdminView(env);
    const [first] = view.teams;
    await updateTeam(env, host, first!.id, { captainId: women[0]!.pid });

    const res = await distribute(env, host);
    expect(res).toEqual({ assigned: 16, unassigned: 0 });
    view = await gameAdminView(env);
    const sizes = view.teams.map((t) => t.size);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(Math.max(...view.teams.map((t) => t.males)) - Math.min(...view.teams.map((t) => t.males))).toBeLessThanOrEqual(1);
    expect(Math.max(...view.teams.map((t) => t.females)) - Math.min(...view.teams.map((t) => t.females))).toBeLessThanOrEqual(1);
    expect(view.players.find((p) => p.participantId === women[0]!.pid)).toMatchObject({ teamId: first!.id, captain: true });
    // У всех команд есть капитан (случайный, кроме назначенного).
    expect(view.teams.every((t) => t.captainId !== null)).toBe(true);
    void men;

    // Записался после распределения - сразу в самую маленькую команду.
    const late = await player('f');
    const state = await gameStateFor(env, late.user, []);
    expect(state.people[0]!.teamId).not.toBeNull();
  });

  it('приглашение - тем, кто ещё не ответил, по аккаунту, который держит QR-код', async () => {
    await saveGameConfig(env, host, config());
    await setSignup(env, host, true);
    const answered = await player('m');
    const user = await makeUser(env);
    const { participant } = await makeParticipant(env, user, { gender: 'f' });
    const audience = await inviteAudience(env.db);
    expect(audience.get(user.id)).toEqual([{ id: participant.id, name: expect.any(String) }]);
    expect(audience.has(answered.user.id)).toBe(false);
    // Тестовый запуск - приглашение только тест-листу: админ без него тоже ничего не получает.
    const admin = await makeStaff(env, ['admin']);
    await makeParticipant(env, admin.user, { gender: 'm' });
    await saveGameConfig(env, host, config({ adminsOnly: true, testerIds: [user.id] }));
    expect([...(await inviteAudience(env.db)).keys()]).toEqual([user.id]);
    await saveGameConfig(env, host, config({ adminsOnly: true, testerIds: [user.id, admin.user.id] }));
    expect((await inviteAudience(env.db)).has(admin.user.id)).toBe(true);
  });

  it('по расписанию «только отмеченные на входе» - без отметки записаться нельзя', async () => {
    await saveGameConfig(env, host, config({ audience: 'arrived_today' }));
    await setSignup(env, host, true);
    const user = await makeUser(env);
    const { participant } = await makeParticipant(env, user, { gender: 'm' });
    await expect(answerGame(env, user, [], participant.id, true)).rejects.toMatchObject({ code: 'not_eligible' });
  });

  it('игра выключена или «только ведущим» - участнику не видна', async () => {
    await saveGameConfig(env, host, config({ adminsOnly: true }));
    const user = await makeUser(env);
    expect((await gameStateFor(env, user, [])).visible).toBe(false);
    expect((await gameStateFor(env, user, ['host'])).visible).toBe(true);
  });
});

describe('игра: голосование', () => {
  async function ready(mode: GameConfig['mode']) {
    await saveGameConfig(env, host, config({ mode, roundSeconds: null }));
    await setTeamCount(env, host, 3);
    await setSignup(env, host, true);
    const a = await player('m');
    const b = await player('f');
    const c = await player('m');
    await distribute(env, host);
    const view = await gameAdminView(env);
    return { view, a, b, c };
  }
  const teamOf = (view: GameAdminView, pid: number) => view.players.find((p) => p.participantId === pid)!.teamId!;

  it('«после каждой команды»: 1…5, за свою команду нельзя, голос можно поменять, закрытый раунд не принимает', async () => {
    const { view, a } = await ready('per_team');
    const own = teamOf(view, a.pid);
    const other = view.teams.find((t) => t.id !== own)!.id;
    const spectator = await makeUser(env);

    await openGameRound(env, host, own);
    let round = (await gameStateFor(env, a.user, [])).round!;
    await expect(voteGame(env, a.user, [], { roundId: round.id, votes: [{ teamId: own, points: 5 }] })).rejects.toMatchObject({ statusCode: 403 });
    // Зритель без регистрации - может.
    await voteGame(env, spectator, [], { roundId: round.id, votes: [{ teamId: own, points: 5 }] });
    await expect(voteGame(env, spectator, [], { roundId: round.id, votes: [{ teamId: own, points: 6 }] })).rejects.toMatchObject({ code: 'bad_vote' });

    await openGameRound(env, host, other);
    round = (await gameStateFor(env, a.user, [])).round!;
    await voteGame(env, a.user, [], { roundId: round.id, votes: [{ teamId: other, points: 2 }] });
    const changed = await voteGame(env, a.user, [], { roundId: round.id, votes: [{ teamId: other, points: 4 }] });
    expect(changed.round!.myVotes).toEqual({ [other]: 4 });

    // Ещё раз за ту же команду - тот же раунд, голоса не задваиваются.
    await openGameRound(env, host, own);
    expect((await gameStateFor(env, a.user, [])).round!.id).not.toBe(round.id);
    await openGameRound(env, host, other);
    expect((await gameStateFor(env, a.user, [])).round!.id).toBe(round.id);

    const screen = await gameScreen(env, view.screenToken);
    expect(screen.teams.find((t) => t.id === own)!.points).toBe(5);
    expect(screen.teams.find((t) => t.id === other)!.points).toBe(4);
    expect(screen.round).toMatchObject({ teamId: other, voters: 1 });
    await expect(gameScreen(env, 'wrong-token-123')).rejects.toMatchObject({ statusCode: 404 });

    // Таймер вышел - раунд закрыт, голос не принимается.
    await env.db.update(schema.gameRounds).set({ closesAt: new Date(Date.now() - 1000) }).where(eq(schema.gameRounds.id, round.id));
    await expect(voteGame(env, spectator, [], { roundId: round.id, votes: [{ teamId: other, points: 1 }] })).rejects.toMatchObject({ code: 'round_closed' });
  });

  it('«общий запас»: сохраняется по ходу раздачи, не больше запаса, без своей команды', async () => {
    const { view, b } = await ready('budget');
    const own = teamOf(view, b.pid);
    const others = view.teams.filter((t) => t.id !== own).map((t) => t.id);
    await openGameRound(env, host, null);
    const round = (await gameStateFor(env, b.user, [])).round!;
    // Раздал часть - уже засчитано (пузыри на экране растут сразу).
    await voteGame(env, b.user, [], { roundId: round.id, votes: [{ teamId: others[0]!, points: 7 }] });
    expect((await gameScreen(env, view.screenToken)).teams.find((t) => t.id === others[0])!.points).toBe(7);
    await expect(voteGame(env, b.user, [], { roundId: round.id, votes: [{ teamId: others[0]!, points: 8 }, { teamId: others[1]!, points: 3 }] })).rejects.toMatchObject({ code: 'budget' });
    await expect(voteGame(env, b.user, [], { roundId: round.id, votes: [{ teamId: own, points: 10 }] })).rejects.toMatchObject({ statusCode: 403 });
    await voteGame(env, b.user, [], { roundId: round.id, votes: [{ teamId: others[0]!, points: 7 }, { teamId: others[1]!, points: 3 }] });
    const screen = await gameScreen(env, view.screenToken);
    expect(screen.teams.find((t) => t.id === others[0])!.points).toBe(7);
    expect(screen.teams.find((t) => t.id === others[1])!.points).toBe(3);
    // Всё убрал - голоса нет.
    const s = await voteGame(env, b.user, [], { roundId: round.id, votes: [] });
    expect(s.round!.myVotes).toEqual({});
    await resetVotes(env, host);
    expect((await gameScreen(env, view.screenToken)).teams.every((t) => t.points === 0)).toBe(true);
  });

  it('таймер: задача закрывает раунд, только если время не продлили', async () => {
    const { view } = await ready('per_team');
    await openGameRound(env, host, view.teams[0]!.id, 60);
    const [round] = await env.db.select().from(schema.gameRounds).where(eq(schema.gameRounds.status, 'open'));
    await closeRoundIfDue(env, round!.id, new Date(0).toISOString());
    expect((await env.db.select().from(schema.gameRounds).where(eq(schema.gameRounds.id, round!.id)))[0]!.status).toBe('open');
    await closeRoundIfDue(env, round!.id, round!.closesAt!.toISOString());
    expect((await env.db.select().from(schema.gameRounds).where(eq(schema.gameRounds.id, round!.id)))[0]!.status).toBe('closed');
  });
});

describe('игра: капитан и права', () => {
  it('капитан оформляет команду; с проверкой - ждёт одобрения; чужой - нельзя', async () => {
    await saveGameConfig(env, host, config({ reviewNames: true, countryBy: 'captain' }));
    await setTeamCount(env, host, 2);
    await setSignup(env, host, true);
    const a = await player('m');
    const b = await player('f');
    const view = await gameAdminView(env);
    await updateTeam(env, host, view.teams[0]!.id, { captainId: a.pid });
    await distribute(env, host);
    const team = view.teams[0]!.id;
    await expect(designTeam(env, b.user, [], team, { name: 'Чужая', countryCode: 'KE' })).rejects.toMatchObject({ statusCode: 403 });
    const s = await designTeam(env, a.user, [], team, { name: 'Надежда', countryCode: 'KE' });
    expect(s.pendingDesign).toMatchObject({ name: 'Надежда', countryCode: 'KE' });
    expect(s.teams.find((t) => t.id === team)).toMatchObject({ placeholder: true, title: 'Команда 1' });
  });

  it('ведущий видит игру в админке, но не участников; участник - не видит админку игры', async () => {
    const auth = `Bearer ${(await createSession(env.db, host.user.id, 'web', 1)).token}`;
    expect((await app.inject({ method: 'GET', url: '/api/admin/game', headers: { authorization: auth } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/participants', headers: { authorization: auth } })).statusCode).toBe(403);
    const cashier = await makeStaff(env, ['cashier']);
    const cashAuth = `Bearer ${(await createSession(env.db, cashier.user.id, 'web', 1)).token}`;
    expect((await app.inject({ method: 'GET', url: '/api/admin/game', headers: { authorization: cashAuth } })).statusCode).toBe(403);
  });
});

describe('игра: проверка тестировщика', () => {
  const jobs = async (name: string) =>
    (await env.pool.query<{ data: { participantIds?: number[] } }>(`select data from pgboss.job where name = $1`, [name])).rows.map((r) => r.data);

  it('чтение состояния и экрана ничего не пишет в базу - иначе триггер будил бы все приложения', async () => {
    await saveGameConfig(env, host, config({ mode: 'per_team' }));
    await setTeamCount(env, host, 2);
    const view = await gameAdminView(env);
    const user = await makeUser(env);
    const client = await env.pool.connect();
    const got: string[] = [];
    client.on('notification', (n) => got.push(n.payload ?? ''));
    await client.query('LISTEN sof_events');
    try {
      await gameStateFor(env, user, []);
      await gameAdminView(env);
      await gameScreen(env, view.screenToken);
      await new Promise((r) => setTimeout(r, 150));
      expect(got).toEqual([]);
      // А истёкший раунд закрывается при чтении - тогда уведомление нужно.
      await openGameRound(env, host, view.teams[0]!.id, 60);
      await env.db.update(schema.gameRounds).set({ closesAt: new Date(Date.now() - 1000) });
      got.length = 0;
      expect((await gameStateFor(env, user, [])).round).toBeNull();
      await new Promise((r) => setTimeout(r, 150));
      expect(got.some((p) => p.includes('"game"'))).toBe(true);
    } finally {
      await client.query('UNLISTEN sof_events');
      client.release();
    }
  });

  it('номер «Команда N» не меняется, когда ведущий перемешивает порядок выступлений', async () => {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 4);
    const before = await gameAdminView(env);
    const names = new Map(before.teams.map((t) => [t.id, t.title]));
    await reorderTeams(env, host, [...before.teams].reverse().map((t) => t.id));
    const after = await gameAdminView(env);
    expect(after.teams.map((t) => t.id)).toEqual([...before.teams].reverse().map((t) => t.id));
    for (const t of after.teams) expect(t.title).toBe(names.get(t.id));
    // Лишние убираются с последними номерами, а не последние по порядку выступлений.
    await setTeamCount(env, host, 3);
    expect((await gameAdminView(env)).teams.map((t) => t.title).sort()).toEqual(['Команда 1', 'Команда 2', 'Команда 3']);
  });

  it('ведущий записывает в игру того, кто не ответил сам, и находит его поиском', async () => {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 2);
    const user = await makeUser(env);
    const { participant } = await makeParticipant(env, user, { gender: 'f', lastName: 'Безтелефонова', firstName: 'Аня' });
    const found = await gameCandidates(env, 'безтелеф ан');
    expect(found).toEqual([expect.objectContaining({ participantId: participant.id, answer: null, teamId: null })]);
    expect(await gameCandidates(env, '%')).toEqual([]);
    const team = (await gameAdminView(env)).teams[1]!.id;
    await movePlayer(env, host, participant.id, team);
    expect((await gameAdminView(env)).players).toEqual([expect.objectContaining({ participantId: participant.id, answer: 'yes', teamId: team })]);
  });

  it('капитан, назначенный после распределения, получает сообщение «ты капитан»', async () => {
    await saveGameConfig(env, host, config({ randomCaptain: false }));
    await setTeamCount(env, host, 1);
    await setSignup(env, host, true);
    const a = await player('m');
    await distribute(env, host);
    await env.pool.query(`delete from pgboss.job where name = 'game.assigned'`);
    const team = (await gameAdminView(env)).teams[0]!.id;
    await updateTeam(env, host, team, { captainId: a.pid });
    expect(await jobs('game.assigned')).toEqual([{ participantIds: [a.pid] }]);
  });

  it('время записи проверяется: закрыть раньше, чем открыть, нельзя', async () => {
    await expect(
      saveGameConfig(env, host, config({ signupOpensAt: '2026-10-24T12:00:00+03:00', signupClosesAt: '2026-10-24T11:00:00+03:00' })),
    ).rejects.toMatchObject({ code: 'bad_times' });
  });

  it('ответ телефону несёт время сервера - для таймера', async () => {
    await saveGameConfig(env, host, config());
    const s = await gameStateFor(env, await makeUser(env), []);
    expect(Math.abs(Date.parse(s.serverTime) - Date.now())).toBeLessThan(5000);
  });
});

describe('игра: тест-лист и сброс', () => {
  it('тестовый режим: игра видна и приглашение приходит только ведущим и тест-листу', async () => {
    const tester = await makeUser(env);
    await env.db.update(schema.users).set({ username: 'tester_game_qa' }).where(eq(schema.users.id, tester.id));
    const outsider = await makeUser(env);
    await makeParticipant(env, tester, { gender: 'f' });
    await makeParticipant(env, outsider, { gender: 'm' });
    expect((await searchBotUsers(env, '@tester_game')).map((u) => u.userId)).toEqual([tester.id]);
    await saveGameConfig(env, host, config({ adminsOnly: true, testerIds: [tester.id] }));
    expect((await gameStateFor(env, tester, [])).visible).toBe(true);
    expect((await gameStateFor(env, outsider, [])).visible).toBe(false);
    const invited = await inviteAudience(env.db);
    expect(invited.has(tester.id)).toBe(true);
    expect(invited.has(outsider.id)).toBe(false);
    expect((await gameAdminView(env)).testers).toEqual([expect.objectContaining({ userId: tester.id, username: 'tester_game_qa', participants: 1 })]);
  });

  it('сброс: «команды» - игроки остаются без команд; «всё» - и ответы', async () => {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 2);
    await setSignup(env, host, true);
    await player('m');
    await player('f');
    await distribute(env, host);
    await resetGame(env, host, 'teams');
    let v = await gameAdminView(env);
    expect(v.teams).toEqual([]);
    expect(v.distributedAt).toBeNull();
    expect(v.players.filter((p) => p.answer === 'yes' && p.teamId === null)).toHaveLength(2);
    await resetGame(env, host, 'all');
    v = await gameAdminView(env);
    expect(v.players).toEqual([]);
    expect(v.signupOpen).toBe(false);
  });

  it('запись не открывается, пока игра выключена', async () => {
    await saveGameConfig(env, host, config({ enabled: false }));
    await expect(setSignup(env, host, true)).rejects.toMatchObject({ code: 'game_disabled' });
  });
});

describe('игра: тестовый и настоящий запуск', () => {
  it('тестовый запуск: тестировщики записываются без отметки на входе, приглашение - только им', async () => {
    // Настройка «только отмеченным сегодня» - в тесте она не мешает.
    await saveGameConfig(env, host, config({ audience: 'arrived_today' }));
    const tester = await makeUser(env);
    const { participant } = await makeParticipant(env, tester, { gender: 'f' });
    const outsider = await makeUser(env);
    await makeParticipant(env, outsider, { gender: 'm' });
    // Тест-лист пуст - тест только для админов и ведущих, приглашений никому.
    await setLaunch(env, host, 'test');
    expect([...(await inviteAudience(env.db)).keys()]).toEqual([]);
    await addTester(env, host, tester.id);
    await setLaunch(env, host, 'test');
    const view = await gameAdminView(env);
    expect(view.launch).toBe('test');
    expect(view.audience).toBe(1);
    await setSignup(env, host, true);
    const invited = await inviteAudience(env.db);
    expect([...invited.keys()]).toEqual([tester.id]);
    // Ведущий видит игру, но приглашение ему не приходит, пока его нет в тест-листе.
    expect(invited.has(host.user.id)).toBe(false);
    const s = await answerGame(env, tester, [], participant.id, true);
    expect(s.people[0]).toMatchObject({ answer: 'yes', eligible: true });
    expect((await gameStateFor(env, outsider, [])).visible).toBe(false);
  });

  it('«Записать всех в игру»: тестировщики сразу «участвую», после распределения - сразу в команды', async () => {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 2);
    const a = await makeUser(env);
    const b = await makeUser(env);
    await makeParticipant(env, a, { gender: 'm' });
    await makeParticipant(env, a, { gender: 'f' });
    await makeParticipant(env, b, { gender: 'f' });
    await addTester(env, host, a.id);
    await setLaunch(env, host, 'test');
    expect(await enrollTesters(env, host)).toEqual({ enrolled: 2 });
    await distribute(env, host);
    expect((await gameAdminView(env)).players.filter((p) => p.teamId !== null)).toHaveLength(2);
    await addTester(env, host, b.id);
    await env.pool.query(`delete from pgboss.job where name = 'game.assigned'`);
    expect(await enrollTesters(env, host)).toEqual({ enrolled: 1 });
    const view = await gameAdminView(env);
    expect(view.players.every((p) => p.teamId !== null)).toBe(true);
    expect(view.testers.map((t) => t.inGame)).toEqual([2, 1]);
    expect((await env.pool.query(`select count(*)::int as n from pgboss.job where name = 'game.assigned'`)).rows[0].n).toBe(1);
  });

  it('переход к настоящему запуску стирает тестовые данные, команды остаются заглушками', async () => {
    await saveGameConfig(env, host, config({ mode: 'per_team' }));
    await setTeamCount(env, host, 2);
    const a = await makeUser(env);
    await makeParticipant(env, a, { gender: 'm' });
    await addTester(env, host, a.id);
    await setLaunch(env, host, 'test');
    await enrollTesters(env, host);
    await distribute(env, host);
    const team = (await gameAdminView(env)).teams[0]!;
    await updateTeam(env, host, team.id, { name: 'Тестовая', countryCode: 'KE', color: '#123456' });
    await openGameRound(env, host, team.id, 60);
    await setLaunch(env, host, 'live', { wipe: true, invite: false });
    const v = await gameAdminView(env);
    expect(v.launch).toBe('live');
    expect(v.players).toEqual([]);
    expect(v.rounds).toEqual([]);
    expect(v.distributedAt).toBeNull();
    expect(v.signupOpen).toBe(false);
    expect(v.teams).toHaveLength(2);
    expect(v.teams[0]).toMatchObject({ title: 'Команда 1', placeholder: true, countryCode: null, captainId: null, color: '#d0352c' });
    expect(v.config.testerIds).toEqual([a.id]);
  });

  it('пульт: из теста в настоящую игру - ход теста стираем, подготовку ведущего (название, страна, задание) оставляем', async () => {
    await setTeamCount(env, host, 2);
    const a = await makeUser(env);
    await makeParticipant(env, a, { gender: 'm' });
    await addTester(env, host, a.id);
    await setLaunch(env, host, 'test');
    await enrollTesters(env, host);
    await distribute(env, host);
    const team = (await gameAdminView(env)).teams[0]!;
    await createTask(env, host, { title: 'Горная деревня', context: '', text: '', countryCode: null });
    const task = (await gameAdminView(env)).tasks[0]!;
    await updateTeam(env, host, team.id, { name: 'Надежда', countryCode: 'KE', color: '#123456', taskId: task.id });
    await startGame(env, host, true);
    await setLaunch(env, host, 'live', { wipe: true, invite: false, keepSetup: true });
    const v = await gameAdminView(env);
    expect(v.launch).toBe('live');
    expect(v.players).toEqual([]);
    expect(v.distributedAt).toBeNull();
    expect(v.startedAt).toBeNull();
    expect(v.teams[0]).toMatchObject({ title: 'Надежда', countryCode: 'KE', color: '#123456', taskId: task.id, captainId: null });
  });

  it('сохранение настроек не меняет запуск и тест-лист', async () => {
    const a = await makeUser(env);
    await saveGameConfig(env, host, config());
    await addTester(env, host, a.id);
    await setLaunch(env, host, 'test');
    await saveGameSettings(env, host, config({ enabled: false, adminsOnly: false, testerIds: [], pointsPerTeam: 7 }));
    const v = await gameAdminView(env);
    expect(v.launch).toBe('test');
    expect(v.config).toMatchObject({ testerIds: [a.id], pointsPerTeam: 7 });
  });
});

describe('игра: запуск приглашает', () => {
  const inviteJobs = async () =>
    (await env.pool.query<{ data: { userIds?: number[] } }>(`select data from pgboss.job where name = 'game.invite' order by created_on`)).rows.map((r) => r.data);

  it('тестовый запуск сразу открывает запись и рассылает приглашения; новому в тест-листе - только ему', async () => {
    await env.pool.query(`delete from pgboss.job where name = 'game.invite'`);
    await saveGameConfig(env, host, config());
    const a = await makeUser(env);
    await makeParticipant(env, a, { gender: 'm' });
    await addTester(env, host, a.id);
    expect(await inviteJobs()).toEqual([]);
    await setLaunch(env, host, 'test');
    expect((await gameAdminView(env)).signupOpen).toBe(true);
    expect(await inviteJobs()).toEqual([{}]);
    // Добавили человека посреди теста - приглашение только ему.
    const b = await makeUser(env);
    await addTester(env, host, b.id);
    expect(await inviteJobs()).toEqual([{}, { userIds: [b.id] }]);
    // b не зарегистрирован - ему отдельное сообщение «голосовать можно».
    expect(await votersOnlyTesters(env.db)).toEqual([b.id]);
  });

  it('запуск без приглашений - запись закрыта, рассылки нет', async () => {
    await env.pool.query(`delete from pgboss.job where name = 'game.invite'`);
    await saveGameConfig(env, host, config({ enabled: false }));
    await setLaunch(env, host, 'live', { invite: false });
    expect((await gameAdminView(env)).signupOpen).toBe(false);
    expect(await inviteJobs()).toEqual([]);
  });
});

describe('игра: кнопка «Участвую» от и до', () => {
  it('повторное «Участвую» ничего не меняет; после распределения выйти из команды кнопкой нельзя', async () => {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 2);
    await setSignup(env, host, true);
    const a = await player('m');
    const before = (await env.db.select().from(schema.gamePlayers).where(eq(schema.gamePlayers.participantId, a.pid)))[0]!;
    await answerGame(env, a.user, [], a.pid, true);
    const again = (await env.db.select().from(schema.gamePlayers).where(eq(schema.gamePlayers.participantId, a.pid)))[0]!;
    expect(again.answeredAt.getTime()).toBe(before.answeredAt.getTime());
    await distribute(env, host);
    await expect(answerGame(env, a.user, [], a.pid, false)).rejects.toMatchObject({ code: 'answer_locked' });
    const s = await answerGame(env, a.user, [], a.pid, true);
    expect(s.people[0]).toMatchObject({ answer: 'yes', teamId: expect.any(Number) });
  });

  it('до распределения передумать можно', async () => {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 2);
    await setSignup(env, host, true);
    const a = await player('f');
    const s = await answerGame(env, a.user, [], a.pid, false);
    expect(s.people[0]).toMatchObject({ answer: 'no', teamId: null });
  });
});

describe('игра: задания, тайна до старта и сцена', () => {
  /** Две команды по игроку, у каждой задание; ведущий даёт страну через задание. */
  async function prepared() {
    await saveGameConfig(env, host, config());
    await setTeamCount(env, host, 2);
    await setSignup(env, host, true);
    const a = await player('m');
    const b = await player('f');
    await distribute(env, host);
    await createTask(env, host, { title: 'Церковь в горах', context: 'В деревне нет *ни одной* церкви', text: 'Расскажите про **деревню**', countryCode: 'KE' });
    await createTask(env, host, { title: 'Церковь в городе', context: '', text: '', countryCode: null });
    const view = await gameAdminView(env);
    const teamA = view.players.find((p) => p.participantId === a.pid)!.teamId!;
    const teamB = view.players.find((p) => p.participantId === b.pid)!.teamId!;
    return { a, b, teamA, teamB, kenya: view.tasks.find((t) => t.countryCode === 'KE')!, city: view.tasks.find((t) => !t.countryCode)! };
  }

  it('задание со страной ставит команде страну; задание переходит от команды к команде; случайная раздача без повторов', async () => {
    const { teamA, teamB, kenya, city } = await prepared();
    await updateTeam(env, host, teamA, { taskId: kenya.id });
    let view = await gameAdminView(env);
    expect(view.teams.find((t) => t.id === teamA)).toMatchObject({ taskId: kenya.id, countryCode: 'KE' });
    await updateTeam(env, host, teamB, { taskId: kenya.id });
    view = await gameAdminView(env);
    expect(view.teams.find((t) => t.id === teamA)!.taskId).toBeNull();
    expect(view.teams.find((t) => t.id === teamB)!.taskId).toBe(kenya.id);
    expect(await assignTasks(env, host)).toEqual({ assigned: 1, left: 0 });
    view = await gameAdminView(env);
    expect(view.teams.find((t) => t.id === teamA)!.taskId).toBe(city.id);
    expect(view.tasks.map((t) => t.teamId).sort()).toEqual([teamA, teamB].sort());
  });

  it('капитан выбирает страну - получает её задание; страну без свободного задания выбрать нельзя', async () => {
    const { a, teamA, kenya } = await prepared();
    await saveGameConfig(env, host, config({ countryBy: 'captain' }));
    await updateTeam(env, host, teamA, { captainId: a.pid });
    const s = await gameStateFor(env, a.user, []);
    expect(s.captainCountry).toBe(true);
    expect(s.countries).toEqual(['KE']);
    await expect(designTeam(env, a.user, [], teamA, { name: 'Надежда', countryCode: 'FR' })).rejects.toMatchObject({ code: 'country_taken' });
    await designTeam(env, a.user, [], teamA, { name: 'Надежда', countryCode: 'KE' });
    expect((await gameAdminView(env)).teams.find((t) => t.id === teamA)).toMatchObject({ taskId: kenya.id, countryCode: 'KE', title: 'Надежда' });
  });

  it('страну даёт ведущий: капитан меняет только название; страна и задание скрыты до «Показать задания», потом - только своё', async () => {
    const { a, b, teamA, teamB, kenya, city } = await prepared();
    await updateTeam(env, host, teamA, { taskId: kenya.id, captainId: a.pid });
    await updateTeam(env, host, teamB, { taskId: city.id, countryCode: 'BR' });
    await designTeam(env, a.user, [], teamA, { name: 'Надежда', countryCode: 'FR' });
    expect((await gameAdminView(env)).teams.find((t) => t.id === teamA)).toMatchObject({ countryCode: 'KE', title: 'Надежда' });

    let s = await gameStateFor(env, a.user, []);
    expect(s.revealed).toBe(false);
    expect(s.teams.every((t) => t.countryCode === null && t.flag === null)).toBe(true);
    expect(s.teamTasks).toEqual({});
    const token = (await gameAdminView(env)).screenToken;
    let screen = await gameScreen(env, token);
    expect(screen.phase).toBe('lobby');
    expect(screen.teams.every((t) => t.flag === null)).toBe(true);

    await startGame(env, host, true);
    expect((await gameScreen(env, token)).phase).toBe('started');
    expect((await gameAdminView(env)).signupOpen).toBe(false);

    await revealTasks(env, host, true, false);
    s = await gameStateFor(env, a.user, []);
    expect(s.teams.find((t) => t.id === teamA)).toMatchObject({ countryCode: 'KE', flag: '🇰🇪' });
    expect(s.teamTasks).toEqual({ [teamA]: { title: 'Церковь в горах', context: 'В деревне нет *ни одной* церкви', text: 'Расскажите про **деревню**' } });
    expect(Object.keys((await gameStateFor(env, b.user, [])).teamTasks)).toEqual([String(teamB)]);
    screen = await gameScreen(env, token);
    expect(screen.phase).toBe('revealed');
    expect(screen.teams.find((t) => t.id === teamB)!.flag).toBe('🇧🇷');
  });

  it('на сцене: флаг и задание команды на экране; «Скрыть» убирает', async () => {
    const { teamA, kenya } = await prepared();
    await updateTeam(env, host, teamA, { taskId: kenya.id });
    const token = (await gameAdminView(env)).screenToken;
    await setStage(env, host, teamA);
    const screen = await gameScreen(env, token);
    expect(screen.stage).toMatchObject({ team: { id: teamA, countryCode: 'KE', flag: '🇰🇪' }, task: { title: 'Церковь в горах' } });
    expect((await gameAdminView(env)).stageTeamId).toBe(teamA);
    await setStage(env, host, null);
    expect((await gameScreen(env, token)).stage).toBeNull();
  });

  it('«Показать задания» с сообщением: каждой команде её задание в бот, одно на аккаунт', async () => {
    const { a, b, teamA, teamB, kenya, city } = await prepared();
    await updateTeam(env, host, teamA, { taskId: kenya.id });
    await updateTeam(env, host, teamB, { taskId: city.id });
    await revealTasks(env, host, true, true);
    const jobs = await env.pool.query(`select count(*)::int as n from pgboss.job where name = 'game.tasks_revealed'`);
    expect(jobs.rows[0].n).toBeGreaterThan(0);
    const sent: { chat: number; text: string }[] = [];
    const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
    tg.config.use(async (_prev, method, payload) => {
      const p = payload as { chat_id: number; text?: string };
      if (method === 'sendMessage') sent.push({ chat: p.chat_id, text: p.text ?? '' });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' }, text: '' } } as never;
    });
    await runJob({ ...env, tg }, 'game.tasks_revealed', {}, 'game-reveal-1');
    expect(sent).toHaveLength(2);
    const toA = sent.find((m) => m.chat === a.user.tgId)!;
    expect(toA.text).toContain('🇰🇪');
    expect(toA.text).toContain('Церковь в горах');
    expect(toA.text).toContain('<b>деревню</b>');
    expect(toA.text).toContain('<b>Контекст</b>\nВ деревне нет <i>ни одной</i> церкви');
    expect(toA.text).toContain('<b>Задание</b>\nРасскажите');
    expect(sent.find((m) => m.chat === b.user.tgId)!.text).toContain('Церковь в городе');
  });
});

describe('игра: рассылка приглашений', () => {
  /** Поддельный Telegram: запоминает, кому и что отправили. */
  function fakeTg() {
    const sent: { chat: number; text: string; buttons: string[] }[] = [];
    const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
    let msg = 1;
    tg.config.use(async (_prev, method, payload) => {
      const p = payload as { chat_id: number; text?: string; reply_markup?: { inline_keyboard?: { text: string }[][] } };
      if (method === 'sendMessage') sent.push({ chat: p.chat_id, text: p.text ?? '', buttons: (p.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text) });
      return { ok: true, result: method === 'sendMessage' ? { message_id: ++msg, date: 0, chat: { id: p.chat_id, type: 'private' }, text: '' } : true } as never;
    });
    return { tg, sent };
  }

  it('тестовый запуск: тестировщику - приглашение с кнопками и пометкой «тест», без регистрации - «голосовать можно», остальным - ничего', async () => {
    await saveGameConfig(env, host, config());
    const a = await makeUser(env);
    await makeParticipant(env, a, { gender: 'm' });
    const b = await makeUser(env);
    const outsider = await makeUser(env);
    await makeParticipant(env, outsider, { gender: 'f' });
    await addTester(env, host, a.id);
    await addTester(env, host, b.id);
    await setLaunch(env, host, 'test');
    const { tg, sent } = fakeTg();
    await runJob({ ...env, tg }, 'game.invite', {}, 'game-invite-test-1');
    const toA = sent.filter((m) => m.chat === a.tgId);
    const toB = sent.filter((m) => m.chat === b.tgId);
    expect(toA).toHaveLength(1);
    expect(toA[0]!.text).toContain('Тестовый запуск');
    expect(toA[0]!.buttons).toEqual(expect.arrayContaining(['🙋 Участвую', 'Не участвую']));
    expect(toB).toHaveLength(1);
    expect(toB[0]!.text).toContain('голосовать');
    expect(sent.some((m) => m.chat === outsider.tgId)).toBe(false);
    // Приглашение только новому человеку.
    sent.splice(0);
    await runJob({ ...env, tg }, 'game.invite', { userIds: [b.id] }, 'game-invite-test-2');
    expect(sent.map((m) => m.chat)).toEqual([b.tgId]);
  });
});

