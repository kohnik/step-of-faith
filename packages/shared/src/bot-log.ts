/**
 * Журнал сообщений бота: что, кому и когда бот отправил сам (напоминания, ответы на действия, вопросы).
 * Ручные рассылки - в своём журнале («Рассылки»), здесь их запуски показываем рядом для полноты.
 */

export const BOT_TOPICS = ['tickets', 'payments', 'merch', 'counseling', 'seminars', 'activities', 'game', 'chat', 'broadcast', 'other'] as const;
export type BotTopic = (typeof BOT_TOPICS)[number];
export const BOT_TOPIC_LABELS: Record<BotTopic, string> = {
  tickets: 'QR-коды и вход',
  payments: 'Оплата и чеки',
  merch: 'Мерч',
  counseling: 'Душепопечение',
  seminars: 'Семинары',
  activities: 'Мероприятия',
  game: 'Игра',
  chat: 'Переписка',
  broadcast: 'Рассылки',
  other: 'Прочее',
};

/** Итог отправки: дошло; бот заблокирован; человек ни разу не открывал бота; нет Telegram; сбой (повторят). */
export const BOT_OUTCOMES = ['sent', 'blocked', 'unreachable', 'no_telegram', 'failed'] as const;
export type BotOutcome = (typeof BOT_OUTCOMES)[number];
export const BOT_OUTCOME_LABELS: Record<BotOutcome, string> = {
  sent: 'дошло',
  blocked: 'бот заблокирован',
  unreachable: 'не открывал бота',
  no_telegram: 'нет Telegram',
  failed: 'сбой',
};

/**
 * Вид сообщения → подпись и тема. Ключ - имя задачи бота или вид из `notify.text`.
 * `mass` - одна задача шлёт многим (запуск виден одной строкой); остальные - по человеку, их группируем по часу.
 */
export const BOT_KINDS: Record<string, { label: string; topic: BotTopic; mass?: boolean }> = {
  'tickets.send': { label: 'QR-код участника', topic: 'tickets' },
  'tickets.shared': { label: 'QR-код передали другому аккаунту', topic: 'tickets' },
  'checkin.welcome': { label: 'Добро пожаловать (после входа)', topic: 'tickets' },
  'registration.cancelled': { label: 'Регистрацию отменили', topic: 'tickets' },
  'payment.confirmed': { label: 'Оплата принята', topic: 'payments' },
  'payment.notice': { label: 'Оплата: напоминание и изменения', topic: 'payments' },
  'receipt.reviewed': { label: 'Чек проверен', topic: 'payments' },
  'receipt.draft_reminder': { label: 'Чек не отправлен - напоминание', topic: 'payments' },
  'merch.confirm_ask': { label: 'Мерч: «Точно заберёте?»', topic: 'merch', mass: true },
  'merch.notice': { label: 'Мерч: бронь, оплата, долг', topic: 'merch' },
  'merch.paid_reminder': { label: 'Мерч: оплачен, ждёт вас', topic: 'merch', mass: true },
  'chat.merch_notify': { label: 'Мерч: копия сообщения продавцам', topic: 'merch' },
  'merch.receipt_notify': { label: 'Мерч: чек на проверку - продавцам', topic: 'merch', mass: true },
  'counseling.booked': { label: 'Душепопечение: вы записаны', topic: 'counseling' },
  'counseling.reminder': { label: 'Душепопечение: за 15 минут', topic: 'counseling' },
  'counseling.announce': { label: 'Душепопечение: «Напомнить всем»', topic: 'counseling', mass: true },
  'counseling.changed': { label: 'Душепопечение: место или отмена', topic: 'counseling' },
  'seminar.assigned': { label: 'Семинары: ваши семинары', topic: 'seminars', mass: true },
  'seminar.rooms': { label: 'Семинары: залы', topic: 'seminars', mass: true },
  'activity.promoted': { label: 'Мероприятие: место освободилось', topic: 'activities' },
  'activity.reminder': { label: 'Расписание: за 15 минут', topic: 'activities', mass: true },
  'activity.changed': { label: 'Мероприятие изменилось', topic: 'activities', mass: true },
  'game.invite': { label: 'Игра: приглашение', topic: 'game', mass: true },
  'game.assigned': { label: 'Игра: ты в команде', topic: 'game', mass: true },
  'game.tasks_revealed': { label: 'Игра: задание команды', topic: 'game', mass: true },
  'game.round_notify': { label: 'Игра: голосование открыто', topic: 'game', mass: true },
  'chat.deliver': { label: 'Ответ организаторов', topic: 'chat' },
  'chat.notify': { label: 'Копия сообщения участника - админам', topic: 'chat' },
  'feedback.remind': { label: 'Напоминание: оставить отзыв', topic: 'broadcast', mass: true },
  'notify.text': { label: 'Сообщение', topic: 'other' },
};

