import {
  activityParticipantSchema,
  activitySwitchSchema,
  claimSchema,
  counselingBookSchema,
  verifyPhoneSchema,
  participantUpdateSchema,
  paymentMethodChangeSchema,
  guestRegistrationSchema,
  registrationSubmitSchema,
  seminarVotesSchema,
  type SeminarsPublic,
} from '@sof/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.ts';
import { enqueue } from '../../jobs/queues.ts';
import {
  cancelActivityRegistration,
  listActivities,
  registerForActivity,
  setInterest,
  switchActivity,
} from '../../services/activity.service.ts';
import { claim, findClaimable, phoneFromSignedContact, setVerifiedPhone } from '../../services/claim.service.ts';
import { adoptRestoredByPhone } from '../../services/restore.service.ts';
import { bookCounseling, cancelCounseling, publicCounseling } from '../../services/counseling.service.ts';
import { getInfo } from '../../services/info.service.ts';
import { publicSeminars, saveSeminarVotes } from '../../services/seminar.service.ts';
import {
  cancelOwnParticipant,
  changePaymentMethod,
  createTransferLink,
  getMe,
  updateOwnParticipant,
} from '../../services/participants.service.ts';
import { activeFamilyIds, submitGuestRegistration, submitRegistration } from '../../services/registration.service.ts';
import { getSettings } from '../../services/settings.service.ts';
import { getRoles, getUser } from '../../services/users.service.ts';
import { requireParticipant } from '../auth.ts';
import { idParam, oneFile, parse, tooManyRequests, UserRateLimiter } from '../http.ts';
import { createPurposeReceipt } from '../../services/payment.service.ts';
import { PHOTO_MAX_BYTES, savePrivate } from '../../services/media.service.ts';
import { badRequest } from '../../lib/errors.ts';

const SEMINARS_HIDDEN: SeminarsPublic = { open: false, published: false, picks: 0, topics: [], votes: [], sessions: [], waiting: [] };

// Щедро: одно нажатие - до 5 запросов (повторы при плохой связи), а «мест нет» и «это не я» тоже требуют повтора.
const registrationLimiter = new UserRateLimiter(20, 0.5);
const resendLimiter = new UserRateLimiter(1, 1 / 60);
const claimLimiter = new UserRateLimiter(10, 0.1);
const receiptLimiter = new UserRateLimiter(6, 0.1);

