import { CHAT_MARKS, chatNotifyPatchSchema, chatStaffSendSchema, chatUserSendSchema, type ChatNotifyView, type Permission } from '@sof/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.ts';
import {
  avatarOf,
  chatNotifyPeople,
  forgetAvatar,
  listThreads,
  photoThumb,
  searchMessages,
  searchPeople,
  staffMarkRead,
  staffMarkUnread,
  setThreadMark,
  staffPhoto,
  staffThread,
  staffWrites,
  unreadThreadsCount,
  assertMerchThread,
  messageOwner,
  setThreadTopic,
  userHistory,
  userMarkRead,
  userPhoto,
  userUnread,
  userWrites,
} from '../../services/chat.service.ts';
import { merchRequestItems } from '../../services/merch.service.ts';
import { getSettings, patchSettings } from '../../services/settings.service.ts';
import { PHOTO_MAX_BYTES, readStored, savePhoto } from '../../services/media.service.ts';
import { requireParticipant, requireStaff } from '../auth.ts';
import { idParam, oneFile, parse, tooManyRequests, UserRateLimiter } from '../http.ts';

const sendLimiter = new UserRateLimiter(10, 0.5);

/** Номер сообщения, раньше которого подгружать (листаем вверх). */
const beforeOf = (req: FastifyRequest) => {
  const n = Number((req.query as Record<string, string | undefined>).before);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Переписка с организаторами: участник - в приложении, команда - в админке (права как у вопросов). */
export function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireParticipant(ctx) };
  const need = (...perms: Permission[]) => ({ preHandler: requireStaff(ctx, perms) });
  const me = (req: FastifyRequest) => req.tgUser!;
  const staff = (req: FastifyRequest) => req.staff!;
  const { PRIVATE_DIR } = ctx.config;
  const sendImage = async (reply: FastifyReply, file: string, thumb: boolean) =>
    reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'private, max-age=86400')
      .send(await readStored(PRIVATE_DIR, thumb ? photoThumb(file) : file));

  // ---------- участник ----------

  app.get('/api/messages', auth, async (req) => userHistory(ctx.db, me(req).id, beforeOf(req)));

  // Копии обычных сообщений участников в бот: кому из админов слать (по умолчанию - всем).
  app.get('/api/admin/chat-notify', need('settings:write'), async (): Promise<ChatNotifyView> => ({
    people: await chatNotifyPeople(ctx.db, await getSettings(ctx.db, { fresh: true })),
  }));
  app.patch('/api/admin/chat-notify', need('settings:write'), async (req): Promise<ChatNotifyView> => {
    const { chatNotify } = parse(chatNotifyPatchSchema, req.body);
    const current = await getSettings(ctx.db, { fresh: true });
    const next = await patchSettings(ctx.db, { chatNotify: { ...current.chatNotify, ...chatNotify } }, staff(req).user.id);
    return { people: await chatNotifyPeople(ctx.db, next) };
  });
  app.get('/api/messages/unread', auth, async (req) => ({ unread: await userUnread(ctx.db, me(req).id) }));
  app.post('/api/messages', auth, async (req) => {
    if (!sendLimiter.take(`u:${me(req).id}`)) throw tooManyRequests();
    const body = parse(chatUserSendSchema, req.body);
    // Заявка на бронь из «Мерча»: вещи проверяем сразу, бронирует потом продавец.
    const merch = body.items?.length ? await merchRequestItems(ctx.db, me(req), body.items) : undefined;
    return userWrites(ctx.db, me(req), body.text, { topic: body.topic, merch, boss: ctx.boss });
  });
  app.post('/api/messages/read', auth, async (req) => {
    await userMarkRead(ctx.db, me(req).id);
    return { ok: true };
  });
  app.get('/api/messages/:id/photo', auth, async (req, reply) =>
    sendImage(reply, await userPhoto(ctx.db, me(req).id, idParam(req.params)), (req.query as Record<string, string>).thumb === '1'),
  );

  // ---------- команда ----------

  // Сообщения видят те, кто ведёт контент, и продавцы мерча - но продавцы только папку «Мерч».
  const chats = need('content:write', 'merch:sell');
  const merchOnly = (req: FastifyRequest) => !staff(req).permissions.includes('content:write');
  /** Продавцу - только переписки из «Мерча». */
  const access = async (req: FastifyRequest, userId: number) => {
    if (merchOnly(req)) await assertMerchThread(ctx.db, userId);
  };

  app.get('/api/admin/chats', chats, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const folder = merchOnly(req) ? 'merch' : q.folder === 'merch' || q.folder === 'other' ? q.folder : undefined;
    return listThreads(ctx, { search: q.q?.slice(0, 80), unread: q.unread === '1', marked: q.marked === '1', folder });
  });
  app.get('/api/admin/chats/search', chats, async (req) =>
    searchMessages(ctx, String((req.query as Record<string, string | undefined>).q ?? '').slice(0, 80), { merchOnly: merchOnly(req) }),
  );
  app.get('/api/admin/chats/count', chats, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { unread: await unreadThreadsCount(ctx.db, { merchOnly: merchOnly(req) || q.folder === 'merch' }) };
  });
  app.get('/api/admin/chats/people', chats, async (req) =>
    searchPeople(ctx.db, String((req.query as Record<string, string | undefined>).q ?? '').slice(0, 80)),
  );
  /** Картинка к сообщению: сжимаем и кладём в закрытую папку, сообщение потом ссылается на файл. */
  app.post('/api/admin/chats/upload', chats, async (req) => {
    const { data, mime } = await oneFile(req, PHOTO_MAX_BYTES);
    const saved = await savePhoto(PRIVATE_DIR, 'chat', data, mime);
    return { photo: saved.file };
  });
  app.get('/api/admin/chats/photo/:id', chats, async (req, reply) => {
    const id = idParam(req.params);
    await access(req, await messageOwner(ctx.db, id));
    return sendImage(reply, await staffPhoto(ctx.db, id), (req.query as Record<string, string>).thumb === '1');
  });
  app.get('/api/admin/chats/upload/:hash', chats, async (req, reply) => {
    const hash = String((req.params as Record<string, string>).hash);
    if (!/^[0-9a-f]{20}$/.test(hash)) return reply.code(404).send({ error: 'not_found', message: 'Нет файла' });
    return sendImage(reply, `chat/${hash}.webp`, true);
  });
  app.get('/api/admin/chats/avatar/:id', chats, async (req, reply) => {
    const userId = idParam(req.params);
    const file = await avatarOf(ctx.db, userId);
    const data = await readStored(PRIVATE_DIR, file).catch(() => null);
    if (!data) {
      // Файла нет (потерялся при переезде) - забываем его: фото подтянется заново, а пока будут буквы.
      await forgetAvatar(ctx.db, userId);
      return reply.code(404).send({ error: 'not_found', message: 'Фото нет' });
    }
    return reply.header('Content-Type', 'image/webp').header('Cache-Control', 'private, max-age=3600').send(data);
  });
  app.get('/api/admin/chats/:id', chats, async (req) => {
    await access(req, idParam(req.params));
    return staffThread(ctx, idParam(req.params), beforeOf(req));
  });
  app.post('/api/admin/chats/:id/read', chats, async (req) => {
    await access(req, idParam(req.params));
    await staffMarkRead(ctx.db, idParam(req.params));
    return { ok: true };
  });
  app.post('/api/admin/chats/:id/unread', chats, async (req) => {
    await access(req, idParam(req.params));
    await staffMarkUnread(ctx.db, idParam(req.params));
    return { ok: true };
  });
  app.put('/api/admin/chats/:id/mark', chats, async (req) => {
    await access(req, idParam(req.params));
    const { mark } = parse(z.object({ mark: z.enum(CHAT_MARKS).nullable() }), req.body);
    await setThreadMark(ctx.db, idParam(req.params), mark);
    return { ok: true };
  });
  /** Папка: в «Мерч» или обратно в общие - только тем, кто видит все переписки. */
  app.put('/api/admin/chats/:id/topic', need('content:write'), async (req) => {
    const { topic } = parse(z.object({ topic: z.enum(['merch']).nullable() }), req.body);
    await setThreadTopic(ctx.db, idParam(req.params), topic);
    return { ok: true };
  });
  app.post('/api/admin/chats/:id/messages', chats, async (req) => {
    await access(req, idParam(req.params));
    return staffWrites(ctx, staff(req), idParam(req.params), parse(chatStaffSendSchema, req.body), { topic: merchOnly(req) ? 'merch' : undefined });
  });
}
