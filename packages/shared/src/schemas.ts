import { z } from 'zod';
import { ROLES } from './permissions.ts';
import {
  GENDERS,
  RELATIONS,
  CATEGORIES,
  PAYMENT_STATUSES,
  PARTICIPANT_STATUSES,
  ACTIVITY_STATUSES,
  MEALS,
  FEEDBACK_CATEGORIES,
  REGISTRATION_MODES,
  CHECKPOINT_KINDS,
  CHECKIN_METHODS,
  PAYMENT_METHODS,
  COUNSELOR_AUDIENCES,
  TIERS,
  REG_PAYMENT_METHODS,
  DEFAULT_TIERS,
  BRACELETS,
  isFreeTier,
  DEFAULT_BREAKFAST,
  CONSENT_VERSION,
  normalizePhone,
  normalizeTelegramUsername,
} from './enums.ts';

// ---------- общие примитивы ----------

const name = z.string().trim().min(1).max(60);
const optionalText = (max: number) => z.string().trim().max(max).nullish();
const isoDateTime = z.iso.datetime({ offset: true });
const money = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, 'Сумма в формате 1234.50');

// ---------- регистрация ----------

/** Любой номер (бывают иностранные) → `+375291234567`. */
const phoneField = z
  .string()
  .trim()
  .max(30)
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Проверьте номер телефона' });
      return z.NEVER;
    }
    return n;
  });

const telegramUsernameField = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const n = normalizeTelegramUsername(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Ник - латиница, цифры и _, например @ivan_petrov' });
      return z.NEVER;
    }
    return n;
  });

const churchField = z.string().trim().min(1).max(120);

/** Дата рождения: не из будущего и не раньше 1900 года (клиент проверяет то же, сервер - на всякий случай). */
const birthDateField = z.iso
  .date()
  .refine((d) => d >= '1900-01-01' && d <= new Date().toISOString().slice(0, 10), { message: 'Проверьте дату рождения' });

/** Без межполевых проверок - чтобы можно было .partial()/.extend(). */
export const participantBaseSchema = z.object({
  lastName: name,
  firstName: name,
  middleName: optionalText(60),
  birthDate: birthDateField,
  gender: z.enum(GENDERS),
  /** Населённый пункт */
  city: z.string().trim().min(1).max(80),
  church: churchField,
  phone: phoneField,
  relation: z.enum(RELATIONS),
  tier: z.enum(TIERS),
  /** Завтрак к варианту (+цена завтрака). Без default: в правке «не прислали» ≠ «сняли». К «Без взноса» сервер его не ставит. */
  breakfast: z.boolean().optional(),
  paymentMethod: z.enum(REG_PAYMENT_METHODS).nullish(),
  /** Ник в Telegram - по нему бот узнает человека, когда тот сам зайдёт. */
  telegramUsername: telegramUsernameField,
});

/**
 * Вариант «с завтраком» (fee45) стал галочкой у «Взнос и питание». Форма, открытая до обновления,
 * или черновик на телефоне пришлёт старый ключ - переводим его, а не отказываем в регистрации.
 */
function upgradeLegacyTier(v: unknown): unknown {
  return v && typeof v === 'object' && (v as { tier?: unknown }).tier === 'fee45' ? { ...v, tier: 'fee35', breakfast: true } : v;
}

export const participantInputSchema = participantBaseSchema.superRefine((p, ctx) => {
  if (!p.phone && p.relation !== 'child') {
    ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Укажите телефон' });
  }
  if (!isFreeTier(p.tier) && !p.paymentMethod) {
    ctx.addIssue({ code: 'custom', path: ['paymentMethod'], message: 'Выберите способ оплаты' });
  }
});
export type ParticipantInput = z.infer<typeof participantInputSchema>;
/** То, что присылает форма (до нормализации телефона и ника). */
export type ParticipantInputRaw = z.input<typeof participantInputSchema>;

export const registrationSubmitSchema = z.object({
  idempotencyKey: z.uuid(),
  participants: z
    .array(z.preprocess(upgradeLegacyTier, participantInputSchema))
    .min(1)
    .max(50)
    .refine((list) => list.filter((p) => p.relation === 'self').length <= 1, { message: '«Я» может быть только один' }),
  /** «Это не я»: человек с тем же телефоном и именем в другом аккаунте - всё равно регистрируем. */
  notDuplicate: z.boolean().default(false),
  /** Готов(а) оплатить регистрацию того, у кого нет возможности (одна галочка на анкету). */
  sponsorOffer: z.boolean().default(false),
  consent: z.object({
    pd: z.literal(true, { error: 'Нужно согласие на обработку персональных данных' }),
    photo: z.boolean().default(false),
    documentVersion: z.string().min(1).max(40),
  }),
});
export type RegistrationSubmit = z.infer<typeof registrationSubmitSchema>;

/** Регистрация «Гость» на месте: только за себя, вариант «Только взнос». */
export const guestRegistrationSchema = z.object({
  idempotencyKey: z.uuid(),
  lastName: participantBaseSchema.shape.lastName,
  firstName: participantBaseSchema.shape.firstName,
  phone: participantBaseSchema.shape.phone.refine((v) => !!v, 'Укажите телефон'),
  gender: participantBaseSchema.shape.gender,
  notDuplicate: z.boolean().default(false),
  consent: registrationSubmitSchema.shape.consent,
});
export type GuestRegistration = z.infer<typeof guestRegistrationSchema>;

