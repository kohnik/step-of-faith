import {
  gameAnswerSchema,
  gameConfigSchema,
  gameLaunchSchema,
  gameMoveSchema,
  gameRevealSchema,
  gameRoundOpenSchema,
  gameStageSchema,
  gameTaskInputSchema,
  gameTeamDesignSchema,
  gameTeamUpdateSchema,
  gameVoteSchema,
} from '@sof/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.ts';
import {
  answerGame,
  closeGameRound,
  designTeam,
  distribute,
  extendGameRound,
  gameAdminView,
  gameCandidates,
  addTester,
  enrollTesters,
  removeTester,
  resetGame,
  saveGameSettings,
  searchBotUsers,
  setLaunch,
  gameScreen,
  gameStateFor,
  movePlayer,
  newScreenToken,
  openGameRound,
  randomCaptain,
  reinvite,
  reorderTeams,
  resetDistribution,
  resetVotes,
  reviewProposal,
  setGameFlags,
  setSignup,
  setTeamCount,
  updateTeam,
  voteGame,
  assignTasks,
  createTask,
  deleteTask,
  revealTasks,
  setStage,
  startGame,
  updateTask,
} from '../../services/game.service.ts';
import { getRoles } from '../../services/users.service.ts';
import { requireParticipant, requireStaff } from '../auth.ts';
import { idParam, parse, tooManyRequests, UserRateLimiter } from '../http.ts';

// Голос сохраняется по ходу нажатий (с задержкой на клиенте): до ~3 запросов в секунду на человека с запасом.
const voteLimiter = new UserRateLimiter(30, 3);

