import {
  activityInputSchema,
  activitySignupSchema,
  activityUpdateSchema,
  adminParticipantCreateSchema,
  adminParticipantUpdateSchema,
  adminPaymentSchema,
  announcementInputSchema,
  announcementUpdateSchema,
  broadcastInputSchema,
  bulkParticipantsSchema,
  checkpointInputSchema,
  checkpointUpdateSchema,
  counselingOpenSchema,
  counselingAnnounceSchema,
  counselorInputSchema,
  counselorUpdateSchema,
  donationSchema,
  hasPermission,
  infoPageInputSchema,
  moneyCancelSchema,
  moneyEntrySchema,
  participantListInputSchema,
  participantListMembersSchema,
  type PeopleCounts,
  type Permission,
  plannedRoomSchema,
  receiptDecisionSchema,
  roomInputSchema,
  roomUpdateSchema,
  scannerCardSchema,
  segmentSchema,
  seminarAutoPlanSchema,
  seminarBlockInputSchema,
  seminarBlockUpdateSchema,
  seminarMoveSchema,
  seminarPlanSchema,
  seminarTopicInputSchema,
  seminarTopicUpdateSchema,
  settingsPatchSchema,
  settingsSchema,
  staffInviteSchema,
  memberLinkSchema,
  staffPasswordSchema,
  staffRolesSchema,
} from '@sof/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.ts';
import { enqueue } from '../../jobs/queues.ts';
import {
  adminCancelBooking,
  announceCounseling,
  adminCounseling,
  createCounselor,
  deleteCounselor,
  setCounselingOpen,
  updateCounselor,
} from '../../services/counseling.service.ts';
import {
  autoPlanSeminars,
  changedPeople,
  createBlock,
  createRoom,
  createTopic,
  deleteBlock,
  deleteRoom,
  deleteTopic,
  distributeSeminars,
  listBlocks,
  listRooms,
  moveSeminarPerson,
  publishSeminars,
  seminarsSummary,
  setAllBlocksRegistration,
  setSeminarAutoPlan,
  setPlannedRoom,
  unplacedPeople,
  updateBlock,
  updateRoom,
  updateTopic,
} from '../../services/seminar.service.ts';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import {
  activityRegistrations,
  canEditActivity,
  createActivity,
  deleteActivity,
  listActivities,
  updateActivity,
} from '../../services/activity.service.ts';
import {
  auditRows,
  bulkUpdate,
  checkInRows,
  createCheckpoint,
  ensureDailyEntrances,
  createParticipant,
  duplicateGroups,
  exportActivityXlsx,
  exportSeminarBlockXlsx,
  exportParticipantsXlsx,
  exportPaymentsXlsx,
  exportReceiptsXlsx,
  participantDetail,
  participantRow,
  participantRows,
  reissue,
  scanLogRows,
  updateCheckpoint,
  updateParticipant,
  deleteParticipant,
} from '../../services/admin.service.ts';
import {
  addToParticipantList,
  createParticipantList,
  deleteParticipantList,
  listParticipantLists,
  removeFromParticipantList,
  renameParticipantList,
} from '../../services/lists.service.ts';
import { cancelBroadcast, createBroadcast, listBroadcasts, previewSegment } from '../../services/broadcast.service.ts';
import { listCheckpoints, revokeCheckIn } from '../../services/checkin.service.ts';
import { dashboard } from '../../services/dashboard.service.ts';
import { addDonation, listPayments, undoDonation } from '../../services/ledger.service.ts';
import { addMoneyEntry, cancelMoneyEntry, moneyView } from '../../services/money.service.ts';
import {
  createAnnouncement,
  deleteAnnouncement,
  deletePage,
  getInfo,
  updateAnnouncement,
  upsertPage,
} from '../../services/info.service.ts';
import { deleteReceipt, listReceipts, markPaid, receiptFile, reviewReceipt, undoPayment, unsentDrafts } from '../../services/payment.service.ts';
import { getSettings, patchSettings, updateSettings } from '../../services/settings.service.ts';
import { botMessagesForParticipant, botOverview, botRun, botUnreachable } from '../../services/bot-log.service.ts';
import {
  createInvite,
  disableMemberLink,
  makeMemberLink,
  memberLink,
  createScannerCard,
  listStaff,
  setPassword,
  setRoles,
} from '../../services/staff.service.ts';
import { requireStaff } from '../auth.ts';
import { idParam, parse } from '../http.ts';