/** Своё редактирование из Mini App. Вариант и способ оплаты меняются, только пока не оплачено (проверяет сервер). */
export const participantUpdateSchema = z.preprocess(upgradeLegacyTier, participantBaseSchema.partial().omit({ relation: true }));
export type ParticipantUpdate = z.infer<typeof participantUpdateSchema>;

// ---------- «Меня уже зарегистрировали» ----------

/** Номер из Telegram в Mini App: строка, подписанная Telegram (`requestContact`), - проверяем как initData. */
export const verifyPhoneSchema = z.object({ contact: z.string().min(10).max(4096) });

/** Забрать себе регистрации, сделанные другим аккаунтом на мой подтверждённый номер. */
export const claimSchema = z.object({ participantIds: z.array(z.number().int().positive()).min(1).max(50) });
export type ClaimRequest = z.infer<typeof claimSchema>;

// ---------- переписка с организаторами ----------

/** Сообщение участника организаторам. */
export const chatUserSendSchema = z
  .object({
    text: z.string().trim().max(2000).default(''),
    /** Написал из раздела «Мерч» - переписка уходит в папку «Мерч». */
    topic: z.enum(['merch']).optional(),
    /** Заявка на бронь: какие вещи и сколько. Остатки не трогает - бронирует продавец. */
    items: z
      .array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(10) }))
      .max(10)
      .optional(),
  })
  .refine((v) => v.text !== '' || (v.items?.length ?? 0) > 0, { message: 'Напишите сообщение', path: ['text'] });

/** Сообщение команды: текст, картинка (загружена заранее) или и то и другое. */
export const chatStaffSendSchema = z
  .object({
    text: z.string().trim().max(4000).nullish(),
    photo: z
      .string()
      .regex(/^chat\/[0-9a-f]{20}\.webp$/)
      .nullish(),
  })
  .refine((v) => !!v.text || !!v.photo, { message: 'Напишите сообщение или добавьте картинку' });
export type ChatStaffSend = z.infer<typeof chatStaffSendSchema>;

/** Смена способа оплаты после регистрации (пока взнос не внесён). */
export const paymentMethodChangeSchema = z.object({ method: z.enum(REG_PAYMENT_METHODS) });
export type PaymentMethodChange = z.infer<typeof paymentMethodChangeSchema>;

// ---------- активности ----------

/*
 * Схемы правки (PATCH) строим из полей без значений по умолчанию: zod 4 подставляет default и внутри
 * .partial(), и правка одного поля молча меняла бы другие (переключатель записи стирал залы блока).
 */

const activityFields = z.object({
  title: z.string().trim().min(1).max(120),
  description: optionalText(4000),
  location: optionalText(120),
  host: optionalText(120),
  /** Тип - свободный текст («Семинар», «Служение» или свой). */
  kind: z.string().trim().min(1, 'Укажите тип').max(40),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  registrationMode: z.enum(REGISTRATION_MODES),
  capacity: z.number().int().positive().max(100000).nullish(),
  waitlistEnabled: z.boolean(),
  registrationOpensAt: isoDateTime.nullish(),
  registrationClosesAt: isoDateTime.nullish(),
  minAge: z.number().int().min(0).max(120).nullish(),
  maxAge: z.number().int().min(0).max(120).nullish(),
  status: z.enum(ACTIVITY_STATUSES),
  /** Завтрак, обед или ужин: тем, у кого это питание, - личное напоминание. */
  meal: z.enum(MEALS).nullish(),
});
export const activityInputSchema = activityFields.extend({
  waitlistEnabled: activityFields.shape.waitlistEnabled.default(true),
  status: activityFields.shape.status.default('published'),
});
export type ActivityInput = z.infer<typeof activityInputSchema>;
export const activityUpdateSchema = activityFields.partial();
export type ActivityUpdate = z.infer<typeof activityUpdateSchema>;

export const activityParticipantSchema = z.object({ participantId: z.number().int().positive() });

// ---------- залы и семинары ----------

const roomFields = z.object({
  name: z.string().trim().min(1, 'Как называется зал?').max(80),
  capacity: z.number().int().min(1, 'Вместимость - больше нуля').max(100000),
  note: optionalText(200),
  sort: z.number().int().min(0).max(10000),
});
export const roomInputSchema = roomFields.extend({ sort: roomFields.shape.sort.default(0) });
export type RoomInput = z.infer<typeof roomInputSchema>;
export const roomUpdateSchema = roomFields.partial();

const seminarBlockFields = z.object({
  title: z.string().trim().min(1, 'Как называется блок?').max(80),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /** Какие залы доступны в этом блоке. */
  roomIds: z.array(z.number().int().positive()).max(100),
  registrationOpen: z.boolean(),
  /** Скрыть блок от участников целиком. */
  hidden: z.boolean(),
});
export const seminarBlockInputSchema = seminarBlockFields.extend({
  roomIds: seminarBlockFields.shape.roomIds.default([]),
  registrationOpen: seminarBlockFields.shape.registrationOpen.default(false),
  hidden: seminarBlockFields.shape.hidden.default(false),
});
export type SeminarBlockInput = z.infer<typeof seminarBlockInputSchema>;
export const seminarBlockUpdateSchema = seminarBlockFields.partial();
export type SeminarBlockUpdate = z.infer<typeof seminarBlockUpdateSchema>;

