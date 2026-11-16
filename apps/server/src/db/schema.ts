import type { ChatMerchItem } from '@sof/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const ref = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const inList = (column: unknown, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

// ---------- аккаунты ----------

/** Telegram-аккаунты. `tg_id` пустой у персонала без Telegram и у участников, заведённых вручную. */
export const users = pgTable('users', {
  id: id(),
  tgId: bigint('tg_id', { mode: 'number' }).unique(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  displayName: text('display_name'),
  languageCode: text('language_code'),
  phone: text('phone'),
  paymentRef: text('payment_ref').notNull().unique(),
  allowsWrite: boolean('allows_write').notNull().default(false),
  botBlocked: boolean('bot_blocked').notNull().default(false),
  awaitingReceiptUntil: ts('awaiting_receipt_until'),
  /** Какой чек ждём после кнопки в боте: 'donation' или 'merch:<id брони>'; пусто - взнос. */
  awaitingReceiptFor: text('awaiting_receipt_for'),
  /** Фото профиля из Telegram (маленькое, в закрытой папке) и когда последний раз проверяли. */
  avatar: text('avatar'),
  avatarCheckedAt: ts('avatar_checked_at'),
  /** Нажал «Задать вопрос» - следующий текст до этого времени считаем вопросом. */
  awaitingQuestionUntil: ts('awaiting_question_until'),
  /** Бот сам попросил номер («Меня уже зарегистрировали»): до этого времени отвечаем на присланный контакт. */
  awaitingContactUntil: ts('awaiting_contact_until'),
  /** Больше не используется: номера сообщений для очистки чатов теперь в chat_messages. */
  lastMessageId: bigint('last_message_id', { mode: 'number' }),
  lastTicketsSentAt: ts('last_tickets_sent_at'),
  /** Восстановлен из выгрузки участников (после сбоя хостинга), Telegram id ещё не известен. Сбрасывается, когда человек зайдёт сам. */
  restoredAt: ts('restored_at'),
  createdAt: createdAt(),
  lastSeenAt: ts('last_seen_at'),
});

/**
 * Кто заходил в бота и в Mini App: одна строка на человека, день (по часам конференции) и источник.
 * Повторные заходы за день новых строк не дают - для «сколько людей заходит каждый день» в сводке.
 */
export const userVisits = pgTable(
  'user_visits',
  {
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    source: text('source').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.source, t.userId] }),
    check('user_visits_source_ck', inList(t.source, ['bot', 'app'])),
  ],
);

// ---------- участники и билеты ----------

export const participants = pgTable(
  'participants',
  {
    id: id(),
    ownerUserId: ref('owner_user_id')
      .notNull()
      .references(() => users.id),
    holderUserId: ref('holder_user_id').references(() => users.id),
    lastName: text('last_name').notNull(),
    firstName: text('first_name').notNull(),
    middleName: text('middle_name'),
    /** У гостя, записавшегося на месте (`on_site`), даты рождения и города может не быть. */
    birthDate: date('birth_date', { mode: 'string' }),
    gender: text('gender').notNull(),
    city: text('city'),
    church: text('church'),
    phone: text('phone'),
    /** Ник в Telegram без @ - по нему бот узнаёт человека, когда тот сам придёт. */
    telegramUsername: text('telegram_username'),
    relation: text('relation').notNull().default('self'),
    category: text('category').notNull().default('participant'),
    status: text('status').notNull().default('active'),
    personKey: text('person_key').notNull(),
    /** Вариант участия (fee10 / fee35 / nofee / free); цена и цвет - в настройках. */
    tier: text('tier'),
    /** Завтрак к платному варианту - доплата из settings.breakfast, уже входит в amount_due. */
    breakfast: boolean('breakfast').notNull().default(false),
    /** Как собирается платить: transfer / cash. */
    paymentMethod: text('payment_method'),
    paymentStatus: text('payment_status').notNull().default('unpaid'),
    amountDue: numeric('amount_due', { precision: 10, scale: 2 }),
    amountPaid: numeric('amount_paid', { precision: 10, scale: 2 }).notNull().default('0'),
    paidAt: ts('paid_at'),
    paymentNote: text('payment_note'),
    arrivedAt: ts('arrived_at'),
    registeredByStaff: boolean('registered_by_staff').notNull().default(false),
    /** «Гость (на месте)»: упрощённая регистрация в день конференции - Ф.И., телефон, пол, «Только взнос». */
    onSite: boolean('on_site').notNull().default(false),
    /** Отметил(а) в анкете: готов(а) оплатить регистрацию того, у кого нет возможности (с ним свяжутся). */
    sponsorOffer: boolean('sponsor_offer').notNull().default(false),
    extra: jsonb('extra').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('participants_person_uq').on(t.ownerUserId, t.personKey).where(sql`${t.status} <> 'cancelled'`),
    index('participants_owner_idx').on(t.ownerUserId),
    index('participants_holder_idx').on(t.holderUserId),
    index('participants_person_key_idx').on(t.personKey),
    index('participants_tg_username_idx').on(sql`lower(${t.telegramUsername})`),
    check('participants_tier_ck', sql`${t.tier} is null or ${t.tier} in ('fee10', 'fee35', 'nofee', 'free')`),
    check('participants_pay_method_ck', sql`${t.paymentMethod} is null or ${t.paymentMethod} in ('transfer', 'cash')`),
    check('participants_gender_ck', inList(t.gender, ['m', 'f'])),
    check('participants_status_ck', inList(t.status, ['active', 'cancelled'])),
    check(
      'participants_category_ck',
      inList(t.category, ['participant', 'child', 'volunteer', 'speaker', 'organizer', 'guest']),
    ),
    check('participants_payment_ck', inList(t.paymentStatus, ['unpaid', 'pending', 'paid', 'partial', 'exempt'])),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    participantId: ref('participant_id')
      .notNull()
      .references(() => participants.id),
    code: text('code').notNull().unique(),
    webToken: text('web_token').notNull().unique(),
    status: text('status').notNull().default('active'),
    revokedReason: text('revoked_reason'),
    imageFileId: text('image_file_id'),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('tickets_one_active_uq').on(t.participantId).where(sql`${t.status} = 'active'`),
    check('tickets_status_ck', inList(t.status, ['active', 'revoked'])),
  ],
);

