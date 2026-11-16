import type {
  GameStateView,
  GameTeamDesign,
  GameVoteRequest,
  GuestRegistration,
  ActivityRegisterResponse,
  ActivitySwitchResponse,
  ActivityView,
  ClaimableResponse,
  ClaimResponse,
  CounselingBookRequest,
  CounselingPublic,
  FeedbackInput,
  ChatHistory,
  ChatMessageView,
  SeminarsPublic,
  SeminarVotesInput,
  InfoResponse,
  MeResponse,
  MerchCatalogResponse,
  MerchOrderCreate,
  MerchOrderView,
  MyParticipant,
  ParticipantUpdate,
  RegistrationResult,
  RegistrationSubmit,
  RegPaymentMethod,
  TicketsResendResponse,
  TransferLinkResponse,
} from '@sof/shared';
import { PAYMENT_STATUS_LABELS, breakfastAllowed, formatRub } from '@sof/shared';
import { createContext, useContext } from 'react';
import { api } from '../api/client.ts';
import { eventStarted, plural } from '../lib/time.ts';

/** Кэш семинаров: выбор тем и свои сеансы (главная, расписание, экран семинаров). */
export const SEMINARS_KEY = ['seminars'] as const;
/** «2 темы», «1 тему». */
export const topicsWord = (n: number) => `${n} ${plural(n, ['тему', 'темы', 'тем'])}`;

/** Выбор человека: id тем по порядку выбора. */
export function votesOf(data: SeminarsPublic | undefined, personId: number | undefined): number[] {
  return data?.votes.find((v) => v.participantId === personId)?.topicIds ?? [];
}

/** Семинары человека после публикации - по времени. */
export function sessionsOf(data: SeminarsPublic | undefined, personId: number | undefined): ActivityView[] {
  return (data?.sessions ?? []).filter((s) => s.my.some((m) => m.participantId === personId && m.status === 'registered'));
}

/** Кэш переписки с организаторами и счётчика непрочитанного: живые обновления «questions» обновляют оба. */
export const MESSAGES_KEY = ['questions', 'messages'] as const;
export const UNREAD_KEY = ['questions', 'unread'] as const;
/** Кэш служителей душепопечения (главная, расписание, экран записи). */
export const COUNSELING_KEY = ['counseling'] as const;

/**
 * Отзывы из /api/me. Копия на устройстве от прошлой версии приложения поля не знает -
 * читаем через эту функцию, иначе главная упала бы до ответа сервера.
 */
export function feedbackOf(me: MeResponse): MeResponse['feedback'] {
  return me.feedback ?? { visible: false, mine: 0, prompt: false, name: me.user.firstName ?? '' };
}