/** Тема семинара - одна на все потоки: название, спикер, описание. */
const seminarTopicFields = z.object({
  title: z.string().trim().min(1, 'Как называется тема?').max(120),
  host: optionalText(120),
  description: optionalText(4000),
  /** Скрыть тему от участников: за неё не голосуют. */
  hidden: z.boolean(),
});
export const seminarTopicInputSchema = seminarTopicFields.extend({ hidden: seminarTopicFields.shape.hidden.default(false) });
export type SeminarTopicInput = z.infer<typeof seminarTopicInputSchema>;
export const seminarTopicUpdateSchema = seminarTopicFields.partial();

/** Выбор тем за человека из семьи: сколько потоков - столько тем; пустой список - снять выбор. */
export const seminarVotesSchema = z.object({
  participantId: z.number().int().positive(),
  topicIds: z.array(z.number().int().positive()).max(10),
});
export type SeminarVotesInput = z.infer<typeof seminarVotesSchema>;

/** Распределить: reset - заново (кроме ручных переносов), иначе только тех, у кого места ещё нет. */
export const seminarPlanSchema = z.object({ reset: z.boolean().default(false) });
export const seminarAutoPlanSchema = z.object({ on: z.boolean() });

/** Админ переносит человека на другой сеанс потока; activityId = null - убрать из потока. */
export const seminarMoveSchema = z.object({
  participantId: z.number().int().positive(),
  blockId: z.number().int().positive(),
  activityId: z.number().int().positive().nullable(),
});
export type SeminarMoveInput = z.infer<typeof seminarMoveSchema>;

/** Ручной зал для темы до публикации; null - пусть предложит бот. */
export const plannedRoomSchema = z.object({ roomId: z.number().int().positive().nullable() });

// ---------- душепопечение ----------

/** Служитель: имя, место, окно приёма и длина окошка на человека. */
const counselorFields = z.object({
  name: z.string().trim().min(1, 'Как зовут служителя?').max(120),
  /** Зал из справочника или свой текст: «504 каб. церкви, 5-й этаж». */
  place: optionalText(160),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  slotMinutes: z.number().int().min(5, 'Окошко - от 5 минут').max(240, 'Окошко - до 4 часов'),
  /** Скрыть служителя от участников (записи остаются). */
  hidden: z.boolean(),
  /** Кого принимает: всех, только девушек или только парней - другим время видно, но записаться нельзя. */
  audience: z.enum(COUNSELOR_AUDIENCES),
  /** Свои метки - просто подпись у служителя. */
  tags: z.array(z.string().trim().min(1, 'Пустая метка').max(24, 'Метка - до 24 знаков')).max(4, 'Не больше 4 меток'),
});
export const counselorInputSchema = counselorFields.extend({
  slotMinutes: counselorFields.shape.slotMinutes.default(20),
  hidden: counselorFields.shape.hidden.default(false),
  audience: counselorFields.shape.audience.default('all'),
  tags: counselorFields.shape.tags.default([]),
});
export type CounselorInput = z.infer<typeof counselorInputSchema>;
export const counselorUpdateSchema = counselorFields.partial();
export type CounselorUpdate = z.infer<typeof counselorUpdateSchema>;

/** Записаться (или перейти на другое время - запись у человека одна). */
export const counselingBookSchema = z.object({
  counselorId: z.number().int().positive(),
  slotStart: isoDateTime,
  participantId: z.number().int().positive(),
});
export type CounselingBookRequest = z.infer<typeof counselingBookSchema>;

export const counselingOpenSchema = z.object({ open: z.boolean() });
/** «Напомнить всем»: записанным (к одному служителю или ко всем) - их время, имя служителя и место. */
export const counselingAnnounceSchema = z.object({ counselorId: z.number().int().positive().nullable() });

export const activitySwitchSchema = z.object({
  participantId: z.number().int().positive(),
  fromActivityId: z.number().int().positive(),
});
export type ActivitySwitchRequest = z.infer<typeof activitySwitchSchema>;

// ---------- check-in ----------

export const checkInEventSchema = z.object({
  clientEventId: z.uuid(),
  checkpointId: z.number().int().positive(),
  participantId: z.number().int().positive(),
  code: z.string().max(40).nullish(),
  clientTs: isoDateTime,
  deviceId: z.string().min(1).max(64),
  method: z.enum(CHECKIN_METHODS),
  offline: z.boolean().default(false),
  overrideUnpaid: z.boolean().default(false),
});
export type CheckInEvent = z.infer<typeof checkInEventSchema>;

export const checkInBatchSchema = z.object({ events: z.array(checkInEventSchema).min(1).max(100) });
export type CheckInBatch = z.infer<typeof checkInBatchSchema>;

export const lookupSchema = z
  .object({
    checkpointId: z.number().int().positive(),
    code: z.string().max(200).nullish(),
    participantId: z.number().int().positive().nullish(),
  })
  .refine((v) => v.code || v.participantId, 'Нужен code или participantId');
export type LookupRequest = z.infer<typeof lookupSchema>;

/** Сумма приёма: пусто - «весь остаток», иначе больше нуля. */
const paidAmount = money.refine((v) => Number(v) > 0, 'Сумма должна быть больше нуля').nullish();

/** Касса на входе: не оплатил, заплатит переводом позже - пропускаем, человеку в бот реквизиты и «пришлите чек». */
export const promiseTransferSchema = z.object({ participantIds: z.array(z.number().int().positive()).min(1).max(20) });