export const consents = pgTable('consents', {
  id: id(),
  participantId: ref('participant_id')
    .notNull()
    .references(() => participants.id),
  givenByUserId: ref('given_by_user_id')
    .notNull()
    .references(() => users.id),
  kind: text('kind').notNull(),
  documentVersion: text('document_version').notNull(),
  givenAt: ts('given_at').notNull().defaultNow(),
});

export const registrationRequests = pgTable('registration_requests', {
  idempotencyKey: uuid('idempotency_key').primaryKey(),
  userId: ref('user_id')
    .notNull()
    .references(() => users.id),
  payloadSha256: text('payload_sha256').notNull(),
  result: jsonb('result'),
  createdAt: createdAt(),
});

export const paymentReceipts = pgTable(
  'payment_receipts',
  {
    id: id(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    participantIds: bigint('participant_ids', { mode: 'number' }).array().notNull(),
    /** fee - взнос за людей из participantIds; donation - пожертвование; merch - оплата брони мерча. */
    kind: text('kind').notNull().default('fee'),
    merchOrderId: ref('merch_order_id').references((): AnyPgColumn => merchOrders.id, { onDelete: 'set null' }),
    /** Файл в Telegram; у чека из приложения его нет - только наша копия. */
    fileId: text('file_id'),
    fileUniqueId: text('file_unique_id'),
    /** Копия файла у нас (закрытая папка): Telegram может его и потерять. */
    storedFile: text('stored_file'),
    fileKind: text('file_kind').notNull(),
    mimeType: text('mime_type'),
    comment: text('comment'),
    status: text('status').notNull().default('pending'),
    reviewedBy: ref('reviewed_by').references(() => users.id),
    reviewedAt: ts('reviewed_at'),
    rejectReason: text('reject_reason'),
    /** Сумма чека: у принятого - сколько по нему зачли, у отклонённого - сколько должно было быть. На проверке - пусто (считаем на лету). */
    amount: numeric('amount', { precision: 10, scale: 2 }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('payment_receipts_file_uq').on(t.userId, t.fileUniqueId),
    index('payment_receipts_status_idx').on(t.status),
    check('payment_receipts_status_ck', inList(t.status, ['draft', 'pending', 'accepted', 'rejected'])),
    check('payment_receipts_kind_ck', inList(t.kind, ['fee', 'donation', 'merch'])),
  ],
);

/** Остальные файлы чека (первый - в payment_receipts): несколько переводов одним чеком. */
export const paymentReceiptFiles = pgTable(
  'payment_receipt_files',
  {
    id: id(),
    receiptId: ref('receipt_id')
      .notNull()
      .references(() => paymentReceipts.id, { onDelete: 'cascade' }),
    fileId: text('file_id'),
    fileUniqueId: text('file_unique_id'),
    fileKind: text('file_kind').notNull(),
    mimeType: text('mime_type'),
    storedFile: text('stored_file'),
    createdAt: createdAt(),
  },
  (t) => [unique('payment_receipt_files_uq').on(t.receiptId, t.fileUniqueId), index('payment_receipt_files_receipt_idx').on(t.receiptId)],
);

/**
 * Журнал оплат: каждое зачисление - строка (касса на месте, админка, принятый чек перевода).
 * Итог у участника - `participants.amount_paid`; здесь - из чего он сложился: сколько, чем, кто принял, когда.
 * Отменённый приём остаётся в журнале с `undone_at` и в суммы не идёт.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    /** Пожертвование без QR-кода - без участника (тогда - имя в `donor_name`, если назвали). */
    participantId: ref('participant_id').references(() => participants.id, { onDelete: 'cascade' }),
    /**
     * fee - взнос (сходится с `participants.amount_paid`), donation - пожертвование сверх взноса,
     * merch - оплата мерча (заказ - `merch_order_id`), income - прочий приход, payout - выдача денег (расход).
     */
    kind: text('kind').notNull().default('fee'),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    method: text('method').notNull(),
    /** Кто дал или кому выдали, если это не участник: имя жертвователя, получатель выдачи, от кого приход. */
    donorName: text('donor_name'),
    comment: text('comment'),
    /** На что: категория выдачи или прихода («закупки», «аренда»…). */
    category: text('category'),
    /**
     * desk - приём оплаты (касса, «Принять оплату» в админке), receipt - принятый чек, manual - правка суммы в админке,
     * money - выдача или приход, записанные банкиром, merch - оплата мерча.
     */
    source: text('source').notNull(),
    merchOrderId: ref('merch_order_id').references((): AnyPgColumn => merchOrders.id, { onDelete: 'set null' }),
    receiptId: ref('receipt_id').references(() => paymentReceipts.id, { onDelete: 'set null' }),
    acceptedBy: ref('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    undoneAt: ts('undone_at'),
    undoneBy: ref('undone_by').references(() => users.id, { onDelete: 'set null' }),
    /** Почему отменили (банкир отменяет любую запись - с причиной). */
    undoReason: text('undo_reason'),
  },
  (t) => [
    index('payments_participant_idx').on(t.participantId),
    index('payments_merch_order_idx').on(t.merchOrderId),
    index('payments_accepted_by_idx').on(t.acceptedBy),
    index('payments_created_idx').on(t.createdAt),
    check('payments_method_ck', inList(t.method, ['cash', 'card', 'transfer'])),
    check('payments_source_ck', inList(t.source, ['desk', 'receipt', 'manual', 'money', 'merch'])),
    check('payments_kind_ck', inList(t.kind, ['fee', 'donation', 'merch', 'income', 'payout'])),
    // Взнос всегда чей-то; остальное может быть и без участника.
    check('payments_fee_person_ck', sql`${t.kind} <> 'fee' or ${t.participantId} is not null`),
  ],
);

// ---------- расписание и активности ----------

/** Справочник залов: заводятся один раз, выбираются в мероприятиях и блоках семинаров. */
export const rooms = pgTable(
  'rooms',
  {
    id: id(),
    name: text('name').notNull(),
    capacity: integer('capacity').notNull(),
    /** Подсказка: этаж, как пройти. */
    note: text('note'),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [check('rooms_capacity_ck', sql`${t.capacity} > 0`), uniqueIndex('rooms_name_uq').on(sql`lower(${t.name})`)],
);

/**
 * Блок семинаров («Семинар 1», 17:00): несколько тем в одно время, у блока - свой набор залов.
 * Темы - обычные мероприятия с block_id. Залы темам раздаются по числу записавшихся и публикуются админом.
 */
export const seminarBlocks = pgTable(
  'seminar_blocks',
  {
    id: id(),
    title: text('title').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    /** Свой выключатель записи: можно открыть первый блок, не открывая второй. */
    registrationOpen: boolean('registration_open').notNull().default(false),
    /** Когда залы последний раз опубликованы; до этого участники зала не видят. */
    roomsPublishedAt: ts('rooms_published_at'),
    /** Скрыт от участников целиком (темы сохраняют свой статус и вернутся как были). */
    hidden: boolean('hidden').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [check('seminar_blocks_time_ck', sql`${t.endsAt} >= ${t.startsAt}`)],
);

export const seminarBlockRooms = pgTable(
  'seminar_block_rooms',
  {
    blockId: ref('block_id')
      .notNull()
      .references(() => seminarBlocks.id, { onDelete: 'cascade' }),
    roomId: ref('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.blockId, t.roomId] })],
);

/** Тема семинара: одна на все потоки. В каждом потоке у неё свой сеанс - мероприятие с block_id и topic_id. */
export const seminarTopics = pgTable('seminar_topics', {
  id: id(),
  title: text('title').notNull(),
  host: text('host'),
  description: text('description'),
  /** Скрыта от участников: за неё не голосуют. */
  hidden: boolean('hidden').notNull().default(false),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
});

/** Голос участника за тему: сколько тем выбрать - столько, сколько потоков. */
export const seminarVotes = pgTable(
  'seminar_votes',
  {
    participantId: ref('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    topicId: ref('topic_id')
      .notNull()
      .references(() => seminarTopics.id, { onDelete: 'cascade' }),
    userId: ref('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.participantId, t.topicId] }), index('seminar_votes_topic_idx').on(t.topicId)],
);

export const activities = pgTable(
  'activities',
  {
    id: id(),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    host: text('host'),
    kind: text('kind').notNull().default('other'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    registrationMode: text('registration_mode').notNull().default('none'),
    capacity: integer('capacity'),
    waitlistEnabled: boolean('waitlist_enabled').notNull().default(true),
    registrationOpensAt: ts('registration_opens_at'),
    registrationClosesAt: ts('registration_closes_at'),
    minAge: integer('min_age'),
    maxAge: integer('max_age'),
    status: text('status').notNull().default('published'),
    /** Питание (breakfast / lunch / dinner): тем, у кого оно есть, - личное напоминание. */
    meal: text('meal'),
    /** Зал из справочника (у тем семинаров - опубликованный зал). Текст location остаётся для показа. */
    roomId: ref('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    /** Тема блока семинаров. */
    blockId: ref('block_id').references(() => seminarBlocks.id, { onDelete: 'set null' }),
    /** Зал, который админ поставил теме вручную до публикации (иначе бот предлагает сам). */
    plannedRoomId: ref('planned_room_id').references(() => rooms.id, { onDelete: 'set null' }),
    /** Сеанс темы семинара в потоке (block_id). */
    topicId: ref('topic_id').references(() => seminarTopics.id, { onDelete: 'set null' }),
    createdBy: ref('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('activities_starts_idx').on(t.startsAt),
    index('activities_block_idx').on(t.blockId),
    index('activities_topic_idx').on(t.topicId),
    check('activities_mode_ck', inList(t.registrationMode, ['none', 'required'])),
    check('activities_status_ck', inList(t.status, ['draft', 'published', 'cancelled'])),
    check('activities_capacity_ck', sql`${t.capacity} is null or ${t.capacity} > 0`),
    check('activities_time_ck', sql`${t.endsAt} >= ${t.startsAt}`),
    check('activities_meal_ck', sql`${t.meal} is null or ${t.meal} in ('breakfast', 'lunch', 'dinner')`),
  ],
);

export const activityRegistrations = pgTable(
  'activity_registrations',
  {
    id: id(),
    activityId: ref('activity_id')
      .notNull()
      .references(() => activities.id),
    participantId: ref('participant_id')
      .notNull()
      .references(() => participants.id),
    status: text('status').notNull(),
    queuedAt: ts('queued_at').notNull().default(sql`clock_timestamp()`),
    updatedAt: updatedAt(),
    registeredBy: ref('registered_by').references(() => users.id),
    /** Поставило распределение семинаров; ручные переносы админа - false. */
    planned: boolean('planned').notNull().default(false),
  },
  (t) => [
    unique('activity_registrations_uq').on(t.activityId, t.participantId),
    index('activity_registrations_queue_idx').on(t.activityId, t.status, t.queuedAt, t.id),
    check('activity_registrations_status_ck', inList(t.status, ['registered', 'waitlist', 'cancelled'])),
  ],
);

export const activityInterest = pgTable(
  'activity_interest',
  {
    activityId: ref('activity_id')
      .notNull()
      .references(() => activities.id),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.activityId, t.userId] })],
);

// ---------- душепопечение ----------

/** Служитель: сидит в своём месте, время делится на окошки по slot_minutes, к нему приходят по записи. */
export const counselors = pgTable(
  'counselors',
  {
    id: id(),
    name: text('name').notNull(),
    /** Подпись места; если совпала с залом из справочника - и ссылка на зал. */
    place: text('place'),
    roomId: ref('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    slotMinutes: integer('slot_minutes').notNull().default(20),
    /** Скрыт от участников (в расписании и записи); записи остаются. */
    hidden: boolean('hidden').notNull().default(false),
    /** Кого принимает: all - всех, f - только девушек, m - только парней (проверяем при записи). */
    audience: text('audience').notNull().default('all'),
    /** Свои метки - просто подпись у служителя («на русском», «для пар»). */
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('counselors_time_ck', sql`${t.endsAt} > ${t.startsAt}`),
    check('counselors_slot_ck', sql`${t.slotMinutes} between 5 and 240`),
    check('counselors_audience_ck', sql`${t.audience} in ('all', 'f', 'm')`),
  ],
);

/** Запись на окошко. Окошко - одному человеку, у человека - одна запись. */
export const counselingBookings = pgTable(
  'counseling_bookings',
  {
    id: id(),
    counselorId: ref('counselor_id')
      .notNull()
      .references(() => counselors.id, { onDelete: 'cascade' }),
    slotStart: ts('slot_start').notNull(),
    participantId: ref('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    bookedBy: ref('booked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('counseling_bookings_slot_uq').on(t.counselorId, t.slotStart),
    unique('counseling_bookings_participant_uq').on(t.participantId),
  ],
);

// ---------- check-in ----------

export const checkpoints = pgTable(
  'checkpoints',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    activityId: ref('activity_id').references(() => activities.id),
    day: date('day', { mode: 'string' }),
    isActive: boolean('is_active').notNull().default(true),
    countsInStats: boolean('counts_in_stats').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('checkpoints_kind_ck', inList(t.kind, ['entrance', 'activity', 'meal', 'training']))],
);

export const checkIns = pgTable(
  'check_ins',
  {
    id: id(),
    checkpointId: integer('checkpoint_id')
      .notNull()
      .references(() => checkpoints.id),
    participantId: ref('participant_id')
      .notNull()
      .references(() => participants.id),
    /** Генерируется клиентом на каждую отметку и никогда не переиспользуется. */
    clientEventId: uuid('client_event_id').notNull().unique(),
    scannedBy: ref('scanned_by')
      .notNull()
      .references(() => users.id),
    deviceId: text('device_id'),
    /** Время на устройстве - только для показа, порядок определяет сервер. */
    clientTs: ts('client_ts'),
    method: text('method').notNull().default('scan'),
    offline: boolean('offline').notNull().default(false),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
    revokedBy: ref('revoked_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('check_ins_once').on(t.checkpointId, t.participantId).where(sql`${t.revokedAt} is null`),
    index('check_ins_participant_idx').on(t.participantId),
    index('check_ins_created_idx').on(t.createdAt),
  ],
);

export const scanLog = pgTable(
  'scan_log',
  {
    id: id(),
    clientEventId: uuid('client_event_id'),
    checkpointId: integer('checkpoint_id').references(() => checkpoints.id),
    rawCode: text('raw_code'),
    participantId: ref('participant_id').references(() => participants.id),
    outcome: text('outcome').notNull(),
    staffUserId: ref('staff_user_id').references(() => users.id),
    deviceId: text('device_id'),
    clientTs: ts('client_ts'),
    createdAt: createdAt(),
  },
  (t) => [index('scan_log_created_idx').on(t.createdAt), index('scan_log_outcome_idx').on(t.outcome)],
);

// ---------- персонал ----------

export const staffRoles = pgTable(
  'staff_roles',
  {
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    grantedBy: ref('granted_by').references(() => users.id),
    grantedAt: ts('granted_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    check('staff_roles_role_ck', inList(t.role, ['superadmin', 'admin', 'banker', 'cashier', 'seller', 'scanner', 'organizer', 'host', 'member'])),
  ],
);

/** Одноразовые (или ограниченные) токены: инвайты, передача билета, вход в админку, карточки сканера. */
export const oneTimeTokens = pgTable(
  'one_time_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    purpose: text('purpose').notNull(),
    payload: jsonb('payload').notNull().default({}),
    userId: ref('user_id').references(() => users.id),
    createdBy: ref('created_by').references(() => users.id),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    lastUsedBy: ref('last_used_by').references(() => users.id),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    check(
      'one_time_tokens_purpose_ck',
      inList(t.purpose, ['staff_invite', 'ticket_claim', 'admin_login', 'scanner_card']),
    ),
  ],
);

export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    userAgent: text('user_agent'),
  },
  (t) => [index('staff_sessions_user_idx').on(t.userId)],
);

export const adminCredentials = pgTable('admin_credentials', {
  userId: ref('user_id')
    .primaryKey()
    .references(() => users.id),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret').notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: ts('locked_until'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------- контент и рассылки ----------

export const infoPages = pgTable('info_pages', {
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  bodyMd: text('body_md').notNull().default(''),
  sort: integer('sort').notNull().default(0),
  published: boolean('published').notNull().default(true),
  updatedAt: updatedAt(),
  updatedBy: ref('updated_by').references(() => users.id),
});

export const announcements = pgTable('announcements', {
  id: id(),
  title: text('title').notNull(),
  bodyMd: text('body_md').notNull().default(''),
  pinned: boolean('pinned').notNull().default(false),
  published: boolean('published').notNull().default(true),
  createdBy: ref('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Одноразовые ключи: «это уже сделано». Защищают от повторов там, где очередь задач их не ловит:
 * напоминание за 15 минут и приветствие на входе уходят один раз, повторная отправка кассы не удваивает оплату.
 */
export const onceKeys = pgTable(
  'once_keys',
  {
    key: text('key').primaryKey(),
    createdAt: createdAt(),
  },
  (t) => [index('once_keys_created_idx').on(t.createdAt)],
);

/**
 * Номера сообщений в личных чатах с ботом (входящих и исходящих) за последние двое суток.
 * Telegram даёт боту удалять только сообщения моложе 48 часов - по этому списку «Очистить всю базу»
 * удаляет переписку точно, не задевая старые сообщения (из-за них Telegram отклоняет всю пачку).
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.messageId] }), index('chat_messages_at_idx').on(t.at)],
);

/**
 * Какие сообщения с QR-кодом участника лежат в каком чате. Когда данные поменялись или код перевыпущен,
 * бот присылает новый QR, а у прежнего снимает закрепление и подписывает «актуальный - ниже».
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    participantId: ref('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    ticketId: ref('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.messageId] }), index('ticket_messages_participant_idx').on(t.participantId)],
);

/** Вопросы участников организаторам: задают в боте или приложении, отвечают в админке - ответ уходит в бот. */
export const questions = pgTable(
  'questions',
  {
    id: id(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    answer: text('answer'),
    answeredAt: ts('answered_at'),
    answeredBy: ref('answered_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('questions_user_idx').on(t.userId), index('questions_open_idx').on(t.createdAt).where(sql`${t.answeredAt} is null`)],
);

/** Переписка участника с организаторами: сообщения обеих сторон, картинки - только от команды. */
export const supportMessages = pgTable(
  'support_messages',
  {
    id: id(),
    /** С кем переписка (участник). */
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromStaff: boolean('from_staff').notNull(),
    /** Кто из команды написал. */
    authorId: ref('author_id').references(() => users.id, { onDelete: 'set null' }),
    text: text('text'),
    /** Картинка в закрытой папке (chat/<хеш>.webp), рядом превью -s.webp. */
    photo: text('photo'),
    /** Доставка в бот сообщения команды: null - ещё отправляем. */
    delivery: text('delivery'),
    /** Заявка на бронь мерча из приложения (остатки не трогает): вещи, как их видел участник. */
    merchItems: jsonb('merch_items').$type<ChatMerchItem[]>(),
    /** Бронь, которую продавец сделал по этой заявке. */
    merchOrderId: ref('merch_order_id').references((): AnyPgColumn => merchOrders.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('support_messages_user_idx').on(t.userId, t.id),
    check('support_messages_body_ck', sql`${t.text} is not null or ${t.photo} is not null`),
    check('support_messages_delivery_ck', sql`${t.delivery} is null or ${t.delivery} in ('sent', 'blocked', 'unreachable', 'no_telegram')`),
  ],
);

/** Что прочитано в переписке: номер последнего прочитанного сообщения командой и участником. */
export const supportThreads = pgTable('support_threads', {
  userId: ref('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  staffReadId: bigint('staff_read_id', { mode: 'number' }).notNull().default(0),
  userReadId: bigint('user_read_id', { mode: 'number' }).notNull().default(0),
  /** Команда отметила «непрочитанным» - висит в непрочитанных, пока переписку снова не откроют. */
  markedUnread: boolean('marked_unread').notNull().default(false),
  /** Отметка команды: important / wait / money / later / done (см. CHAT_MARKS). */
  mark: text('mark'),
  /** Папка: merch - про мерч (кнопка в разделе «Мерч» или слова про мерч); продавцы видят только её. */
  topic: text('topic'),
});

/** Нагрузка по часам: сколько запросов пришло в бота и в Mini App (счётчик копится в памяти и сбрасывается раз в 30 с). */
export const trafficHourly = pgTable(
  'traffic_hourly',
  {
    hour: ts('hour').notNull(),
    source: text('source').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'traffic_hourly_pk', columns: [t.hour, t.source] }), check('traffic_hourly_source_ck', inList(t.source, ['bot', 'app']))],
);

/** Нагрузка по людям: запросы каждого в бота и в Mini App по часам - видно, кто «флудит». Старше 15 дней удаляем. */
export const trafficUsers = pgTable(
  'traffic_users',
  {
    hour: ts('hour').notNull(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'traffic_users_pk', columns: [t.hour, t.userId, t.source] }), check('traffic_users_source_ck', inList(t.source, ['bot', 'app']))],
);

/** Список участников, собранный командой вручную (например, «Россияне») - для рассылок. */
export const participantLists = pgTable(
  'participant_lists',
  {
    id: id(),
    name: text('name').notNull(),
    createdBy: ref('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('participant_lists_name_uq').on(sql`lower(${t.name})`)],
);

export const participantListMembers = pgTable(
  'participant_list_members',
  {
    listId: ref('list_id')
      .notNull()
      .references(() => participantLists.id, { onDelete: 'cascade' }),
    participantId: ref('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    addedBy: ref('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.participantId] }), index('participant_list_members_participant_idx').on(t.participantId)],
);

export const broadcasts = pgTable(
  'broadcasts',
  {
    id: id(),
    text: text('text').notNull(),
    segment: jsonb('segment').notNull(),
    status: text('status').notNull().default('scheduled'),
    isTest: boolean('is_test').notNull().default(false),
    scheduledAt: ts('scheduled_at'),
    createdBy: ref('created_by').references(() => users.id),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    total: integer('total').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    blocked: integer('blocked').notNull().default(0),
  },
  (t) => [check('broadcasts_status_ck', inList(t.status, ['scheduled', 'sending', 'done', 'cancelled']))],
);

/** Журнал сообщений бота: каждая отправка - строка (вид, запуск, к чему относится, дошло ли, начало текста). */
export const botMessages = pgTable(
  'bot_messages',
  {
    id: id(),
    userId: ref('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Имя задачи бота или вид из notify.text: «merch.confirm_ask», «counseling.reminder». */
    kind: text('kind').notNull(),
    /** Один запуск массовой отправки (одна задача - многим); у сообщений «по одному» пусто. */
    campaign: text('campaign'),
    /** К чему относится: «order:25», «booking:12». */
    ref: text('ref'),
    /** sent / blocked / unreachable / no_telegram / failed. */
    outcome: text('outcome').notNull(),
    error: text('error'),
    preview: text('preview'),
    createdAt: createdAt(),
  },
  (t) => [index('bot_messages_created_idx').on(t.createdAt), index('bot_messages_campaign_idx').on(t.campaign), index('bot_messages_user_idx').on(t.userId, t.createdAt)],
);

export const broadcastDeliveries = pgTable(
  'broadcast_deliveries',
  {
    broadcastId: ref('broadcast_id')
      .notNull()
      .references(() => broadcasts.id),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    sentAt: ts('sent_at'),
  },
  (t) => [
    primaryKey({ columns: [t.broadcastId, t.userId] }),
    index('broadcast_deliveries_pending_idx').on(t.broadcastId, t.status),
  ],
);

// ---------- служебное ----------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
  updatedBy: ref('updated_by').references(() => users.id),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorUserId: ref('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entity, t.entityId), index('audit_log_created_idx').on(t.createdAt)],
);

// ---------- мерч ----------

/** Вещь в витрине мерча. Цена одна на все цвета и размеры. */
export const merchProducts = pgTable('merch_products', {
  id: id(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  descriptionMd: text('description_md').notNull().default(''),
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  /** Плашка на карточке: «NEW», «Limited». */
  badge: text('badge'),
  sort: integer('sort').notNull().default(0),
  published: boolean('published').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const merchColors = pgTable(
  'merch_colors',
  {
    id: id(),
    productId: ref('product_id')
      .notNull()
      .references(() => merchProducts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hex: text('hex').notNull(),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [index('merch_colors_product_idx').on(t.productId)],
);

/** Размер в цвете: `stock` - сколько штук всего (свободно = stock − в заказах). */
export const merchVariants = pgTable(
  'merch_variants',
  {
    id: id(),
    colorId: ref('color_id')
      .notNull()
      .references(() => merchColors.id, { onDelete: 'cascade' }),
    size: text('size').notNull(),
    stock: integer('stock').notNull().default(0),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('merch_variants_uq').on(t.colorId, t.size), check('merch_variants_stock_ck', sql`${t.stock} >= 0`)],
);

/** Фото, 3D-модели и 360°. Без цвета - общие для всех цветов. Файл - путь в папке медиа (merch/<хеш>.webp|.glb|.spin). */
export const merchMedia = pgTable(
  'merch_media',
  {
    id: id(),
    productId: ref('product_id')
      .notNull()
      .references(() => merchProducts.id, { onDelete: 'cascade' }),
    colorId: ref('color_id').references(() => merchColors.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    file: text('file').notNull(),
    thumb: text('thumb'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes').notNull(),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('merch_media_product_idx').on(t.productId), check('merch_media_kind_ck', inList(t.kind, ['photo', 'model', 'spin']))],
);

/** Заказ (бронь) мерча. Код - для выдачи на конференции. */
export const merchOrders = pgTable(
  'merch_orders',
  {
    id: id(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id),
    code: text('code').notNull().unique(),
    /** Ключ запроса из приложения: повтор (двойное нажатие, плохая связь) вернёт тот же заказ. */
    requestId: uuid('request_id').unique(),
    /** reserved → paid → issued; owed - выдан в долг (оплачено меньше суммы). */
    status: text('status').notNull().default('reserved'),
    total: numeric('total', { precision: 10, scale: 2 }).notNull(),
    /** Сколько уже внесено (долг гасится частями); у оплаченных - вся сумма. */
    paidAmount: numeric('paid_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    /** Покупатель при продаже на месте: участник из базы или имя и телефон (обязателен при долге). */
    buyerParticipantId: ref('buyer_participant_id').references(() => participants.id, { onDelete: 'set null' }),
    buyerName: text('buyer_name'),
    buyerPhone: text('buyer_phone'),
    paymentMethod: text('payment_method'),
    /** Бронь без оплаты снимается в это время; пусто - держим до конференции. */
    expiresAt: ts('expires_at'),
    /** Чек перевода - в закрытой папке, отдаётся только админке. */
    receiptFile: text('receipt_file'),
    receiptMime: text('receipt_mime'),
    receiptAt: ts('receipt_at'),
    note: text('note'),
    paidAt: ts('paid_at'),
    paidBy: ref('paid_by').references(() => users.id),
    issuedAt: ts('issued_at'),
    issuedBy: ref('issued_by').references(() => users.id),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    /** Спросили в боте «точно заберёте?» (время - в настройках мерча); не ответили до `confirmBy` - бронь снимается. */
    confirmAskedAt: ts('confirm_asked_at'),
    confirmBy: ts('confirm_by'),
    /** Без снятия брони: бронь команды или подтверждённая раньше - только напоминаем. */
    confirmSoft: boolean('confirm_soft').notNull().default(false),
    confirmedAt: ts('confirmed_at'),
    /** Бронь сделал кто-то из команды (по заявке в переписке) - «точно заберёте?» такой брони бот не задаёт. */
    reservedBy: ref('reserved_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('merch_orders_user_idx').on(t.userId),
    index('merch_orders_status_idx').on(t.status),
    check('merch_orders_status_ck', inList(t.status, ['reserved', 'paid', 'issued', 'owed', 'cancelled', 'expired'])),
    check('merch_orders_method_ck', sql`${t.paymentMethod} is null or ${t.paymentMethod} in ('cash', 'card', 'transfer')`),
  ],
);

export const merchOrderItems = pgTable(
  'merch_order_items',
  {
    id: id(),
    orderId: ref('order_id')
      .notNull()
      .references(() => merchOrders.id, { onDelete: 'cascade' }),
    variantId: ref('variant_id')
      .notNull()
      .references(() => merchVariants.id),
    qty: integer('qty').notNull(),
    /** Цена за штуку и подпись на момент заказа: «Худи - чёрный, M». */
    price: numeric('price', { precision: 10, scale: 2 }).notNull(),
    title: text('title').notNull(),
  },
  (t) => [
    index('merch_order_items_order_idx').on(t.orderId),
    index('merch_order_items_variant_idx').on(t.variantId),
    check('merch_order_items_qty_ck', sql`${t.qty} > 0`),
  ],
);

// ---------- отзывы ----------

/** Отзыв о конференции из приложения. Анонимный - в админке без автора (аккаунт храним: «уже оставлял»). */
export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    text: text('text').notNull(),
    anonymous: boolean('anonymous').notNull().default(true),
    /** Подпись, если не анонимно: имя, можно со ссылкой на соцсеть. */
    signature: text('signature'),
    starred: boolean('starred').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('feedback_created_idx').on(t.createdAt),
    index('feedback_user_idx').on(t.userId),
    check('feedback_category_ck', inList(t.category, ['testimony', 'review', 'suggestion'])),
  ],
);

// ---------- игра «Церкви» ----------

/** Одна строка: настройки игры и её состояние (запись открыта, распределили, итоги показаны). */
export const gameState = pgTable('game_state', {
  id: integer('id').primaryKey().default(1),
  config: jsonb('config').notNull(),
  signupOpen: boolean('signup_open').notNull().default(false),
  distributedAt: ts('distributed_at'),
  designLocked: boolean('design_locked').notNull().default(false),
  resultsShown: boolean('results_shown').notNull().default(false),
  /** Секретная часть ссылки на большой экран (без входа). */
  screenToken: text('screen_token').notNull(),
  /** «Начать игру»: запись и оформление закрыты, на экране - заставка игры. */
  startedAt: ts('started_at'),
  /** «Показать задания»: команды видят своё задание, страну и флаг. */
  tasksRevealedAt: ts('tasks_revealed_at'),
  /** Кто сейчас выступает - его флаг и задание на большом экране. */
  stageTeamId: ref('stage_team_id').references((): AnyPgColumn => gameTeams.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

/** Задание команде: пишут заранее; со страной - выбрал страну, получил это задание. */
export const gameTasks = pgTable('game_tasks', {
  id: id(),
  title: text('title').notNull(),
  /** Контекст: в какой ситуации церковь (видят вместе с заданием). */
  context: text('context').notNull().default(''),
  text: text('text').notNull().default(''),
  countryCode: text('country_code'),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const gameTeams = pgTable(
  'game_teams',
  {
    id: id(),
    sort: integer('sort').notNull().default(0),
    /** null - заглушка «Команда N», пока капитан не придумал название. */
    name: text('name'),
    countryCode: text('country_code'),
    /** Флаг по умолчанию - из страны; можно поставить свой эмодзи. */
    flag: text('flag'),
    color: text('color').notNull(),
    captainId: ref('captain_id').references(() => participants.id, { onDelete: 'set null' }),
    /** Предложение капитана, ждущее одобрения ведущего (если включена проверка названий). */
    proposal: jsonb('proposal'),
    /** Задание команды: одно задание - одной команде. */
    taskId: ref('task_id').references(() => gameTasks.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('game_teams_sort_idx').on(t.sort), uniqueIndex('game_teams_task_uq').on(t.taskId).where(sql`${t.taskId} is not null`)],
);

export const gamePlayers = pgTable(
  'game_players',
  {
    participantId: ref('participant_id')
      .primaryKey()
      .references(() => participants.id, { onDelete: 'cascade' }),
    answer: text('answer').notNull(),
    teamId: ref('team_id').references(() => gameTeams.id, { onDelete: 'set null' }),
    answeredAt: ts('answered_at').notNull().defaultNow(),
    assignedAt: ts('assigned_at'),
  },
  (t) => [index('game_players_team_idx').on(t.teamId), check('game_players_answer_ck', inList(t.answer, ['yes', 'no']))],
);

/** Раунд голосования: за одну команду (после её выступления) или общий (team_id null - общий запас). */
export const gameRounds = pgTable(
  'game_rounds',
  {
    id: id(),
    teamId: ref('team_id').references(() => gameTeams.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('open'),
    openedAt: ts('opened_at').notNull().defaultNow(),
    closesAt: ts('closes_at'),
    closedAt: ts('closed_at'),
    openedBy: ref('opened_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('game_rounds_status_ck', inList(t.status, ['open', 'closed'])),
    // Открытый раунд - один на всю игру.
    uniqueIndex('game_rounds_one_open_uq').on(t.status).where(sql`${t.status} = 'open'`),
  ],
);

/** Голос аккаунта Telegram: сколько «человек» отправил в команду в этом раунде. */
export const gameVotes = pgTable(
  'game_votes',
  {
    id: id(),
    roundId: ref('round_id')
      .notNull()
      .references(() => gameRounds.id, { onDelete: 'cascade' }),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    teamId: ref('team_id')
      .notNull()
      .references(() => gameTeams.id, { onDelete: 'cascade' }),
    points: integer('points').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('game_votes_uq').on(t.roundId, t.userId, t.teamId),
    index('game_votes_team_idx').on(t.teamId),
    check('game_votes_points_ck', sql`${t.points} > 0`),
  ],
);
