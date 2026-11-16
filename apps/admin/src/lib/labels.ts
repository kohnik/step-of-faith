import {
  activityKindLabel,
  CATEGORIES,
  CATEGORY_LABELS,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  RELATION_LABELS,
  RELATION_OPTIONS as RELATION_CHOICES,
  type ActivityStatus,
  type BroadcastView,
  type Category,
  type CheckInMethod,
  type CheckpointView,
  type CheckpointKind,
  type Gender,
  type ParticipantStatus,
  type PaymentStatus,
  type Permission,
  type ReceiptView,
  type RegistrationMode,
  type Relation,
  type Role,
  type Segment,
} from '@sof/shared';

export const PAYMENT_STATUS_COLORS: Record<PaymentStatus, string> = {
  unpaid: 'red',
  pending: 'yellow',
  paid: 'green',
  partial: 'orange',
  exempt: 'teal',
};

export const CATEGORY_COLORS: Record<Category, string> = {
  participant: 'blue',
  child: 'grape',
  volunteer: 'teal',
  speaker: 'violet',
  organizer: 'indigo',
  guest: 'gray',
};

export const PARTICIPANT_STATUS_LABELS: Record<ParticipantStatus, string> = {
  active: 'Активен',
  cancelled: 'Отменён',
};

/** Кем приходится владельцу аккаунта (в общем словаре self = «Я» - это для участника). */
export function relationLabel(relation: Relation): string {
  return relation === 'self' ? 'Владелец аккаунта' : RELATION_LABELS[relation];
}

/** Что предлагаем выбрать (без «брат/сестра» - старые записи с ним по-прежнему подписываются через RELATION_LABELS). */
export const RELATION_OPTIONS = RELATION_CHOICES.map((r) => ({ value: r, label: relationLabel(r) }));

export const GENDER_LABELS: Record<Gender, string> = { m: 'Мужской', f: 'Женский' };
export const GENDER_SHORT: Record<Gender, string> = { m: 'М', f: 'Ж' };

export const CHECKPOINT_KIND_LABELS: Record<CheckpointKind, string> = {
  entrance: 'Вход',
  activity: 'Активность',
  meal: 'Питание',
  training: 'Тренировка',
};

export const CHECKPOINT_KIND_COLORS: Record<CheckpointKind, string> = {
  entrance: 'blue',
  activity: 'violet',
  meal: 'orange',
  training: 'gray',
};

export function checkpointLabel(c: CheckpointView): string {
  return `${c.name} · ${CHECKPOINT_KIND_LABELS[c.kind]}${c.isActive ? '' : ' (выключена)'}`;
}

export const CHECKIN_METHOD_LABELS: Record<CheckInMethod, string> = {
  scan: 'Скан QR',
  manual: 'Вручную',
  family: 'Вместе с семьёй',
  bot: 'Через бота',
};

/** Исходы сканирования из журнала (`scan_log.outcome`). */
export const SCAN_OUTCOME_LABELS: Record<string, string> = {
  new: 'Отмечен',
  retry: 'Повторная отправка',
  duplicate: 'Уже отмечен',
  event_id_reused: 'Повторный скан',
  unpaid: 'Не оплачено',
  cancelled_participant: 'Участник отменён',
  revoked_ticket: 'QR-код отключён',
  not_found: 'Не найден',
  checkpoint_inactive: 'Точка выключена',
  before_event: 'До начала конференции',
  check_in_undone: 'Повтор отменённой отметки',
  forbidden: 'Нет прав',
  invalid_code: 'Неверный код',
  unknown_code: 'Неизвестный код',
};

export const SCAN_OUTCOME_COLORS: Record<string, string> = {
  new: 'green',
  retry: 'gray',
  duplicate: 'yellow',
  event_id_reused: 'gray',
  unpaid: 'orange',
  cancelled_participant: 'red',
  revoked_ticket: 'red',
  not_found: 'red',
  checkpoint_inactive: 'gray',
  before_event: 'blue',
  check_in_undone: 'gray',
  forbidden: 'red',
  invalid_code: 'red',
  unknown_code: 'red',
};

export const scanOutcomeLabel = (outcome: string) => SCAN_OUTCOME_LABELS[outcome] ?? outcome;
export const scanOutcomeColor = (outcome: string) => SCAN_OUTCOME_COLORS[outcome] ?? 'gray';

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  draft: 'Скрыто',
  published: 'Показано',
  cancelled: 'Отменено',
};