export const markPaidSchema = z.object({
  participantIds: z.array(z.number().int().positive()).min(1).max(50),
  amount: paidAmount,
  method: z.enum(PAYMENT_METHODS),
  note: optionalText(500),
  /** «Без сдачи»: что дали сверх взноса - пожертвованием от первого в списке, тем же способом. */
  donation: paidAmount,
  /** Ключ повтора: запрос ушёл по тайм-ауту и отправлен снова - второй раз не зачисляем. */
  requestId: z.uuid().nullish(),
});
export type MarkPaidRequest = z.infer<typeof markPaidSchema>;

/** Пожертвование на кассе: от участника (по QR-коду) или без него - тогда имя, если назвали. */
export const donationSchema = z.object({
  participantId: z.number().int().positive().nullish(),
  donorName: optionalText(120),
  amount: money.refine((v) => Number(v) > 0, 'Сумма должна быть больше нуля'),
  method: z.enum(PAYMENT_METHODS),
  comment: optionalText(500),
  requestId: z.uuid(),
});
export type DonationRequest = z.infer<typeof donationSchema>;

/** Отменить отметку по номеру события (было в офлайн-очереди, но могло дойти до сервера). */
export const revokeByEventSchema = z.object({ clientEventId: z.uuid() });

/** Касса: найти человека по QR-коду или id - только для оплаты (журнал входа не трогаем). */
export const paymentFindSchema = z
  .object({
    code: z.string().max(200).nullish(),
    participantId: z.number().int().positive().nullish(),
  })
  .refine((v) => v.code || v.participantId, 'Нужен code или participantId');
export type PaymentFindRequest = z.infer<typeof paymentFindSchema>;

/** Касса: отменить свой приём (ошиблись человеком). */
export const paymentUndoSchema = z.object({ participantId: z.number().int().positive() });

/** Админка: принять оплату за одного человека. */
export const adminPaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: paidAmount,
  note: optionalText(500),
  /** Ключ повтора, как у кассы: двойное нажатие или повтор после тайм-аута не зачисляется дважды. */
  requestId: z.uuid().nullish(),
});
export type AdminPaymentRequest = z.infer<typeof adminPaymentSchema>;

// ---------- авторизация ----------

export const loginTokenSchema = z.object({
  token: z.string().min(16).max(128),
  mode: z.enum(['cookie', 'bearer']).default('cookie'),
});

export const passwordLoginSchema = z.object({
  login: z.string().trim().min(3).max(60),
  password: z.string().min(8).max(200),
  totp: z.string().regex(/^\d{6}$/),
});

// ---------- админка ----------

export const adminParticipantCreateSchema = participantBaseSchema.extend({
  church: churchField.nullish(),
  tier: z.enum(TIERS).default('fee10'),
  category: z.enum(CATEGORIES).default('participant'),
  paymentStatus: z.enum(PAYMENT_STATUSES).default('unpaid'),
  amountDue: money.nullish(),
  note: optionalText(1000),
});
export type AdminParticipantCreate = z.infer<typeof adminParticipantCreateSchema>;

export const adminParticipantUpdateSchema = z
  .object({
    lastName: name,
    firstName: name,
    middleName: optionalText(60),
    birthDate: birthDateField,
    gender: z.enum(GENDERS),
    city: z.string().trim().min(1).max(80),
    church: churchField.nullish(),
    phone: phoneField,
    telegramUsername: telegramUsernameField,
    tier: z.enum(TIERS),
    breakfast: z.boolean(),
    paymentMethod: z.enum(REG_PAYMENT_METHODS).nullish(),
    category: z.enum(CATEGORIES),
    status: z.enum(PARTICIPANT_STATUSES),
    paymentStatus: z.enum(PAYMENT_STATUSES),
    amountDue: money.nullish(),
    amountPaid: money,
    paymentNote: optionalText(1000),
    /** Готов(а) оплатить за другого - админ может поправить отметку из анкеты. */
    sponsorOffer: z.boolean(),
  })
  .partial();
export type AdminParticipantUpdate = z.infer<typeof adminParticipantUpdateSchema>;

export const bulkParticipantsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mark_paid'), ids: z.array(z.number().int().positive()).min(1).max(2000) }),
  z.object({ action: z.literal('mark_unpaid'), ids: z.array(z.number().int().positive()).min(1).max(2000) }),
  z.object({
    action: z.literal('set_category'),
    ids: z.array(z.number().int().positive()).min(1).max(2000),
    category: z.enum(CATEGORIES),
  }),
]);
export type BulkParticipantsRequest = z.infer<typeof bulkParticipantsSchema>;

export const receiptDecisionSchema = z.object({
  amount: paidAmount,
  reason: optionalText(500),
  /** Принять только за этих людей из чека (остальные вернутся в «не оплачено»). */
  participantIds: z.array(z.number().int().positive()).max(50).nullish(),
});

const checkpointFields = z.object({
  kind: z.enum(CHECKPOINT_KINDS),
  name: z.string().trim().min(1).max(80),
  activityId: z.number().int().positive().nullish(),
  /** День точки входа (`YYYY-MM-DD`): сканер в этот день берёт её. Пусто - на все дни. */
  day: z.iso.date().nullish(),
  isActive: z.boolean(),
});
export const checkpointInputSchema = checkpointFields.extend({ isActive: checkpointFields.shape.isActive.default(true) });
export type CheckpointInput = z.infer<typeof checkpointInputSchema>;
/** Правка - без значений по умолчанию: переименование не должно включать выключенную точку. */
export const checkpointUpdateSchema = checkpointFields.partial();

