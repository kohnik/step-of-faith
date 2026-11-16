import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle, type SendOptions } from 'pg-boss';
import type { Tx } from '../db/client.ts';

export interface JobPayloads {
  /** Отрисовать и отправить билеты в чат, закрепить первое сообщение. */
  'tickets.send': {
    userId: number;
    participantIds: number[];
    /** updated - поменялись данные на QR (вариант, ФИО): тот же код, новая картинка и подпись. */
    reason: 'registered' | 'resend' | 'claimed' | 'reissued' | 'linked' | 'found' | 'restored' | 'updated';
  };
  /** «Добро пожаловать» после первой отметки на входе. */
  'checkin.welcome': { participantId: number };
  /** Продвинули из листа ожидания. */
  'activity.promoted': { activityId: number; participantIds: number[] };
  /** Напоминание за 15 минут; при запуске сверяем, что начало не перенесли. */
  'activity.reminder': { activityId: number; startsAt: string };
  /** Перенос или отмена - уведомить записавшихся. */
  'activity.changed': { activityId: number; change: 'moved' | 'cancelled' | 'place' };
  /** Опубликовали залы семинаров - записавшимся на эти темы сообщить зал. */
  'seminar.rooms': { blockId: number; topicIds: number[] };
  /** Опубликовали распределение семинаров - каждому аккаунту его семинары с залами. */
  'seminar.assigned': { participantIds: number[] };
  /** Записались на душепопечение - подтверждение в бот. */
  'counseling.booked': { bookingId: number };
  /** Напоминание за 15 минут; при запуске сверяем, что запись та же. */
  'counseling.reminder': { bookingId: number; slotStart: string };
  /** «Напомнить всем»: записанным (к одному служителю или ко всем) - их время, служитель и место. `at` - когда нажали. */
  'counseling.announce': { counselorId: number | null; at: string };
  'broadcast.run': { broadcastId: number };
  'receipt.reviewed': { receiptId: number; notAccepted?: number[] };
  /** Черновик чека на нескольких людей так и не отправили - напомнить через 15 минут. */
  'receipt.draft_reminder': { receiptId: number };
  /** Оплату приняли (касса, админка) - сообщить владельцу аккаунта и держателю QR-кода. */
  'payment.confirmed': { participantIds: number[]; method: 'cash' | 'card' | 'transfer'; amounts: Record<string, string>; donation?: string };
  /** Пересобрать список команд `/` для чата пользователя (после смены ролей). */
  'user.commands': { userId: number };
  /** Произвольное текстовое уведомление пользователю. */
  /** `kind` - для журнала сообщений: «merch.notice», «counseling.changed» (см. BOT_KINDS). */
  'notify.text': { userId: number; text: string; kind?: string };
  /** Сообщение команды в переписке - в бот участнику (текст или фото с подписью). */
  'chat.deliver': { messageId: number };
  'chat.merch_notify': { messageId: number };
  /** Обычное сообщение участника (не «Мерч») - копия в бот админам и суперадминам, кому включено. */
  'chat.notify': { messageId: number };
  /** Напоминание оставить отзыв: картинка, текст, кнопка. userIds - только им (проверка), иначе всем, кто ещё не оставил. */
  'feedback.remind': { userIds?: number[] };
  /** Копия файла чека из Telegram - к нам в закрытую папку. */
  'receipt.archive': { receiptId: number };
  /** Раз в 10 минут: копии всех чеков, у которых её ещё нет (старые и не скачавшиеся с первого раза). */
  'receipt.archive_missing': Record<string, never>;
  /** Подтянуть фото профиля из Telegram для списка переписок. */
  'chat.avatar': { userId: number };
  /** Срок брони мерча вышел - снять, если так и не оплатили. */
  'merch.expire': { orderId: number };
  /** Раз в минуту: подошло время «Точно заберёте?» из настроек мерча - запускаем вопрос (один раз на это время). */
  /** Прислали чек за мерч - продавцам в бот: проверьте и подтвердите оплату. */
  'merch.receipt_notify': { receiptId: number };
  'merch.confirm_tick': Record<string, never>;
  /** «Точно заберёте?» всем с неоплаченной бронью; `at` - время вопроса из настроек (по нему же - кого уже спросили). */
  'merch.confirm_ask': { at: string };
  /** Время ответа вышло: не ответили - снять бронь. `askedAt` - именно этот вопрос (на новый ждём заново). */
  'merch.confirm_drop': { orderId: number; askedAt: string };
  /** Игра: приглашение «Будешь участвовать?» всем, кому положено и кто ещё не ответил. */
  /** `userIds` - только этим аккаунтам (новый человек в тест-листе), иначе всем, кому положено. */
  'game.invite': { userIds?: number[] };
  /** Игра: «Показать задания» - каждой команде её задание, страна и флаг. */
  'game.tasks_revealed': Record<string, never>;
  /** Игра: «Ты в команде …» (капитану - отдельно). */
  'game.assigned': { participantIds: number[] };
  /** Игра: таймер раунда вышел - закрыть, если не продлили. */
  'game.round_close': { roundId: number; closesAt: string };
  /** Игра: открылось голосование - сообщить игрокам (по настройке). */
  'game.round_notify': { roundId: number };
  /** Игра: открыть/закрыть запись или распределить по расписанию (время сверяется при запуске). */
  'game.schedule': { key: 'signupOpensAt' | 'signupClosesAt' | 'distributeAt'; at: string };
}

