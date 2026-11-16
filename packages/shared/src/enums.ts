/** Справочники и подписи без zod - их можно тянуть на первый экран, не подгружая схемы. */
// ---------- справочники ----------

export const GENDERS = ['m', 'f'] as const;
export const RELATIONS = ['self', 'spouse', 'child', 'parent', 'sibling', 'friend', 'other'] as const;
/** Что предлагаем в формах и в каком порядке. 'sibling' остаётся в RELATIONS только ради старых записей. */
export const RELATION_OPTIONS = ['self', 'friend', 'spouse', 'child', 'parent', 'other'] as const satisfies readonly (typeof RELATIONS)[number][];
export const DEFAULT_CITY = 'Минск';
export const CATEGORIES = ['participant', 'child', 'volunteer', 'speaker', 'organizer', 'guest'] as const;
export const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'partial', 'exempt'] as const;
export const PARTICIPANT_STATUSES = ['active', 'cancelled'] as const;
export const ACTIVITY_STATUSES = ['draft', 'published', 'cancelled'] as const;
export const REGISTRATION_MODES = ['none', 'required'] as const;
export const CHECKPOINT_KINDS = ['entrance', 'activity', 'meal', 'training'] as const;
export const CHECKIN_METHODS = ['scan', 'manual', 'family', 'bot'] as const;
export const PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;
/** Кого принимает служитель душепопечения: всех, только девушек, только парней. */
export const COUNSELOR_AUDIENCES = ['all', 'f', 'm'] as const;