export const participantApi = {
  register: (body: RegistrationSubmit) =>
    api<RegistrationResult>('/api/registrations', { method: 'POST', body, timeoutMs: 20_000 }),
  registerGuest: (body: GuestRegistration) =>
    api<RegistrationResult>('/api/registrations/guest', { method: 'POST', body, timeoutMs: 20_000, retries: 2 }),
  updateParticipant: (id: number, patch: ParticipantUpdate) =>
    api<MyParticipant>(`/api/participants/${id}`, { method: 'PATCH', body: patch }),
  changePaymentMethod: (id: number, method: RegPaymentMethod) =>
    api<MyParticipant>(`/api/participants/${id}/payment-method`, { method: 'POST', body: { method } }),
  cancelParticipant: (id: number) => api<MeResponse>(`/api/participants/${id}/cancel`, { method: 'POST' }),
  transferLink: (id: number) => api<TransferLinkResponse>(`/api/participants/${id}/transfer-link`, { method: 'POST' }),
  resendTickets: () => api<TicketsResendResponse>('/api/tickets/resend', { method: 'POST' }),
  schedule: () => api<ActivityView[]>('/api/schedule'),
  registerActivity: (activityId: number, participantId: number) =>
    api<ActivityRegisterResponse>(`/api/activities/${activityId}/register`, { method: 'POST', body: { participantId } }),
  /** Перезапись при пересечении по времени: из `fromActivityId` в `activityId`, если там есть место. */
  switchActivity: (activityId: number, participantId: number, fromActivityId: number) =>
    api<ActivitySwitchResponse>(`/api/activities/${activityId}/switch`, {
      method: 'POST',
      body: { participantId, fromActivityId },
    }),
  cancelActivity: (activityId: number, participantId: number) =>
    api<ActivityView>(`/api/activities/${activityId}/cancel`, { method: 'POST', body: { participantId } }),
  interest: (activityId: number, on: boolean) =>
    api<ActivityView>(`/api/activities/${activityId}/interest`, { method: 'POST', body: { on } }),
  info: () => api<InfoResponse>('/api/info'),
  merch: () => api<MerchCatalogResponse>('/api/merch'),
  game: () => api<GameStateView>('/api/game'),
  gameAnswer: (participantId: number, yes: boolean) =>
    api<GameStateView>('/api/game/answer', { method: 'POST', body: { participantId, yes }, retries: 1 }),
  gameVote: (body: GameVoteRequest) => api<GameStateView>('/api/game/vote', { method: 'POST', body, retries: 2, timeoutMs: 10_000 }),
  gameDesign: (teamId: number, body: GameTeamDesign) =>
    api<GameStateView>(`/api/game/teams/${teamId}/design`, { method: 'POST', body, retries: 1 }),
  merchOrders: () => api<MerchOrderView[]>('/api/merch/orders'),
  merchOrder: (body: MerchOrderCreate) => api<MerchOrderView>('/api/merch/orders', { method: 'POST', body, retries: 2, timeoutMs: 15_000 }),
  merchCancel: (id: number) => api<MerchOrderView>(`/api/merch/orders/${id}/cancel`, { method: 'POST', retries: 0 }),
  feedbackSend: (body: FeedbackInput) => api<{ id: number; mine: number }>('/api/feedback', { method: 'POST', body, retries: 0 }),
  feedbackSeen: () => api<{ ok: true }>('/api/feedback/seen', { method: 'POST', retries: 1 }),
  merchConfirm: (id: number) => api<MerchOrderView>(`/api/merch/orders/${id}/confirm`, { method: 'POST', retries: 0 }),
  merchMethod: (id: number, method: 'cash' | 'transfer') =>
    api<MerchOrderView>(`/api/merch/orders/${id}/method`, { method: 'POST', body: { method }, retries: 0 }),
  /** Чек пожертвования - файлом из приложения. */
  donationReceipt: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api<{ sent: boolean }>('/api/receipts/donation', { method: 'POST', body: form, retries: 0, timeoutMs: 60_000 });
  },
  merchReceipt: (id: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api<MerchOrderView>(`/api/merch/orders/${id}/receipt`, { method: 'POST', body: form, retries: 0, timeoutMs: 60_000 });
  },
  /** Номер из Telegram (подписанный ответ) → регистрации на этот номер с других аккаунтов. */
  verifyPhone: (contact: string) =>
    api<ClaimableResponse>('/api/me/phone', { method: 'POST', body: { contact }, retries: 0, timeoutMs: 10_000 }),
  /** Переписка с организаторами; `before` - сообщения раньше этого. */
  messages: (before?: number) => api<ChatHistory>('/api/messages', { query: { before } }),
  messagesUnread: () => api<{ unread: number }>('/api/messages/unread'),
  /** `merch` - написали из раздела «Мерч»: переписка уходит в папку «Мерч» у команды. */
  sendMessage: (text: string, topic?: 'merch', items?: { variantId: number; qty: number }[]) =>
    api<ChatMessageView>('/api/messages', { method: 'POST', body: { text, topic, items }, retries: 0 }),
  readMessages: () => api<{ ok: true }>('/api/messages/read', { method: 'POST', retries: 0 }),
  seminars: () => api<SeminarsPublic>('/api/seminars'),
  /** Выбор тем за человека - заменяет прежний целиком. */
  seminarVotes: (body: SeminarVotesInput) => api<SeminarsPublic>('/api/seminars/votes', { method: 'PUT', body, retries: 0 }),
  counseling: () => api<CounselingPublic>('/api/counseling'),
  /** Записаться или перейти на другое время - запись у человека одна. */
  bookCounseling: (body: CounselingBookRequest) =>
    api<CounselingPublic>('/api/counseling/book', { method: 'POST', body, retries: 0 }),
  cancelCounseling: (participantId: number) =>
    api<CounselingPublic>('/api/counseling/cancel', { method: 'POST', body: { participantId }, retries: 0 }),
  claim: (participantIds: number[]) =>
    api<ClaimResponse>('/api/me/claim', { method: 'POST', body: { participantIds }, retries: 0, timeoutMs: 10_000 }),
};

export const MeContext = createContext<MeResponse | null>(null);

/** Данные /api/me - внутри ParticipantApp они уже загружены. */
/** Как у участников называется душепопечение - задаётся в админке («Молитвенная комната»). */
export const counselingTitle = (me: MeResponse) => me.event.counselingTitle || 'Молитвенная комната';

export function useMeData(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMeData outside ParticipantApp');
  return me;
}

/**
 * Запись выключена. До конференции её откроют на месте; во время конференции - «пока закрыта»:
 * организаторы могут открыть её позже (семинары следующего дня, мероприятия после обеда).
 */
export function signupClosedText(me: MeResponse): string {
  return eventStarted(me.event.startsAt) ? 'Запись пока закрыта' : 'Запись откроется на конференции';
}

/** Душепопечение: записаться может только зарегистрированный на конференцию; выключили запись - «пока закрыта». */
export const COUNSELING_UNREGISTERED = 'Запись доступна после регистрации на конференцию';
export const COUNSELING_CLOSED = 'Запись пока закрыта';

/** Когда вносить взнос: до начала - заранее, после начала - на кассе у входа. */
export function feeDeadlineText(me: MeResponse): string {
  return eventStarted(me.event.startsAt) ? 'Взнос можно внести на кассе у входа.' : 'Взнос вносится до начала конференции.';
}

