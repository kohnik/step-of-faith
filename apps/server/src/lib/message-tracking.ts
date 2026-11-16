import { sql } from 'drizzle-orm';
import { GrammyError, type Api } from 'grammy';
import { schema, type DbLike } from '../db/client.ts';

/** Методы, которые создают сообщение в чате. */
const SEND_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendMediaGroup',
  'sendVideo',
  'sendAnimation',
  'sendVoice',
  'sendAudio',
  'sendSticker',
  'sendContact',
  'sendLocation',
  'copyMessage',
  'forwardMessage',
]);

/** Номера храним чуть дольше 48 часов: моложе Telegram даёт боту удалять, старше - уже нет. */
const KEEP_HOURS = 49;
/** При очистке берём с запасом на время самой очистки. */
export const DELETABLE_HOURS = 47;

let sincePrune = 0;

/**
 * Запомнить номера сообщений личного чата с ботом - входящих и исходящих. По ним «Очистить всю базу»
 * удаляет переписку. Примерно раз в сотню записей убираем то, что старше двух суток.
 */
export async function rememberMessages(db: DbLike, chatId: number, messageIds: number[]): Promise<void> {
  const ids = messageIds.filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!(chatId > 0) || ids.length === 0) return;
  await db
    .insert(schema.chatMessages)
    .values(ids.map((messageId) => ({ chatId, messageId })))
    .onConflictDoNothing();
  sincePrune += 1;
  if (sincePrune >= 100) {
    sincePrune = 0;
    await db.delete(schema.chatMessages).where(sql`${schema.chatMessages.at} < now() - make_interval(hours => ${KEEP_HOURS})`);
  }
}

/** Запоминаем номера исходящих сообщений в личных чатах (id чата с пользователем > 0). Ошибки не мешают отправке. */
export function trackOutgoingMessages(api: Api, db: DbLike): void {
  api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (!res.ok) return res;
    const chatId = Number((payload as { chat_id?: unknown }).chat_id);
    if (!(chatId > 0)) return res;
    if (SEND_METHODS.has(method)) {
      const result = res.result as unknown;
      const ids = (Array.isArray(result) ? result : [result]).map((m) => Number((m as { message_id?: unknown } | null)?.message_id));
      void rememberMessages(db, chatId, ids).catch(() => {});
    } else if (method === 'pinChatMessage') {
      // Закрепление оставляет в чате служебную строку «… закрепил(а)» - обычно со следующим номером.
      const pinned = Number((payload as { message_id?: unknown }).message_id);
      void rememberMessages(db, chatId, [pinned + 1]).catch(() => {});
    }
    return res;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Удалить в личном чате сообщения с этими номерами: новые вперёд, пачками по 100. Если Telegram отказал
 * всей пачке (в ней есть сообщение, которое удалить нельзя), делим её пополам - остальное удалится.
 * Ненайденные номера Telegram пропускает сам. Возвращает, сколько номеров ушло в успешные запросы.
 */
export async function wipeChat(api: Api, chatId: number, messageIds: number[], { pauseMs = 40, maxRequests = 300 } = {}): Promise<number> {
  await api.unpinAllChatMessages(chatId).catch(() => {});
  const ids = [...new Set(messageIds)].sort((a, b) => b - a);
  let budget = maxRequests;
  let deleted = 0;
  const run = async (part: number[]): Promise<void> => {
    if (part.length === 0 || budget <= 0) return;
    budget -= 1;
    try {
      await api.deleteMessages(chatId, part);
      deleted += part.length;
    } catch (err) {
      const code = err instanceof GrammyError ? err.error_code : 0;
      if (code === 429) {
        await sleep(((err as GrammyError).parameters.retry_after ?? 1) * 1000);
        return run(part);
      }
      // Бот заблокирован или чата нет - дальше в этом чате делать нечего.
      if (code === 403) throw err;
      if (part.length === 1) return;
      const mid = Math.ceil(part.length / 2);
      await run(part.slice(0, mid));
      await run(part.slice(mid));
      return;
    }
    if (pauseMs) await sleep(pauseMs);
  };
  for (let i = 0; i < ids.length; i += 100) await run(ids.slice(i, i + 100));
  return deleted;
}