function sendXlsx(reply: FastifyReply, filename: string, body: Buffer) {
  reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return reply.send(body);
}

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const need = (...perms: Permission[]) => ({ preHandler: requireStaff(ctx, perms) });
  const staff = (req: FastifyRequest) => req.staff!;
  /** После приёма или отмены оплаты: полная строка - тем, кому можно читать участников; кассе - только оплата. */
  const paymentRowFor = async (req: FastifyRequest, id: number) => {
    const row = await participantRow(ctx, id);
    if (hasPermission(staff(req).roles, 'participants:read')) return row;
    const { fullName, paymentStatus, amountDue, amountPaid, paidAt, status } = row;
    return { id, fullName, paymentStatus, amountDue, amountPaid, paidAt, status };
  };
  const query = (req: FastifyRequest) => req.query as Record<string, string | undefined>;

  app.get('/api/admin/dashboard', need('dashboard:read'), async () => dashboard(ctx));

  // ---------- участники ----------

  app.get('/api/admin/participants', need('participants:read'), async () => ({ items: await participantRows(ctx) }));

  /** Живые счётчики для меню: дёшево, можно опрашивать каждые 10 секунд. */
  app.get('/api/admin/counts', need('participants:read'), async (): Promise<PeopleCounts> => {
    const res = await ctx.db.execute<{ participants: number; confirmed: number }>(sql`
      select count(*)::int as participants, count(arrived_at)::int as confirmed
        from participants where status = 'active'`);
    return res.rows[0]!;
  });

  app.get('/api/admin/participants/export.xlsx', need('export'), async (_req, reply) =>
    sendXlsx(reply, `participants-${new Date().toISOString().slice(0, 10)}.xlsx`, await exportParticipantsXlsx(ctx)),
  );

  app.get('/api/admin/participants/duplicates', need('participants:read'), async () => duplicateGroups(ctx));

  app.get('/api/admin/participants/:id', need('participants:read'), async (req) => participantDetail(ctx, idParam(req.params)));
  /** Что бот отправил этому человеку (его аккаунту и тому, кто его записал). */
  app.get('/api/admin/participants/:id/bot-messages', need('participants:read'), async (req) => botMessagesForParticipant(ctx.db, idParam(req.params)));

  // ---------- сообщения бота ----------

  app.get('/api/admin/bot-log', need('broadcasts:send'), async () => botOverview(ctx.db));
  app.get('/api/admin/bot-log/runs/:key', need('broadcasts:send'), async (req) =>
    botRun(ctx.db, decodeURIComponent((req.params as { key: string }).key)),
  );
  app.get('/api/admin/bot-log/unreachable', need('broadcasts:send'), async () => botUnreachable(ctx.db));

  app.patch('/api/admin/participants/:id', need('participants:write'), async (req) =>
    updateParticipant(ctx, idParam(req.params), parse(adminParticipantUpdateSchema, req.body), staff(req)),
  );

  // Удалить совсем (дубль, тест) - админ и суперадмин; карточка остаётся в журнале действий.
  app.delete('/api/admin/participants/:id', need('participants:write'), async (req) => deleteParticipant(ctx, idParam(req.params), staff(req)));

  app.post('/api/admin/participants', need('participants:write'), async (req) =>
    createParticipant(ctx, parse(adminParticipantCreateSchema, req.body), staff(req)),
  );

  // Массовые правки - только с правом менять участников: у кассы оно точечное (свой приём, 15 минут на отмену).
  app.post('/api/admin/participants/bulk', need('participants:write'), async (req) =>
    bulkUpdate(ctx, parse(bulkParticipantsSchema, req.body), staff(req)),
  );

  app.post('/api/admin/participants/:id/reissue', need('participants:write'), async (req) =>
    reissue(ctx, idParam(req.params), staff(req)),
  );

  app.post('/api/admin/participants/:id/resend', need('participants:write'), async (req) => {
    const id = idParam(req.params);
    const p = await ctx.db.query.participants.findFirst({ where: (t, { eq }) => eq(t.id, id) });
    if (!p || p.status !== 'active') throw notFound('Участник не найден');
    await enqueue(ctx.boss, 'tickets.send', { userId: p.holderUserId ?? p.ownerUserId, participantIds: [id], reason: 'resend' });
    return { queued: true };
  });

  // ---------- оплаты ----------

  /** Принять оплату за человека (наличные в 504-м, перевод по выписке банка - в т. ч. у людей без Telegram). */
  app.post('/api/admin/participants/:id/payment', need('payments:write'), async (req) => {
    const id = idParam(req.params);
    const body = parse(adminPaymentSchema, req.body);
    const res = await markPaid(ctx, staff(req), {
      participantIds: [id],
      method: body.method,
      amount: body.amount ?? null,
      note: body.note ?? null,
      requestId: body.requestId ?? null,
    });
    if (!res.duplicate && res.updated === 0) {
      throw conflict('nothing_to_pay', 'Ничего не зачислено: взнос уже внесён, участник без взноса или отменён');
    }
    const row = await paymentRowFor(req, id);
    return res.duplicate ? { ...row, warning: 'Этот приём уже записан - повтор не засчитан' } : row;
  });

  /** Отменить оплату (ошиблись): свежую - вернуть как было, давнюю - «не оплачено». */
  app.post('/api/admin/participants/:id/payment/undo', need('payments:write'), async (req) => {
    const id = idParam(req.params);
    await undoPayment(ctx, staff(req), id);
    return paymentRowFor(req, id);
  });

  /** Прислали чек, но не нажали «Отправить» - кому написать. */
  app.get('/api/admin/receipts/drafts', need('payments:write'), async () => unsentDrafts(ctx.db));

  app.get('/api/admin/receipts', need('payments:write'), async (req) => {
    const status = z.enum(['pending', 'accepted', 'rejected']).optional().parse(query(req).status || undefined);
    return listReceipts(ctx, status);
  });

  // Выгрузка отобранных чеков: ids через запятую (то, что отобрано фильтром или отмечено в таблице).
  app.get('/api/admin/receipts/export.xlsx', need('payments:write'), async (req, reply) => {
    const ids = String(query(req).ids ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 5000);
    if (ids.length === 0) throw badRequest('no_receipts', 'Нет чеков для выгрузки');
    return sendXlsx(reply, `receipts-${new Date().toISOString().slice(0, 10)}.xlsx`, await exportReceiptsXlsx(ctx, ids));
  });

  /** Журнал оплат: наличные на кассе, принятые чеки, правки - каждое зачисление строкой. */
  app.get('/api/admin/payments', need('payments:write'), async () => listPayments(ctx.db));

  app.post('/api/admin/donations', need('payments:write'), async (req) => addDonation(ctx, staff(req), parse(donationSchema, req.body)));
  app.post('/api/admin/donations/:id/undo', need('payments:write'), async (req) => undoDonation(ctx, staff(req), idParam(req.params)));

  app.get('/api/admin/payments/export.xlsx', need('payments:write'), async (req, reply) => {
    const ids = String(query(req).ids ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 10000);
    if (ids.length === 0) throw badRequest('no_payments', 'Нет оплат для выгрузки');
    return sendXlsx(reply, `payments-${new Date().toISOString().slice(0, 10)}.xlsx`, await exportPaymentsXlsx(ctx, ids));
  });

  // ---------- деньги (банкир): весь приход и расход ----------

  app.get('/api/admin/money', need('money:manage'), async () => moneyView(ctx.db));
  app.post('/api/admin/money', need('money:manage'), async (req) => addMoneyEntry(ctx, staff(req), parse(moneyEntrySchema, req.body)));
  app.post('/api/admin/money/:id/cancel', need('money:manage'), async (req) =>
    cancelMoneyEntry(ctx, staff(req), idParam(req.params), parse(moneyCancelSchema, req.body).reason),
  );
  app.get('/api/admin/money/export.xlsx', need('money:manage'), async (req, reply) => {
    const ids = String(query(req).ids ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 20000);
    if (ids.length === 0) throw badRequest('no_payments', 'Нет записей для выгрузки');
    return sendXlsx(reply, `money-${new Date().toISOString().slice(0, 10)}.xlsx`, await exportPaymentsXlsx(ctx, ids, { all: true }));
  });

  app.get('/api/admin/receipts/:id/file', need('payments:write'), async (req, reply) => {
    const n = Number((req.query as Record<string, string | undefined>).n ?? 0);
    const file = await receiptFile(ctx, idParam(req.params), Number.isInteger(n) && n >= 0 && n < 50 ? n : 0);
    reply.header('Content-Type', file.contentType).header('Cache-Control', 'private, max-age=600');
    return reply.send(file.body);
  });

  app.post('/api/admin/receipts/:id/accept', need('payments:write'), async (req) =>
    reviewReceipt(ctx, idParam(req.params), staff(req), 'accept', parse(receiptDecisionSchema, req.body ?? {})),
  );

  app.post('/api/admin/receipts/:id/reject', need('payments:write'), async (req) =>
    reviewReceipt(ctx, idParam(req.params), staff(req), 'reject', parse(receiptDecisionSchema, req.body ?? {})),
  );

  /** Удалить чек (дубль, прислали не то) - только суперадмин. */
  app.delete('/api/admin/receipts/:id', need('receipts:delete'), async (req) => deleteReceipt(ctx, idParam(req.params), staff(req)));

  // ---------- check-in ----------

  app.get('/api/admin/check-ins', need('participants:read'), async (req) => {
    const cp = Number(query(req).checkpointId);
    return { items: await checkInRows(ctx.db, Number.isInteger(cp) && cp > 0 ? sql`ci.checkpoint_id = ${cp}` : sql`true`) };
  });

  app.post('/api/admin/check-ins/:id/revoke', need('checkin:revoke'), async (req) => {
    await revokeCheckIn(ctx, staff(req), idParam(req.params));
    return { ok: true };
  });

  app.get('/api/admin/scan-log', need('participants:read'), async (req) => {
    const outcome = query(req).outcome;
    return { items: await scanLogRows(ctx.db, outcome ? sql`sl.outcome = ${outcome}` : sql`true`) };
  });

  app.get('/api/admin/checkpoints', need('participants:read', 'checkin:write'), async () => listCheckpoints(ctx.db));

  app.post('/api/admin/checkpoints', need('activities:all'), async (req) =>
    createCheckpoint(ctx, parse(checkpointInputSchema, req.body), staff(req)),
  );

  app.patch('/api/admin/checkpoints/:id', need('activities:all'), async (req) =>
    updateCheckpoint(ctx, idParam(req.params), parse(checkpointUpdateSchema, req.body), staff(req)),
  );

  /** Точки входа на каждый день конференции (по датам из настроек): на 2-й и 3-й день отметка - новая. */
  app.post('/api/admin/checkpoints/daily-entrances', need('activities:all'), async (req) => ensureDailyEntrances(ctx, staff(req)));

  // ---------- активности ----------

  app.get('/api/admin/activities', need('activities:own', 'activities:all'), async (req) => {
    const s = staff(req);
    return hasPermission(s.roles, 'activities:all')
      ? listActivities(ctx, { includeDrafts: true })
      : listActivities(ctx, { includeDrafts: true, createdBy: s.user.id });
  });

  app.post('/api/admin/activities', need('activities:own', 'activities:all'), async (req) =>
    createActivity(ctx, parse(activityInputSchema, req.body), staff(req)),
  );

  app.patch('/api/admin/activities/:id', need('activities:own', 'activities:all'), async (req) =>
    updateActivity(ctx, idParam(req.params), parse(activityUpdateSchema, req.body), staff(req)),
  );

  // ---------- залы и семинары ----------

  app.get('/api/admin/rooms', need('activities:own', 'activities:all'), async () => listRooms(ctx.db));
  app.post('/api/admin/rooms', need('activities:all'), async (req) => createRoom(ctx.db, parse(roomInputSchema, req.body)));
  app.patch('/api/admin/rooms/:id', need('activities:all'), async (req) =>
    replanAfter(req, updateRoom(ctx.db, idParam(req.params), parse(roomUpdateSchema, req.body))),
  );
  app.delete('/api/admin/rooms/:id', need('activities:all'), async (req) => {
    await replanAfter(req, deleteRoom(ctx.db, idParam(req.params)));
    return { ok: true };
  });

  /** Поменяли темы, потоки или залы - автоматическое распределение (если включено) раскладывает людей заново. */
  const replanAfter = async <T>(req: FastifyRequest, work: Promise<T>): Promise<T> => {
    const result = await work;
    await autoPlanSeminars(ctx, staff(req).user.id);
    return result;
  };
  app.get('/api/admin/seminars', need('activities:all'), async () => listBlocks(ctx.db));
  app.post('/api/admin/seminars', need('activities:all'), async (req) =>
    replanAfter(req, createBlock(ctx, parse(seminarBlockInputSchema, req.body), staff(req))),
  );
  /** «Запись на семинары открыта» - сразу во всех блоках (у каждого блока остаётся свой выключатель). */
  app.patch('/api/admin/seminars/registration', need('activities:all'), async (req) =>
    setAllBlocksRegistration(ctx, parse(activitySignupSchema, req.body).open, staff(req)),
  );
  app.patch('/api/admin/seminars/:id', need('activities:all'), async (req) =>
    replanAfter(req, updateBlock(ctx, idParam(req.params), parse(seminarBlockUpdateSchema, req.body), staff(req))),
  );
  app.delete('/api/admin/seminars/:id', need('activities:all'), async (req) => {
    await replanAfter(req, deleteBlock(ctx, idParam(req.params), staff(req)));
    return { ok: true };
  });
  /** Темы - общие для всех потоков; голоса, распределение и публикация - сразу по всем потокам. */
  app.get('/api/admin/seminar-topics', need('activities:all'), async () => seminarsSummary(ctx.db));
  app.post('/api/admin/seminar-topics', need('activities:all'), async (req) =>
    replanAfter(req, createTopic(ctx, parse(seminarTopicInputSchema, req.body), staff(req))),
  );
  app.patch('/api/admin/seminar-topics/:id', need('activities:all'), async (req) =>
    replanAfter(req, updateTopic(ctx, idParam(req.params), parse(seminarTopicUpdateSchema, req.body), staff(req))),
  );
  app.delete('/api/admin/seminar-topics/:id', need('activities:all'), async (req) =>
    replanAfter(req, deleteTopic(ctx, idParam(req.params), staff(req))),
  );
  app.post('/api/admin/seminar-sessions/:id/room', need('activities:all'), async (req) =>
    replanAfter(req, setPlannedRoom(ctx.db, idParam(req.params), parse(plannedRoomSchema, req.body).roomId)),
  );
  app.post('/api/admin/seminars/plan', need('activities:all'), async (req) =>
    distributeSeminars(ctx, parse(seminarPlanSchema, req.body ?? {}).reset, staff(req)),
  );
  /** «Распределять автоматически»: включили - сразу раскладываем, кого ещё не разложили. */
  app.post('/api/admin/seminars/auto', need('activities:all'), async (req) =>
    setSeminarAutoPlan(ctx, parse(seminarAutoPlanSchema, req.body).on, staff(req)),
  );
  app.post('/api/admin/seminars/publish', need('activities:all'), async (req) => publishSeminars(ctx, staff(req)));
  app.post('/api/admin/seminars/move', need('activities:all'), async (req) =>
    moveSeminarPerson(ctx, parse(seminarMoveSchema, req.body), staff(req)),
  );
  app.get('/api/admin/seminars/changed', need('activities:all'), async () => changedPeople(ctx.db));
  app.get('/api/admin/seminars/:id/unplaced', need('activities:all'), async (req) => unplacedPeople(ctx.db, idParam(req.params)));

  // ---------- душепопечение ----------

  app.get('/api/admin/counseling', need('activities:all'), async () => adminCounseling(ctx.db));
  app.patch('/api/admin/counseling', need('activities:all'), async (req) =>
    setCounselingOpen(ctx.db, parse(counselingOpenSchema, req.body).open, staff(req)),
  );
  app.post('/api/admin/counselors', need('activities:all'), async (req) =>
    createCounselor(ctx, parse(counselorInputSchema, req.body), staff(req)),
  );
  app.patch('/api/admin/counselors/:id', need('activities:all'), async (req) =>
    updateCounselor(ctx, idParam(req.params), parse(counselorUpdateSchema, req.body), staff(req)),
  );
  app.delete('/api/admin/counselors/:id', need('activities:all'), async (req) => deleteCounselor(ctx, idParam(req.params), staff(req)));
  app.post('/api/admin/counseling/announce', need('activities:all'), async (req) =>
    announceCounseling(ctx, parse(counselingAnnounceSchema, req.body).counselorId, staff(req)),
  );
  app.delete('/api/admin/counseling-bookings/:id', need('activities:all'), async (req) =>
    adminCancelBooking(ctx, idParam(req.params), staff(req)),
  );

  /** Удалить мероприятие совсем; записавшимся - сообщение. */
  app.delete('/api/admin/activities/:id', need('activities:own', 'activities:all'), async (req) =>
    deleteActivity(ctx, staff(req), idParam(req.params)),
  );

  const ownActivity = async (req: FastifyRequest) => {
    const id = idParam(req.params);
    const a = await ctx.db.query.activities.findFirst({ where: (t, { eq }) => eq(t.id, id) });
    if (!a) throw notFound('Активность не найдена');
    if (!canEditActivity(staff(req), a)) throw forbidden();
    return id;
  };

  app.get('/api/admin/activities/:id/registrations', need('activities:own', 'activities:all'), async (req) =>
    activityRegistrations(ctx, await ownActivity(req)),
  );

  app.get('/api/admin/activities/:id/registrations.xlsx', need('activities:own', 'activities:all'), async (req, reply) => {
    const { title, body } = await exportActivityXlsx(ctx, await ownActivity(req));
    return sendXlsx(reply, `${title}.xlsx`, body);
  });

  /** Все списки блока семинаров одной книгой: лист на тему. */
  app.get('/api/admin/seminars/:id/registrations.xlsx', need('activities:all'), async (req, reply) => {
    const { title, body } = await exportSeminarBlockXlsx(ctx, idParam(req.params));
    return sendXlsx(reply, `${title}.xlsx`, body);
  });

  // ---------- списки участников ----------

  // Списки нужны и в рассылках: там их видят те, кто рассылает.
  app.get('/api/admin/lists', need('participants:read', 'broadcasts:send'), async () => listParticipantLists(ctx.db));

  app.post('/api/admin/lists', need('participants:write'), async (req) =>
    createParticipantList(ctx.db, parse(participantListInputSchema, req.body), staff(req)),
  );

  app.patch('/api/admin/lists/:id', need('participants:write'), async (req) =>
    renameParticipantList(ctx.db, idParam(req.params), parse(participantListInputSchema, req.body), staff(req)),
  );

  app.delete('/api/admin/lists/:id', need('participants:write'), async (req) => {
    await deleteParticipantList(ctx.db, idParam(req.params), staff(req));
    return { ok: true };
  });

  app.post('/api/admin/lists/:id/add', need('participants:write'), async (req) =>
    addToParticipantList(ctx.db, idParam(req.params), parse(participantListMembersSchema, req.body).ids, staff(req)),
  );

  app.post('/api/admin/lists/:id/remove', need('participants:write'), async (req) =>
    removeFromParticipantList(ctx.db, idParam(req.params), parse(participantListMembersSchema, req.body).ids, staff(req)),
  );

  // ---------- рассылки ----------

  app.post('/api/admin/broadcasts/preview', need('broadcasts:send'), async (req) => ({
    recipients: await previewSegment(ctx.db, parse(z.object({ segment: segmentSchema }), req.body).segment),
  }));

  app.get('/api/admin/broadcasts', need('broadcasts:send'), async () => listBroadcasts(ctx));

  app.post('/api/admin/broadcasts', need('broadcasts:send'), async (req) =>
    createBroadcast(ctx, parse(broadcastInputSchema, req.body), staff(req)),
  );

  app.post('/api/admin/broadcasts/:id/cancel', need('broadcasts:send'), async (req) =>
    cancelBroadcast(ctx, idParam(req.params), staff(req)),
  );

  // ---------- контент ----------

  app.get('/api/admin/content', need('content:write'), async () => getInfo(ctx, { includeHidden: true }));

  app.put('/api/admin/info-pages/:slug', need('content:write'), async (req) =>
    upsertPage(ctx, (req.params as { slug: string }).slug, parse(infoPageInputSchema, req.body), staff(req)),
  );

  app.delete('/api/admin/info-pages/:slug', need('content:write'), async (req) => {
    await deletePage(ctx, (req.params as { slug: string }).slug, staff(req));
    return { ok: true };
  });

  app.post('/api/admin/announcements', need('content:write'), async (req) =>
    createAnnouncement(ctx, parse(announcementInputSchema, req.body), staff(req)),
  );

  app.patch('/api/admin/announcements/:id', need('content:write'), async (req) =>
    updateAnnouncement(ctx, idParam(req.params), parse(announcementUpdateSchema, req.body), staff(req)),
  );

  app.delete('/api/admin/announcements/:id', need('content:write'), async (req) => {
    await deleteAnnouncement(ctx, idParam(req.params), staff(req));
    return { ok: true };
  });

  // ---------- персонал ----------

  app.get('/api/admin/staff', need('staff:manage', 'staff:invite_cashier'), async (req) =>
    listStaff(ctx, { onlyCashiers: !staff(req).permissions.includes('staff:manage') }),
  );

  app.post('/api/admin/staff/:id/roles', need('staff:manage'), async (req) =>
    setRoles(ctx, idParam(req.params), parse(staffRolesSchema, req.body).roles, staff(req)),
  );

  app.post('/api/admin/staff/invites', need('staff:manage', 'staff:invite_cashier'), async (req) => {
    const body = parse(staffInviteSchema, req.body);
    return createInvite(ctx, body.role, body.expiresInHours, staff(req));
  });

  // Многоразовая ссылка «Участник команды» - тем же, кто может приглашать (роль слабее кассира).
  app.get('/api/admin/staff/member-link', need('staff:manage', 'staff:invite_cashier'), async () => ({ link: await memberLink(ctx) }));
  app.post('/api/admin/staff/member-link', need('staff:manage', 'staff:invite_cashier'), async (req) =>
    makeMemberLink(ctx, staff(req), parse(memberLinkSchema, req.body ?? {}).reset),
  );
  app.delete('/api/admin/staff/member-link', need('staff:manage', 'staff:invite_cashier'), async (req) => {
    await disableMemberLink(ctx.db, staff(req));
    return { ok: true };
  });

  app.post('/api/admin/staff/scanner-cards', need('staff:manage'), async (req) => {
    const body = parse(scannerCardSchema, req.body);
    return createScannerCard(ctx, body.name, body.role, body.expiresInHours, staff(req));
  });

  app.post('/api/admin/staff/:id/password', need('staff:manage'), async (req) => {
    const body = parse(staffPasswordSchema, req.body);
    return setPassword(ctx, idParam(req.params), body.login, body.password, staff(req));
  });

  // ---------- настройки и аудит ----------

  app.get('/api/admin/settings', need('dashboard:read', 'settings:write', 'payments:write'), async () =>
    getSettings(ctx.db, { fresh: true }),
  );

  app.put('/api/admin/settings', need('settings:write'), async (req) =>
    updateSettings(ctx.db, parse(settingsSchema, req.body), staff(req).user.id),
  );
  app.patch('/api/admin/settings', need('settings:write'), async (req) =>
    patchSettings(ctx.db, parse(settingsPatchSchema, req.body), staff(req).user.id),
  );

  /** Запись на мероприятия открывают на месте - это может любой админ расписания, не только суперадмин. */
  app.get('/api/admin/activities-signup', need('activities:own', 'activities:all'), async () => ({
    open: (await getSettings(ctx.db)).activityRegistrationOpen,
  }));
  app.patch('/api/admin/activities-signup', need('activities:all'), async (req) => {
    const { open } = parse(activitySignupSchema, req.body);
    const next = await patchSettings(ctx.db, { activityRegistrationOpen: open }, staff(req).user.id);
    return { open: next.activityRegistrationOpen };
  });

  app.get('/api/admin/audit', need('audit:read'), async (req) => {
    const q = query(req);
    return auditRows(ctx.db, { entity: q.entity || undefined, entityId: q.entityId || undefined });
  });
}