export const segmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('unpaid') }),
  z.object({ kind: z.literal('not_arrived') }),
  z.object({ kind: z.literal('arrived') }),
  z.object({ kind: z.literal('category'), category: z.enum(CATEGORIES) }),
  z.object({ kind: z.literal('activity'), activityId: z.number().int().positive() }),
  z.object({ kind: z.literal('staff') }),
  z.object({ kind: z.literal('list'), listId: z.number().int().positive() }),
]);
export type Segment = z.infer<typeof segmentSchema>;

export const participantListInputSchema = z.object({ name: z.string().trim().min(1).max(80) });
export type ParticipantListInput = z.infer<typeof participantListInputSchema>;

export const participantListMembersSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(5000) });
export type ParticipantListMembersInput = z.infer<typeof participantListMembersSchema>;

export const broadcastInputSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  segment: segmentSchema,
  scheduledAt: isoDateTime.nullish(),
  /** true - отправить только себе, чтобы посмотреть, как выглядит */
  test: z.boolean().default(false),
  /** дублировать в ленту объявлений на сайте */
  alsoAnnouncement: z.boolean().default(false),
});
export type BroadcastInput = z.infer<typeof broadcastInputSchema>;

export const infoPageInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  bodyMd: z.string().max(20000),
  sort: z.number().int().default(0),
  published: z.boolean().default(true),
});
export type InfoPageInput = z.infer<typeof infoPageInputSchema>;

const announcementFields = z.object({
  title: z.string().trim().min(1).max(160),
  bodyMd: z.string().max(10000),
  pinned: z.boolean(),
  published: z.boolean(),
});
export const announcementInputSchema = announcementFields.extend({
  pinned: announcementFields.shape.pinned.default(false),
  published: announcementFields.shape.published.default(true),
});
export type AnnouncementInput = z.infer<typeof announcementInputSchema>;
/** Правка - без значений по умолчанию: «закрепить» не публикует скрытое, «скрыть» не открепляет. */
export const announcementUpdateSchema = announcementFields.partial();

/** Банкир: выдать деньги (payout) или записать прочий приход (income). */
export const moneyEntrySchema = z.object({
  requestId: z.uuid(),
  kind: z.enum(['payout', 'income']),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,7}([.,]\d{1,2})?$/, 'Сумма в рублях, например 150 или 150,50')
    .transform((v) => v.replace(',', '.'))
    .refine((v) => Number(v) > 0, 'Сумма больше нуля'),
  method: z.enum(['cash', 'transfer', 'card']),
  /** Кому выдали или от кого пришло. */
  counterparty: z.string().trim().min(1, 'Укажите, кому или от кого').max(120),
  /** На что / за что. */
  comment: z.string().trim().min(1, 'Укажите, на что').max(300),
  category: z.string().trim().max(60).optional().nullable(),
});
export type MoneyEntryRequest = z.infer<typeof moneyEntrySchema>;

export const moneyCancelSchema = z.object({ reason: z.string().trim().min(2, 'Укажите причину').max(300) });

export const staffRolesSchema = z.object({ roles: z.array(z.enum(ROLES)).max(ROLES.length) });

export const staffInviteSchema = z.object({
  role: z.enum(ROLES),
  expiresInHours: z.number().int().min(1).max(24 * 90).default(72),
});

export const memberLinkSchema = z.object({ reset: z.boolean().default(false) });

export const scannerCardSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(['scanner', 'cashier']),
  expiresInHours: z.number().int().min(1).max(24 * 7).default(72),
});

export const staffPasswordSchema = z.object({
  login: z.string().trim().min(3).max(60),
  password: z.string().min(10).max(200),
});

const tierConfigSchema = z.object({
  label: z.string().trim().min(1).max(80),
  short: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200),
  amount: z.number().min(0).max(100000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #RRGGBB'),
  /** Сколько мест у варианта; null - без ограничения. Старые сохранённые настройки без поля - без ограничения. */
  limit: z.number().int().positive().max(100000).nullable().default(null),
  /** Старые сохранённые настройки без поля - показываем. */
  enabled: z.boolean().default(true),
  bracelet: z.enum(BRACELETS),
});

// Нового варианта нет в сохранённых настройках - берём его по умолчанию (иначе не прошли бы схему и сбросились все варианты).
// Браслета нет в старых сохранённых настройках - берём браслет этого варианта по умолчанию.
const tierWithDefault = (t: (typeof TIERS)[number]) =>
  tierConfigSchema.extend({ bracelet: z.enum(BRACELETS).default(DEFAULT_TIERS[t].bracelet) }).default(DEFAULT_TIERS[t]);
export const tiersSchema = z
  .object(Object.fromEntries(TIERS.map((t) => [t, tierWithDefault(t)])) as Record<(typeof TIERS)[number], ReturnType<typeof tierWithDefault>>)
  .refine((v) => TIERS.some((t) => v[t].enabled), { message: 'Хотя бы один вариант участия должен показываться при регистрации' });

export const breakfastConfigSchema = z.object({
  amount: z.number().min(0).max(100000),
  limit: z.number().int().positive().max(100000).nullable(),
  description: z.string().trim().max(200),
  enabled: z.boolean().default(true),
});

/** Часовой пояс из базы IANA (Europe/Minsk): с опечаткой все даты в приложении падали бы с RangeError. */
const timeZoneField = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Неизвестный часовой пояс' },
  );