export const ACTIVITY_STATUS_COLORS: Record<ActivityStatus, string> = {
  draft: 'gray',
  published: 'green',
  cancelled: 'red',
};

const KIND_COLORS: Record<string, string> = {
  Служение: 'indigo',
  Семинар: 'violet',
  Сессия: 'grape',
  'Общая программа': 'blue',
  'Мастер-класс': 'teal',
  Игра: 'orange',
  Питание: 'yellow',
  Другое: 'gray',
};
const KIND_PALETTE = ['cyan', 'pink', 'lime', 'red', 'green', 'blue', 'teal', 'orange'];

/** Цвет типа мероприятия: у основных - свой, у своих типов - стабильный по названию. */
export function activityKindColor(kind: string): string {
  const label = activityKindLabel(kind);
  if (KIND_COLORS[label]) return KIND_COLORS[label];
  let h = 0;
  for (const ch of label.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return KIND_PALETTE[h % KIND_PALETTE.length]!;
}

export const REGISTRATION_MODE_LABELS: Record<RegistrationMode, string> = {
  none: 'Свободный вход',
  required: 'По записи',
};

export const REGISTRATION_STATUS_LABELS: Record<'registered' | 'waitlist' | 'cancelled', string> = {
  registered: 'Записан(а)',
  waitlist: 'Лист ожидания',
  cancelled: 'Отменил(а)',
};

export const REGISTRATION_STATUS_COLORS: Record<'registered' | 'waitlist' | 'cancelled', string> = {
  registered: 'green',
  waitlist: 'yellow',
  cancelled: 'gray',
};

/** Вид чека: взнос - без подписи (обычный), остальные - бейджем. */
export const RECEIPT_KIND_LABELS: Record<ReceiptView['kind'], string> = { fee: 'Взнос', donation: 'Пожертвование', merch: 'Мерч' };
export const RECEIPT_KIND_COLORS: Record<ReceiptView['kind'], string> = { fee: 'blue', donation: 'grape', merch: 'pink' };

export const RECEIPT_STATUS_LABELS: Record<ReceiptView['status'], string> = {
  pending: 'На проверке',
  accepted: 'Принят',
  rejected: 'Отклонён',
};

export const RECEIPT_STATUS_COLORS: Record<ReceiptView['status'], string> = {
  pending: 'yellow',
  accepted: 'green',
  rejected: 'red',
};

export const BROADCAST_STATUS_LABELS: Record<BroadcastView['status'], string> = {
  scheduled: 'Запланирована',
  sending: 'Отправляется',
  done: 'Отправлена',
  cancelled: 'Отменена',
};

export const BROADCAST_STATUS_COLORS: Record<BroadcastView['status'], string> = {
  scheduled: 'blue',
  sending: 'yellow',
  done: 'green',
  cancelled: 'gray',
};

export const SEGMENT_KIND_LABELS: Record<Segment['kind'], string> = {
  all: 'Все участники',
  unpaid: 'Не оплатили',
  not_arrived: 'Ещё не пришли',
  arrived: 'Уже пришли',
  category: 'Категория',
  activity: 'Записанные на активность',
  staff: 'Команда',
  list: 'Список',
};

export const SEGMENT_KIND_HINTS: Record<Segment['kind'], string> = {
  all: 'Всем, кто зарегистрировал хотя бы одного участника',
  unpaid: 'Тем, у кого кто-то ещё не оплатил, чек на проверке или оплачено частично',
  not_arrived: 'Тем, у кого кто-то ещё не пришёл',
  arrived: 'Тем, у кого кто-то уже пришёл',
  category: 'Тем, у кого есть участник выбранной категории',
  activity: 'Тем, у кого кто-то записан на выбранную активность',
  staff: 'Всей команде: админам, волонтёрам, организаторам',
  list: 'Тем, у кого есть участник из этого списка. Списки собирают в «Участники → Списки»',
};

export function segmentLabel(
  segment: Segment,
  activityTitle?: (id: number) => string | undefined,
  listName?: (id: number) => string | undefined,
): string {
  if (segment.kind === 'list') {
    const name = listName?.(segment.listId);
    return name ? `Список «${name}»` : 'Список (удалён)';
  }
  if (segment.kind === 'category') return `Категория: ${CATEGORY_LABELS[segment.category]}`;
  if (segment.kind === 'activity') {
    const title = activityTitle?.(segment.activityId);
    return `Записанные: ${title ?? `активность #${segment.activityId}`}`;
  }
  return SEGMENT_KIND_LABELS[segment.kind];
}

export const CONSENT_KIND_LABELS: Record<'pd' | 'photo', string> = {
  pd: 'Обработка персональных данных',
  photo: 'Фото- и видеосъёмка',
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'checkin:write': 'Отмечать гостей на входе (сканер)',
  'checkin:revoke': 'Отменять любые отметки',
  'payments:write': 'Проверять чеки и отмечать оплату, в т.ч. на месте',
  'receipts:delete': 'Удалять чеки',
  'activities:own': 'Вести свои активности: создавать, смотреть списки, отмечать',
  'activities:all': 'Всё расписание, все активности и точки отметки',
  'participants:read': 'Смотреть всю базу участников',
  'participants:write': 'Править данные участников и перевыпускать QR-коды',
  export: 'Выгружать базу в Excel',
  'broadcasts:send': 'Делать рассылки в Telegram',
  'content:write': 'Писать инфо-страницы и объявления',
  'dashboard:read': 'Смотреть сводку',
  'staff:manage': 'Управлять командой: роли, приглашения, карточки, пароли',
  'settings:write': 'Менять настройки конференции',
  'audit:read': 'Смотреть историю изменений',
  'game:manage': 'Вести игру: команды, набор, распределение, голосование',
  'money:manage': 'Все деньги: выдавать и принимать, журнал, отмена записей',
  'staff:invite_cashier': 'Приглашать кассиров',
  'merch:stock': 'Мерч: товары, размеры, количество, цены',
  'merch:sell': 'Мерч: продавать, выдавать заказы, вести долги',
  'merch:stats': 'Мерч: статистика продаж',
  'feedback:read': 'Отзывы: читать и выгружать',
};

/** Роли в «Команде»: как их называем и что они значат. Организатора больше не выдаём. */
export const TEAM_ROLE_LABELS: Record<Role, string> = {
  superadmin: 'Суперадмин',
  admin: 'Админ',
  banker: 'Банкир',
  scanner: 'Сканер (волонтёр)',
  cashier: 'Кассир',
  seller: 'Продавец мерча',
  organizer: 'Организатор',
  host: 'Ведущий',
  member: 'Участник команды',
};

export const TEAM_ROLE_HINTS: Record<Role, string> = {
  superadmin: 'Всё, что может админ, плюс команда и история изменений',
  admin: 'Вся админка: участники, расписание, рассылки, сводка, настройки',
  scanner: 'Отмечает приход в сканере - в боте или по карточке. Веб-админка ему не нужна',
  banker:
    'Все деньги: всё, что кассир, плюс выдаёт деньги и записывает любой приход и расход, видит журнал всех денег и цифры мерча, приглашает кассиров',
  seller: 'Мерч: заполняет склад (товары, размеры, количество, цены), продаёт, ведёт должников, видит статистику',
  cashier: 'Касса: принимает взносы (наличные, переводы), проверяет чеки, отмечает вход, видит список участников и все оплаты. Без правки участников и настроек',
  organizer: 'Свои активности в расписании',
  host: 'Игра: команды, набор игроков, распределение, голосование и большой экран',
  member: 'Только смотрит: сводку, отзывы и статистику мерча. Это есть у всех ролей - остальные добавляют к этому свою работу',
};

/** Какие роли можно выдать (суперадмина - только суперадмин). */
export function assignableRoles(viewerIsSuper: boolean): Role[] {
  return viewerIsSuper
    ? ['member', 'admin', 'banker', 'cashier', 'seller', 'scanner', 'host', 'superadmin']
    : ['member', 'admin', 'banker', 'cashier', 'seller', 'scanner', 'host'];
}

/** Главная роль человека (если их несколько). */
export function primaryRole(roles: readonly Role[]): Role | null {
  const order: Role[] = ['superadmin', 'admin', 'banker', 'cashier', 'seller', 'host', 'organizer', 'scanner', 'member'];
  return order.find((r) => roles.includes(r)) ?? null;
}

export const ROLE_COLORS: Record<string, string> = {
  superadmin: 'red',
  admin: 'blue',
  banker: 'orange',
  cashier: 'green',
  seller: 'teal',
  scanner: 'gray',
  organizer: 'violet',
  host: 'grape',
  member: 'cyan',
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  participant: 'Участник',
  activity: 'Активность',
  broadcast: 'Рассылка',
  check_in: 'Отметка',
  checkpoint: 'Точка отметки',
  info_page: 'Инфо-страница',
  announcement: 'Объявление',
  receipt: 'Чек',
  settings: 'Настройки',
  staff: 'Команда',
  user: 'Пользователь',
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'activity.create': 'Создана активность',
  'activity.update': 'Изменена активность',
  'activity.delete': 'Удалена активность',
  'activity.staff_enroll': 'Записал(а) волонтёр',
  'activity.staff_unenroll': 'Запись убрал(а) волонтёр',
  'announcement.create': 'Создано объявление',
  'announcement.update': 'Изменено объявление',
  'announcement.delete': 'Удалено объявление',
  'broadcast.create': 'Создана рассылка',
  'broadcast.cancel': 'Отменена рассылка',
  'checkin.revoke': 'Отменена отметка',
  'checkin.override_unpaid': 'Пропущен(а) без оплаты',
  'counseling.cancel': 'Отменена запись на душепопечение',
  'counselor.create': 'Добавлен служитель',
  'counselor.update': 'Изменён служитель',
  'counselor.delete': 'Удалён служитель',
  'checkpoint.create': 'Создана точка отметки',
  'checkpoint.update': 'Изменена точка отметки',
  'info_page.upsert': 'Сохранена инфо-страница',
  'info_page.delete': 'Удалена инфо-страница',
  'participant.create': 'Участник добавлен вручную',
  'participant.update': 'Изменены данные участника',
  'participant.self_update': 'Участник изменил свои данные',
  'participant.self_cancel': 'Участник отменил регистрацию',
  'participant.bulk.mark_paid': 'Массово: оплачено',
  'participant.bulk.mark_unpaid': 'Массово: не оплачено',
  'participant.bulk.set_category': 'Массово: категория',
  'participant.link_by_username': 'Привязан(а) по нику',
  'participant.payment_method': 'Изменён способ оплаты',
  'participant.unlink_not_me': '«Это не я» - привязка снята',
  'payment.mark_paid': 'Оплата на месте',
  'payment.undo': 'Оплата отменена',
  'question.answer': 'Ответ на вопрос',
  'chat.send': 'Сообщение участнику',
  'receipt.accept_person': 'Чек принят',
  'receipt.create': 'Прислан чек',
  'receipt.accept': 'Чек принят',
  'receipt.reject': 'Чек отклонён',
  'receipt.delete': 'Чек удалён',
  'registration.submit': 'Регистрация',
  'seminar_block.create': 'Создан поток семинаров',
  'seminar_block.update': 'Изменён поток семинаров',
  'seminar_block.delete': 'Удалён поток семинаров',
  'seminar_block.publish_rooms': 'Опубликованы залы семинаров',
  'seminar_block.registration_all': 'Выбор семинаров открыт или закрыт',
  'seminar.plan': 'Распределение семинаров',
  'seminar.publish': 'Опубликовано распределение семинаров',
  'seminar.move': 'Перенос на другой семинар',
  'seminar_topic.create': 'Добавлена тема семинара',
  'seminar_topic.update': 'Изменена тема семинара',
  'seminar_topic.delete': 'Удалена тема семинара',
  'settings.update': 'Изменены настройки',
  'staff.invite': 'Создано приглашение',
  'staff.invite_redeem': 'Принято приглашение',
  'staff.password': 'Задан пароль для входа',
  'staff.roles': 'Изменены роли',
  'staff.scanner_card': 'Создана карточка волонтёра',
  'ticket.claim': 'QR-код передан другому аккаунту',
  'ticket.reissue': 'QR-код перевыпущен',
};

export const auditActionLabel = (action: string) => AUDIT_ACTION_LABELS[action] ?? action;
export const auditEntityLabel = (entity: string) => AUDIT_ENTITY_LABELS[entity] ?? entity;

// ---------- данные для Select ----------

export const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }));
export const PAYMENT_STATUS_OPTIONS = PAYMENT_STATUSES.map((s) => ({ value: s, label: PAYMENT_STATUS_LABELS[s] }));