export function participantRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireParticipant(ctx) };
  const me = (req: FastifyRequest) => req.tgUser!;

  app.get('/api/me', auth, async (req) => getMe(ctx, me(req)));

  // «Меня уже зарегистрировали». Пользователя перечитываем: initData кэшируется, а номер мог только что появиться.
  const fresh = async (req: FastifyRequest) => (await getUser(ctx.db, me(req).id)) ?? me(req);

  app.get('/api/me/claimable', auth, async (req) => findClaimable(ctx.db, await fresh(req)));

  /** Номер из Telegram (подписанный ответ requestContact) → запоминаем и ищем регистрации на него. */
  app.post('/api/me/phone', auth, async (req) => {
    const user = me(req);
    if (!claimLimiter.take(`p:${user.id}`)) throw tooManyRequests();
    const phone = phoneFromSignedContact(parse(verifyPhoneSchema, req.body).contact, ctx.config.BOT_TOKEN, user.tgId);
    const withPhone = await setVerifiedPhone(ctx.db, user, phone);
    // После сбоя хостинга: семья из выгрузки с этим номером переходит на аккаунт.
    const adopted = await adoptRestoredByPhone(ctx, withPhone);
    return { ...(await findClaimable(ctx.db, withPhone)), adopted: adopted.length };
  });

  app.post('/api/me/claim', auth, async (req) => {
    const user = me(req);
    if (!claimLimiter.take(`c:${user.id}`)) throw tooManyRequests();
    return claim(ctx, await fresh(req), parse(claimSchema, req.body).participantIds);
  });

  app.post('/api/registrations', auth, async (req) => {
    const user = me(req);
    if (!registrationLimiter.take(`r:${user.id}`)) throw tooManyRequests();
    const body = parse(registrationSubmitSchema, req.body);
    return submitRegistration(ctx, user, body);
  });

  /** «Гость» на месте: Ф.И., телефон, пол - только за себя, «Только взнос». */
  /** Чек пожертвования из приложения: файл - сразу в закрытую папку, чек - на проверку. */
  app.post('/api/receipts/donation', auth, async (req) => {
    if (!receiptLimiter.take(`d:${me(req).id}`)) throw tooManyRequests();
    const settings = await getSettings(ctx.db);
    if (!settings.paymentsEnabled || !settings.transfersEnabled) throw badRequest('transfers_disabled', 'Переводы сейчас не принимаем');
    const { data } = await oneFile(req, PHOTO_MAX_BYTES);
    const saved = await savePrivate(ctx.config.PRIVATE_DIR, 'receipts', data);
    const res = await createPurposeReceipt(ctx, me(req), { kind: 'donation' }, { stored: saved });
    return { sent: res.status === 'sent' };
  });

  app.post('/api/registrations/guest', auth, async (req) => {
    const user = me(req);
    if (!registrationLimiter.take(`r:${user.id}`)) throw tooManyRequests();
    return submitGuestRegistration(ctx, user, parse(guestRegistrationSchema, req.body));
  });

  app.patch('/api/participants/:id', auth, async (req) =>
    updateOwnParticipant(ctx, me(req), idParam(req.params), parse(participantUpdateSchema, req.body)),
  );

  app.post('/api/participants/:id/payment-method', auth, async (req) =>
    changePaymentMethod(ctx, me(req), idParam(req.params), parse(paymentMethodChangeSchema, req.body).method),
  );

  app.post('/api/participants/:id/cancel', auth, async (req) => {
    await cancelOwnParticipant(ctx, me(req), idParam(req.params));
    return getMe(ctx, me(req));
  });

  app.post('/api/participants/:id/transfer-link', auth, async (req) =>
    createTransferLink(ctx, me(req), idParam(req.params)),
  );

  /** «Прислать билеты в чат ещё раз» - не чаще раза в минуту. */
  app.post('/api/tickets/resend', auth, async (req) => {
    const user = me(req);
    if (!resendLimiter.take(`t:${user.id}`)) return { queued: false, reason: 'too_soon' };
    const ids = await activeFamilyIds(ctx, [user.id]);
    if (ids.length === 0) return { queued: false, reason: 'no_tickets' };
    await enqueue(ctx.boss, 'tickets.send', { userId: user.id, participantIds: ids, reason: 'resend' });
    return { queued: true };
  });

  // Расписание скрыто в настройках - участникам пусто, команда (любая роль) видит как обычно.
  app.get('/api/schedule', auth, async (req) => {
    const user = me(req);
    if (!(await getSettings(ctx.db)).scheduleVisible && (await getRoles(ctx.db, user.id)).length === 0) return [];
    return listActivities(ctx, { userId: user.id });
  });

  /** Семинары: выбор тем семьи и, после публикации, свои сеансы с залами. Расписание скрыто - тоже скрыто. */
  app.get('/api/seminars', auth, async (req) => {
    const user = me(req);
    if (!(await getSettings(ctx.db)).scheduleVisible && (await getRoles(ctx.db, user.id)).length === 0) return SEMINARS_HIDDEN;
    return publicSeminars(ctx, user.id);
  });
  app.put('/api/seminars/votes', auth, async (req) => saveSeminarVotes(ctx, me(req), parse(seminarVotesSchema, req.body)));

  // Душепопечение: служители с окошками; чужие записи - только «занято». Расписание скрыто - тоже скрыто.
  app.get('/api/counseling', auth, async (req) => {
    const user = me(req);
    const settings = await getSettings(ctx.db);
    if (!settings.scheduleVisible && (await getRoles(ctx.db, user.id)).length === 0) {
      return { open: settings.counselingOpen, counselors: [], my: [] };
    }
    return publicCounseling(ctx, user.id);
  });
  app.post('/api/counseling/book', auth, async (req) => bookCounseling(ctx, me(req), parse(counselingBookSchema, req.body)));
  app.post('/api/counseling/cancel', auth, async (req) => {
    const { participantId } = parse(activityParticipantSchema, req.body);
    return cancelCounseling(ctx, me(req), participantId);
  });

  app.post('/api/activities/:id/register', auth, async (req) => {
    const { participantId } = parse(activityParticipantSchema, req.body);
    return registerForActivity(ctx, me(req), idParam(req.params), participantId);
  });

  /** Перезапись при пересечении по времени: из fromActivityId в :id. */
  app.post('/api/activities/:id/switch', auth, async (req) => {
    const { participantId, fromActivityId } = parse(activitySwitchSchema, req.body);
    return switchActivity(ctx, me(req), idParam(req.params), participantId, fromActivityId);
  });

  app.post('/api/activities/:id/cancel', auth, async (req) => {
    const { participantId } = parse(activityParticipantSchema, req.body);
    return cancelActivityRegistration(ctx, me(req), idParam(req.params), participantId);
  });

  app.post('/api/activities/:id/interest', auth, async (req) => {
    const { on } = parse(z.object({ on: z.boolean() }), req.body);
    return setInterest(ctx, me(req), idParam(req.params), on);
  });

  app.get('/api/info', auth, async () => getInfo(ctx));
}
