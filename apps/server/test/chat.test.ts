import { randomUUID } from 'node:crypto';
import { sign } from '@tma.js/init-data-node';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Api } from 'grammy';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { runJob } from '../src/jobs/workers.ts';
import {
  isMerchText,
  listThreads,
  searchPeople,
  staffMarkRead,
  staffThread,
  staffWrites,
  unreadThreadsCount,
  userHistory,
  userMarkRead,
  userUnread,
  userWrites,
} from '../src/services/chat.service.ts';
import { savePhoto } from '../src/services/media.service.ts';
import { merchNotifyPeople } from '../src/services/merch.service.ts';
import { chatNotifyPeople } from '../src/services/chat.service.ts';
import { getSettings, invalidateSettingsCache, patchSettings } from '../src/services/settings.service.ts';
import { createSession } from '../src/services/sessions.service.ts';
import type { UserRow } from '../src/services/users.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
});
afterAll(async () => {
  await app?.close();
  await env?.teardown();
});

const tma = (u: UserRow) => `tma ${sign({ user: { id: u.tgId!, first_name: 'Тест', allows_write_to_pm: true } } as never, env.config.BOT_TOKEN, new Date())}`;
const bearer = async (userId: number) => `Bearer ${(await createSession(env.db, userId, 'web', 1)).token}`;

/** Подставной Telegram: запоминает вызовы, фото профиля - одно, если `withAvatar`. */
function fakeTg(withAvatar = false) {
  const calls: { method: string; p: Record<string, unknown> }[] = [];
  const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
  tg.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls.push({ method, p });
    const chat = { id: p.chat_id as number, type: 'private' };
    if (method === 'getUserProfilePhotos') {
      return { ok: true, result: { total_count: withAvatar ? 1 : 0, photos: [] } } as never;
    }
    return { ok: true, result: { message_id: calls.length, date: 0, chat, text: '' } } as never;
  });
  return { tg, calls };
}

