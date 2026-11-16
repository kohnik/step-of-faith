import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_INFO,
  type AdminFeedbackRow,
  type AdminFeedbackView,
  type FeedbackCategory,
  type FeedbackInput,
  type MeResponse,
  type Settings,
} from '@sof/shared';
import ExcelJS from 'exceljs';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type DbLike } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import { firstTime } from '../lib/once.ts';
import { excelTime, sheet } from './admin.service.ts';
import { getSettings, patchSettings } from './settings.service.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import type { UserRow } from './users.service.ts';

/** Сколько отзывов можно оставить с одного аккаунта - защита от случайной лавины. */
const MAX_PER_USER = 30;

const isAdmin = (roles: readonly string[]) => roles.includes('admin') || roles.includes('superadmin');

/**
 * Кому видна форма отзывов: всем (тумблер или «Конец «Шага веры»») или админам на проверке.
 * Участникам - только тем, у кого есть регистрация: отзыв о конференции от того, кто на ней был.
 */
export function feedbackVisible(s: Pick<Settings, 'feedbackOpen' | 'feedbackAdmins' | 'eventEnded'>, roles: readonly string[], registered: boolean): boolean {
  if (isAdmin(roles) && s.feedbackAdmins) return true;
  return (s.feedbackOpen || s.eventEnded) && (registered || roles.length > 0);
}

const promptKey = (s: Pick<Settings, 'feedbackWave'>, userId: number) => `feedback-prompt:${s.feedbackWave}:${userId}`;

async function myCount(db: DbLike, userId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.feedback).where(eq(schema.feedback.userId, userId));
  return r?.n ?? 0;
}

/** Подпись по умолчанию: «Я» из регистрации, иначе имя в Telegram. */
function defaultName(user: UserRow, family: { relation: string | null; lastName: string; firstName: string; middleName: string | null }[]): string {
  const self = family.find((p) => p.relation === 'self');
  return self ? `${self.firstName} ${self.lastName}` : userDisplayName(user);
}

export async function feedbackState(
  db: DbLike,
  s: Settings,
  user: UserRow,
  roles: readonly string[],
  family: { status: string; relation: string | null; lastName: string; firstName: string; middleName: string | null }[],
): Promise<MeResponse['feedback']> {
  const active = family.filter((p) => p.status === 'active');
  const visible = feedbackVisible(s, roles, active.length > 0);
  const mine = visible ? await myCount(db, user.id) : 0;
  let prompt = false;
  // Участникам - пока не оставили отзыв; админам - после каждого включения (проверяют, как выглядит).
  if (visible && (mine === 0 || isAdmin(roles))) {
    const [seen] = await db.execute<{ key: string }>(sql`select key from once_keys where key = ${promptKey(s, user.id)}`).then((r) => r.rows);
    prompt = !seen;
  }
  return { visible, mine, prompt, name: defaultName(user, active) };
}

/** Заставку «Оставь отзыв» показали (закрыли или пошли писать) - больше на это включение не показываем. */
export async function markPromptSeen(db: DbLike, user: UserRow): Promise<void> {
  await firstTime(db, promptKey(await getSettings(db), user.id));
}

