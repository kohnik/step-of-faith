import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { RealtimeHub } from '../realtime/hub.ts';
import { invalidateSettingsCache } from '../services/settings.service.ts';
import { countRequest } from '../services/traffic.service.ts';
import { AppError } from '../lib/errors.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { chatRoutes } from './routes/chat.ts';
import { devRoutes } from './routes/dev.ts';
import { eventRoutes } from './routes/events.ts';
import { gameRoutes } from './routes/game.ts';
import { feedbackRoutes } from './routes/feedback.ts';
import { merchRoutes } from './routes/merch.ts';
import { participantRoutes } from './routes/participant.ts';
import { publicRoutes } from './routes/public.ts';
import { staffRoutes } from './routes/staff.ts';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  // Загрузка файлов (фото и 3D мерча, чеки): один файл на запрос; точный предел - на маршруте.
  await app.register(multipart, { limits: { files: 1, fields: 10, fileSize: 30 * 1024 * 1024 } });
  // Только для публичных маршрутов (config.rateLimit на маршруте); остальное - лимит на пользователя.
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Слишком много запросов, подождите немного' });
    }
    if (err.validation || (err.statusCode && err.statusCode < 500)) {
      return reply.code(err.statusCode ?? 400).send({ error: 'bad_request', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Что-то пошло не так. Попробуйте ещё раз.' });
  });

  // Нагрузка: запросы Mini App участников (без админки, сканера, служебных и потока живых обновлений) - и чьи они.
  app.addHook('onResponse', async (req) => {
    const u = req.url;
    if (u.startsWith('/api/') && !/^\/api\/(admin|staff|health|events|auth|public)\b/.test(u)) countRequest('app', req.tgUser?.id);
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: `Нет такого адреса: ${req.url}` }));

  publicRoutes(app, ctx);
  devRoutes(app, ctx);
  authRoutes(app, ctx);
  participantRoutes(app, ctx);
  merchRoutes(app, ctx);
  chatRoutes(app, ctx);
  gameRoutes(app, ctx);
  feedbackRoutes(app, ctx);
  // Живые обновления Mini App: слушатель канала базы живёт столько же, сколько сервер.
  // Настройки поменяли (в т. ч. из другого процесса) - сбрасываем кэш, иначе приложения перезапросили бы старые.
  const hub = new RealtimeHub(ctx.config.DATABASE_URL, ctx.log, 2000, (kind) => {
    if (kind === 'settings') invalidateSettingsCache();
  });
  // Выключено - не держим и соединение с базой для прослушивания.
  if (ctx.config.REALTIME_ENABLED) await hub.start();
  // preClose: открытые потоки закрываем до остановки сервера, иначе он ждал бы их вечно.
  app.addHook('preClose', async () => hub.stop());
  app.decorate('realtime', hub);
  eventRoutes(app, ctx, hub);
  staffRoutes(app, ctx);
  adminRoutes(app, ctx);
  return app;
}