export const settingsSchema = z.object({
  eventName: z.string().trim().min(1).max(120),
  eventTimezone: timeZoneField,
  eventStartsAt: isoDateTime.nullable(),
  eventEndsAt: isoDateTime.nullable(),
  registrationOpensAt: isoDateTime.nullable(),
  registrationClosesAt: isoDateTime.nullable(),
  /**
   * Регистрация на месте (день конференции): короткая форма «Гость» - Ф.И., телефон, пол, «Только взнос»,
   * только за себя. Пока включена - регистрация открыта, что бы ни стояло в датах выше.
   */
  onSiteRegistration: z.boolean(),
  maxParticipantsPerAccount: z.number().int().min(1).max(50),
  /** Запись на мероприятия: до конференции закрыта, организатор открывает выключателем на месте. */
  activityRegistrationOpen: z.boolean(),
  /** Показывать расписание участникам (команда видит всегда). */
  scheduleVisible: z.boolean(),
  /** Запись на душепопечение: свой выключатель, открывают на конференции. */
  counselingOpen: z.boolean(),
  /** Семинары распределяются сами - после каждого выбора тем. Выключено - только кнопкой «Распределить». */
  seminarAutoPlan: z.boolean(),
  /** Как душепопечение называется у участников: расписание, главная, бот. */
  counselingTitle: z.string().trim().min(1).max(60),
  totalCapacity: z.number().int().positive().nullable(),
  /** Принимаем ли переводы. Выключено - только наличные: в форме нет выбора способа, в боте нет чеков. */
  transfersEnabled: z.boolean(),
  /** Реквизиты для безналичного перевода. */
  paymentInstructions: z.string().max(4000),
  /** Где и когда сдать наличные. */
  cashInstructions: z.string().max(4000),
  /** Варианты участия: цена, цвет, подписи. */
  tiers: tiersSchema,
  /** Завтрак - галочка к платному варианту: доплата и лимит. */
  breakfast: breakfastConfigSchema,
  /** Оплата выключена - ни бот, ни Mini App, ни сканер о ней не говорят. */
  paymentsEnabled: z.boolean(),
  allowUnpaidEntry: z.boolean(),
  /** Дни конференции: участникам «чек получен ✓» вместо «чек на проверке», «не забудьте оплатить» вместо «к оплате». */
  softPaymentLabels: z.boolean(),
  consentDocumentVersion: z.string().trim().min(1).max(40),
  consentDocumentUrl: z.url().nullable(),
  photoConsentEnabled: z.boolean(),
  welcomeText: z.string().max(4000),
  supportContact: z.string().max(200).nullable(),
  /** Витрина мерча в Mini App. */
  merchVisible: z.boolean(),
  /** Включённую витрину видят только администраторы - проверить до показа всем. */
  merchAdminsOnly: z.boolean(),
  /** Бронь и продажа мерча (пока выключено - только витрина). */
  merchSalesEnabled: z.boolean(),
  /** Участник бронирует сам кнопкой «Забронировать»; выключено - выбирает размер и пишет продавцу, бронирует продавец. */
  merchSelfBooking: z.boolean(),
  /** Сколько часов держим неоплаченную бронь; null - до конференции. */
  merchReservationHours: z.number().int().min(1).max(24 * 60).nullable(),
  /** Оплата брони переводом прямо в приложении (чек - там же); выключено - только бронь, платят на месте. */
  merchOnlinePayment: z.boolean(),
  /** Как перевести за мерч и пожертвование (тот же счёт, без шагов про взнос); пусто - текст для взноса. */
  merchPaymentInstructions: z.string().max(4000),
  /**
   * Когда спросить в боте всех с бронью «Точно заберёте?» (и показать вопрос на главной в приложении); null - не спрашивать.
   * Не ответили за `merchConfirmHours` часов - бронь снимается.
   */
  merchConfirmAt: isoDateTime.nullable(),
  /** Сколько часов ждём ответа на «Точно заберёте?». */
  merchConfirmHours: z.number().int().min(1).max(48),
  /** Не ответили вовремя - снять бронь (кроме подтверждённых раньше); выключено - только напоминаем. */
  merchConfirmDrop: z.boolean(),
  /**
   * Копии сообщений из папки «Мерч» в бот: кому включили или выключили (id → да/нет).
   * Кого здесь нет - продавцам включено, админам выключено.
   */
  merchNotify: z.record(z.string().regex(/^\d+$/), z.boolean()),
  /**
   * Копии обычных сообщений участников (не «Мерч») в бот: кому включили или выключили (id → да/нет).
   * Кого здесь нет - админам и суперадминам включено.
   */
  chatNotify: z.record(z.string().regex(/^\d+$/), z.boolean()),
  /** Отзывы в приложении: кнопка на главной и заставка «Оставь отзыв» - всем участникам. */
  feedbackOpen: z.boolean(),
  /** Проверить отзывы на админах (пока всем выключено). */
  feedbackAdmins: z.boolean(),
  /** Метка включения: заставку «Оставь отзыв» показываем один раз на каждое включение. */
  feedbackWave: z.string().max(40),
  /** «Конец «Шага веры»»: вместо главной - экран благодарности (написать организаторам, оставить отзыв). */
  eventEnded: z.boolean(),
  endTitle: z.string().trim().max(120),
  endText: z.string().max(1500),
});
export type Settings = z.infer<typeof settingsSchema>;
/** «Копии в Telegram» на странице «Сообщения». */
export const feedbackSettingsPatchSchema = z.object({ feedbackOpen: z.boolean().optional(), feedbackAdmins: z.boolean().optional() }).strict();

