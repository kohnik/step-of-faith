/**
 * Типы ответов API. Даты - ISO-строки (UTC), дни рождения - `YYYY-MM-DD`,
 * деньги - строки `1234.50`, id - числа.
 */
import type { Permission, Role } from './permissions.ts';
import type {
  ActivityKind,
  ActivityStatus,
  Meal,
  FeedbackCategory,
  Bracelet,
  BreakfastConfig,
  Category,
  ChatMark,
  CheckInMethod,
  CheckpointKind,
  CounselorAudience,
  Gender,
  ParticipantStatus,
  PaymentMethod,
  PaymentStatus,
  RegistrationMode,
  Relation,
  RegPaymentMethod,
  Tier,
  TierConfig,
  TiersConfig,
} from './enums.ts';
import type { BotScheduledItem } from './bot-log.ts';
import type { Segment, Settings } from './schemas.ts';

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

// ---------- участник ----------

export interface TicketView {
  code: string;
  displayCode: string;
  /** Страница билета в браузере - работает без Telegram. */
  webUrl: string;
  /** PNG-картинка билета - для `downloadFile` и печати. */
  imageUrl: string;
}

export interface MyParticipant {
  id: number;
  lastName: string;
  firstName: string;
  middleName: string | null;
  fullName: string;
  birthDate: string | null;
  gender: Gender;
  city: string | null;
  church: string | null;
  phone: string | null;
  relation: Relation;
  category: Category;
  status: ParticipantStatus;
  /** null - старые записи до вариантов участия. */
  tier: Tier | null;
  /** Завтрак к варианту (входит в amountDue). */
  breakfast: boolean;
  paymentMethod: RegPaymentMethod | null;
  telegramUsername: string | null;
  /** Младше 16 на начало конференции. */
  under16: boolean;
  /** «Гость (на месте)»: короткая форма без даты рождения и города. */
  onSite: boolean;
  paymentStatus: PaymentStatus;
  amountDue: string | null;
  amountPaid: string;
  /** Первый приход на конференцию. */
  arrivedAt: string | null;
  /** Последняя отметка на входе - на 2-й и 3-й день сегодняшняя. */
  lastArrivedAt: string | null;
  /** Кто зарегистрировал, если это сделал другой аккаунт. */
  registeredBy: string | null;
  /** Билет передан мне с другого аккаунта. */
  transferredToMe: boolean;
  /** Билет передан с моего аккаунта кому-то ещё. */
  transferredAway: boolean;
  ticket: TicketView | null;
}

export interface MeResponse {
  user: {
    id: number;
    tgId: number | null;
    firstName: string | null;
    username: string | null;
    /** Код для комментария к переводу - один на аккаунт. */
    paymentRef: string;
  };
  roles: Role[];
  permissions: Permission[];
  participants: MyParticipant[];
  /**
   * Отзывы: visible - форма и кнопка на главной (всем или админам на проверке, только у кого есть регистрация или роль);
   * mine - сколько уже оставил; prompt - показать заставку «Оставь отзыв» (впервые после включения и ещё не оставлял);
   * name - как подписать отзыв по умолчанию.
   */
  feedback: { visible: boolean; mine: number; prompt: boolean; name: string };
  registration: {
    open: boolean;
    /** Регистрация на месте: короткая форма «Гость» вместо полной анкеты. */
    onSite: boolean;
    opensAt: string | null;
    closesAt: string | null;
    maxPerAccount: number;
    consentVersion: string;
    consentUrl: string | null;
    photoConsentEnabled: boolean;
    capacityLeft: number | null;
    tiers: TiersConfig;
    /** Сколько мест осталось у вариантов с лимитом (например, обед и ужин). Нет ключа - без лимита. */
    tierLeft: Partial<Record<Tier, number>>;
    breakfast: BreakfastConfig;
    /** Сколько завтраков осталось; null - без лимита. */
    breakfastLeft: number | null;
    /** После сбоя хостинга ещё не все вернулись: показываем, что регистрации после 29 октября нужно сделать заново. */
    restored?: boolean;
  };
  /** instructions - реквизиты для перевода, cash - где сдать наличные, transfers - принимаем ли переводы. */
  payment: {
    instructions: string;
    cash: string;
    transfers: boolean;
    /** Как перевести за мерч и пожертвование - без шагов про взнос. */
    otherInstructions: string;
  };
  /**
   * Что сейчас включено. payments - экраны оплаты; activitySignup - запись на мероприятия открыта;
   * schedule - расписание видно участникам (команде - всегда).
   */
  features: {
    payments: boolean;
    activitySignup: boolean;
    schedule: boolean;
    merch: boolean;
    merchSales: boolean;
    game: boolean;
    /** Дни конференции: «чек получен ✓» и «не забудьте оплатить» вместо «чек на проверке» и «к оплате». */
    softPaymentLabels: boolean;
  };
  event: {
    name: string;
    timezone: string;
    startsAt: string | null;
    endsAt: string | null;
    supportContact: string | null;
    /** Как у участников называется душепопечение («Молитвенная комната»). */
    counselingTitle: string;
    /** «Конец «Шага веры»»: вместо главной - экран благодарности. */
    ended: boolean;
    endTitle: string;
    endText: string;
  };
}

export interface RegistrationResult {
  created: { id: number; fullName: string; ticketCode: string }[];
  skipped: { fullName: string; reason: 'already_registered' }[];
}

/** Регистрация на мой номер телефона, которую сделал другой аккаунт. */
export interface ClaimCandidate {
  id: number;
  fullName: string;
  /** Кто записал: «Саша Л.». */
  registeredBy: string;
}

