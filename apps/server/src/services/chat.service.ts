import type {
  ChatDelivery,
  ChatHistory,
  ChatMark,
  ChatMerchItem,
  ChatMerchItemView,
  ChatMerchRequest,
  ChatSearchHit,
  ChatMessageView,
  ChatPerson,
  ChatThreadRow,
  ChatThreadView,
  ChatTopic,
  ChatNotifyView,
  Settings,
} from '@sof/shared';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import type { PgBoss } from 'pg-boss';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { AppError, notFound } from '../lib/errors.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import { getSettings } from './settings.service.ts';
import type { UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;
type MessageRow = typeof schema.supportMessages.$inferSelect;

/** Сколько сообщений в час может написать участник - от случайного флуда. */
const PER_HOUR = 20;
const PAGE = 50;
/** Фото профиля перепроверяем раз в сутки. */
const AVATAR_TTL_MS = 24 * 3600_000;

/** Бот ждёт сообщение после кнопки «Задать вопрос» или «Ответить». */
export const QUESTION_WINDOW_MS = 20 * 60_000;

/** Превью картинки лежит рядом: chat/<хеш>-s.webp. */
export const photoThumb = (file: string) => file.replace(/\.webp$/, '-s.webp');

type OrderRef = NonNullable<ChatMerchRequest['order']>;

interface ViewExtras {
  authors?: Map<number, string>;
  orders?: Map<number, OrderRef>;
  /** Вещи из заявок: размер (variantId) → превью, вещь, цвет. */
  thumbs?: Map<number, Pick<ChatMerchItemView, 'thumbUrl' | 'detail'>>;
}

const toView = (m: MessageRow, { authors, orders, thumbs }: ViewExtras = {}): ChatMessageView => ({
  id: m.id,
  fromStaff: m.fromStaff,
  author: authors && m.authorId ? (authors.get(m.authorId) ?? null) : null,
  text: m.text,
  photo: m.photo !== null,
  createdAt: m.createdAt.toISOString(),
  delivery: m.delivery as ChatDelivery | null,
  merch: m.merchItems
    ? {
        items: m.merchItems.map((it) => ({ ...it, thumbUrl: null, detail: null, ...thumbs?.get(it.variantId) })),
        order: m.merchOrderId ? (orders?.get(m.merchOrderId) ?? null) : null,
      }
    : null,
});

/** Вещи из заявок: первое фото этого цвета (иначе общее фото вещи), вещь, цвет, размер - сразу видно, что просят. */
async function thumbsOf(db: DbLike, rows: MessageRow[]): Promise<Map<number, Pick<ChatMerchItemView, 'thumbUrl' | 'detail'>>> {
  const ids = [...new Set(rows.flatMap((r) => r.merchItems?.map((it) => it.variantId) ?? []))];
  if (ids.length === 0) return new Map();
  const variants = await db
    .select({
      id: schema.merchVariants.id,
      size: schema.merchVariants.size,
      colorId: schema.merchColors.id,
      color: schema.merchColors.name,
      hex: schema.merchColors.hex,
      productId: schema.merchColors.productId,
      product: schema.merchProducts.title,
    })
    .from(schema.merchVariants)
    .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
    .innerJoin(schema.merchProducts, eq(schema.merchProducts.id, schema.merchColors.productId))
    .where(inArray(schema.merchVariants.id, ids));
  const productIds = [...new Set(variants.map((v) => v.productId))];
  const photos = productIds.length
    ? await db
        .select()
        .from(schema.merchMedia)
        .where(and(inArray(schema.merchMedia.productId, productIds), eq(schema.merchMedia.kind, 'photo')))
        .orderBy(asc(schema.merchMedia.sort), asc(schema.merchMedia.id))
    : [];
  const out = new Map<number, Pick<ChatMerchItemView, 'thumbUrl' | 'detail'>>();
  for (const v of variants) {
    const own = photos.filter((p) => p.productId === v.productId);
    const m = own.find((p) => p.colorId === v.colorId) ?? own.find((p) => p.colorId === null) ?? own[0];
    out.set(v.id, { thumbUrl: m ? `/media/${m.thumb ?? m.file}` : null, detail: { product: v.product, color: v.color, hex: v.hex, size: v.size } });
  }
  return out;
}

/** Всё, что нужно сообщениям страницы: брони и превью по заявкам. */
async function extrasOf(db: DbLike, rows: MessageRow[]): Promise<Pick<ViewExtras, 'orders' | 'thumbs'>> {
  const [orders, thumbs] = await Promise.all([ordersOf(db, rows), thumbsOf(db, rows)]);
  return { orders, thumbs };
}

/** Брони по заявкам из переписки: код и статус - для карточки заявки. */
async function ordersOf(db: DbLike, rows: MessageRow[]): Promise<Map<number, OrderRef>> {
  const ids = [...new Set(rows.map((r) => r.merchOrderId).filter((x): x is number => x !== null))];
  if (ids.length === 0) return new Map();
  const [list, items, receipts] = await Promise.all([
    db
      .select({ id: schema.merchOrders.id, code: schema.merchOrders.code, status: schema.merchOrders.status })
      .from(schema.merchOrders)
      .where(inArray(schema.merchOrders.id, ids)),
    db
      .select({ orderId: schema.merchOrderItems.orderId, variantId: schema.merchOrderItems.variantId })
      .from(schema.merchOrderItems)
      .where(inArray(schema.merchOrderItems.orderId, ids)),
    db
      .select({ orderId: schema.paymentReceipts.merchOrderId })
      .from(schema.paymentReceipts)
      .where(and(inArray(schema.paymentReceipts.merchOrderId, ids), eq(schema.paymentReceipts.status, 'pending'))),
  ]);
  return new Map(
    list.map((o) => [
      o.id,
      { ...o, variantIds: items.filter((i) => i.orderId === o.id).map((i) => i.variantId), receiptPending: o.status === 'reserved' && receipts.some((r) => r.orderId === o.id) },
    ]),
  );
}

/** Имя: из регистрации «Я» («Фамилия Имя»), иначе из Telegram. */
export async function namesOf(db: DbLike, userIds: number[]): Promise<Map<number, { name: string; username: string | null }>> {
  const out = new Map<number, { name: string; username: string | null }>();
  if (userIds.length === 0) return out;
  const [users, selves] = await Promise.all([
    db.query.users.findMany({ where: inArray(schema.users.id, userIds) }),
    db.query.participants.findMany({
      where: and(
        inArray(schema.participants.ownerUserId, userIds),
        eq(schema.participants.relation, 'self'),
        eq(schema.participants.status, 'active'),
      ),
    }),
  ]);
  for (const u of users) {
    const tgName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.displayName || (u.username ? `@${u.username}` : 'Без имени');
    out.set(u.id, { name: tgName, username: u.username });
  }
  for (const p of selves) {
    const prev = out.get(p.ownerUserId);
    out.set(p.ownerUserId, { name: `${p.lastName} ${p.firstName}`, username: prev?.username ?? null });
  }
  return out;
}

/**
 * Сообщение про мерч: вещи, размеры, бронь, код выдачи «M-1234». Такая переписка уходит в папку «Мерч»
 * (сама обратно не уходит - вернуть можно вручную).
 * Не про мерч: «взнос в размере 35 рублей», «предзаказ завтрака».
 */
const MERCH_WORDS =
  /мерч|футболк|лонг|худи|свитшот|толстовк|майк[аиуе]|(?<!(?:^|[^\p{L}])в\s+)размер|предзаказ(?![\p{L}]*\s+завтрак)|брон[ьиюяе]|заброни|(?<![\p{L}\d])[mм]-?\d{4,5}(?!\d)/iu;
export const isMerchText = (text: string) => MERCH_WORDS.test(text.replaceAll('ё', 'е'));

/** Заявка текстом - её видно и в боте, и в поиске: «Хочу забронировать: • Футболка, белая, M × 1». */
export const merchRequestText = (items: ChatMerchItem[]) =>
  `🛍 Хочу забронировать:\n${items.map((it) => `• ${it.title} × ${it.qty}`).join('\n')}`;

/** Строка «прочитано» для переписки: создаём при первом сообщении. */
async function ensureThread(db: DbLike, userId: number) {
  await db.insert(schema.supportThreads).values({ userId }).onConflictDoNothing();
}

/** Сколько сообщений по `before` (вверх) и есть ли ещё раньше. */
async function page(db: DbLike, userId: number, before: number | null) {
  const rows = await db
    .select()
    .from(schema.supportMessages)
    .where(and(eq(schema.supportMessages.userId, userId), before ? lt(schema.supportMessages.id, before) : undefined))
    .orderBy(desc(schema.supportMessages.id))
    .limit(PAGE + 1);
  return { rows: rows.slice(0, PAGE).reverse(), hasMore: rows.length > PAGE };
}

// ---------- участник ----------

/**
 * Сообщение участника: из бота (после «Задать вопрос») и из приложения - одинаково.
 * `merch` - заявка на бронь из раздела «Мерч»: вещи уже проверены, текст сообщения перечисляет их.
 */
export async function userWrites(
  db: DbLike,
  user: UserRow,
  text: string,
  opts: { topic?: ChatTopic; merch?: ChatMerchItem[]; boss?: PgBoss } = {},
): Promise<ChatMessageView> {
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.supportMessages)
    .where(
      and(
        eq(schema.supportMessages.userId, user.id),
        eq(schema.supportMessages.fromStaff, false),
        gt(schema.supportMessages.createdAt, new Date(Date.now() - 3600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= PER_HOUR) {
    throw new AppError(429, 'too_many_messages', 'Вы написали уже много сообщений - подождите ответа, пожалуйста');
  }
  const items = opts.merch?.length ? opts.merch : null;
  const body = items ? [merchRequestText(items), text.trim()].filter(Boolean).join('\n\n') : text.trim();
  const [row] = await db
    .insert(schema.supportMessages)
    .values({ userId: user.id, fromStaff: false, text: body.slice(0, 2000), merchItems: items })
    .returning();
  await ensureThread(db, user.id);
  // Своё сообщение участник, конечно, прочитал - и всё, что было до него. Про мерч - в папку «Мерч».
  const merch = !!items || opts.topic === 'merch' || isMerchText(text);
  const [th] = await db
    .update(schema.supportThreads)
    .set({ userReadId: row!.id, ...(merch ? { topic: 'merch' } : {}) })
    .where(eq(schema.supportThreads.userId, user.id))
    .returning({ topic: schema.supportThreads.topic });
  // Переписка в «Мерче» - копию сообщения в бот тем продавцам и админам, кому включили; остальная - админам.
  if (opts.boss) await enqueue(opts.boss, th?.topic === 'merch' ? 'chat.merch_notify' : 'chat.notify', { messageId: row!.id });
  return toView(row!, await extrasOf(db, [row!]));
}

export async function userHistory(db: DbLike, userId: number, before: number | null): Promise<ChatHistory> {
  const { rows, hasMore } = await page(db, userId, before);
  const extras = await extrasOf(db, rows);
  return { messages: rows.map((m) => toView(m, extras)), hasMore };
}

/** Сколько сообщений команды участник ещё не видел. */
export async function userUnread(db: DbLike, userId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from support_messages m left join support_threads t on t.user_id = m.user_id
     where m.user_id = ${userId} and m.from_staff and m.id > coalesce(t.user_read_id, 0)`);
  return res.rows[0]?.n ?? 0;
}

export async function userMarkRead(db: DbLike, userId: number): Promise<void> {
  await ensureThread(db, userId);
  await db.execute(sql`
    update support_threads
       set user_read_id = greatest(user_read_id, coalesce((select max(id) from support_messages where user_id = ${userId}), 0))
     where user_id = ${userId}`);
}

/** Картинка из своей переписки (чужую не отдаём). */
export async function userPhoto(db: DbLike, userId: number, messageId: number): Promise<string> {
  const m = await db.query.supportMessages.findFirst({
    where: and(eq(schema.supportMessages.id, messageId), eq(schema.supportMessages.userId, userId)),
  });
  if (!m?.photo) throw notFound('Картинка не найдена');
  return m.photo;
}

// ---------- команда ----------

/** Почему сообщение не дойдёт в бот; null - дойдёт. */
function botNote(u: { tgId: number | null; botBlocked: boolean }): string | null {
  if (u.tgId === null) return 'Нет Telegram - увидит только в приложении';
  if (u.botBlocked) return 'Остановил бота - в бот не придёт, увидит в приложении';
  return null;
}

/**
 * Переписки: последние сверху, с непрочитанным. `search` - по имени и нику; `unread` - только непрочитанные
 * (и отмеченные «непрочитанным»); `marked` - только с отметкой. Фото профиля, которых ещё нет (или проверяли давно), подтягиваем фоном.
 */
export async function listThreads(
  ctx: Ctx,
  opts: { search?: string; unread?: boolean; marked?: boolean; folder?: 'merch' | 'other' } = {},
): Promise<ChatThreadRow[]> {
  const res = await ctx.db.execute<{
    user_id: string;
    unread: number;
    marked_unread: boolean | null;
    mark: ChatMark | null;
    topic: ChatTopic | null;
    text: string | null;
    photo: string | null;
    from_staff: boolean;
    created_at: Date;
  }>(sql`
    with t as (
      select m.user_id, max(m.id) as last_id,
             count(*) filter (where not m.from_staff and m.id > coalesce(th.staff_read_id, 0))::int as unread
        from support_messages m left join support_threads th on th.user_id = m.user_id
       group by m.user_id, th.staff_read_id
    )
    select t.user_id, t.unread, th.marked_unread, th.mark, th.topic, m.text, m.photo, m.from_staff, m.created_at
      from t join support_messages m on m.id = t.last_id
      left join support_threads th on th.user_id = t.user_id
     where ${opts.folder === 'merch' ? sql`th.topic = 'merch'` : opts.folder === 'other' ? sql`th.topic is null` : sql`true`}
     order by t.last_id desc
     limit 1000`);
  const ids = res.rows.map((r) => Number(r.user_id));
  const [names, users] = await Promise.all([
    namesOf(ctx.db, ids),
    ids.length ? ctx.db.query.users.findMany({ where: inArray(schema.users.id, ids) }) : [],
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  await refreshAvatars(ctx, users);
  const words = searchWords(opts.search ?? '');
  // Ищем по всем именам переписки: «Я» из регистрации, Telegram, ник, все участники семьи (дети тоже).
  const haystack = new Map<number, string>();
  if (words.length && ids.length) {
    const people = await ctx.db.query.participants.findMany({
      where: and(
        sql`(${inArray(schema.participants.ownerUserId, ids)} or ${inArray(schema.participants.holderUserId, ids)})`,
        eq(schema.participants.status, 'active'),
      ),
    });
    for (const uid of ids) {
      const u = byId.get(uid);
      const family = people.filter((p) => (p.holderUserId ?? p.ownerUserId) === uid || p.ownerUserId === uid);
      haystack.set(
        uid,
        normalize(
          [names.get(uid)?.name, u?.firstName, u?.lastName, u?.displayName, u?.username, ...family.flatMap((p) => [p.lastName, p.firstName, p.middleName])]
            .filter(Boolean)
            .join(' '),
        ),
      );
    }
  }
  return res.rows
    .map((r) => {
      const uid = Number(r.user_id);
      const n = names.get(uid);
      return {
        userId: uid,
        name: n?.name ?? 'Без имени',
        username: n?.username ?? null,
        avatar: !!byId.get(uid)?.avatar,
        lastText: r.text ?? '🖼 Картинка',
        lastAt: new Date(r.created_at).toISOString(),
        lastFromStaff: r.from_staff,
        unread: r.unread,
        markedUnread: !!r.marked_unread,
        mark: r.mark ?? null,
        topic: r.topic ?? null,
      };
    })
    .filter(
      (t) =>
        (!opts.unread || t.unread > 0 || t.markedUnread) &&
        (!opts.marked || t.mark !== null) &&
        words.every((w) => (haystack.get(t.userId) ?? '').includes(w)),
    );
}

/** Для поиска: строчные, «ё» как «е», без @ в начале слова. */
const normalize = (s: string) => s.toLowerCase().replaceAll('ё', 'е');
const searchWords = (q: string) =>
  normalize(q)
    .split(/\s+/)
    .map((w) => w.replace(/^@/, ''))
    .filter(Boolean);

/** Поиск по тексту сообщений: последние совпадения сверху. */
export async function searchMessages(ctx: Ctx, query: string, opts: { merchOnly?: boolean } = {}): Promise<ChatSearchHit[]> {
  const q = normalize(query.trim());
  if (q.length < 2) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await ctx.db
    .select()
    .from(schema.supportMessages)
    .where(
      and(
        sql`replace(lower(${schema.supportMessages.text}), 'ё', 'е') like ${like}`,
        opts.merchOnly ? sql`${schema.supportMessages.userId} in (select user_id from support_threads where topic = 'merch')` : undefined,
      ),
    )
    .orderBy(desc(schema.supportMessages.id))
    .limit(50);
  const ids = [...new Set(rows.map((m) => m.userId))];
  const [names, users] = await Promise.all([
    namesOf(ctx.db, ids),
    ids.length ? ctx.db.query.users.findMany({ where: inArray(schema.users.id, ids) }) : [],
  ]);
  const withAvatar = new Set(users.filter((u) => u.avatar).map((u) => u.id));
  return rows.map((m) => ({
    messageId: m.id,
    userId: m.userId,
    name: names.get(m.userId)?.name ?? 'Без имени',
    avatar: withAvatar.has(m.userId),
    text: m.text ?? '',
    fromStaff: m.fromStaff,
    createdAt: m.createdAt.toISOString(),
  }));
}

/** Переписок, где есть непрочитанное командой (или отмеченных «непрочитанным»). */
export async function unreadThreadsCount(db: DbLike, opts: { merchOnly?: boolean } = {}): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select m.user_id
        from support_messages m left join support_threads t on t.user_id = m.user_id
       where not m.from_staff and m.id > coalesce(t.staff_read_id, 0)
      union
      select t.user_id from support_threads t where t.marked_unread
    ) x
    ${opts.merchOnly ? sql`where x.user_id in (select user_id from support_threads where topic = 'merch')` : sql``}`);
  return res.rows[0]?.n ?? 0;
}

async function personOf(ctx: Ctx, userId: number): Promise<ChatPerson> {
  const user = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw notFound('Человек не найден');
  const [names, people] = await Promise.all([
    namesOf(ctx.db, [userId]),
    ctx.db.query.participants.findMany({
      where: and(
        sql`(${schema.participants.ownerUserId} = ${userId} or ${schema.participants.holderUserId} = ${userId})`,
        eq(schema.participants.status, 'active'),
      ),
    }),
  ]);
  await refreshAvatars(ctx, [user]);
  return {
    userId,
    name: names.get(userId)?.name ?? 'Без имени',
    username: user.username,
    avatar: !!user.avatar,
    botNote: botNote(user),
    participants: people.map((p) => ({ id: p.id, name: `${p.lastName} ${p.firstName}` })),
  };
}

/** Открытая переписка: кто это и сообщения (по `before` - раньше). */
export async function staffThread(ctx: Ctx, userId: number, before: number | null): Promise<ChatThreadView> {
  const person = await personOf(ctx, userId);
  const { rows, hasMore } = await page(ctx.db, userId, before);
  const authorIds = [...new Set(rows.map((r) => r.authorId).filter((x): x is number => x !== null))];
  const authors = new Map([...(await namesOf(ctx.db, authorIds))].map(([id, n]) => [id, n.name]));
  const [th, extras] = await Promise.all([
    ctx.db.query.supportThreads.findFirst({ where: eq(schema.supportThreads.userId, userId) }),
    extrasOf(ctx.db, rows),
  ]);
  return {
    person,
    messages: rows.map((m) => toView(m, { authors, ...extras })),
    hasMore,
    mark: (th?.mark as ChatMark | null | undefined) ?? null,
    topic: (th?.topic as ChatTopic | null | undefined) ?? null,
  };
}

export async function staffMarkRead(db: DbLike, userId: number): Promise<void> {
  await ensureThread(db, userId);
  await db.execute(sql`
    update support_threads
       set staff_read_id = greatest(staff_read_id, coalesce((select max(id) from support_messages where user_id = ${userId}), 0)),
           marked_unread = false
     where user_id = ${userId}`);
}

/** «Отметить непрочитанным»: висит в непрочитанных и в счётчике, пока переписку снова не откроют. */
export async function staffMarkUnread(db: DbLike, userId: number): Promise<void> {
  await ensureThread(db, userId);
  await db.update(schema.supportThreads).set({ markedUnread: true }).where(eq(schema.supportThreads.userId, userId));
}

/** Отметка-смайлик переписки (null - снять). */
export async function setThreadMark(db: DbLike, userId: number, mark: ChatMark | null): Promise<void> {
  await ensureThread(db, userId);
  await db.update(schema.supportThreads).set({ mark }).where(eq(schema.supportThreads.userId, userId));
}

/** Перенести переписку в папку «Мерч» или вернуть в общие (null). */
export async function setThreadTopic(db: DbLike, userId: number, topic: ChatTopic | null): Promise<void> {
  await ensureThread(db, userId);
  await db.update(schema.supportThreads).set({ topic }).where(eq(schema.supportThreads.userId, userId));
}

/**
 * Продавец видит только папку «Мерч»: переписка должна быть там. Новую (сообщений ещё нет) начать можно -
 * она сразу попадёт в «Мерч».
 */
export async function assertMerchThread(db: DbLike, userId: number): Promise<void> {
  const th = await db.query.supportThreads.findFirst({ where: eq(schema.supportThreads.userId, userId) });
  if (th?.topic === 'merch') return;
  const [m] = await db.select({ id: schema.supportMessages.id }).from(schema.supportMessages).where(eq(schema.supportMessages.userId, userId)).limit(1);
  if (m) throw notFound('Эта переписка не про мерч');
}

/** Чья это картинка - для проверки доступа продавца. */
export async function messageOwner(db: DbLike, messageId: number): Promise<number> {
  const m = await db.query.supportMessages.findFirst({ where: eq(schema.supportMessages.id, messageId) });
  if (!m) throw notFound('Сообщение не найдено');
  return m.userId;
}

/** Сообщение команды: сохраняем и отправляем в бот фоном (с кнопкой «Ответить»). */
export async function staffWrites(
  ctx: Ctx,
  actor: StaffPrincipal,
  userId: number,
  input: { text?: string | null; photo?: string | null },
  opts: { topic?: ChatTopic } = {},
): Promise<ChatMessageView> {
  const user = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw notFound('Человек не найден');
  const row = await ctx.db.transaction(async (tx) => {
    const [m] = await tx
      .insert(schema.supportMessages)
      .values({ userId, fromStaff: true, authorId: actor.user.id, text: input.text?.trim() || null, photo: input.photo ?? null })
      .returning();
    await ensureThread(tx, userId);
    // Ответили - значит, прочитали всё до этого. Продавец пишет первым - переписка сразу в «Мерче».
    await tx
      .update(schema.supportThreads)
      .set({ staffReadId: m!.id, ...(opts.topic ? { topic: opts.topic } : {}) })
      .where(eq(schema.supportThreads.userId, userId));
    await enqueue(ctx.boss, 'chat.deliver', { messageId: m!.id }, { tx });
    await audit(tx, { actorUserId: actor.user.id, action: 'chat.send', entity: 'user', entityId: userId, after: { messageId: m!.id, photo: !!m!.photo } });
    return m!;
  });
  return toView(row, { authors: new Map([[actor.user.id, (await namesOf(ctx.db, [actor.user.id])).get(actor.user.id)?.name ?? '']]) });
}

/** Картинка сообщения для админки. */
export async function staffPhoto(db: DbLike, messageId: number): Promise<string> {
  const m = await db.query.supportMessages.findFirst({ where: eq(schema.supportMessages.id, messageId) });
  if (!m?.photo) throw notFound('Картинка не найдена');
  return m.photo;
}

/** Кому написать первым: поиск по фамилии, имени, нику и телефону (участники и их аккаунты). */
export async function searchPeople(db: DbLike, query: string): Promise<ChatPerson[]> {
  const q = query.trim().replace(/^@/, '');
  if (q.length < 2) return [];
  const like = `%${q.toLowerCase()}%`;
  const digits = q.replace(/\D/g, '');
  const res = await db.execute<{ user_id: string }>(sql`
    select distinct coalesce(p.holder_user_id, p.owner_user_id) as user_id
      from participants p
     where p.status = 'active'
       and (lower(p.last_name || ' ' || p.first_name) like ${like}
            or lower(p.first_name || ' ' || p.last_name) like ${like}
            ${digits.length >= 5 ? sql`or regexp_replace(coalesce(p.phone, ''), '\\D', '', 'g') like ${`%${digits}%`}` : sql``})
    union
    select u.id from users u
     where lower(coalesce(u.username, '')) like ${like}
        or lower(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) like ${like}
    limit 20`);
  const ids = res.rows.map((r) => Number(r.user_id));
  if (ids.length === 0) return [];
  const [names, users, people] = await Promise.all([
    namesOf(db, ids),
    db.query.users.findMany({ where: inArray(schema.users.id, ids) }),
    db.query.participants.findMany({
      where: and(
        sql`(${inArray(schema.participants.ownerUserId, ids)} or ${inArray(schema.participants.holderUserId, ids)})`,
        eq(schema.participants.status, 'active'),
      ),
    }),
  ]);
  return users.map((u) => ({
    userId: u.id,
    name: names.get(u.id)?.name ?? 'Без имени',
    username: u.username,
    avatar: !!u.avatar,
    botNote: botNote(u),
    participants: people
      .filter((p) => (p.holderUserId ?? p.ownerUserId) === u.id)
      .map((p) => ({ id: p.id, name: `${p.lastName} ${p.firstName}` })),
  }));
}

/** Фото профиля, которое ещё не проверяли или проверяли давно, - фоновой задачей (одна на человека). */
async function refreshAvatars(ctx: Ctx, users: { id: number; tgId: number | null; avatarCheckedAt: Date | null }[]) {
  const stale = users.filter((u) => u.tgId !== null && (!u.avatarCheckedAt || Date.now() - u.avatarCheckedAt.getTime() > AVATAR_TTL_MS));
  for (const u of stale) {
    await enqueue(ctx.boss, 'chat.avatar', { userId: u.id }, { singletonKey: `avatar:${u.id}` });
  }
}

/** Файл фото профиля для админки. */
export async function avatarOf(db: DbLike, userId: number): Promise<string> {
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!u?.avatar) throw notFound('Фото нет');
  return u.avatar;
}

/** Файл фото пропал - забываем его и время проверки, чтобы фоновая задача скачала фото заново. */
export async function forgetAvatar(db: DbLike, userId: number): Promise<void> {
  await db.update(schema.users).set({ avatar: null, avatarCheckedAt: null }).where(eq(schema.users.id, userId));
}

// ---------- бот: окно «пишите сообщение» ----------

/** Бот: нажали «Задать вопрос» или «Ответить» - ждём сообщение. */
export async function startAwaitingQuestion(db: DbLike, userId: number): Promise<void> {
  await db
    .update(schema.users)
    .set({ awaitingQuestionUntil: new Date(Date.now() + QUESTION_WINDOW_MS) })
    .where(eq(schema.users.id, userId));
}

export async function cancelAwaitingQuestion(db: DbLike, userId: number): Promise<void> {
  await db.update(schema.users).set({ awaitingQuestionUntil: null }).where(eq(schema.users.id, userId));
}

// ---------- копии сообщений админам ----------

const CHAT_NOTIFY_ROLES = ['admin', 'superadmin'];

/** Админы и суперадмины: кому приходят копии обычных сообщений участников (по умолчанию - всем). */
export async function chatNotifyPeople(db: DbLike, s: Settings): Promise<ChatNotifyView['people']> {
  const rows = await db
    .select({ userId: schema.staffRoles.userId, role: schema.staffRoles.role })
    .from(schema.staffRoles)
    .where(inArray(schema.staffRoles.role, CHAT_NOTIFY_ROLES));
  const roles = new Map<number, string[]>();
  for (const r of rows) roles.set(r.userId, [...(roles.get(r.userId) ?? []), r.role]);
  const names = await namesOf(db, [...roles.keys()]);
  return [...roles]
    .map(([userId, rs]) => ({
      userId,
      name: names.get(userId)?.name ?? 'Без имени',
      roles: CHAT_NOTIFY_ROLES.filter((r) => rs.includes(r)),
      on: s.chatNotify[String(userId)] ?? true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Кому сейчас слать копию обычного сообщения участника. */
export async function chatNotifyRecipients(db: DbLike): Promise<number[]> {
  return (await chatNotifyPeople(db, await getSettings(db))).filter((p) => p.on).map((p) => p.userId);
}
