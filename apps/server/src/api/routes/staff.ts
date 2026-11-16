import {
  activityInputSchema,
  activityParticipantSchema,
  activityUpdateSchema,
  canUseAdminWeb,
  checkInBatchSchema,
  hasPermission,
  type AdminLinkResponse,
  type DevWipeResponse,
  lookupSchema,
  donationSchema,
  markPaidSchema,
  promiseTransferSchema,
  moneyCancelSchema,
  moneyEntrySchema,
  revokeByEventSchema,
  paymentUndoSchema,
  paymentFindSchema,
} from '@sof/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.ts';
import { forbidden, notFound } from '../../lib/errors.ts';
import {
  activityRegistrations,
  canEditActivity,
  createActivity,
  deleteActivity,
  ensureActivityCheckpoint,
  listActivities,
  staffEnroll,
  staffUnenroll,
  updateActivity,
} from '../../services/activity.service.ts';
import {
  buildManifest,
  listCheckpoints,
  findForPayment,
  lookup,
  manifestVersion,
  processCheckIns,
  revokeCheckIn,
  revokeCheckInByEvent,
  searchParticipants,
  staffRecent,
  staffStats,
} from '../../services/checkin.service.ts';
import { staffOverview } from '../../services/overview.service.ts';
import { markPaid, promiseTransfer, undoPayment } from '../../services/payment.service.ts';
import { addDonation, listPayments, undoDonation } from '../../services/ledger.service.ts';
import { addMoneyEntry, cancelMoneyEntry, moneySummary } from '../../services/money.service.ts';
import { createAdminLoginLink } from '../../services/staff.service.ts';
import { RESET_MESSAGE, wipeChatsAndNotify, wipeDatabase } from '../../services/dev.service.ts';
import { requireStaff } from '../auth.ts';
import { idParam, parse } from '../http.ts';