export const feedbackInputSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  text: z.string().trim().min(3, 'Напиши хотя бы пару слов').max(4000, 'Не больше 4000 знаков'),
  anonymous: z.boolean(),
  /** Подпись, если не анонимно: имя, можно со ссылкой на соцсеть. */
  signature: z.string().trim().max(120).nullish(),
});
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

export const feedbackStarSchema = z.object({ starred: z.boolean() }).strict();

export const chatNotifyPatchSchema = z.object({ chatNotify: z.record(z.string().regex(/^\d+$/), z.boolean()) }).strict();
/** «Настройки» сохраняют только изменённые поля - сервер сливает их с текущими. */
export const settingsPatchSchema = settingsSchema.partial();
/** Настройки мерча правят и продавцы («Мерч» → «Настройки»): только эти поля, остальные настройки им не видны. */
export const merchSettingsPatchSchema = settingsSchema
  .pick({
    merchVisible: true,
    merchAdminsOnly: true,
    merchSalesEnabled: true,
    merchSelfBooking: true,
    merchReservationHours: true,
    merchOnlinePayment: true,
    merchPaymentInstructions: true,
    merchConfirmAt: true,
    merchConfirmHours: true,
    merchConfirmDrop: true,
    merchNotify: true,
  })
  .partial()
  .strict();
export type MerchSettings = Required<z.infer<typeof merchSettingsPatchSchema>>;
/** Для формы: настройки мерча и общий выключатель переводов (его меняет только админ в «Настройках»). */
export type MerchSettingsView = MerchSettings & {
  transfersEnabled: boolean;
  /** Продавцы и админы: кому приходят копии сообщений из «Мерча» (с учётом умолчаний). */
  merchNotifyPeople: { userId: number; name: string; roles: string[]; on: boolean }[];
};
/** Отдельный переключатель записи на мероприятия (страница «Расписание», не только суперадмину). */
export const activitySignupSchema = z.object({ open: z.boolean() });

export const DEFAULT_SETTINGS: Settings = {
  eventName: 'Шаг веры 2026',
  eventTimezone: 'Europe/Minsk',
  eventStartsAt: null,
  eventEndsAt: null,
  registrationOpensAt: null,
  registrationClosesAt: null,
  onSiteRegistration: false,
  maxParticipantsPerAccount: 6,
  activityRegistrationOpen: false,
  scheduleVisible: true,
  counselingOpen: false,
  seminarAutoPlan: true,
  counselingTitle: 'Молитвенная комната',
  totalCapacity: null,
  transfersEnabled: true,
  paymentInstructions: 'Реквизиты для перевода появятся здесь позже.',
  cashInstructions:
    'После молодёжных и воскресных служений (2-й и 3-й поток), в кабинете 504, с 17 октября по 1 ноября включительно.',
  tiers: DEFAULT_TIERS,
  breakfast: DEFAULT_BREAKFAST,
  paymentsEnabled: true,
  allowUnpaidEntry: false,
  softPaymentLabels: false,
  consentDocumentVersion: CONSENT_VERSION,
  consentDocumentUrl: null,
  photoConsentEnabled: true,
  welcomeText: 'Здравствуйте! Это бот конференции «Шаг веры 2026»: регистрация, QR-код для входа и расписание.',
  supportContact: null,
  merchVisible: false,
  merchAdminsOnly: true,
  merchSalesEnabled: false,
  merchSelfBooking: false,
  merchReservationHours: 72,
  merchOnlinePayment: true,
  merchPaymentInstructions: '',
  // Пятница конференции, 13:30 - за 3 часа до начала вечера.
  merchConfirmAt: '2026-11-06T13:30:00+03:00',
  merchConfirmHours: 3,
  merchConfirmDrop: true,
  merchNotify: {},
  chatNotify: {},
  feedbackOpen: false,
  feedbackAdmins: false,
  feedbackWave: '',
  eventEnded: false,
  endTitle: 'Спасибо, что были с нами!',
  endText: '«Шаг веры» уже прошёл, но шаг, который ты сделал, - только начало. Расскажи, как это было, или напиши организаторам: мы читаем всё.',
};

// ---------- мерч ----------

/**
 * Кому видна витрина мерча: выключена - никому (и команде тоже); «только администраторам» - админам и продавцам;
 * иначе всем. Бронь - тем же, кому видна витрина, если продажа включена.
 */
export function merchAccess(
  s: Pick<Settings, 'merchVisible' | 'merchAdminsOnly' | 'merchSalesEnabled'>,
  roles: readonly string[],
): { visible: boolean; sales: boolean } {
  // Продавец видит скрытую витрину, как админ: проверяет, как выглядят вещи до открытия.
  const admin = roles.includes('admin') || roles.includes('superadmin') || roles.includes('seller');
  const visible = s.merchVisible && (!s.merchAdminsOnly || admin);
  return { visible, sales: visible && s.merchSalesEnabled };
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #RRGGBB');

const merchProductFields = z.object({
  title: z.string().trim().min(1).max(80),
  subtitle: z.string().trim().max(120).nullable(),
  descriptionMd: z.string().max(4000),
  price: z.number().min(0).max(100000),
  badge: z.string().trim().max(20).nullable(),
  sort: z.number().int().min(-100000).max(100000),
  published: z.boolean(),
});
export const merchProductInputSchema = merchProductFields.extend({
  subtitle: merchProductFields.shape.subtitle.default(null),
  descriptionMd: merchProductFields.shape.descriptionMd.default(''),
  badge: merchProductFields.shape.badge.default(null),
  sort: merchProductFields.shape.sort.default(0),
  published: merchProductFields.shape.published.default(false),
});
export type MerchProductInput = z.infer<typeof merchProductInputSchema>;
/** Правка - без значений по умолчанию: «не прислали» ≠ «сбросили». */
export const merchProductUpdateSchema = merchProductFields.partial();

export const merchColorInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  hex: hexColor,
  sort: z.number().int().min(-100000).max(100000).default(0),
});
export const merchColorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  hex: hexColor,
  sort: z.number().int().min(-100000).max(100000),
}).partial();

