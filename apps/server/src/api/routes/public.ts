import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppContext } from '../../context.ts';
import { notFound } from '../../lib/errors.ts';
import { getInfo } from '../../services/info.service.ts';
import { getPublicTicket, publicTicketPng } from '../../services/tickets.service.ts';

export function publicRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/health', async () => {
    await ctx.db.execute(sql`select 1`);
    return { ok: true, time: new Date().toISOString() };
  });

  const limit = { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } };

  /** Веб-билет: открывается в браузере по секретной ссылке, без Telegram. */
  app.get('/api/public/tickets/:token', limit, async (req, reply) => {
    const { token } = req.params as { token: string };
    const ticket = await getPublicTicket(ctx.db, ctx.config, token);
    if (!ticket) throw notFound('Билет не найден');
    reply.header('Cache-Control', 'private, no-cache');
    return ticket;
  });

  app.get('/api/public/tickets/:token/image.png', limit, async (req, reply) => {
    const { token } = req.params as { token: string };
    const png = await publicTicketPng(ctx.db, token);
    if (!png) throw notFound('Билет не найден');
    reply
      .header('Content-Type', 'image/png')
      .header('Content-Disposition', 'inline; filename="ticket.png"')
      .header('Cache-Control', 'private, max-age=3600');
    return reply.send(png);
  });

  app.get('/api/public/info', limit, async () => getInfo(ctx));
}
