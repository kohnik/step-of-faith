import type {
  GameAdminView,
  GameTaskInput,
  GameTeamUpdate,
  AdminMerchOrderView,
  AdminMerchProduct,
  MerchPayMethod,
  MerchScanResponse,
  MerchSettings,
  MerchSettingsView,
  MerchStats,
  MoneyEntryRequest,
  MoneySummary,
  ActivityInput,
  AdminLinkResponse,
  DevWipeResponse,
  DonationRequest,
  ActivityRegistrationRow,
  ActivityUpdate,
  ActivityView,
  CheckInBatchResponse,
  CheckInEvent,
  CheckpointView,
  LookupRequest,
  LookupResponse,
  MarkPaidRequest,
  MarkPaidResponse,
  OkResponse,
  PaymentEntryView,
  PaymentFindRequest,
  PaymentFindResponse,
  StaffEnrollResponse,
  StaffRecentScan,
  StaffOverview,
  StaffSearchResponse,
  StaffStats,
} from '@sof/shared';
import { api } from '../api/client.ts';

export const staffApi = {
  checkpoints: () => api<CheckpointView[]>('/api/staff/checkpoints', { auth: 'staff' }),
  /** Быстрый ответ важнее полноты: 3 секунды, без повторов - иначе работаем по локальной базе. */
  lookup: (body: LookupRequest) =>
    api<LookupResponse>('/api/staff/lookup', { method: 'POST', body, auth: 'staff', timeoutMs: 3000, retries: 0 }),
  checkIns: (events: CheckInEvent[], timeoutMs = 3000) =>
    api<CheckInBatchResponse>('/api/staff/check-ins', { method: 'POST', body: { events }, auth: 'staff', timeoutMs, retries: 0 }),
  /** «Отменить» для события из офлайн-очереди: могло дойти до сервера (тайм-аут) - снимаем и там. */
  revokeByEvent: (clientEventId: string) =>
    api<{ revoked: boolean }>('/api/staff/check-ins/revoke-by-event', {
      method: 'POST',
      body: { clientEventId },
      auth: 'staff',
      timeoutMs: 6000,
      retries: 0,
    }),
  revoke: (checkInId: number) =>
    api<OkResponse>(`/api/staff/check-ins/${checkInId}/revoke`, { method: 'POST', auth: 'staff', timeoutMs: 6000 }),
  search: (q: string, checkpointId: number, signal?: AbortSignal) =>
    api<StaffSearchResponse>('/api/staff/search', {
      query: { q, checkpointId },
      auth: 'staff',
      signal,
      timeoutMs: 5000,
      retries: 0,
    }),
  recent: (checkpointId: number) =>
    api<StaffRecentScan[]>('/api/staff/recent', { query: { checkpointId }, auth: 'staff', retries: 0, timeoutMs: 5000 }),
  stats: (checkpointId: number) => api<StaffStats>('/api/staff/stats', { query: { checkpointId }, auth: 'staff', retries: 0 }),
  /** Касса: человек по QR-коду или id - без записи в журнал входа. */
  findForPayment: (body: PaymentFindRequest) =>
    api<PaymentFindResponse>('/api/staff/payments/find', { method: 'POST', body, auth: 'staff', timeoutMs: 6000, retries: 1 }),
  /** Касса: кого принял(а) этот человек - новые сверху. */
  myPayments: () => api<PaymentEntryView[]>('/api/staff/payments/mine', { auth: 'staff', retries: 1 }),
  /** Касса: пожертвование - от участника или без QR-кода. */
  donate: (body: DonationRequest) =>
    api<{ id: number | null; duplicate?: true }>('/api/staff/donations', { method: 'POST', body, auth: 'staff', timeoutMs: 8000 }),
  undoDonation: (id: number) => api<OkResponse>(`/api/staff/donations/${id}/undo`, { method: 'POST', body: {}, auth: 'staff', retries: 0 }),
  /** Касса ошиблась человеком - отменить свой приём (15 минут). */
  undoPayment: (participantId: number) =>
    api<OkResponse>('/api/staff/payments/undo', { method: 'POST', body: { participantId }, auth: 'staff', timeoutMs: 8000, retries: 0 }),
  /** Не оплатил, заплатит переводом позже: реквизиты и «пришлите чек» - в бот. */
  promiseTransfer: (participantIds: number[]) =>
    api<{ notified: number }>('/api/staff/payments/promise-transfer', { method: 'POST', body: { participantIds }, auth: 'staff', timeoutMs: 8000, retries: 1 }),
  markPaid: (body: MarkPaidRequest) =>
    api<MarkPaidResponse>('/api/staff/payments/mark-paid', { method: 'POST', body, auth: 'staff', timeoutMs: 8000 }),
  activities: () => api<ActivityView[]>('/api/staff/activities', { auth: 'staff' }),
  createActivity: (body: ActivityInput) => api<ActivityView>('/api/staff/activities', { method: 'POST', body, auth: 'staff' }),
  updateActivity: (id: number, body: ActivityUpdate) =>
    api<ActivityView>(`/api/staff/activities/${id}`, { method: 'PATCH', body, auth: 'staff' }),
  /** Удалить мероприятие совсем; записавшимся придёт сообщение. */
  deleteActivity: (id: number) =>
    api<{ notified: number }>(`/api/staff/activities/${id}`, { method: 'DELETE', auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  registrations: (id: number) => api<ActivityRegistrationRow[]>(`/api/staff/activities/${id}/registrations`, { auth: 'staff' }),
  /** Поиск человека без точки отметки - чтобы записать его на активность. */
  searchPeople: (q: string, signal?: AbortSignal) =>
    api<StaffSearchResponse>('/api/staff/search', { query: { q }, auth: 'staff', signal, timeoutMs: 5000, retries: 0 }),
  /** Записать человека на активность за него (нет своего Telegram). */
  enroll: (activityId: number, participantId: number) =>
    api<StaffEnrollResponse>(`/api/staff/activities/${activityId}/registrations`, {
      method: 'POST',
      body: { participantId },
      auth: 'staff',
      timeoutMs: 8000,
    }),
  unenroll: (activityId: number, participantId: number) =>
    api<ActivityRegistrationRow[]>(`/api/staff/activities/${activityId}/registrations/cancel`, {
      method: 'POST',
      body: { participantId },
      auth: 'staff',
      timeoutMs: 8000,
    }),
  /** Одноразовая ссылка входа в веб-админку (уже залогиненной). */
  /** Только на время разработки: стереть все регистрации и аккаунты (кроме своего). */
  devWipe: () => api<DevWipeResponse>('/api/staff/dev/wipe', { method: 'POST', auth: 'staff', retries: 0, timeoutMs: 30_000 }),
  adminLink: () => api<AdminLinkResponse>('/api/staff/admin-link', { method: 'POST', auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  /** «Статистика» для админов: регистрации, оплата, питание, кто едет, программа. */
  overview: () => api<StaffOverview>('/api/staff/overview', { auth: 'staff', timeoutMs: 15_000 }),

  // ---------- банкир ----------
  money: () => api<{ summary: MoneySummary; mine: PaymentEntryView[] }>('/api/staff/money', { auth: 'staff', retries: 1 }),
  /** Выдать или принять. Повтор с тем же requestId не запишется дважды. */
  addMoney: (body: MoneyEntryRequest) =>
    api<{ id: number | null; duplicate?: true }>('/api/staff/money', { method: 'POST', body, auth: 'staff', timeoutMs: 8000 }),
  cancelMoney: (id: number, reason: string) =>
    api<OkResponse>(`/api/staff/money/${id}/cancel`, { method: 'POST', body: { reason }, auth: 'staff', retries: 0, timeoutMs: 8000 }),

  // ---------- продавец мерча (те же маршруты, что в админке) ----------
  merchProducts: () => api<AdminMerchProduct[]>('/api/admin/merch', { auth: 'staff', retries: 1 }),
  merchOrders: () => api<AdminMerchOrderView[]>('/api/admin/merch/orders', { auth: 'staff', retries: 1 }),
  merchSettings: () => api<MerchSettingsView>('/api/admin/merch-settings', { auth: 'staff', retries: 1 }),
  saveMerchSettings: (patch: Partial<MerchSettings>) =>
    api<MerchSettingsView>('/api/admin/merch-settings', { method: 'PATCH', body: patch, auth: 'staff', retries: 0, timeoutMs: 8000 }),
  merchStats: () => api<MerchStats>('/api/admin/merch/stats', { auth: 'staff', retries: 1 }),
  merchBuyers: (q: string, signal?: AbortSignal) =>
    api<{ id: number; name: string; phone: string | null; city: string | null }[]>('/api/admin/merch/buyers', {
      query: { q },
      auth: 'staff',
      signal,
      timeoutMs: 5000,
      retries: 0,
    }),
  merchSell: (body: {
    requestId: string;
    items: { variantId: number; qty: number }[];
    method: MerchPayMethod;
    debt: boolean;
    paidNow: string | null;
    buyerParticipantId: number | null;
    buyerName: string | null;
    buyerPhone: string | null;
  }) => api<AdminMerchOrderView>('/api/admin/merch/sell', { method: 'POST', body: { ...body, paymentMethod: 'cash' }, auth: 'staff', timeoutMs: 10_000 }),
  /** Выдать бронь: неоплаченную - сразу «оплачено и выдано» (способ обязателен). */
  /** QR-код участника на стойке мерча: человек, взнос и его заказы. */
  /** Чек за мерч на проверке: принять (бронь оплачена) или отклонить с причиной. */
  merchReceiptAccept: (receiptId: number) =>
    api<AdminMerchOrderView>(`/api/admin/merch/receipts/${receiptId}/accept`, { method: 'POST', body: {}, auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  merchReceiptReject: (receiptId: number, reason: string) =>
    api<AdminMerchOrderView>(`/api/admin/merch/receipts/${receiptId}/reject`, { method: 'POST', body: { reason }, auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  merchScan: (code: string) => api<MerchScanResponse>('/api/admin/merch/scan', { method: 'POST', body: { code }, auth: 'staff', retries: 1, timeoutMs: 8000 }),
  merchCancel: (id: number, reason: string | null) =>
    api<AdminMerchOrderView>(`/api/admin/merch/orders/${id}/cancel`, { method: 'POST', body: { reason }, auth: 'staff', retries: 0, timeoutMs: 8000 }),
  merchIssue: (id: number, method: MerchPayMethod | null) =>
    api<AdminMerchOrderView>(`/api/admin/merch/orders/${id}/issue`, { method: 'POST', body: { method }, auth: 'staff', retries: 0, timeoutMs: 8000 }),
  merchRepay: (id: number, amount: string, method: MerchPayMethod) =>
    api<AdminMerchOrderView>(`/api/admin/merch/orders/${id}/repay`, { method: 'POST', body: { amount, method }, auth: 'staff', retries: 0, timeoutMs: 8000 }),
  // ---------- игра: пульт ведущего ----------
  game: () => api<GameAdminView>('/api/admin/game', { auth: 'staff', retries: 1 }),
  gamePost: (path: string, body: unknown = {}) =>
    api<GameAdminView>(`/api/admin/game/${path}`, { method: 'POST', body, auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  gameDistribute: () =>
    api<{ assigned: number; unassigned: number; view: GameAdminView }>('/api/admin/game/distribute', { method: 'POST', body: {}, auth: 'staff', retries: 0, timeoutMs: 15_000 }),
  gameAssignTasks: () =>
    api<{ assigned: number; left: number; view: GameAdminView }>('/api/admin/game/teams/assign-tasks', { method: 'POST', body: {}, auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  gameTeam: (id: number, body: GameTeamUpdate) =>
    api<GameAdminView>(`/api/admin/game/teams/${id}`, { method: 'PATCH', body, auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  gameTaskCreate: (body: GameTaskInput) => api<GameAdminView>('/api/admin/game/tasks', { method: 'POST', body, auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  gameTaskUpdate: (id: number, body: GameTaskInput) =>
    api<GameAdminView>(`/api/admin/game/tasks/${id}`, { method: 'PATCH', body, auth: 'staff', retries: 0, timeoutMs: 10_000 }),
  gameTaskDelete: (id: number) => api<GameAdminView>(`/api/admin/game/tasks/${id}`, { method: 'DELETE', auth: 'staff', retries: 0, timeoutMs: 10_000 }),
};
