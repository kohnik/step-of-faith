/**
 * Бот с поддельным Telegram API: исходящие запросы записываются, апдейты подаём сами.
 * Так проверяем настоящие обработчики (кнопки, чеки) без сети и без настоящего токена.
 */
import type { Update } from 'grammy/types';
import { createBot } from '../src/bot/bot.ts';
import type { TestEnv } from './helpers.ts';

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

let updateSeq = 1;
let messageSeq = 1000;

export function makeTestBot(env: TestEnv) {
  const bot = createBot(env);
  const calls: ApiCall[] = [];
  bot.botInfo = {
    id: 42,
    is_bot: true,
    first_name: 'Test bot',
    username: 'test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as never;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as Record<string, unknown>;
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'editMessageText') {
      result = { message_id: (p.message_id as number | undefined) ?? ++messageSeq, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text };
    }
    return { ok: true, result } as never;
  });

  const usernames = new Map<number, string>();
  const from = (tgId: number) => ({ id: tgId, is_bot: false, first_name: `U${tgId}`, username: usernames.get(tgId) });
  const chat = (tgId: number) => ({ id: tgId, type: 'private' as const, first_name: `U${tgId}` });

  return {
    bot,
    calls,
    /** Ник в Telegram для этого пользователя (для привязки по нику). */
    setUsername: (tgId: number, username: string) => usernames.set(tgId, username),
    /** Сбросить записанные вызовы. */
    reset: () => calls.splice(0),
    async text(tgId: number, text: string) {
      const cmd = /^\/\w+/.exec(text);
      const entities = cmd ? [{ type: 'bot_command' as const, offset: 0, length: cmd[0].length }] : undefined;
      await bot.handleUpdate({ update_id: updateSeq++, message: { message_id: ++messageSeq, date: 0, chat: chat(tgId), from: from(tgId), text, entities } } as Update);
    },
    async photo(tgId: number, fileUniqueId: string) {
      await bot.handleUpdate({
        update_id: updateSeq++,
        message: {
          message_id: ++messageSeq,
          date: 0,
          chat: chat(tgId),
          from: from(tgId),
          photo: [{ file_id: `file-${fileUniqueId}`, file_unique_id: fileUniqueId, width: 100, height: 100 }],
        },
      } as Update);
    },
    /** Файл (документ): картинка, PDF, HEIC… */
    async document(tgId: number, fileUniqueId: string, fileName: string, mimeType?: string, fileSize = 200_000) {
      await bot.handleUpdate({
        update_id: updateSeq++,
        message: {
          message_id: ++messageSeq,
          date: 0,
          chat: chat(tgId),
          from: from(tgId),
          document: { file_id: `file-${fileUniqueId}`, file_unique_id: fileUniqueId, file_name: fileName, mime_type: mimeType, file_size: fileSize },
        },
      } as Update);
    },
    /** Контакт: кнопка «Поделиться номером» присылает свой (userId = tgId), из записной книжки - чужой. */
    async contact(tgId: number, userId: number | undefined, phone: string) {
      await bot.handleUpdate({
        update_id: updateSeq++,
        message: {
          message_id: ++messageSeq,
          date: 0,
          chat: chat(tgId),
          from: from(tgId),
          contact: { phone_number: phone, first_name: `U${tgId}`, user_id: userId },
        },
      } as Update);
    },
    /** Нажатие inline-кнопки под сообщением `messageId`. */
    async tap(tgId: number, messageId: number, data: string) {
      await bot.handleUpdate({
        update_id: updateSeq++,
        callback_query: {
          id: String(updateSeq),
          from: from(tgId),
          chat_instance: 'x',
          data,
          message: { message_id: messageId, date: 0, chat: chat(tgId), from: { id: 42, is_bot: true, first_name: 'Test bot' }, text: '…' },
        },
      } as Update);
    },
    /** Служебное сообщение «бот закрепил сообщение» (приходит от самого бота). */
    async pinnedService(tgId: number) {
      await bot.handleUpdate({
        update_id: updateSeq++,
        message: {
          message_id: ++messageSeq,
          date: 0,
          chat: chat(tgId),
          from: { id: 42, is_bot: true, first_name: 'Test bot' },
          pinned_message: { message_id: 1, date: 0, chat: chat(tgId) },
        },
      } as Update);
    },
  };
}

/** Кнопки последнего сообщения/правки: [текст, callback_data]. */
export function buttonsOf(call: ApiCall | undefined): [string, string][] {
  const kb = (call?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
  return kb.flat().map((b) => [b.text, b.callback_data ?? '']);
}