/** Задачи бота, которые не пишут людям, а что-то делают по расписанию, - для «Запланировано». */
export const BOT_JOB_LABELS: Record<string, string> = {
  'merch.confirm_drop': 'Мерч: снять бронь без ответа',
  'merch.expire': 'Мерч: снять неоплаченную бронь',
  'game.round_close': 'Игра: закрыть голосование',
  'game.schedule': 'Игра: шаг по расписанию',
  'broadcast.run': 'Рассылка',
};

export const botKindInfo = (kind: string) => BOT_KINDS[kind] ?? { label: kind, topic: 'other' as BotTopic };

// ---------- ответы API ----------

export type BotTone = 'green' | 'yellow' | 'red' | 'gray';

/** Запуск: массовая отправка (одна задача - многим) или сообщения одного вида за час. */
export interface BotRunView {
  /** `c:<вид>:<запуск>`, `k:<вид>:<час ISO>` или `b:<id рассылки>`. */
  key: string;
  kind: string;
  label: string;
  topic: BotTopic;
  /** Первое и последнее сообщение запуска. */
  at: string;
  lastAt: string;
  total: number;
  sent: number;
  /** Не дошло: заблокировали бота, не открывали его, нет Telegram, сбой. */
  failed: number;
  /** Ответы - где в сообщении вопрос («Точно заберёте?», приглашение в игру). */
  answers: { label: string; count: number; tone: BotTone }[] | null;
}

export interface BotMessageRow {
  id: number;
  at: string;
  userId: number | null;
  userName: string;
  username: string | null;
  kind: string;
  label: string;
  outcome: BotOutcome;
  error: string | null;
  preview: string | null;
  answer: { label: string; tone: BotTone } | null;
}

export interface BotRunDetail {
  run: BotRunView;
  rows: BotMessageRow[];
}

/** Что бот сделает дальше: задачи по времени, сгруппированные по виду и минуте. */
export interface BotScheduledItem {
  name: string;
  label: string;
  at: string;
  /** Сколько задач (мероприятий, записей, броней) в эту минуту. */
  count: number;
  /** Сколько человек получат сообщение; null - заранее не посчитать (рассылка по группе). */
  recipients: number | null;
  /** О чём: названия мероприятий, «19:40 · служитель · место», коды броней. */
  lines: string[];
  /** Как будет выглядеть сообщение (пример для первого). */
  preview: string | null;
}

/** До кого бот не достучится: заблокировали бота, ни разу не открывали, записаны без Telegram. */
export interface BotUnreachableRow {
  userId: number | null;
  name: string;
  username: string | null;
  phone: string | null;
  reason: 'blocked' | 'unreachable' | 'no_telegram';
  people: string[];
}

export interface BotLogOverview {
  today: { sent: number; failed: number };
  runs: BotRunView[];
  scheduled: BotScheduledItem[];
  unreachable: { blocked: number; unreachable: number; noTelegram: number };
}