/** Участники, которых аккаунт зарегистрировал сам (лимит «N на аккаунт» считается по ним). */
export function ownedActive(me: MeResponse): MyParticipant[] {
  return me.participants.filter((p) => p.status === 'active' && !p.transferredToMe);
}

/** «Я» уже есть: записался сам или его записал кто-то другой (узнали по нику, номеру или передали QR-код). */
export function hasSelf(me: MeResponse): boolean {
  return ownedActive(me).some((p) => p.relation === 'self') || me.participants.some((p) => p.transferredToMe && p.status === 'active');
}

/** Можно ли сейчас сменить вариант участия: свой человек, регистрация открыта, взнос ещё не вносили. */
/** Уже оплатил без завтрака - может докупить завтрак (доплата на кассе или переводом), пока завтрак включён и есть места. */
export function canAddBreakfast(me: MeResponse, p: MyParticipant): boolean {
  return (
    // Завтрак выключен в настройках - кнопки нет (сервер всё равно не даст).
    me.registration.breakfast?.enabled !== false &&
    !p.onSite &&
    p.status === 'active' &&
    !p.transferredToMe &&
    me.registration.open &&
    (p.paymentStatus === 'paid' || p.paymentStatus === 'partial') &&
    !p.breakfast &&
    breakfastAllowed(p.tier) &&
    me.registration.breakfastLeft !== 0
  );
}

/** Докупил завтрак, но ещё не заплатил за него (внесено не больше цены без завтрака) - может передумать и снять. */
export function canRemoveBreakfast(me: MeResponse, p: MyParticipant): boolean {
  const base = p.tier ? me.registration.tiers[p.tier as keyof typeof me.registration.tiers]?.amount : undefined;
  return (
    !p.onSite &&
    p.status === 'active' &&
    !p.transferredToMe &&
    me.registration.open &&
    (p.paymentStatus === 'paid' || p.paymentStatus === 'partial') &&
    p.breakfast &&
    base !== undefined &&
    Number(p.amountPaid ?? 0) <= base + 1e-9
  );
}

export function canChangeTier(me: MeResponse, p: MyParticipant): boolean {
  return (
    // Гость на месте - только «Только взнос», без выбора питания.
    !p.onSite &&
    p.status === 'active' &&
    !p.transferredToMe &&
    me.registration.open &&
    (p.paymentStatus === 'unpaid' || p.paymentStatus === 'exempt')
  );
}

export function freeSlots(me: MeResponse): number {
  return Math.max(0, me.registration.maxPerAccount - ownedActive(me).length);
}

/** Оплата включена организаторами? Пока выключена - экраны и статусы оплаты не показываем. */
export function paymentsOn(me: MeResponse): boolean {
  return me.features?.payments === true;
}

/** «Не оплачено · 35 руб.» - сразу видно, сколько внести. */
export function paymentLabel(p: Pick<MyParticipant, 'paymentStatus' | 'amountDue'>): string {
  const label = PAYMENT_STATUS_LABELS[p.paymentStatus];
  return p.paymentStatus === 'unpaid' && p.amountDue && Number(p.amountDue) > 0 ? `${label} · ${formatRub(p.amountDue)}` : label;
}

export type PayTone = 'ok' | 'warn' | 'bad' | 'muted';

/** Сколько человеку осталось внести. */
export const leftToPay = (p: Pick<MyParticipant, 'amountDue' | 'amountPaid'>) =>
  Math.max(0, Number(p.amountDue ?? 0) - Number(p.amountPaid ?? 0));

/**
 * Статус взноса одной строкой для экранов участника: «к оплате 35 руб.», «оплачено», «чек на проверке»,
 * «осталось 15 руб.», «без взноса». Цвет - текстом, без плашек.
 */
export function paymentState(
  p: Pick<MyParticipant, 'paymentStatus' | 'amountDue' | 'amountPaid'>,
  /** Дни конференции: «чек получен ✓» и «не забудьте оплатить» - без тревожных подписей. */
  soft = false,
): { text: string; tone: PayTone } {
  switch (p.paymentStatus) {
    case 'exempt':
      return { text: 'без взноса', tone: 'muted' };
    case 'paid':
      return { text: 'оплачено', tone: 'ok' };
    case 'pending':
      return soft ? { text: 'чек получен ✓', tone: 'ok' } : { text: 'чек на проверке', tone: 'warn' };
    case 'partial':
      return { text: `осталось ${formatRub(leftToPay(p))}`, tone: 'warn' };
    default:
      // Сумму в мягкой подписи не пишем: она есть рядом («Осталось внести»), а имя не обрезается.
      return soft ? { text: 'не забудьте оплатить', tone: 'warn' } : { text: `к оплате ${formatRub(leftToPay(p))}`, tone: 'bad' };
  }
}

export const PAY_TONE_CLASS: Record<PayTone, string> = {
  ok: 'text-ok-fg',
  warn: 'text-warn-fg',
  bad: 'text-bad-fg',
  muted: 'text-subtle',
};

/** После регистрации вернуть человека к семинарам (пришёл по ссылке из канала). */
export const AFTER_REGISTER_KEY = 'sof.after-register';