export interface ClaimableResponse {
  /** Подтверждённый Telegram номер аккаунта; null - ещё не делились. */
  phone: string | null;
  candidates: ClaimCandidate[];
  /** После сбоя хостинга: столько регистраций из выгрузки перешло на аккаунт по этому номеру. */
  adopted?: number;
}

export interface ClaimResponse {
  claimed: { id: number; fullName: string }[];
}

/** Отказ регистрации «Я»: такой человек уже записан с другого аккаунта (details ошибки 409). */
export interface RegisteredByOtherDetails {
  registeredBy: string;
  fullName: string;
}

export type ChatDelivery = 'sent' | 'blocked' | 'unreachable' | 'no_telegram';

/** Сообщение переписки с организаторами. */
export interface ChatMessageView {
  id: number;
  fromStaff: boolean;
  /** Кто из команды написал (только в админке). */
  author: string | null;
  text: string | null;
  /** Есть картинка: показываем по адресу картинки сообщения. */
  photo: boolean;
  createdAt: string;
  /** Доставка в бот сообщения команды; null - ещё отправляем (или это сообщение участника). */
  delivery: ChatDelivery | null;
  /** Заявка на бронь мерча из приложения: вещи; бронь - когда продавец её сделал. */
  merch: ChatMerchRequest | null;
}

/** Вещь в заявке - как её видел участник. */
export interface ChatMerchItem {
  variantId: number;
  qty: number;
  title: string;
  price: string;
}

/** Вещь заявки для админки: превью (фото этого цвета, иначе общее), вещь, цвет и размер отдельно. */
export interface ChatMerchItemView extends ChatMerchItem {
  thumbUrl: string | null;
  /** null - размер уже удалили из каталога: остаётся только `title`. */
  detail: { product: string; color: string; hex: string; size: string } | null;
}

/** Кому приходят копии обычных сообщений участников (с учётом умолчаний). */
export interface AdminFeedbackRow {
  id: number;
  category: FeedbackCategory;
  text: string;
  anonymous: boolean;
  /** Кто написал - только если подписал отзыв (у анонимного - null). */
  author: { userId: number; name: string; username: string | null } | null;
  starred: boolean;
  createdAt: string;
}

export interface AdminFeedbackView {
  items: AdminFeedbackRow[];
  counts: Record<FeedbackCategory, number>;
  open: boolean;
  admins: boolean;
  /** Включён «Конец «Шага веры»» - форма открыта всем независимо от тумблера. */
  ended: boolean;
}

export interface ChatNotifyView {
  people: { userId: number; name: string; roles: string[]; on: boolean }[];
}

export interface ChatMerchRequest {
  items: ChatMerchItemView[];
  /** Бронь по заявке; variantIds - какие размеры в неё вошли (продавец мог забронировать не всё). */
  order: { id: number; code: string; status: string; variantIds: number[]; /** Чек перевода ждёт проверки. */ receiptPending?: boolean } | null;
}

/** Переписка участника: сообщения от старых к новым, подгрузка - по `before`. */
export interface ChatHistory {
  messages: ChatMessageView[];
  hasMore: boolean;
}