export const merchSizeInputSchema = z.object({
  size: z.string().trim().min(1).max(20),
  stock: z.number().int().min(0).max(100000).default(0),
  sort: z.number().int().min(-100000).max(100000).default(0),
});
export const merchSizeUpdateSchema = z.object({
  size: z.string().trim().min(1).max(20),
  stock: z.number().int().min(0).max(100000),
  sort: z.number().int().min(-100000).max(100000),
}).partial();

export const merchMediaUpdateSchema = z.object({
  colorId: z.number().int().positive().nullable(),
  sort: z.number().int().min(-100000).max(100000),
}).partial();

/** Файл, который вернула загрузка редактора (`merch/<хеш>.webp|.glb`), - к вещи его привяжет «Сохранить». */
export const MERCH_FILE_RE = /^merch\/[0-9a-f]{20}\.(webp|glb|spin)$/;

/**
 * Редактор вещи целиком - всё, что набрали, уходит одной кнопкой «Сохранить».
 * `id: null` - новая вещь. Цвета, размеры и файлы: `id` - уже были, `null` - новые; чего нет в списке - удалить.
 * Порядок в списках = порядок в витрине. Файл ссылается на цвет его `key` (`null` - обложка и общие).
 */
export const merchProductSaveSchema = merchProductFields.extend({
  id: z.number().int().positive().nullable(),
  colors: z
    .array(
      z.object({
        id: z.number().int().positive().nullable(),
        key: z.string().min(1).max(40),
        name: z.string().trim().min(1).max(40),
        hex: hexColor,
        sizes: z
          .array(
            z.object({
              id: z.number().int().positive().nullable(),
              size: z.string().trim().min(1).max(20),
              stock: z.number().int().min(0).max(100000),
            }),
          )
          .max(40),
      }),
    )
    .min(1, 'У вещи должен остаться хотя бы один цвет')
    .max(20),
  media: z
    .array(
      z.object({
        id: z.number().int().positive().nullable(),
        file: z.string().regex(MERCH_FILE_RE).nullable(),
        color: z.string().min(1).max(40).nullable(),
      }),
    )
    .max(250),
});
export type MerchProductSave = z.infer<typeof merchProductSaveSchema>;

export const MERCH_ORDER_STATUSES = ['reserved', 'paid', 'issued', 'owed', 'cancelled', 'expired'] as const;
export type MerchOrderStatus = (typeof MERCH_ORDER_STATUSES)[number];
export const MERCH_PAY_METHODS = ['cash', 'card', 'transfer'] as const;
export type MerchPayMethod = (typeof MERCH_PAY_METHODS)[number];

export const merchOrderCreateSchema = z.object({
  /** Повтор запроса (двойное нажатие, плохая связь) не создаст второй заказ. */
  requestId: z.uuid(),
  items: z
    .array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(10) }))
    .min(1)
    .max(20),
  /** Как собирается платить: на месте или переводом. */
  paymentMethod: z.enum(['cash', 'transfer']).default('cash'),
});
export type MerchOrderCreate = z.infer<typeof merchOrderCreateSchema>;

/** Продавец бронирует вещи для человека из переписки (по заявке или сам). */
export const merchReserveSchema = merchOrderCreateSchema.pick({ requestId: true, items: true }).extend({
  userId: z.number().int().positive(),
  /** Заявка из переписки, по которой бронируем: после брони на ней «Забронировано». */
  messageId: z.number().int().positive().nullish(),
});
export type MerchReserve = z.infer<typeof merchReserveSchema>;

export const merchOrderPaySchema = z.object({ method: z.enum(MERCH_PAY_METHODS) });
export const merchOrderCancelSchema = z.object({ reason: z.string().trim().max(300).nullish() });

const rubAmount = z
  .string()
  .trim()
  .regex(/^\d{1,7}([.,]\d{1,2})?$/, 'Сумма - число, например 1500')
  .transform((v) => v.replace(',', '.'));

/**
 * Продажа на месте (продавец). Оплачено сразу или в долг: при долге покупатель обязателен -
 * участник из базы или имя и телефон; можно сразу внести часть (`paidNow`).
 */
export const merchSellSchema = merchOrderCreateSchema
  .extend({
    method: z.enum(MERCH_PAY_METHODS),
    debt: z.boolean().default(false),
    paidNow: rubAmount.nullish(),
    buyerParticipantId: z.number().int().positive().nullish(),
    buyerName: z.string().trim().max(120).nullish(),
    buyerPhone: z.string().trim().max(40).nullish(),
  })
  .refine((v) => !v.debt || v.buyerParticipantId || (v.buyerName && v.buyerPhone), {
    message: 'В долг - укажите покупателя: участника или имя и телефон',
    path: ['buyerName'],
  });
export type MerchSell = z.infer<typeof merchSellSchema>;

/** Погашение долга за мерч - полностью или частью. */
export const merchRepaySchema = z.object({
  amount: rubAmount.refine((v) => Number(v) > 0, 'Сумма больше нуля'),
  method: z.enum(MERCH_PAY_METHODS),
});