describe('переписка с организаторами', () => {
  it('участник пишет - у команды непрочитанное; команда отвечает с картинкой - в бот с кнопкой «Ответить»', async () => {
    const admin = await makeStaff(env, ['admin']);
    const owner = await makeUser(env);
    await makeParticipant(env, owner, { lastName: 'Перепискин', firstName: 'Олег' });

    await userWrites(env.db, owner, 'Во сколько начало?');
    await userWrites(env.db, owner, 'И где парковка?');
    const before = await unreadThreadsCount(env.db);
    const thread = (await listThreads(env)).find((t) => t.userId === owner.id)!;
    expect(thread).toMatchObject({ name: 'Перепискин Олег', unread: 2, lastText: 'И где парковка?', lastFromStaff: false });
    expect((await listThreads(env, { search: 'перепис' })).map((t) => t.userId)).toContain(owner.id);
    expect((await listThreads(env, { search: 'никого-такого' })).length).toBe(0);

    await staffMarkRead(env.db, owner.id);
    expect(await unreadThreadsCount(env.db)).toBe(before - 1);

    // Картинка: сохраняем как при загрузке, отправляем с подписью.
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).png().toBuffer();
    const saved = await savePhoto(env.config.PRIVATE_DIR, 'chat', png, 'image/png');
    const sent = await staffWrites(env, admin, owner.id, { text: 'В 10:00. Парковка - вот схема', photo: saved.file });
    expect(sent).toMatchObject({ fromStaff: true, photo: true, delivery: null });
    expect(await userUnread(env.db, owner.id)).toBe(1);

    const { tg, calls } = fakeTg();
    await runJob({ ...env, tg }, 'chat.deliver', { messageId: sent.id }, randomUUID());
    const photo = calls.find((c) => c.method === 'sendPhoto')!;
    expect(String(photo.p.caption)).toContain('Организаторы');
    expect(String(photo.p.caption)).toContain('В 10:00. Парковка - вот схема');
    expect(JSON.stringify(photo.p.reply_markup)).toContain('v1:ask');
    const row = await env.db.query.supportMessages.findFirst({ where: eq(schema.supportMessages.id, sent.id) });
    expect(row!.delivery).toBe('sent');

    // История по порядку, автор ответа виден команде.
    const view = await staffThread(env, owner.id, null);
    expect(view.messages.map((m) => m.text)).toEqual(['Во сколько начало?', 'И где парковка?', 'В 10:00. Парковка - вот схема']);
    expect(view.messages.at(-1)!.author).toBeTruthy();
    expect(view.person.botNote).toBeNull();

    // Участник прочитал - счётчик обнулился; картинку видит только он.
    await userMarkRead(env.db, owner.id);
    expect(await userUnread(env.db, owner.id)).toBe(0);
    expect((await userHistory(env.db, owner.id, null)).messages).toHaveLength(3);
    const mine = await app.inject({ method: 'GET', url: `/api/messages/${sent.id}/photo`, headers: { authorization: tma(owner) } });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toBe('image/webp');
    const stranger = await makeUser(env);
    const other = await app.inject({ method: 'GET', url: `/api/messages/${sent.id}/photo`, headers: { authorization: tma(stranger) } });
    expect(other.statusCode).toBe(404);
  });

  it('команда пишет первой: поиск человека, нет Telegram - пометка; остановил бота - «не доставлено»', async () => {
    const admin = await makeStaff(env, ['admin']);
    const owner = await makeUser(env);
    await makeParticipant(env, owner, { lastName: 'Первонаписанный', firstName: 'Иван' });
    const found = await searchPeople(env.db, 'первонапис');
    expect(found.map((p) => p.userId)).toContain(owner.id);

    await env.db.update(schema.users).set({ botBlocked: true }).where(eq(schema.users.id, owner.id));
    const m = await staffWrites(env, admin, owner.id, { text: 'Здравствуйте! Подтвердите, пожалуйста, приезд.' });
    expect((await staffThread(env, owner.id, null)).person.botNote).toContain('Остановил бота');
    const { tg, calls } = fakeTg();
    await runJob({ ...env, tg }, 'chat.deliver', { messageId: m.id }, randomUUID());
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    const row = await env.db.query.supportMessages.findFirst({ where: eq(schema.supportMessages.id, m.id) });
    expect(row!.delivery).toBe('blocked');
    // В приложении сообщение всё равно видно.
    expect((await userHistory(env.db, owner.id, null)).messages.at(-1)!.text).toContain('Подтвердите');
  });

  it('через API: участник пишет и читает, команда видит счётчик и отвечает; лимит сообщений', async () => {
    const admin = await makeStaff(env, ['admin']);
    const owner = await makeUser(env);
    const post = (text: string) => app.inject({ method: 'POST', url: '/api/messages', headers: { authorization: tma(owner) }, payload: { text } });
    expect((await post('Привет!')).statusCode).toBe(200);
    const auth = await bearer(admin.user.id);
    const count = (await app.inject({ method: 'GET', url: '/api/admin/chats/count', headers: { authorization: auth } })).json() as { unread: number };
    expect(count.unread).toBeGreaterThan(0);
    const reply = await app.inject({
      method: 'POST',
      url: `/api/admin/chats/${owner.id}/messages`,
      headers: { authorization: auth },
      payload: { text: 'Здравствуйте!' },
    });
    expect(reply.statusCode).toBe(200);
    const unread = (await app.inject({ method: 'GET', url: '/api/messages/unread', headers: { authorization: tma(owner) } })).json() as {
      unread: number;
    };
    expect(unread.unread).toBe(1);
    // Пустое сообщение команды не проходит.
    const empty = await app.inject({ method: 'POST', url: `/api/admin/chats/${owner.id}/messages`, headers: { authorization: auth }, payload: {} });
    expect(empty.statusCode).toBe(400);

    for (let i = 0; i < 19; i++) await userWrites(env.db, owner, `Ещё ${i}`);
    await expect(userWrites(env.db, owner, 'Двадцать первое')).rejects.toMatchObject({ code: 'too_many_messages' });
  });

  it('фото профиля: нет фото - отметка «проверено», без ошибки', async () => {
    const owner = await makeUser(env);
    const { tg } = fakeTg(false);
    await runJob({ ...env, tg }, 'chat.avatar', { userId: owner.id }, randomUUID());
    const row = await env.db.query.users.findFirst({ where: eq(schema.users.id, owner.id) });
    expect(row!.avatar).toBeNull();
    expect(row!.avatarCheckedAt).not.toBeNull();
  });

  it('папка «Мерч»: кнопка из раздела «Мерч» и слова про мерч; продавец видит и отвечает только там', async () => {
    expect(['Какие размеры футболок?', 'Хочу забронировать лонгслив', 'код M-4821', 'код м-4821', 'есть мерч?'].every(isMerchText)).toBe(true);
    expect(['Где обед?', 'Когда начало?', 'Как оплатить взнос?'].some(isMerchText)).toBe(false);
    // Сумма и завтрак - не мерч; «лонг» - мерч.
    expect(['Оплатила взнос в размере 35 рублей', 'добавил предзаказ завтрака', 'В размере 10 руб.'].some(isMerchText)).toBe(false);
    expect(['хочу самый крутой лонг?', 'Какой размер есть?', 'предзаказ худи'].every(isMerchText)).toBe(true);

    const [general, byButton, byWords] = [await makeUser(env), await makeUser(env), await makeUser(env)];
    const post = (u: UserRow, payload: object) => app.inject({ method: 'POST', url: '/api/messages', headers: { authorization: tma(u) }, payload });
    await post(general, { text: 'Где будет обед?' });
    await post(byButton, { text: 'Здравствуйте', topic: 'merch' });
    await post(byWords, { text: 'Остались футболки M?' });

    const merch = (await listThreads(env, { folder: 'merch' })).map((t) => t.userId);
    expect(merch).toEqual(expect.arrayContaining([byButton.id, byWords.id]));
    expect(merch).not.toContain(general.id);
    expect((await listThreads(env, { folder: 'other' })).map((t) => t.userId)).toContain(general.id);

    const seller = await bearer((await makeStaff(env, ['seller'])).user.id);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/chats', headers: { authorization: seller } })).json() as { userId: number; topic: string | null }[];
    expect(list.every((t) => t.topic === 'merch')).toBe(true);
    expect(list.map((t) => t.userId)).toContain(byButton.id);
    expect((await app.inject({ method: 'GET', url: `/api/admin/chats/${general.id}`, headers: { authorization: seller } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/admin/chats/${general.id}/messages`, headers: { authorization: seller }, payload: { text: 'Привет' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/admin/chats/${byButton.id}/messages`, headers: { authorization: seller }, payload: { text: 'Есть все размеры' } })).statusCode).toBe(200);
    // Продавец пишет первым новому человеку - переписка сразу в «Мерче».
    const fresh = await makeUser(env);
    expect((await app.inject({ method: 'POST', url: `/api/admin/chats/${fresh.id}/messages`, headers: { authorization: seller }, payload: { text: 'Ваша бронь готова' } })).statusCode).toBe(200);
    expect((await listThreads(env, { folder: 'merch' })).map((t) => t.userId)).toContain(fresh.id);
    // Папку меняет только тот, кто видит все переписки.
    expect((await app.inject({ method: 'PUT', url: `/api/admin/chats/${general.id}/topic`, headers: { authorization: seller }, payload: { topic: 'merch' } })).statusCode).toBe(403);
    const admin = await bearer((await makeStaff(env, ['admin'])).user.id);
    expect((await app.inject({ method: 'PUT', url: `/api/admin/chats/${general.id}/topic`, headers: { authorization: admin }, payload: { topic: 'merch' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/admin/chats/${general.id}`, headers: { authorization: seller } })).statusCode).toBe(200);
  });

  it('копии из папки «Мерч» в бот: продавцам - да, админам - нет, отметки в настройках меняют это; не из «Мерча» - никому', async () => {
    const seller = await makeStaff(env, ['seller'], 'Продавец Аня');
    const quiet = await makeStaff(env, ['seller'], 'Продавец Тихий');
    const admin = await makeStaff(env, ['admin'], 'Админ Боря');
    const people = await merchNotifyPeople(env.db, await getSettings(env.db, { fresh: true }));
    expect(people.find((p) => p.userId === seller.user.id)).toMatchObject({ on: true, roles: ['seller'] });
    expect(people.find((p) => p.userId === admin.user.id)).toMatchObject({ on: false, roles: ['admin'] });
    await patchSettings(env.db, { merchNotify: { [String(quiet.user.id)]: false, [String(admin.user.id)]: true } }, admin.user.id);
    invalidateSettingsCache();

    const owner = await makeUser(env);
    const { tg, calls } = fakeTg();
    const sentTo = () => new Set(calls.filter((c) => c.method === 'sendMessage').map((c) => c.p.chat_id));
    const m = await userWrites(env.db, owner, 'Есть худи размера L?', { topic: 'merch' });
    await runJob({ ...env, tg }, 'chat.merch_notify', { messageId: m.id }, randomUUID());
    expect([...sentTo()]).toEqual(expect.arrayContaining([seller.user.tgId, admin.user.tgId]));
    expect(sentTo().has(quiet.user.tgId)).toBe(false);
    const copy = calls.find((c) => c.method === 'sendMessage' && c.p.chat_id === seller.user.tgId)!;
    expect(String(copy.p.text)).toContain('Есть худи размера L?');
    expect(JSON.stringify(copy.p.reply_markup)).toContain(`/messages/${owner.id}`);

    // Обычная переписка (не «Мерч») - копий нет.
    calls.length = 0;
    const other = await makeUser(env);
    const q = await userWrites(env.db, other, 'Во сколько начало?');
    await runJob({ ...env, tg }, 'chat.merch_notify', { messageId: q.id }, randomUUID());
    expect(sentTo().size).toBe(0);
  });

  it('обычные сообщения - копия админам и суперадминам (по умолчанию всем), выключенному - нет; «Мерч» - не сюда', async () => {
    const a1 = await makeStaff(env, ['admin'], 'Админ Вера');
    const off = await makeStaff(env, ['superadmin'], 'Супер Тихий');
    const seller = await makeStaff(env, ['seller'], 'Продавец Петя');
    const people = await chatNotifyPeople(env.db, await getSettings(env.db, { fresh: true }));
    expect(people.find((p) => p.userId === a1.user.id)).toMatchObject({ on: true, roles: ['admin'] });
    expect(people.some((p) => p.userId === seller.user.id)).toBe(false);
    await patchSettings(env.db, { chatNotify: { [String(off.user.id)]: false } }, a1.user.id);
    invalidateSettingsCache();

    const { tg, calls } = fakeTg();
    const sentTo = () => new Set(calls.filter((c) => c.method === 'sendMessage').map((c) => c.p.chat_id));
    const owner = await makeUser(env);
    const q = await userWrites(env.db, owner, 'Где проходит ужин?');
    await runJob({ ...env, tg }, 'chat.notify', { messageId: q.id }, randomUUID());
    expect(sentTo().has(a1.user.tgId)).toBe(true);
    expect(sentTo().has(off.user.tgId)).toBe(false);
    expect(sentTo().has(seller.user.tgId)).toBe(false);
    const copy = calls.find((c) => c.method === 'sendMessage' && c.p.chat_id === a1.user.tgId)!;
    expect(String(copy.p.text)).toContain('Где проходит ужин?');
    expect(JSON.stringify(copy.p.reply_markup)).toContain(`/messages/${owner.id}`);

    // Переписка в «Мерче» - сюда копий нет (их получают продавцы).
    calls.length = 0;
    const buyer = await makeUser(env);
    const m = await userWrites(env.db, buyer, 'Есть худи M?', { topic: 'merch' });
    await runJob({ ...env, tg }, 'chat.notify', { messageId: m.id }, randomUUID());
    expect(sentTo().size).toBe(0);
  });
});