export function gameRoutes(app: FastifyInstance, ctx: AppContext) {
  const participant = { preHandler: requireParticipant(ctx) };
  const host = { preHandler: requireStaff(ctx, ['game:manage']) };
  const me = (req: FastifyRequest) => req.tgUser!;
  const staff = (req: FastifyRequest) => req.staff!;
  const roles = (req: FastifyRequest) => getRoles(ctx.db, me(req).id);

  // ---------- мини-апка: любой, кто открыл бота ----------

  app.get('/api/game', participant, async (req) => gameStateFor(ctx, me(req), await roles(req)));

  app.post('/api/game/answer', participant, async (req) => {
    const body = parse(gameAnswerSchema, req.body);
    return answerGame(ctx, me(req), await roles(req), body.participantId, body.yes);
  });

  app.post('/api/game/vote', participant, async (req) => {
    if (!voteLimiter.take(`v:${me(req).id}`)) throw tooManyRequests();
    return voteGame(ctx, me(req), await roles(req), parse(gameVoteSchema, req.body));
  });

  app.post('/api/game/teams/:id/design', participant, async (req) =>
    designTeam(ctx, me(req), await roles(req), idParam(req.params), parse(gameTeamDesignSchema, req.body)),
  );

  // ---------- большой экран: по секретной ссылке, без входа ----------

  app.get('/api/game/screen/:token', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(8).max(64) }), req.params);
    reply.header('Cache-Control', 'no-store');
    return gameScreen(ctx, token);
  });

  // ---------- ведущий ----------

  app.get('/api/admin/game', host, async () => gameAdminView(ctx));

  // ---------- задания и ход игры ----------

  app.post('/api/admin/game/tasks', host, async (req) => {
    await createTask(ctx, staff(req), parse(gameTaskInputSchema, req.body));
    return gameAdminView(ctx);
  });

  app.patch('/api/admin/game/tasks/:id', host, async (req) => {
    await updateTask(ctx, staff(req), idParam(req.params), parse(gameTaskInputSchema, req.body));
    return gameAdminView(ctx);
  });

  app.delete('/api/admin/game/tasks/:id', host, async (req) => {
    await deleteTask(ctx, staff(req), idParam(req.params));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/teams/assign-tasks', host, async (req) => {
    const result = await assignTasks(ctx, staff(req));
    return { ...result, view: await gameAdminView(ctx) };
  });

  app.post('/api/admin/game/start', host, async (req) => {
    await startGame(ctx, staff(req), parse(z.object({ started: z.boolean() }), req.body).started);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/reveal', host, async (req) => {
    const body = parse(gameRevealSchema, req.body);
    await revealTasks(ctx, staff(req), body.revealed, body.notify);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/stage', host, async (req) => {
    await setStage(ctx, staff(req), parse(gameStageSchema, req.body).teamId);
    return gameAdminView(ctx);
  });

  app.get('/api/admin/game/candidates', host, async (req) => gameCandidates(ctx, parse(z.object({ q: z.string().max(100).default('') }), req.query).q));

  app.get('/api/admin/game/bot-users', host, async (req) => searchBotUsers(ctx, parse(z.object({ q: z.string().max(100).default('') }), req.query).q));

  app.post('/api/admin/game/reset', host, async (req) => {
    await resetGame(ctx, staff(req), parse(z.object({ scope: z.enum(['teams', 'all']) }), req.body).scope);
    return gameAdminView(ctx);
  });

  app.put('/api/admin/game/config', host, async (req) => saveGameSettings(ctx, staff(req), parse(gameConfigSchema, req.body)));

  app.post('/api/admin/game/launch', host, async (req) => {
    const body = parse(gameLaunchSchema, req.body);
    await setLaunch(ctx, staff(req), body.mode, { wipe: body.wipe, invite: body.invite, keepSetup: body.keepSetup });
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/testers', host, async (req) => {
    await addTester(ctx, staff(req), parse(z.object({ userId: z.number().int().positive() }), req.body).userId);
    return gameAdminView(ctx);
  });

  app.delete('/api/admin/game/testers/:id', host, async (req) => {
    await removeTester(ctx, staff(req), idParam(req.params));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/testers/enroll', host, async (req) => {
    const result = await enrollTesters(ctx, staff(req));
    return { ...result, view: await gameAdminView(ctx) };
  });

  app.post('/api/admin/game/signup', host, async (req) => {
    await setSignup(ctx, staff(req), parse(z.object({ open: z.boolean() }), req.body).open);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/reinvite', host, async () => {
    await reinvite(ctx);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/distribute', host, async (req) => {
    const result = await distribute(ctx, staff(req));
    return { ...result, view: await gameAdminView(ctx) };
  });

  app.post('/api/admin/game/reset-distribution', host, async (req) => {
    await resetDistribution(ctx, staff(req));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/flags', host, async (req) => {
    await setGameFlags(ctx, staff(req), parse(z.object({ designLocked: z.boolean().optional(), resultsShown: z.boolean().optional() }), req.body));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/screen-token', host, async (req) => {
    await newScreenToken(ctx, staff(req));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/teams/count', host, async (req) => {
    await setTeamCount(ctx, staff(req), parse(z.object({ count: z.number().int() }), req.body).count);
    return gameAdminView(ctx);
  });

  app.patch('/api/admin/game/teams/:id', host, async (req) => {
    await updateTeam(ctx, staff(req), idParam(req.params), parse(gameTeamUpdateSchema, req.body));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/teams/:id/proposal', host, async (req) => {
    await reviewProposal(ctx, staff(req), idParam(req.params), parse(z.object({ approve: z.boolean() }), req.body).approve);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/teams/:id/random-captain', host, async (req) => {
    await randomCaptain(ctx, staff(req), idParam(req.params));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/teams/order', host, async (req) => {
    const body = parse(z.object({ ids: z.array(z.number().int().positive()).max(100).optional(), shuffle: z.boolean().optional() }), req.body);
    await reorderTeams(ctx, staff(req), body.shuffle ? 'shuffle' : (body.ids ?? []));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/players/move', host, async (req) => {
    const body = parse(gameMoveSchema, req.body);
    await movePlayer(ctx, staff(req), body.participantId, body.teamId);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/rounds', host, async (req) => {
    const body = parse(gameRoundOpenSchema, req.body);
    await openGameRound(ctx, staff(req), body.teamId, body.seconds);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/rounds/close', host, async (req) => {
    await closeGameRound(ctx, staff(req));
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/rounds/extend', host, async (req) => {
    await extendGameRound(ctx, staff(req), parse(z.object({ seconds: z.number().int().min(10).max(600) }), req.body).seconds);
    return gameAdminView(ctx);
  });

  app.post('/api/admin/game/reset-votes', host, async (req) => {
    await resetVotes(ctx, staff(req));
    return gameAdminView(ctx);
  });
}