/** Строка списка переписок в админке. */
/** Список участников (для рассылок). */
export interface ParticipantListView {
  id: number;
  name: string;
  /** Сколько участников в списке (активных). */
  count: number;
  /** Сколько из них получат рассылку: есть Telegram, бот не остановлен. */
  recipients: number;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Найденное по тексту сообщение в «Сообщениях». */
export interface ChatSearchHit {
  messageId: number;
  userId: number;
  name: string;
  avatar: boolean;
  text: string;
  fromStaff: boolean;
  createdAt: string;
}

export interface ChatThreadRow {
  userId: number;
  /** Имя из регистрации «Я» или из Telegram. */
  name: string;
  username: string | null;
  /** Есть фото профиля из Telegram. */
  avatar: boolean;
  lastText: string;
  lastAt: string | null;
  lastFromStaff: boolean;
  /** Непрочитанные командой сообщения участника. */
  unread: number;
  /** Команда отметила «непрочитанным» (без новых сообщений). */
  markedUnread: boolean;
  /** Отметка-смайлик команды. */
  mark: ChatMark | null;
  /** Папка «Мерч». */
  topic: ChatTopic | null;
}

/** Папка переписки: merch - про мерч. */
export type ChatTopic = 'merch';

/** Шапка открытой переписки: кто это и дойдёт ли сообщение в бот. */
export interface ChatPerson {
  userId: number;
  name: string;
  username: string | null;
  avatar: boolean;
  /** Почему в бот не придёт (в приложении увидит); null - придёт. */
  botNote: string | null;
  /** Карточки участников этого аккаунта. */
  participants: { id: number; name: string }[];
}

export interface ChatThreadView extends ChatHistory {
  person: ChatPerson;
  /** Отметка-смайлик команды. */
  mark: ChatMark | null;
  /** Папка «Мерч». */
  topic: ChatTopic | null;
}

export interface TransferLinkResponse {
  link: string;
  expiresAt: string;
}

export interface PublicTicket {
  fullName: string;
  eventTimezone: string;
  code: string;
  displayCode: string;
  status: 'active' | 'revoked';
  eventName: string;
  paymentStatus: PaymentStatus;
  /** Последняя отметка на входе (на 2-й и 3-й день - сегодняшняя). */
  arrivedAt: string | null;
  imageUrl: string;
  tier: (Pick<TierConfig, 'short' | 'color'> & { key: Tier }) | null;
  breakfast: boolean;
}

// ---------- расписание ----------

export interface RoomView {
  id: number;
  name: string;
  capacity: number;
  note: string | null;
  sort: number;
}

/** Блок семинаров, к которому относится тема. */
export interface ActivityBlockRef {
  id: number;
  title: string;
  registrationOpen: boolean;
  /** Залы опубликованы - участники видят зал темы. */
  roomsPublished: boolean;
}

export interface ActivityView {
  id: number;
  title: string;
  description: string | null;
  location: string | null;
  host: string | null;
  kind: ActivityKind;
  startsAt: string;
  endsAt: string;
  registrationMode: RegistrationMode;
  capacity: number | null;
  registeredCount: number;
  waitlistCount: number;
  waitlistEnabled: boolean;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  minAge: number | null;
  maxAge: number | null;
  status: ActivityStatus;
  /** Питание: личное напоминание тем, у кого оно есть. */
  meal: Meal | null;
  interestCount: number;
  createdBy: number | null;
  /** Зал из справочника (у тем семинаров - после публикации). */
  roomId: number | null;
  /** Тема блока семинаров. */
  block: ActivityBlockRef | null;
  /** Записи моей семьи на эту активность. */
  my: { participantId: number; status: 'registered' | 'waitlist' }[];
  myInterest: boolean;
}

export type ActivityRegisterOutcome =
  | 'registered'
  | 'waitlist'
  | 'already_registered'
  | 'already_waitlist'
  | 'full'
  | 'closed'
  | 'age_restricted'
  | 'time_conflict'
  | 'not_open'
  | 'not_found';

/** Активность, на которую человек уже записан в это же время. */
export interface ActivityConflict {
  activityId: number;
  title: string;
  startsAt: string;
  endsAt: string;
}

export interface ActivityRegisterResponse {
  outcome: ActivityRegisterOutcome;
  activity: ActivityView;
  /** Только при outcome = 'time_conflict'. */
  conflict?: ActivityConflict | null;
}

/**
 * Перезапись: если в новой активности есть место, человек переходит в неё, а место в старой освобождается.
 * Иначе ничего не меняется (outcome = full / closed / …), старая запись остаётся.
 */
export interface ActivitySwitchResponse {
  outcome: ActivityRegisterOutcome;
  activity: ActivityView;
  fromActivity: ActivityView;
}

/** Счётчики для меню админки: зарегистрированные и подтверждённые (отсканированные на входе). */
export interface PeopleCounts {
  participants: number;
  confirmed: number;
}

export interface AdminLinkResponse {
  /** Одноразовая ссылка на веб-админку, по которой вход происходит сам. */
  url: string;
}

export interface ActivityRegistrationRow {
  participantId: number;
  fullName: string;
  age: number | null;
  category: Category;
  status: 'registered' | 'waitlist' | 'cancelled';
  queuedAt: string;
  attended: boolean;
}

/** Волонтёр записал человека на активность: итог и обновлённый список. */
export interface StaffEnrollResponse {
  outcome: ActivityRegisterOutcome;
  conflict: ActivityConflict | null;
  rows: ActivityRegistrationRow[];
}

/** Строка распределения тем блока по залам (админка): сеанс темы в этом потоке. */
export interface SeminarTopicRow {
  id: number;
  /** Общая тема (null - старая тема без общей). */
  topicId: number | null;
  /** Сколько человек выбрали тему (во всех потоках). */
  votes: number;
  /** Тема скрыта от участников. */
  hidden: boolean;
  title: string;
  host: string | null;
  description: string | null;
  status: ActivityStatus;
  registered: number;
  /** Зал, который поставил админ вручную; null - решает бот. */
  plannedRoomId: number | null;
  /** Зал по распределению сейчас (ручной или предложенный ботом); null - сеанса нет (залов не хватило или тема идёт один раз). */
  roomId: number | null;
  /** Зал, который сейчас опубликован участникам. */
  publishedRoomId: number | null;
  /** Сколько человек не влезает в зал; 0 - влезают. */
  overflow: number;
}

export interface SeminarBlockView {
  id: number;
  title: string;
  startsAt: string;
  endsAt: string;
  registrationOpen: boolean;
  roomsPublishedAt: string | null;
  /** Скрыт от участников целиком. */
  hidden: boolean;
  rooms: RoomView[];
  topics: SeminarTopicRow[];
  /** Залы блока, которые сейчас никому не достались. */
  freeRoomIds: number[];
  /** Распределение отличается от опубликованного - есть что публиковать. */
  dirty: boolean;
  /** Проголосовали, но в этом потоке без места. */
  unplaced: number;
}

/** Тема семинара в админке: одна на все потоки, с числом голосов. */
export interface SeminarTopicView {
  id: number;
  title: string;
  host: string | null;
  description: string | null;
  hidden: boolean;
  sort: number;
  votes: number;
}

/** Голосование и распределение семинаров целиком (админка). */
export interface SeminarsSummary {
  topics: SeminarTopicView[];
  /** Голосование открыто (запись открыта хоть в одном видимом потоке). */
  open: boolean;
  /** Сколько тем выбрать - по числу видимых потоков. */
  picks: number;
  /** Активных участников и сколько из них выбрали хоть одну тему. */
  participants: number;
  voters: number;
  /** Когда распределение последний раз опубликовано. */
  publishedAt: string | null;
  /** Есть неопубликованные изменения (залы или люди). */
  dirty: boolean;
  /** Сколько человек поменяли выбор после того, как их рассадили (место пока прежнее). */
  changed: number;
  /** Распределять самим после каждого выбора тем (настройка). */
  autoPlan: boolean;
}

/** Проголосовал, но в потоке без места: кого поставить вручную. */
export interface SeminarUnplacedRow {
  participantId: number;
  fullName: string;
  age: number | null;
  /** Выбранные темы. */
  topics: string[];
}

/** Поменял выбор после того, как его рассадили: где сидит сейчас и что выбрал. */
export interface SeminarChangedRow {
  participantId: number;
  fullName: string;
  age: number | null;
  /** Куда записан сейчас (темы, которые он больше не выбирает, - в `dropped`). */
  now: string[];
  dropped: string[];
  /** Что выбрал теперь. */
  wants: string[];
}

/** Семинары для участника: голосование за темы и, после публикации, свои сеансы с залами. */
export interface SeminarsPublic {
  open: boolean;
  /** Распределение опубликовано: сеансы с залами видны. */
  published: boolean;
  /** Сколько тем выбрать каждому. */
  picks: number;
  topics: { id: number; title: string; host: string | null; description: string | null }[];
  /** Выбор семьи по людям. */
  votes: { participantId: number; topicIds: number[] }[];
  /** Опубликованные сеансы, на которые записан кто-то из семьи, - по времени. */
  sessions: ActivityView[];
  /** Кто из семьи поменял выбор после распределения: ждёт, пока организаторы пересадят. */
  waiting: number[];
}

// ---------- душепопечение ----------

/** Окошко у служителя. Чужие записи участник видит только как «занято». */
export interface CounselingSlot {
  start: string;
  taken: boolean;
  /** Окошко занял кто-то из своей семьи - его id; чужая запись или свободно - null. */
  participantId: number | null;
}

export interface CounselorPublic {
  id: number;
  name: string;
  place: string | null;
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
  /** Кого принимает; человек другого пола видит время, но записаться не может. */
  audience: CounselorAudience;
  /** Свои метки - просто подпись. */
  tags: string[];
  slots: CounselingSlot[];
}

/** Запись человека из семьи. */
export interface CounselingBookingMine {
  participantId: number;
  counselorId: number;
  slotStart: string;
}

export interface CounselingPublic {
  /** Открыта ли запись (выключатель в админке). */
  open: boolean;
  counselors: CounselorPublic[];
  my: CounselingBookingMine[];
}

export interface CounselingBookingRow {
  id: number;
  slotStart: string;
  participantId: number;
  fullName: string;
  gender: Gender;
  phone: string | null;
  telegramUsername: string | null;
  createdAt: string;
}

export interface CounselorAdminView {
  id: number;
  name: string;
  place: string | null;
  roomId: number | null;
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
  /** Скрыт от участников. */
  hidden: boolean;
  audience: CounselorAudience;
  tags: string[];
  /** Начала всех окошек. */
  slots: string[];
  bookings: CounselingBookingRow[];
}

export interface CounselingAdminView {
  open: boolean;
  counselors: CounselorAdminView[];
}

export interface InfoPageView {
  slug: string;
  title: string;
  bodyMd: string;
  sort: number;
  published: boolean;
}

export interface AnnouncementView {
  id: number;
  title: string;
  bodyMd: string;
  pinned: boolean;
  published: boolean;
  createdAt: string;
}

export interface InfoResponse {
  pages: InfoPageView[];
  announcements: AnnouncementView[];
}

// ---------- персонал: сессии ----------

export interface SessionInfo {
  user: { id: number; name: string; username: string | null; tgId: number | null };
  roles: Role[];
  permissions: Permission[];
  /** Для ролей без доступа к настройкам: в каком поясе показывать и вводить время; startsAt - начало конференции. */
  event: { name: string; timezone: string; startsAt: string | null };
  /** devTools - кнопка «Очистить всю базу» (только на время разработки и только для DEV_WIPE_TG_IDS). */
  features: { payments: boolean; devTools?: boolean };
  tiers: TiersConfig;
  breakfast: BreakfastConfig;
}

export interface DevWipeResponse {
  participants: number;
  accounts: number;
  /** Скольким отправляем сообщение о новой регистрации (отправка идёт в фоне). */
  notifying: number;
}

export interface OkResponse {
  ok: true;
}

export interface MarkPaidResponse {
  updated: number;
  people: { id: number; fullName: string; paymentStatus: PaymentStatus; amountPaid: string; amountDue: string | null }[];
  /** Этот приём уже был зачислен (повтор того же запроса) - ничего не изменилось, в people текущее состояние. */
  duplicate?: boolean;
}

export type TicketsResendResponse = { queued: true } | { queued: false; reason: 'too_soon' | 'no_tickets' };

export interface QueuedResponse {
  queued: boolean;
}

export interface StaffSessionResponse extends SessionInfo {
  token: string;
  expiresAt: string;
}

// ---------- персонал: сканер ----------

export interface CheckpointView {
  id: number;
  kind: CheckpointKind;
  name: string;
  activityId: number | null;
  day: string | null;
  isActive: boolean;
  countsInStats: boolean;
}

export interface CheckInInfo {
  id: number;
  at: string;
  byName: string;
}

export interface ManifestResponse {
  /** Меняется при любом изменении данных; клиент шлёт его в If-None-Match. */
  version: string;
  generatedAt: string;
  /** Соль для хешей кодов: ключ = sha256hex(salt + canonicalCode). */
  salt: string;
  codes: { h: string; pid: number; st: 'active' | 'revoked' }[];
  participants: {
    id: number;
    fullName: string;
    /**
     * Возраст и «младше 16» вместо даты рождения: база лежит на телефонах волонтёров, и при потере
     * телефона даты рождения всех участников не должны уйти вместе с ним.
     */
    age: number | null;
    under16: boolean;
    /** Только в старых базах, сохранённых на устройстве до обновления. */
    birthDate?: string;
    category: Category;
    status: ParticipantStatus;
    paymentStatus: PaymentStatus;
    tier: Tier | null;
    /** Нет в базах, сохранённых на устройстве до появления галочки завтрака. */
    breakfast?: boolean;
    amountDue: string | null;
    familyId: number;
  }[];
  checkIns: { checkpointId: number; participantId: number; at: string; byName: string }[];
  /** Оплата выключена → никаких «не оплачено» на входе, статусы оплаты не показываем. */
  paymentsEnabled: boolean;
  allowUnpaidEntry: boolean;
  eventTimezone: string;
  tiers: TiersConfig;
  /** Дата, на которую считаем возраст (начало конференции или сегодня). */
  ageOn: string;
}

export interface ParticipantCard {
  id: number;
  fullName: string;
  birthDate: string | null;
  age: number | null;
  category: Category;
  status: ParticipantStatus;
  paymentStatus: PaymentStatus;
  tier: Tier | null;
  breakfast: boolean;
  amountDue: string | null;
  /** Уже внесено (для кассы: сколько осталось). */
  amountPaid: string;
  under16: boolean;
  familyId: number;
  /** Отметка на выбранной точке, если уже есть. */
  checkIn: CheckInInfo | null;
}

export type LookupResponse =
  | {
      found: true;
      codeStatus: 'active' | 'revoked' | 'by_id';
      card: ParticipantCard;
      family: ParticipantCard[];
      paymentsEnabled: boolean;
      allowUnpaidEntry: boolean;
      tiers: TiersConfig;
    }
  | { found: false; reason: 'invalid_code' | 'unknown_code' | 'not_found' };

/** Касса: человек по QR-коду (или id) и остальные записанные вместе с ним. */
export type PaymentFindResponse =
  | { found: true; codeStatus: 'active' | 'revoked' | 'by_id'; card: ParticipantCard; family: ParticipantCard[]; tiers: TiersConfig }
  | { found: false; reason: 'invalid_code' | 'unknown_code' | 'not_found' };

export type CheckInOutcome =
  | 'new'
  | 'retry'
  | 'duplicate'
  | 'event_id_reused'
  | 'unpaid'
  /** Конференция ещё не началась: сканер принимает взносы, вход не отмечается. */
  | 'before_event'
  | 'cancelled_participant'
  | 'revoked_ticket'
  | 'not_found'
  | 'checkpoint_inactive'
  | 'forbidden'
  /** Эту отметку уже отменили («Отменить» на сканере или в админке) - повтор события её не возвращает. */
  | 'check_in_undone';

export interface CheckInResult {
  clientEventId: string;
  outcome: CheckInOutcome;
  checkInId: number | null;
  checkedAt: string | null;
  byName: string | null;
}

export interface CheckInBatchResponse {
  results: CheckInResult[];
}

export interface StaffSearchResponse {
  items: ParticipantCard[];
}

/** Мои последние сканы (история сканера), новые сверху. */
export interface StaffRecentScan {
  id: number;
  fullName: string | null;
  tier: Tier | null;
  /** Нет в истории, сохранённой на устройстве до появления галочки завтрака. */
  breakfast?: boolean;
  /** Итог скана: new / retry / duplicate / unpaid / invalid_code / unknown_code / revoked_ticket / … */
  outcome: string;
  /** Отметку потом отменили. */
  revoked: boolean;
  at: string;
  /** Отметка, которую создал этот скан (для отмены из истории). */
  checkInId: number | null;
  /** Можно отменить сейчас: своя свежая отметка (до 10 минут), ещё не отменена. */
  canUndo: boolean;
}

export interface StaffStats {
  checkpointId: number;
  checkedIn: number;
  expected: number;
  lastHour: number;
  byMe: number;
}

// ---------- админка ----------

export interface AdminParticipantRow {
  id: number;
  lastName: string;
  firstName: string;
  middleName: string | null;
  fullName: string;
  birthDate: string | null;
  age: number | null;
  gender: Gender;
  city: string | null;
  church: string | null;
  phone: string | null;
  telegramUsername: string | null;
  relation: Relation;
  category: Category;
  status: ParticipantStatus;
  tier: Tier | null;
  breakfast: boolean;
  paymentMethod: RegPaymentMethod | null;
  under16: boolean;
  /** «Гость (на месте)»: упрощённая регистрация в день конференции. */
  onSite: boolean;
  /** Аккаунт, который узнали по нику (или которому передали QR-код). */
  holderName: string | null;
  /** С кем переписка в «Сообщениях»: держатель QR-кода или владелец аккаунта. */
  chatUserId: number;
  paymentStatus: PaymentStatus;
  amountDue: string | null;
  amountPaid: string;
  paidAt: string | null;
  paymentNote: string | null;
  arrivedAt: string | null;
  /** Кто отметил приход на входе: имя и ник в Telegram (для «Подтверждённых» и статистики). */
  arrivedBy: { name: string; username: string | null } | null;
  ticketCode: string | null;
  /** Веб-билет и картинка для печати (для тех, у кого нет Telegram). */
  ticketWebUrl: string | null;
  ticketImageUrl: string | null;
  familyId: number;
  familySize: number;
  ownerName: string;
  ownerUsername: string | null;
  ownerTgId: number | null;
  ownerPhone: string | null;
  paymentRef: string;
  possibleDuplicate: boolean;
  /** Отметил(а) в анкете: готов(а) оплатить регистрацию того, у кого нет возможности. */
  sponsorOffer: boolean;
  /** В каких списках участников (id списков). */
  lists: number[];
  createdAt: string;
  updatedAt: string;
  /** Только в ответе на сохранение: например, вариант сверх лимита мест. */
  warning?: string;
}

export interface AuditEntry {
  id: number;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export type ReceiptKind = 'fee' | 'donation' | 'merch';

/** Прислали чек, но не нажали «Отправить»: команда видит, кому написать. */
export interface UnsentDraftView {
  id: number;
  userId: number;
  userName: string;
  people: string[];
  files: number;
  createdAt: string;
}

export interface ReceiptView {
  id: number;
  /** Взнос (за людей ниже), пожертвование или оплата брони мерча. */
  kind: ReceiptKind;
  /** Чек за мерч: бронь, за которую он, и что в ней (вещь, цвет, размер). */
  merchOrder: {
    id: number;
    code: string;
    total: string;
    status: string;
    items: { product: string; color: string; size: string; qty: number }[];
  } | null;
  userId: number;
  userName: string;
  paymentRef: string;
  participants: {
    id: number;
    fullName: string;
    paymentStatus: PaymentStatus;
    tier: Tier | null;
    breakfast: boolean;
    amountDue: string | null;
    amountPaid: string;
  }[];
  /** Сумма к оплате за людей из чека. */
  expectedTotal: string;
  /** Сумма чека: на проверке - сколько должно быть; принятый - сколько по нему зачли; отклонённый - сколько должно было быть. */
  amount: string | null;
  fileKind: 'photo' | 'document';
  /** image/jpeg, image/png, application/pdf… - картинку, присланную файлом, показываем как фото. */
  mimeType: string | null;
  fileUrl: string;
  /** Все файлы чека: первый - тот же, что fileUrl; следом - присланные подряд (несколько переводов). */
  files: { url: string; kind: 'photo' | 'document'; mimeType: string | null }[];
  comment: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  rejectReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewerName: string | null;
}

export interface AdminCheckInRow {
  id: number;
  checkpointId: number;
  checkpointName: string;
  participantId: number;
  fullName: string;
  at: string;
  byName: string;
  byUsername: string | null;
  method: CheckInMethod;
  offline: boolean;
  deviceId: string | null;
  revokedAt: string | null;
}

export interface ScanLogRow {
  id: number;
  checkpointName: string | null;
  rawCode: string | null;
  participantId: number | null;
  fullName: string | null;
  outcome: string;
  staffName: string | null;
  staffUsername: string | null;
  deviceId: string | null;
  createdAt: string;
}

export interface AdminParticipantDetail {
  participant: AdminParticipantRow;
  family: AdminParticipantRow[];
  checkIns: AdminCheckInRow[];
  activities: { activityId: number; title: string; startsAt: string; status: string }[];
  receipts: ReceiptView[];
  /** Журнал оплат человека: взносы и пожертвования (с отменёнными). */
  payments: PaymentEntryView[];
  consents: { kind: 'pd' | 'photo'; documentVersion: string; givenAt: string; givenByName: string }[];
  audit: AuditEntry[];
}

export interface DuplicateGroup {
  key: string;
  participants: AdminParticipantRow[];
}

/** Питание во 2-й день; breakfastLimit - сколько всего завтраков (null - без лимита). */
export interface Meals {
  /** Обед и ужин - у всех с чёрным браслетом («Обед и ужин», «Нуждаюсь в спонсоре»). */
  lunchDinner: number;
  breakfast: number;
  breakfastLimit: number | null;
  /** Браслеты: сколько положено и сколько уже пришли (отмечены на входе). Завтрак не влияет. */
  bracelets: Record<Bracelet, { total: number; arrived: number }>;
}

export interface DashboardResponse {
  accounts: number;
  participants: { active: number; cancelled: number };
  payments: Record<PaymentStatus, number>;
  byTier: { tier: Tier | 'none'; total: number; paid: number; arrived: number }[];
  /** Питание во 2-й день: обед и ужин - вариант «Взнос и питание», завтрак - у кого галочка завтрака. */
  meals: Meals;
  /** Заходы по дням (последние 14, сегодня - последний): разных людей всего, в боте, в Mini App и новых. */
  visits: { day: string; total: number; bot: number; app: number; new: number }[];
  /** Нагрузка: запросы в бота (сообщения, кнопки) и в Mini App - по часам за 48 ч и по дням за 14 дней. `at` - начало часа (ISO). */
  traffic: {
    hours: { at: string; bot: number; app: number }[];
    days: { day: string; bot: number; app: number }[];
    /** Кто больше всех за последние 24 часа (первые 10). */
    top: { userId: number; name: string; username: string | null; bot: number; app: number }[];
  };
  money: MoneyBreakdown;
  under16: number;
  /** arrived - пришли хоть раз за конференцию; today - отмечены на входе сегодня; eventDay - сегодня день конференции. */
  arrival: { arrived: number; expected: number; today: number; eventDay: boolean };
  arrivalsByQuarterHour: { t: string; n: number }[];
  byCategory: { category: Category; total: number; arrived: number }[];
  activities: { id: number; title: string; startsAt: string; capacity: number | null; registered: number; waitlist: number }[];
  scanners: { name: string; username: string | null; count: number; lastAt: string }[];
  alerts: { duplicates: number; invalid: number; recent: ScanLogRow[] };
  pendingReceipts: number;
  generatedAt: string;
}

/**
 * Деньги: ожидаем и получили (по участникам), и из чего сложилось полученное - по журналу оплат:
 * способами (наличные, перевод, карта) и кто сколько принял на кассе.
 */
export interface MoneyBreakdown {
  expected: string;
  received: string;
  /** Взносы по способам (пожертвования - отдельно, в `donations`). */
  byMethod: { method: PaymentMethod; amount: string; people: number }[];
  /** cash/other - взносы, donations - пожертвования, принятые этим кассиром. */
  byCashier: { userId: number | null; name: string; cash: string; other: string; donations: string; people: number }[];
  donations: { amount: string; cash: string; count: number };
}

/** Строка журнала оплат: одно зачисление. */
/** Вид записи в журнале денег: взнос, пожертвование, мерч, прочий приход, выдача (расход). */
export type MoneyKind = 'fee' | 'donation' | 'merch' | 'income' | 'payout';

export interface PaymentEntryView {
  id: number;
  /** fee - взнос, donation - пожертвование, merch - оплата мерча, income - прочий приход, payout - выдача. */
  kind: MoneyKind;
  /** Пожертвование без QR-кода - без участника. */
  participantId: number | null;
  /** ФИО участника, иначе имя жертвователя, иначе «Без имени». */
  fullName: string;
  comment: string | null;
  tier: Tier | null;
  amount: string;
  method: PaymentMethod;
  /**
   * desk - касса или «Принять оплату», receipt - принятый чек перевода, manual - правка суммы в админке,
   * money - выдача или приход от банкира, merch - оплата мерча.
   */
  source: 'desk' | 'receipt' | 'manual' | 'money' | 'merch';
  /** На что (выдача, прочий приход). */
  category: string | null;
  /** Заказ мерча, если это оплата мерча. */
  merchOrderId: number | null;
  merchOrderCode: string | null;
  /** Почему отменили. */
  undoReason: string | null;
  receiptId: number | null;
  acceptedById: number | null;
  acceptedByName: string | null;
  createdAt: string;
  /** Отменённый приём: в суммы не идёт. */
  undoneAt: string | null;
  undoneByName: string | null;
  /** Участник сейчас: сколько внесено и статус (у пожертвования без участника - пусто). */
  paymentStatus: PaymentStatus | null;
  amountDue: string | null;
  amountPaid: string | null;
}

/** Сводка банкира: приход по источникам, расход, остаток - всего и отдельно наличными и переводом. */
export interface MoneySummary {
  income: { fee: string; donation: string; merch: string; income: string; total: string };
  payout: string;
  balance: string;
  /** По способам: сколько пришло, сколько выдано, сколько осталось. */
  byMethod: { method: PaymentMethod; in: string; out: string; balance: string }[];
  /** Выдачи по категориям (без категории - «Прочее»). */
  payoutsByCategory: { category: string; amount: string; count: number }[];
}

export interface MoneyResponse {
  summary: MoneySummary;
  entries: PaymentEntryView[];
}

/** «Статистика» в приложении команды: главное на одном экране телефона. */
export interface StaffOverview {
  generatedAt: string;
  registrations: {
    participants: number;
    accounts: number;
    cancelled: number;
    /** Сколько добавилось сегодня и за 7 дней (по часам конференции). */
    today: number;
    week: number;
    /** Последние 14 дней, по возрастанию. */
    byDay: { day: string; n: number }[];
  };
  payments: {
    enabled: boolean;
    byStatus: Record<PaymentStatus, number>;
    expected: string;
    received: string;
    byMethod: MoneyBreakdown['byMethod'];
    donations: MoneyBreakdown['donations'];
    pendingReceipts: number;
  };
  tiers: { tier: Tier | 'none'; label: string; color: string | null; total: number; limit: number | null }[];
  meals: Meals;
  /** Бот сегодня: сколько сообщений дошло и не дошло, что дальше по плану. */
  bot: { sent: number; failed: number; next: BotScheduledItem[] };
  people: {
    cities: { name: string; n: number }[];
    citiesTotal: number;
    churches: { name: string; n: number }[];
    churchesTotal: number;
    gender: { m: number; f: number };
    /** Возраст на начало конференции. */
    ages: { under16: number; from16to17: number; from18to25: number; over25: number };
  };
  arrival: {
    arrived: number;
    expected: number;
    /** Отмечены на входе сегодня и сегодня ли день конференции. */
    today: number;
    eventDay: boolean;
    /** Отметки на входе за последние 3 часа, по 15 минут. */
    flow: { t: string; n: number }[];
    /** Кто сколько отметил за сутки. */
    scanners: { name: string; count: number }[];
  };
  seminars: {
    id: number;
    title: string;
    startsAt: string;
    registrationOpen: boolean;
    roomsPublished: boolean;
    registered: number;
    capacity: number;
    topics: { id: number; title: string; registered: number; overflow: number; room: string | null }[];
  }[];
  counseling: { open: boolean; booked: number; slots: number; counselors: { name: string; booked: number; slots: number }[] } | null;
  /** Мероприятия с записью (кроме тем семинаров), которые ещё не закончились. */
  activities: { id: number; title: string; startsAt: string; capacity: number | null; registered: number; waitlist: number }[];
  attention: { openQuestions: number; pendingReceipts: number; duplicates: number };
}

export interface BroadcastView {
  id: number;
  text: string;
  segment: Segment;
  status: 'scheduled' | 'sending' | 'done' | 'cancelled';
  /** Тестовая отправка только себе. */
  isTest: boolean;
  scheduledAt: string | null;
  createdAt: string;
  createdByName: string | null;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
}

export interface StaffMember {
  userId: number;
  name: string;
  username: string | null;
  tgId: number | null;
  roles: Role[];
  hasPassword: boolean;
  lastSeenAt: string | null;
  /** Главный администратор (задан в настройках сервера): роль суперадмина у него не снимается. */
  permanent: boolean;
}

export interface StaffInviteResponse {
  link: string;
  expiresAt: string;
}

/** Многоразовая ссылка «Участник команды»: одна на всех, пока не сменят. */
export interface MemberLinkView {
  link: string;
  /** Сколько раз по ней вступили (повторные нажатия тоже считаются). */
  uses: number;
  createdAt: string;
}

export interface ScannerCardResponse {
  userId: number;
  loginUrl: string;
  expiresAt: string;
}

export interface StaffPasswordResponse {
  login: string;
  /** otpauth:// - показать QR для приложения-аутентификатора, один раз. */
  totpUri: string;
}

export type SettingsResponse = Settings;

// ---------- мерч ----------

/** photo - фото, model - 3D-модель (.glb), spin - 360°: кадры оборота одним файлом (.spin, см. spin.ts). */
export type MerchMediaKind = 'photo' | 'model' | 'spin';

export interface MerchMediaView {
  id: number;
  kind: MerchMediaKind;
  /** /media/merch/<хеш>.webp|.glb|.spin - отдаётся с вечным кэшем. У 360° thumbUrl - первый кадр. */
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  /** null - для всех цветов. */
  colorId: number | null;
  sort: number;
}

export interface MerchSizeView {
  id: number;
  size: string;
  /** Сколько можно взять сейчас (всего минус в заказах). */
  left: number;
  sort: number;
}

export interface MerchColorView {
  id: number;
  name: string;
  hex: string;
  sort: number;
  sizes: MerchSizeView[];
}

export interface MerchProductView {
  id: number;
  title: string;
  subtitle: string | null;
  descriptionMd: string;
  price: string;
  badge: string | null;
  colors: MerchColorView[];
  media: MerchMediaView[];
  /** Есть хоть один размер в наличии. */
  available: boolean;
}

export interface MerchCatalogResponse {
  products: MerchProductView[];
  /** Бронь и покупка включены. */
  sales: boolean;
  /** Бронируют сами в приложении; false - выбирают и пишут продавцу. */
  selfBooking: boolean;
  /** Сколько часов держим неоплаченную бронь; null - до конференции. */
  reservationHours: number | null;
  /** Реквизиты для перевода; пусто - перевод не принимаем. */
  paymentInstructions: string;
}

/** Админка: размер с полным учётом. */
export interface AdminMerchSize extends MerchSizeView {
  stock: number;
  reserved: number;
  paid: number;
  issued: number;
}

export interface AdminMerchColor extends Omit<MerchColorView, 'sizes'> {
  sizes: AdminMerchSize[];
}

export interface AdminMerchProduct extends Omit<MerchProductView, 'colors'> {
  sort: number;
  published: boolean;
  colors: AdminMerchColor[];
  /** Есть заказы - удалить нельзя, только скрыть. */
  hasOrders: boolean;
}

/** Загруженный в редакторе файл: ещё ни к чему не привязан, пока не нажали «Сохранить». */
export interface MerchUploadView {
  file: string;
  kind: MerchMediaKind;
  url: string;
  thumbUrl: string | null;
  bytes: number;
}

/** owed - выдано в долг: вещь у человека, деньги ещё не все. */
export type MerchOrderStatusView = 'reserved' | 'paid' | 'issued' | 'owed' | 'cancelled' | 'expired';

export interface MerchOrderItemView {
  variantId: number;
  productId: number;
  title: string;
  qty: number;
  price: string;
  thumbUrl: string | null;
}

export interface MerchOrderView {
  id: number;
  /** Код выдачи: «M-4821». */
  code: string;
  status: MerchOrderStatusView;
  total: string;
  /** Сколько уже заплачено (у долга - часть суммы). */
  paidAmount: string;
  paymentMethod: 'cash' | 'card' | 'transfer' | null;
  expiresAt: string | null;
  createdAt: string;
  paidAt: string | null;
  issuedAt: string | null;
  cancelReason: string | null;
  receiptAt: string | null;
  /** Спросили «точно заберёте?» и ждём ответа до этого времени. */
  confirmBy: string | null;
  /** Не ответят до `confirmBy` - бронь снимется (если так в настройках; подтверждённую раньше не снимаем). */
  confirmDrops: boolean;
  items: MerchOrderItemView[];
}

export interface AdminMerchOrderView extends MerchOrderView {
  userId: number;
  userName: string;
  username: string | null;
  note: string | null;
  receiptUrl: string | null;
  paidByName: string | null;
  issuedByName: string | null;
  /** Покупатель при продаже на месте: участник из базы или имя и телефон. */
  buyerParticipantId: number | null;
  buyerName: string | null;
  buyerPhone: string | null;
  /**
   * «Точно заберёте?» по этой брони: ждём ответа до `by`, ответил «Да», бронь сняли без ответа
   * или не ответил (бронь не снимали). null - не спрашивали.
   */
  confirm: { state: 'waiting' | 'yes' | 'dropped' | 'missed'; askedAt: string; by: string | null } | null;
  /** Чек перевода ждёт проверки (из бота или приложения): продавец смотрит и принимает или отклоняет. */
  receipt: { id: number; at: string; files: number; mime: string | null; comment: string | null } | null;
}

/** Продавец отсканировал QR-код участника: кто это, взнос (с семьёй) и все его заказы мерча, кроме снятых. */
export type MerchScanResponse =
  | {
      found: true;
      codeStatus: 'active' | 'revoked' | 'by_id';
      card: ParticipantCard;
      family: ParticipantCard[];
      paymentsEnabled: boolean;
      orders: AdminMerchOrderView[];
    }
  | { found: false; reason: 'invalid_code' | 'unknown_code' | 'not_found' };

/** Статистика мерча: продано, выручка, долги, что заканчивается. */
export interface MerchStats {
  /** Штук продано (оплачено, выдано, в долг). */
  soldQty: number;
  /** Заказов продано. */
  orders: number;
  /** Получено денег за мерч (журнал, без возвратов). */
  revenue: string;
  /** Сумма всех проданных заказов, вместе с долгами. */
  salesTotal: string;
  debt: { count: number; amount: string };
  byItem: { productId: number; title: string; qty: number; amount: string }[];
  byProduct: { productId: number; title: string; qty: number; amount: string }[];
  byMethod: { method: 'cash' | 'card' | 'transfer'; amount: string; count: number }[];
  bySeller: { userId: number | null; name: string; amount: string; count: number }[];
  /** Размеры, где осталось 3 и меньше. */
  lowStock: { variantId: number; title: string; left: number; stock: number }[];
}