export type QueueName = keyof JobPayloads;

export const QUEUE_NAMES = [
  'tickets.send',
  'checkin.welcome',
  'activity.promoted',
  'activity.reminder',
  'activity.changed',
  'seminar.rooms',
  'seminar.assigned',
  'counseling.booked',
  'counseling.reminder',
  'counseling.announce',
  'broadcast.run',
  'receipt.reviewed',
  'receipt.draft_reminder',
  'payment.confirmed',
  'user.commands',
  'notify.text',
  'chat.deliver',
  'chat.merch_notify',
  'chat.notify',
  'feedback.remind',
  'receipt.archive',
  'receipt.archive_missing',
  'chat.avatar',
  'merch.expire',
  'merch.receipt_notify',
  'merch.confirm_tick',
  'merch.confirm_ask',
  'merch.confirm_drop',
  'game.invite',
  'game.assigned',
  'game.tasks_revealed',
  'game.round_close',
  'game.round_notify',
  'game.schedule',
] as const satisfies readonly QueueName[];

export function createBoss(connectionString: string, opts: { worker: boolean }): PgBoss {
  // Процесс API только ставит задачи: обслуживание и расписание крутит bot-worker.
  return new PgBoss({
    connectionString,
    application_name: opts.worker ? 'sof-boss-worker' : 'sof-boss-api',
    max: opts.worker ? 4 : 2,
    supervise: opts.worker,
    schedule: opts.worker,
  });
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of QUEUE_NAMES) {
    // Билеты и рассылки - больше попыток: временные сбои сети и Telegram (шаги задач идемпотентны).
    const options = {
      retryLimit: name === 'broadcast.run' ? 10 : name === 'tickets.send' ? 8 : 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: name === 'broadcast.run' ? 3600 : 300,
    };
    const existing = await boss.getQueue(name);
    if (!existing) await boss.createQueue(name, options);
    // Уже созданную очередь обновляем: иначе новые настройки до развёрнутой базы не доедут.
    else await boss.updateQueue(name, options);
  }
}

/** Ставит задачу; с `tx` - атомарно с транзакцией (задача появится, только если она закоммитится). */
export async function enqueue<Q extends QueueName>(
  boss: PgBoss,
  name: Q,
  data: JobPayloads[Q],
  opts: { tx?: Tx; startAfter?: Date | number; singletonKey?: string } = {},
): Promise<string | null> {
  const options: SendOptions = {};
  if (opts.tx) options.db = fromDrizzle(opts.tx as never, sql as never);
  if (opts.startAfter !== undefined) options.startAfter = opts.startAfter;
  if (opts.singletonKey) options.singletonKey = opts.singletonKey;
  return boss.send(name, data as object, options);
}
