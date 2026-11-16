import { FEEDBACK_CATEGORIES, feedbackInputSchema, feedbackSettingsPatchSchema, feedbackStarSchema, type FeedbackCategory } from '@sof/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.ts';
import {
  adminFeedback,
  createFeedback,
  deleteFeedback,
  feedbackXlsx,
  markPromptSeen,
  setFeedbackSwitches,
  starFeedback,
  type FeedbackFilter,
} from '../../services/feedback.service.ts';
import { getRoles } from '../../services/users.service.ts';
import { requireParticipant, requireStaff } from '../auth.ts';
import { idParam, parse, tooManyRequests, UserRateLimiter } from '../http.ts';

const sendLimiter = new UserRateLimiter(5, 0.2);

/** Фильтр списка из адреса: категория, избранные, поиск, конкретные номера (выгрузка отмеченных). */
function filterOf(req: FastifyRequest): FeedbackFilter {
  const q = req.query as Record<string, string | undefined>;
  const category = (FEEDBACK_CATEGORIES as readonly string[]).includes(q.category ?? '') ? (q.category as FeedbackCategory) : null;
  const ids = q.ids
    ? q.ids
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 5000)
    : undefined;
  return { category, starred: q.starred === '1', q: q.q?.slice(0, 200), ids };
}

/** Отзывы: участник оставляет в приложении, команда читает и выгружает в админке. */
export function feedbackRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireParticipant(ctx) };
  const read = { preHandler: requireStaff(ctx, ['feedback:read']) };
  const settings = { preHandler: requireStaff(ctx, ['settings:write']) };

  app.post('/api/feedback', auth, async (req) => {
    const user = req.tgUser!;
    if (!sendLimiter.take(`u:${user.id}`)) throw tooManyRequests();
    return createFeedback(ctx.db, user, await getRoles(ctx.db, user.id), parse(feedbackInputSchema, req.body));
  });
  app.post('/api/feedback/seen', auth, async (req) => {
    await markPromptSeen(ctx.db, req.tgUser!);
    return { ok: true };
  });

  app.get('/api/admin/feedback', read, async (req) => adminFeedback(ctx.db, filterOf(req)));
  app.get('/api/admin/feedback/export.xlsx', read, async (req, reply) =>
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`otzyvy-${new Date().toISOString().slice(0, 10)}.xlsx`)}`)
      .send(await feedbackXlsx(ctx.db, filterOf(req))),
  );
  app.patch('/api/admin/feedback/:id', read, async (req) => {
    await starFeedback(ctx.db, req.staff!, idParam(req.params), parse(feedbackStarSchema, req.body).starred);
    return { ok: true };
  });
  app.delete('/api/admin/feedback/:id', read, async (req) => {
    await deleteFeedback(ctx.db, req.staff!, idParam(req.params));
    return { ok: true };
  });
  app.patch('/api/admin/feedback-settings', settings, async (req) => {
    const s = await setFeedbackSwitches(ctx.db, req.staff!, parse(feedbackSettingsPatchSchema, req.body));
    return { open: s.feedbackOpen, admins: s.feedbackAdmins };
  });
}