export type Gender = (typeof GENDERS)[number];
export type Relation = (typeof RELATIONS)[number];
export type Category = (typeof CATEGORIES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];
/** Тип мероприятия - свободный текст: основные типы плюс свои, которые запоминаются. */
export type ActivityKind = string;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];
export type CheckInMethod = (typeof CHECKIN_METHODS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type CounselorAudience = (typeof COUNSELOR_AUDIENCES)[number];
/** Метка у служителя: «Для девушек» / «Для парней»; у «всех» метки нет. */
export const COUNSELOR_AUDIENCE_LABELS: Record<Exclude<CounselorAudience, 'all'>, string> = { f: 'Для девушек', m: 'Для парней' };

export const CATEGORY_LABELS: Record<Category, string> = {
  participant: 'Участник',
  child: 'Ребёнок',
  volunteer: 'Волонтёр',
  speaker: 'Спикер',
  organizer: 'Организатор',
  guest: 'Гость',
};

export const RELATION_LABELS: Record<Relation, string> = {
  self: 'Я',
  spouse: 'Муж/жена',
  child: 'Ребёнок',
  parent: 'Родитель',
  sibling: 'Брат/сестра',
  friend: 'Друг/подруга',
  other: 'Другое',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'Не оплачено',
  pending: 'Чек на проверке',
  paid: 'Оплачено',
  partial: 'Оплачено частично',
  exempt: 'Без взноса',
};

/** Основные типы - предлагаем первыми. Свои типы хранятся текстом и потом тоже появляются в списке. */
export const ACTIVITY_KIND_PRESETS = ['Служение', 'Семинар', 'Сессия'] as const;

/** Старые ключи типов (когда тип был списком) → подписи. Новые мероприятия хранят сразу подпись. */
const LEGACY_ACTIVITY_KINDS: Record<string, string> = {
  main: 'Общая программа',
  seminar: 'Семинар',
  workshop: 'Мастер-класс',
  game: 'Игра',
  meal: 'Питание',
  other: 'Другое',
};

export function activityKindLabel(kind: string): string {
  return LEGACY_ACTIVITY_KINDS[kind] ?? kind;
}

/** Типы для выбора: основные, затем уже использованные - без повторов, в порядке появления. */
export function activityKindOptions(used: readonly string[]): string[] {
  const out: string[] = [...ACTIVITY_KIND_PRESETS];
  for (const k of used) {
    const label = activityKindLabel(k).trim();
    if (label && !out.some((x) => x.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  return out;
}


// ---------- варианты участия (взнос) ----------

/**
 * Вариант участия выбирается на каждого человека. Цена и цвет - в настройках (settings.tiers).
 * Завтрак - не вариант, а галочка к платному варианту (settings.breakfast); был вариант fee45 «с завтраком».
 * Бесплатных два: nofee - «Нуждаюсь в спонсоре» (питание оплачивает спонсор), free - «Без взноса»: вход бесплатно, без питания.
 */
export const TIERS = ['fee10', 'fee35', 'nofee', 'free'] as const;
export type Tier = (typeof TIERS)[number];

/** Варианты без взноса: способ оплаты не спрашиваем, цена всегда 0. */
export const FREE_TIERS: readonly Tier[] = ['nofee', 'free'];
export const isFreeTier = (tier: string | null | undefined): boolean => FREE_TIERS.includes(tier as Tier);

/** Как человек собирается внести взнос. */
export const REG_PAYMENT_METHODS = ['transfer', 'cash'] as const;
export type RegPaymentMethod = (typeof REG_PAYMENT_METHODS)[number];
export const REG_PAYMENT_METHOD_LABELS: Record<RegPaymentMethod, string> = {
  transfer: 'Безналичный перевод',
  cash: 'Наличными',
};

export interface TierConfig {
  /** Заголовок карточки в форме. */
  label: string;
  /** Коротко - для бейджа, сканера и QR-кода. */
  short: string;
  /** Что входит. */
  description: string;
  /** Сумма в рублях; 0 - без взноса. */
  amount: number;
  /** #rrggbb */
  color: string;
  /** Сколько человек может выбрать вариант (например, обед и ужин - 250); null - без ограничения. */
  limit: number | null;
  /** Показывать при регистрации. Выключен - в анкете его нет и выбрать нельзя; у уже записанных остаётся. */
  enabled: boolean;
  /** Какой браслет выдать: чёрный - с обедом и ужином, белый - без питания. Завтрак на браслет не влияет. */
  bracelet: Bracelet;
}
export type TiersConfig = Record<Tier, TierConfig>;

/** Питание в расписании: за 15 минут тем, у кого оно есть, - личное напоминание. Обед и ужин - по чёрному браслету, завтрак - по галочке. */
export const MEALS = ['breakfast', 'lunch', 'dinner'] as const;
export type Meal = (typeof MEALS)[number];
export const MEAL_LABELS: Record<Meal, string> = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин' };

/** Браслет на входе: по нему кормят. */
export const BRACELETS = ['black', 'white'] as const;
export type Bracelet = (typeof BRACELETS)[number];
export const BRACELET_LABELS: Record<Bracelet, string> = { black: 'Чёрный браслет', white: 'Белый браслет' };
export const BRACELET_MEANING: Record<Bracelet, string> = { black: 'с питанием', white: 'без питания' };
export const BRACELET_DOT: Record<Bracelet, string> = { black: '⚫️', white: '⚪️' };

/** Цвета - фирменные цвета конференции: синий, красный, серо-сливовый. */
export const DEFAULT_TIERS: TiersConfig = {
  fee10: {
    label: 'Только взнос',
    short: 'Только взнос',
    description: 'Регистрационный взнос, без обеда и ужина',
    amount: 10,
    color: '#4b5da5',
    limit: null,
    enabled: true,
    bracelet: 'white',
  },
  fee35: {
    label: 'Взнос и питание',
    short: 'Обед и ужин',
    description: 'Обед и ужин во второй день',
    amount: 35,
    color: '#d0352c',
    limit: 250,
    enabled: true,
    bracelet: 'black',
  },
  nofee: {
    label: 'Нуждаюсь в спонсоре',
    short: 'Нуждаюсь в спонсоре',
    description: 'Взнос и питание оплатит спонсор',
    amount: 0,
    color: '#7a6e74',
    limit: null,
    enabled: true,
    bracelet: 'black',
  },
  free: {
    label: 'Без взноса',
    short: 'Без взноса',
    description: 'Бесплатный вход, без питания',
    amount: 0,
    color: '#a8701a',
    limit: null,
    enabled: true,
    bracelet: 'white',
  },
};

/** Завтрак - доплата к платному варианту («Только взнос» или «Взнос и питание»), у «Без взноса» его нет. */
export interface BreakfastConfig {
  /** Доплата в рублях. */
  amount: number;
  /** Сколько всего завтраков; null - без ограничения. */
  limit: number | null;
  /** Подсказка у галочки: когда завтрак. */
  description: string;
  /** Предлагать при регистрации. Выключен - галочки нет; у кого завтрак уже есть, остаётся. */
  enabled: boolean;
}

export const DEFAULT_BREAKFAST: BreakfastConfig = {
  amount: 10,
  limit: 100,
  enabled: true,
  description: 'Завтрак во второй день',
};

/** Браслет человека по варианту участия; старые настройки без поля - по умолчанию для варианта. */
export function braceletOf(tiers: Partial<Record<Tier, Partial<TierConfig>>> | null | undefined, tier: string | null | undefined): Bracelet | null {
  if (!tier || !(TIERS as readonly string[]).includes(tier)) return null;
  return tiers?.[tier as Tier]?.bracelet ?? DEFAULT_TIERS[tier as Tier].bracelet;
}

/** К какому варианту можно добавить завтрак. */
export function breakfastAllowed(tier: string | null | undefined): boolean {
  return tier === 'fee10' || tier === 'fee35';
}

/** Сумма к оплате за человека: цена варианта и завтрак, если он есть. */
export function priceOf(s: { tiers: TiersConfig; breakfast: BreakfastConfig }, tier: Tier, breakfast: boolean): number {
  return s.tiers[tier].amount + (breakfast && breakfastAllowed(tier) ? s.breakfast.amount : 0);
}

/** Подпись варианта для бейджа, сканера и QR-кода: «Обед и ужин + завтрак». */
export function tierShort(cfg: Pick<TierConfig, 'short'>, breakfast: boolean | null | undefined): string {
  return breakfast ? `${cfg.short} + завтрак` : cfg.short;
}

/** Регистрация с 16 лет; младших тоже записываем, но помечаем. */
export const MIN_AGE = 16;

export const CONSENT_VERSION = '2026-09-30';
export const CONSENT_LABEL = 'Даю согласие на обработку персональных данных';
export const PRIVACY_POLICY_TEXT =
  'Обработка персональных данных осуществляется в соответствии с Законом Республики Беларусь от 07.05.2021 № 99-З «О защите персональных данных». ' +
  'Регистрируясь, вы даёте согласие на обработку персональных данных для случаев, не предусмотренных ст. 6 указанного Закона. ' +
  'Внешним третьим лицам, не связанным со служением церкви «Благодать», данные не передаются, за исключением сервисов доставки сообщений (Telegram), через которые приходят уведомления.';

/** Сумма `35.00` → `35 руб.` */
export function formatRub(v: string | number | null | undefined): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',');
  return `${s} руб.`;
}

/** Контрастный цвет текста на фоне `#rrggbb`. */
export function textOn(hex: string): '#ffffff' | '#111827' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#111827' : '#ffffff';
}

/**
 * Любой номер → `+<8–15 цифр>` или null. Белорусские `80…`, `8 0…` и девятизначные `29…`
 * дополняем до `+375…`.
 */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (!raw.trim().startsWith('+')) {
    if (/^80(25|29|33|44|17)\d{7}$/.test(d)) d = `375${d.slice(2)}`;
    else if (/^(25|29|33|44)\d{7}$/.test(d)) d = `375${d}`;
  }
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

/** `@Ivan_P` → `Ivan_P`; null, если это не похоже на ник Telegram. */
export function normalizeTelegramUsername(raw: string): string | null {
  const s = raw.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) ? s : null;
}

