import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.ts';
import type { RealtimeHub, RealtimeKind } from '../../realtime/hub.ts';
import { requireParticipant } from '../auth.ts';

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RealtimeHub;
  }
}

/** Пульс, чтобы прокси и мобильные сети не рвали молчащее соединение. */
const PING_MS = 25_000;

/**
 * Поток подсказок для Mini App (Server-Sent Events). Данные в нём не ходят - только «что устарело»:
 * приложение само перезапрашивает нужное обычными запросами (те же права и кэш). Авторизация - заголовок
 * `tma`, поэтому клиент читает поток через fetch, а не EventSource (тот не умеет заголовки).
 */
export function eventRoutes(app: FastifyInstance, ctx: AppContext, hub: RealtimeHub) {
  app.get('/api/events', { preHandler: requireParticipant(ctx) }, async (req, reply) => {
    // Выключено или мест нет - 503: приложение не ломится повторно и обновляется опросом.
    if (!ctx.config.REALTIME_ENABLED) return reply.code(503).send({ error: 'realtime_off', message: 'Живые обновления выключены' });
    if (!hub.hasRoom(ctx.config.REALTIME_MAX_STREAMS)) {
      return reply.code(503).send({ error: 'realtime_busy', message: 'Слишком много подключений' });
    }
    const userId = req.tgUser!.id;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    const write = (chunk: string) => {
      if (open) res.write(chunk);
    };
    write('retry: 5000\n\nevent: hello\ndata: {}\n\n');
    const remove = hub.add({
      userId,
      send: (kind: RealtimeKind) => write(`event: ${kind}\ndata: {}\n\n`),
      close: () => {
        if (!open) return;
        open = false;
        res.end();
      },
    });
    const ping = setInterval(() => write(': ping\n\n'), PING_MS);
    req.raw.on('close', () => {
      open = false;
      clearInterval(ping);
      remove();
    });
  });
}