export function staffRoutes(app: FastifyInstance, ctx: AppContext) {
  const scan = { preHandler: requireStaff(ctx, ['checkin:write', 'activities:own']) };
  const scanOnly = { preHandler: requireStaff(ctx, ['checkin:write']) };
  const cash = { preHandler: requireStaff(ctx, ['payments:write']) };
  const acts = { preHandler: requireStaff(ctx, ['activities:own', 'activities:all']) };
  const bank = { preHandler: requireStaff(ctx, ['money:manage']) };
  const staff = (req: FastifyRequest) => req.staff!;
  const numQuery = (req: FastifyRequest, key: string) => {
    const v = Number((req.query as Record<string, string | undefined>)[key]);
    return Number.isInteger(v) && v > 0 ? v : null;
  };

  app.get('/api/staff/checkpoints', scan, async () => listCheckpoints(ctx.db, { activeOnly: true }));

  /** Только на время разработки: «Очистить всю базу» для DEV_WIPE_TG_IDS. Всем уходит сообщение. */
  app.post('/api/staff/dev/wipe', { preHandler: requireStaff(ctx) }, async (req): Promise<DevWipeResponse> => {
    const s = staff(req);
    if (s.user.tgId == null || !ctx.config.DEV_WIPE_TG_IDS.includes(s.user.tgId)) throw notFound();
    const res = await wipeDatabase(ctx, s.user.id);
    req.log.warn({ by: s.user.id, participants: res.participants, accounts: res.accounts }, 'database wiped (dev)');
    wipeChatsAndNotify(ctx, res.chats, RESET_MESSAGE);
    return { participants: res.participants, accounts: res.accounts, notifying: res.chats.length };
  });

  /** «Статистика» в приложении команды - тем, кому доступна сводка админки. */
  app.get('/api/staff/overview', { preHandler: requireStaff(ctx, ['dashboard:read']) }, async () => staffOverview(ctx));

  /** «Админка» в приложении: одноразовая ссылка, по которой браузер сам входит в веб-админку. */
  app.post('/api/staff/admin-link', { preHandler: requireStaff(ctx) }, async (req): Promise<AdminLinkResponse> => {
    const s = staff(req);
    if (!canUseAdminWeb(s.roles)) throw forbidden('Админка доступна только админам');
    return { url: await createAdminLoginLink(ctx, s.user) };
  });

  /** Локальная база билетов для сканера. Клиент шлёт If-None-Match - чаще всего ответ 304. */
  app.get('/api/staff/manifest', scanOnly, async (req, reply) => {
    const etag = `"${await manifestVersion(ctx.db)}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return buildManifest(ctx);
  });

  app.post('/api/staff/lookup', scan, async (req) => lookup(ctx, staff(req), parse(lookupSchema, req.body)));

  app.post('/api/staff/check-ins', scan, async (req) => {
    const { events } = parse(checkInBatchSchema, req.body);
    return { results: await processCheckIns(ctx, staff(req), events) };
  });

  // Отменить свою отметку (10 минут) может и организатор на своей активности; чужие - только с checkin:revoke.
  app.post('/api/staff/check-ins/:id/revoke', scan, async (req) => {
    await revokeCheckIn(ctx, staff(req), idParam(req.params));
    return { ok: true };
  });

  /** «Отменить» для события из офлайн-очереди, которое могло успеть дойти до сервера. */
  app.post('/api/staff/check-ins/revoke-by-event', scan, async (req) =>
    revokeCheckInByEvent(ctx, staff(req), parse(revokeByEventSchema, req.body).clientEventId),
  );

  app.get('/api/staff/search', scan, async (req) => {
    const q = String((req.query as Record<string, string | undefined>).q ?? '');
    return { items: await searchParticipants(ctx.db, q, numQuery(req, 'checkpointId')) };
  });

  app.get('/api/staff/stats', scan, async (req) => {
    const checkpointId = numQuery(req, 'checkpointId');
    if (!checkpointId) throw notFound('Точка не выбрана');
    return staffStats(ctx.db, checkpointId, staff(req).user.id);
  });

  app.get('/api/staff/recent', scan, async (req) => {
    const checkpointId = numQuery(req, 'checkpointId');
    if (!checkpointId) throw notFound('Точка не выбрана');
    return staffRecent(ctx.db, checkpointId, staff(req).user.id);
  });

  app.post('/api/staff/payments/mark-paid', cash, async (req) => markPaid(ctx, staff(req), parse(markPaidSchema, req.body)));
  /** На входе: не оплатил, заплатит переводом - реквизиты в бот, вход отмечает сканер. */
  app.post('/api/staff/payments/promise-transfer', cash, async (req) => promiseTransfer(ctx, staff(req), parse(promiseTransferSchema, req.body).participantIds));
  /**
   * Касса: человек по QR-коду или id - без записи в журнал входа. До начала конференции сканер работает
   * как проверка оплаты, поэтому смотреть может и сканер; принять оплату - только касса.
   */
  app.post('/api/staff/payments/find', scanOnly, async (req) => findForPayment(ctx.db, parse(paymentFindSchema, req.body)));
  /** Касса: «Мои приёмы» - кого принял(а) этот человек и на какую сумму. */
  app.get('/api/staff/payments/mine', cash, async (req) => listPayments(ctx.db, { acceptedBy: staff(req).user.id }));
  /** Касса: пожертвование - от участника (по QR-коду) или без него. */
  app.post('/api/staff/donations', cash, async (req) => addDonation(ctx, staff(req), parse(donationSchema, req.body)));
  app.post('/api/staff/donations/:id/undo', cash, async (req) => undoDonation(ctx, staff(req), idParam(req.params)));
  /** Банкир с телефона: сводка и свои записи, выдать или принять деньги, отменить запись с причиной. */
  app.get('/api/staff/money', bank, async (req) => ({
    summary: await moneySummary(ctx.db),
    mine: await listPayments(ctx.db, { acceptedBy: staff(req).user.id, kinds: ['income', 'payout'] }),
  }));
  app.post('/api/staff/money', bank, async (req) => addMoneyEntry(ctx, staff(req), parse(moneyEntrySchema, req.body)));
  app.post('/api/staff/money/:id/cancel', bank, async (req) =>
    cancelMoneyEntry(ctx, staff(req), idParam(req.params), parse(moneyCancelSchema, req.body).reason),
  );
  /** Касса ошиблась человеком - отменить свой приём (15 минут). */
  app.post('/api/staff/payments/undo', cash, async (req) => undoPayment(ctx, staff(req), parse(paymentUndoSchema, req.body).participantId));

  // ---------- активности организатора ----------

  app.get('/api/staff/activities', acts, async (req) => {
    const s = staff(req);
    return hasPermission(s.roles, 'activities:all')
      ? listActivities(ctx, { includeDrafts: true })
      : listActivities(ctx, { includeDrafts: true, createdBy: s.user.id });
  });

  app.post('/api/staff/activities', acts, async (req) =>
    createActivity(ctx, parse(activityInputSchema, req.body), staff(req)),
  );

  app.patch('/api/staff/activities/:id', acts, async (req) =>
    updateActivity(ctx, idParam(req.params), parse(activityUpdateSchema, req.body), staff(req)),
  );

  app.delete('/api/staff/activities/:id', acts, async (req) => deleteActivity(ctx, staff(req), idParam(req.params)));

  app.get('/api/staff/activities/:id/registrations', acts, async (req) => {
    const id = idParam(req.params);
    const a = await ctx.db.query.activities.findFirst({ where: (t, { eq }) => eq(t.id, id) });
    if (!a) throw notFound('Активность не найдена');
    if (!canEditActivity(staff(req), a)) throw forbidden();
    return activityRegistrations(ctx, id);
  });

  /** Записать человека на активность за него (нет своего Telegram) и убрать запись. */
  app.post('/api/staff/activities/:id/registrations', acts, async (req) =>
    staffEnroll(ctx, staff(req), idParam(req.params), parse(activityParticipantSchema, req.body).participantId),
  );
  app.post('/api/staff/activities/:id/registrations/cancel', acts, async (req) =>
    staffUnenroll(ctx, staff(req), idParam(req.params), parse(activityParticipantSchema, req.body).participantId),
  );

  app.post('/api/staff/activities/:id/checkpoint', scan, async (req) =>
    ensureActivityCheckpoint(ctx, idParam(req.params), staff(req)),
  );
}
