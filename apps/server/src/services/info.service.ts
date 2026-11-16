import type { AnnouncementInput, AnnouncementView, InfoPageInput, InfoPageView, InfoResponse } from '@sof/shared';
import { asc, desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import type { StaffPrincipal } from './sessions.service.ts';

type PageRow = typeof schema.infoPages.$inferSelect;
type AnnRow = typeof schema.announcements.$inferSelect;

const pageView = (p: PageRow): InfoPageView => ({ slug: p.slug, title: p.title, bodyMd: p.bodyMd, sort: p.sort, published: p.published });
const annView = (a: AnnRow): AnnouncementView => ({
  id: a.id,
  title: a.title,
  bodyMd: a.bodyMd,
  pinned: a.pinned,
  published: a.published,
  createdAt: a.createdAt.toISOString(),
});

export async function getInfo(ctx: Pick<AppContext, 'db'>, { includeHidden = false } = {}): Promise<InfoResponse> {
  const [pages, anns] = await Promise.all([
    ctx.db.query.infoPages.findMany({
      where: includeHidden ? undefined : eq(schema.infoPages.published, true),
      orderBy: [asc(schema.infoPages.sort), asc(schema.infoPages.title)],
    }),
    ctx.db.query.announcements.findMany({
      where: includeHidden ? undefined : eq(schema.announcements.published, true),
      orderBy: [desc(schema.announcements.pinned), desc(schema.announcements.createdAt)],
      limit: 100,
    }),
  ]);
  return { pages: pages.map(pageView), announcements: anns.map(annView) };
}

export async function upsertPage(
  ctx: Pick<AppContext, 'db'>,
  slug: string,
  input: InfoPageInput,
  actor: StaffPrincipal,
): Promise<InfoPageView> {
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) throw badRequest('invalid_slug', 'Адрес страницы: латиница, цифры и дефис');
  const [row] = await ctx.db
    .insert(schema.infoPages)
    .values({ slug, ...input, updatedBy: actor.user.id })
    .onConflictDoUpdate({ target: schema.infoPages.slug, set: { ...input, updatedAt: new Date(), updatedBy: actor.user.id } })
    .returning();
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'info_page.upsert', entity: 'info_page', entityId: slug, after: input });
  return pageView(row!);
}

export async function deletePage(ctx: Pick<AppContext, 'db'>, slug: string, actor: StaffPrincipal): Promise<void> {
  await ctx.db.delete(schema.infoPages).where(eq(schema.infoPages.slug, slug));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'info_page.delete', entity: 'info_page', entityId: slug });
}

export async function createAnnouncement(
  ctx: Pick<AppContext, 'db'>,
  input: AnnouncementInput,
  actor: StaffPrincipal,
): Promise<AnnouncementView> {
  const [row] = await ctx.db.insert(schema.announcements).values({ ...input, createdBy: actor.user.id }).returning();
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'announcement.create', entity: 'announcement', entityId: row!.id, after: input });
  return annView(row!);
}

export async function updateAnnouncement(
  ctx: Pick<AppContext, 'db'>,
  id: number,
  input: Partial<AnnouncementInput>,
  actor: StaffPrincipal,
): Promise<AnnouncementView> {
  const [row] = await ctx.db
    .update(schema.announcements)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(schema.announcements.id, id))
    .returning();
  if (!row) throw notFound('Объявление не найдено');
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'announcement.update', entity: 'announcement', entityId: id, after: input });
  return annView(row);
}

export async function deleteAnnouncement(ctx: Pick<AppContext, 'db'>, id: number, actor: StaffPrincipal): Promise<void> {
  await ctx.db.delete(schema.announcements).where(eq(schema.announcements.id, id));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'announcement.delete', entity: 'announcement', entityId: id });
}