async function registered(db: DbLike, userId: number): Promise<boolean> {
  const [r] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from participants where status = 'active' and (owner_user_id = ${userId} or holder_user_id = ${userId})`).then((x) => x.rows);
  return (r?.n ?? 0) > 0;
}

export async function createFeedback(db: DbLike, user: UserRow, roles: readonly string[], input: FeedbackInput): Promise<{ id: number; mine: number }> {
  const s = await getSettings(db);
  if (!feedbackVisible(s, roles, await registered(db, user.id))) throw badRequest('feedback_closed', 'Отзывы сейчас не принимаются');
  const before = await myCount(db, user.id);
  if (before >= MAX_PER_USER) throw badRequest('feedback_limit', 'Спасибо! Вы уже оставили много отзывов - напишите организаторам, если хотите добавить');
  const signature = input.anonymous ? null : input.signature?.trim() || null;
  const [row] = await db
    .insert(schema.feedback)
    .values({ userId: user.id, category: input.category, text: input.text.trim(), anonymous: input.anonymous, signature })
    .returning({ id: schema.feedback.id });
  // Оставил отзыв - заставка больше не нужна.
  await firstTime(db, promptKey(s, user.id));
  return { id: row!.id, mine: before + 1 };
}

// ---------- админка ----------

export interface FeedbackFilter {
  category?: FeedbackCategory | null;
  starred?: boolean;
  q?: string;
  ids?: number[];
}

async function feedbackRows(db: DbLike, f: FeedbackFilter): Promise<AdminFeedbackRow[]> {
  const where = [];
  if (f.category) where.push(eq(schema.feedback.category, f.category));
  if (f.starred) where.push(eq(schema.feedback.starred, true));
  if (f.ids) where.push(inArray(schema.feedback.id, f.ids.length ? f.ids : [-1]));
  if (f.q?.trim()) where.push(sql`(${schema.feedback.text} ilike ${`%${f.q.trim()}%`} or (not ${schema.feedback.anonymous} and ${schema.feedback.signature} ilike ${`%${f.q.trim()}%`}))`);
  const rows = await db
    .select({ f: schema.feedback, u: schema.users })
    .from(schema.feedback)
    .innerJoin(schema.users, eq(schema.users.id, schema.feedback.userId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(schema.feedback.createdAt))
    .limit(5000);
  return rows.map(({ f, u }) => ({
    id: f.id,
    category: f.category as FeedbackCategory,
    text: f.text,
    anonymous: f.anonymous,
    // Анонимный отзыв - без автора: так обещали в форме.
    author: f.anonymous ? null : { userId: u.id, name: f.signature || userDisplayName(u), username: u.username },
    starred: f.starred,
    createdAt: f.createdAt.toISOString(),
  }));
}

export async function adminFeedback(db: DbLike, f: FeedbackFilter): Promise<AdminFeedbackView> {
  const [items, counts, s] = await Promise.all([
    feedbackRows(db, f),
    db.select({ c: schema.feedback.category, n: sql<number>`count(*)::int` }).from(schema.feedback).groupBy(schema.feedback.category),
    getSettings(db, { fresh: true }),
  ]);
  const byCat = Object.fromEntries(FEEDBACK_CATEGORIES.map((c) => [c, 0])) as Record<FeedbackCategory, number>;
  for (const r of counts) if ((FEEDBACK_CATEGORIES as readonly string[]).includes(r.c)) byCat[r.c as FeedbackCategory] = r.n;
  return { items, counts: byCat, open: s.feedbackOpen, admins: s.feedbackAdmins, ended: s.eventEnded };
}

export async function starFeedback(db: DbLike, actor: StaffPrincipal, id: number, starred: boolean): Promise<void> {
  const [row] = await db.update(schema.feedback).set({ starred }).where(eq(schema.feedback.id, id)).returning({ id: schema.feedback.id });
  if (!row) throw notFound('Отзыв не найден');
  await audit(db, { actorUserId: actor.user.id, action: starred ? 'feedback.star' : 'feedback.unstar', entity: 'feedback', entityId: id });
}

/** Удалить отзыв (спам, ошибка). Текст сохраняем в журнал действий. */
export async function deleteFeedback(db: DbLike, actor: StaffPrincipal, id: number): Promise<void> {
  const [row] = await db.delete(schema.feedback).where(eq(schema.feedback.id, id)).returning();
  if (!row) throw notFound('Отзыв не найден');
  await audit(db, { actorUserId: actor.user.id, action: 'feedback.delete', entity: 'feedback', entityId: id, before: row });
}

/**
 * Тумблеры раздела «Отзывы». «Всем» включили - проверка на админах больше не нужна (выключаем).
 * Каждое включение - новая волна: заставку «Оставь отзыв» увидят снова, в том числе админы после проверки.
 */
export async function setFeedbackSwitches(db: DbLike, actor: StaffPrincipal, patch: { feedbackOpen?: boolean; feedbackAdmins?: boolean }): Promise<Settings> {
  const s = await getSettings(db, { fresh: true });
  const open = patch.feedbackOpen ?? s.feedbackOpen;
  // Пока открыто всем, отдельная проверка на админах не включается.
  const admins = open ? false : (patch.feedbackAdmins ?? s.feedbackAdmins);
  const turnedOn = (open && !s.feedbackOpen) || (admins && !s.feedbackAdmins);
  return patchSettings(db, { feedbackOpen: open, feedbackAdmins: admins, ...(turnedOn ? { feedbackWave: String(Date.now()) } : {}) }, actor.user.id);
}

export async function feedbackXlsx(db: DbLike, f: FeedbackFilter): Promise<Buffer> {
  const [rows, s] = await Promise.all([feedbackRows(db, f), getSettings(db)]);
  const wb = new ExcelJS.Workbook();
  const ws = sheet(wb, 'Отзывы', [
    { header: '№', key: 'id', width: 6 },
    { header: 'Когда', key: 'at', width: 17 },
    { header: 'Категория', key: 'category', width: 15 },
    { header: 'Текст', key: 'text', width: 90 },
    { header: 'Подпись', key: 'author', width: 28 },
    { header: 'Telegram', key: 'username', width: 18 },
    { header: '⭐', key: 'star', width: 5 },
  ]);
  ws.getColumn('at').numFmt = 'dd.mm.yyyy hh:mm';
  ws.getColumn('text').alignment = { wrapText: true, vertical: 'top' };
  for (const r of [...rows].reverse()) {
    ws.addRow({
      id: r.id,
      at: excelTime(r.createdAt, s.eventTimezone),
      category: FEEDBACK_CATEGORY_INFO[r.category].label,
      text: r.text,
      author: r.author ? r.author.name : 'Анонимно',
      username: r.author?.username ? `@${r.author.username}` : '',
      star: r.starred ? '⭐' : '',
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- напоминание в бот ----------

/** Текст напоминания об отзыве (подпись к картинке). */
export const FEEDBACK_REMIND_TEXT = [
  '💛 <b>Поделись своим «Шагом веры»</b>',
  'Конференция позади, а шаг, который ты сделал, только начинается. Нам очень важно услышать тебя:',
  '🙌 <b>Свидетельство</b> - что Бог сделал в твоей жизни\n💬 <b>Отзыв</b> - как тебе «Шаг веры»\n💡 <b>Пожелание</b> - что сделать лучше в следующий раз',
  'Это займёт пару минут 👇',
].join('\n\n');

/** Картинка напоминания - в папке медиа (кладём на сервер отдельно); нет файла - уходит просто текст. */
export const FEEDBACK_REMIND_IMAGE = 'broadcast/feedback-reminder.jpg';

/** Кому напомнить: аккаунты с регистрацией (держатель QR-кода, иначе владелец), кто ещё не оставил отзыв. */
export async function feedbackRemindAudience(db: DbLike): Promise<number[]> {
  const rows = await db.execute<{ uid: string }>(sql`
    select distinct coalesce(p.holder_user_id, p.owner_user_id) as uid from participants p
     where p.status = 'active'
       and not exists (select 1 from feedback f where f.user_id = coalesce(p.holder_user_id, p.owner_user_id))`);
  return rows.rows.map((r) => Number(r.uid));
}
