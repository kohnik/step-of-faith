import { sign } from '@tma.js/init-data-node';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.ts';

/**
 * Только для локальной разработки (NODE_ENV=development): выдаёт подписанную initData,
 * чтобы открыть Mini App в обычном браузере без Telegram. В проде маршрута нет.
 */
export function devRoutes(app: FastifyInstance, ctx: AppContext) {
  if (ctx.config.NODE_ENV !== 'development') return;
  app.get('/api/dev/init-data', async (req) => {
    const q = req.query as { tgId?: string; name?: string };
    const tgId = Number(q.tgId ?? 777000001);
    const initData = sign(
      {
        user: {
          id: tgId,
          first_name: q.name ?? 'Тестовый',
          last_name: 'Пользователь',
          username: `dev${tgId}`,
          language_code: 'ru',
          allows_write_to_pm: true,
        },
      } as never,
      ctx.config.BOT_TOKEN,
      new Date(),
    );
    return { initData };
  });
}