/** Отметки переписок в админке: смайлик и подпись. Одна отметка на переписку. */
export const CHAT_MARKS = ['important', 'wait', 'money', 'later', 'done'] as const;
export type ChatMark = (typeof CHAT_MARKS)[number];
export const CHAT_MARK_INFO: Record<ChatMark, { emoji: string; label: string }> = {
  important: { emoji: '❗', label: 'Важно' },
  wait: { emoji: '⏳', label: 'Ждёт ответа' },
  money: { emoji: '💰', label: 'Оплата' },
  later: { emoji: '⭐', label: 'Вернуться позже' },
  done: { emoji: '✅', label: 'Решено' },
};

// ---------- отзывы ----------

/** Отзыв о конференции: свидетельство, общий отзыв или пожелание на следующий год. */
export const FEEDBACK_CATEGORIES = ['testimony', 'review', 'suggestion'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export const FEEDBACK_CATEGORY_INFO: Record<FeedbackCategory, { emoji: string; label: string; plural: string; hint: string; placeholder: string }> = {
  testimony: {
    emoji: '🙌',
    label: 'Свидетельство',
    plural: 'Свидетельства',
    hint: 'Что Бог сделал в твоей жизни на конференции',
    placeholder: 'Обновление через слово, откровение, покаяние, освобождение, исцеление, крещение Святым Духом…',
  },
  review: {
    emoji: '💬',
    label: 'Отзыв',
    plural: 'Отзывы',
    hint: 'Как тебе «Шаг веры» в целом',
    placeholder: 'Что запомнилось, что тронуло, как всё прошло…',
  },
  suggestion: {
    emoji: '💡',
    label: 'Пожелание',
    plural: 'Пожелания',
    hint: 'Что добавить или убрать в следующий раз',
    placeholder: 'Что сделать лучше на следующих конференциях…',
  },
};
