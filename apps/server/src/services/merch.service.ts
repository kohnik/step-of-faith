import {
  formatRub,
  merchAccess,
  type AdminMerchColor,
  type AdminMerchOrderView,
  type AdminMerchProduct,
  type MerchCatalogResponse,
  type MerchMediaKind,
  type MerchOrderCreate,
  type MerchOrderView,
  type MerchPayMethod,
  type MerchProductSave,
  type MerchProductView,
  type MerchReserve,
  type MerchScanResponse,
  type MerchSell,
  type MerchStats,
  type MerchSettings,
  type MerchSettingsView,
  type Settings,
  type ChatMerchItem,
  type ChatMessageView,
} from '@sof/shared';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { createHash, randomInt } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { esc } from '../bot/format.ts';
import { schema, type DbLike, type Tx } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import type { StoredMedia } from './media.service.ts';
import { recordPayment } from './ledger.service.ts';
import { findForPayment } from './checkin.service.ts';
import { getSettings, otherTransferText, patchSettings } from './settings.service.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import { getRoles, getUser, type UserRow } from './users.service.ts';
import { namesOf, staffWrites } from './chat.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;
type ProductRow = typeof schema.merchProducts.$inferSelect;
type OrderRow = typeof schema.merchOrders.$inferSelect;

/** Заказы, которые держат вещь: бронь, оплачено, выдано, в долг. Снятые и истёкшие возвращают остаток. */
const HOLDING = ['reserved', 'paid', 'issued', 'owed'] as const;
type Held = Record<'reserved' | 'paid' | 'issued', number>;
/** Сколько неоплаченных броней может держать один человек. */
const MAX_OPEN_ORDERS = 5;

const mediaUrl = (file: string | null) => (file ? `/media/${file}` : null);

// ---------- каталог ----------

/** Сколько штук каждого размера в заказах - по статусам. Выданное в долг - тоже «выдано»: вещь уже у человека. */
async function heldByVariant(db: DbLike, variantIds: number[]): Promise<Map<number, Held>> {
  const out = new Map<number, Held>();
  if (variantIds.length === 0) return out;
  const rows = await db
    .select({ variantId: schema.merchOrderItems.variantId, status: schema.merchOrders.status, n: sql<number>`sum(${schema.merchOrderItems.qty})::int` })
    .from(schema.merchOrderItems)
    .innerJoin(schema.merchOrders, eq(schema.merchOrders.id, schema.merchOrderItems.orderId))
    .where(and(inArray(schema.merchOrderItems.variantId, variantIds), inArray(schema.merchOrders.status, [...HOLDING])))
    .groupBy(schema.merchOrderItems.variantId, schema.merchOrders.status);
  for (const r of rows) {
    const cur = out.get(r.variantId) ?? { reserved: 0, paid: 0, issued: 0 };
    cur[r.status === 'owed' ? 'issued' : (r.status as keyof Held)] += r.n;
    out.set(r.variantId, cur);
  }
  return out;
}

/** Каталог целиком (для админки - со скрытыми и полным учётом остатков). */
export async function adminProducts(db: DbLike, ids?: number[]): Promise<AdminMerchProduct[]> {
  const products = await db
    .select()
    .from(schema.merchProducts)
    .where(ids ? inArray(schema.merchProducts.id, ids.length ? ids : [-1]) : sql`true`)
    .orderBy(asc(schema.merchProducts.sort), asc(schema.merchProducts.id));
  const pids = products.map((p) => p.id);
  if (pids.length === 0) return [];
  const [colors, media] = await Promise.all([
    db.select().from(schema.merchColors).where(inArray(schema.merchColors.productId, pids)).orderBy(asc(schema.merchColors.sort), asc(schema.merchColors.id)),
    db.select().from(schema.merchMedia).where(inArray(schema.merchMedia.productId, pids)).orderBy(asc(schema.merchMedia.sort), asc(schema.merchMedia.id)),
  ]);
  const variants = colors.length
    ? await db
        .select()
        .from(schema.merchVariants)
        .where(inArray(schema.merchVariants.colorId, colors.map((c) => c.id)))
        .orderBy(asc(schema.merchVariants.sort), asc(schema.merchVariants.id))
    : [];
  const held = await heldByVariant(db, variants.map((v) => v.id));
  const ordered = variants.length
    ? new Set(
        (
          await db
            .selectDistinct({ variantId: schema.merchOrderItems.variantId })
            .from(schema.merchOrderItems)
            .where(inArray(schema.merchOrderItems.variantId, variants.map((v) => v.id)))
        ).map((r) => r.variantId),
      )
    : new Set<number>();
  return products.map((p) => {
    const pColors: AdminMerchColor[] = colors
      .filter((c) => c.productId === p.id)
      .map((c) => ({
        id: c.id,
        name: c.name,
        hex: c.hex,
        sort: c.sort,
        sizes: variants
          .filter((v) => v.colorId === c.id)
          .map((v) => {
            const h = held.get(v.id) ?? { reserved: 0, paid: 0, issued: 0 };
            return {
              id: v.id,
              size: v.size,
              sort: v.sort,
              stock: v.stock,
              reserved: h.reserved,
              paid: h.paid,
              issued: h.issued,
              left: Math.max(0, v.stock - h.reserved - h.paid - h.issued),
            };
          }),
      }));
    return {
      id: p.id,
      title: p.title,
      subtitle: p.subtitle,
      descriptionMd: p.descriptionMd,
      price: p.price,
      badge: p.badge,
      sort: p.sort,
      published: p.published,
      colors: pColors,
      media: media
        .filter((m) => m.productId === p.id)
        .map((m) => ({
          id: m.id,
          kind: m.kind as MerchMediaKind,
          url: mediaUrl(m.file)!,
          thumbUrl: mediaUrl(m.thumb),
          width: m.width,
          height: m.height,
          bytes: m.bytes,
          colorId: m.colorId,
          sort: m.sort,
        })),
      available: pColors.some((c) => c.sizes.some((s) => s.left > 0)),
      hasOrders: pColors.some((c) => c.sizes.some((s) => ordered.has(s.id))),
    };
  });
}

async function adminProduct(db: DbLike, id: number): Promise<AdminMerchProduct> {
  const [p] = await adminProducts(db, [id]);
  if (!p) throw notFound('Товар не найден');
  return p;
}

/**
 * Витрина для Mini App: только опубликованные; учёт заказов наружу не отдаём - только «осталось».
 * Кому видна - `merchAccess`: выключена - никому, «только администраторам» - админам.
 */
export async function catalog(ctx: Pick<AppContext, 'db'>, opts: { roles: readonly string[] }): Promise<MerchCatalogResponse> {
  const settings = await getSettings(ctx.db);
  const access = merchAccess(settings, opts.roles);
  const visible = access.visible;
  const products: MerchProductView[] = visible
    ? (await adminProducts(ctx.db))
        .filter((p) => p.published)
        .map((p) => ({
          id: p.id,
          title: p.title,
          subtitle: p.subtitle,
          descriptionMd: p.descriptionMd,
          price: p.price,
          badge: p.badge,
          media: p.media,
          available: p.available,
          colors: p.colors.map((c) => ({
            id: c.id,
            name: c.name,
            hex: c.hex,
            sort: c.sort,
            sizes: c.sizes.map((s) => ({ id: s.id, size: s.size, left: s.left, sort: s.sort })),
          })),
        }))
    : [];
  return {
    products,
    sales: access.sales,
    selfBooking: settings.merchSelfBooking,
    reservationHours: settings.merchReservationHours,
    // Тот же счёт, что для взноса, но свой текст - без «пакета регистрации».
    paymentInstructions: onlinePayment(settings) ? otherTransferText(settings) : '',
  };
}

// ---------- правка каталога (админка) ----------

export async function createProduct(
  ctx: Ctx,
  input: { title: string; subtitle: string | null; descriptionMd: string; price: number; badge: string | null; sort: number; published: boolean },
  actor: StaffPrincipal,
): Promise<AdminMerchProduct> {
  const id = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.merchProducts)
      .values({ ...input, price: input.price.toFixed(2) })
      .returning({ id: schema.merchProducts.id });
    // Без цвета у вещи не задать размеры - заводим один «основной», его можно переименовать.
    await tx.insert(schema.merchColors).values({ productId: row!.id, name: 'Основной', hex: '#111111' });
    await audit(tx, { actorUserId: actor.user.id, action: 'merch.product_create', entity: 'merch_product', entityId: row!.id, after: input });
    return row!.id;
  });
  return adminProduct(ctx.db, id);
}

export async function updateProduct(
  ctx: Ctx,
  id: number,
  patch: Partial<{ title: string; subtitle: string | null; descriptionMd: string; price: number; badge: string | null; sort: number; published: boolean }>,
  actor: StaffPrincipal,
): Promise<AdminMerchProduct> {
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.merchProducts).where(eq(schema.merchProducts.id, id));
    if (!before) throw notFound('Товар не найден');
    const set: Partial<ProductRow> = { ...patch, price: patch.price === undefined ? undefined : patch.price.toFixed(2), updatedAt: new Date() };
    await tx.update(schema.merchProducts).set(set).where(eq(schema.merchProducts.id, id));
    await audit(tx, { actorUserId: actor.user.id, action: 'merch.product_update', entity: 'merch_product', entityId: id, before, after: patch });
  });
  return adminProduct(ctx.db, id);
}

/** Удалить можно, пока вещь никто не заказывал; иначе - только скрыть. Файлы удаляет вызывающий (они могут быть общими). */
export async function deleteProduct(ctx: Ctx, id: number, actor: StaffPrincipal): Promise<{ files: string[] }> {
  const p = await adminProduct(ctx.db, id);
  if (p.hasOrders) throw conflict('has_orders', 'Эту вещь уже заказывали - удалить нельзя, снимите её с публикации');
  const media = await ctx.db.select().from(schema.merchMedia).where(eq(schema.merchMedia.productId, id));
  await ctx.db.transaction(async (tx) => {
    await tx.delete(schema.merchProducts).where(eq(schema.merchProducts.id, id));
    await audit(tx, { actorUserId: actor.user.id, action: 'merch.product_delete', entity: 'merch_product', entityId: id, before: p });
  });
  return { files: await unusedFiles(ctx.db, media.flatMap((m) => [m.file, m.thumb]).filter((f): f is string => !!f)) };
}

async function productOfColor(db: DbLike, colorId: number): Promise<number> {
  const [c] = await db.select({ productId: schema.merchColors.productId }).from(schema.merchColors).where(eq(schema.merchColors.id, colorId));
  if (!c) throw notFound('Цвет не найден');
  return c.productId;
}

async function productOfVariant(db: DbLike, variantId: number): Promise<number> {
  const [v] = await db
    .select({ productId: schema.merchColors.productId })
    .from(schema.merchVariants)
    .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
    .where(eq(schema.merchVariants.id, variantId));
  if (!v) throw notFound('Размер не найден');
  return v.productId;
}

export async function addColor(ctx: Ctx, productId: number, input: { name: string; hex: string; sort: number }, actor: StaffPrincipal) {
  await adminProduct(ctx.db, productId);
  const [row] = await ctx.db.insert(schema.merchColors).values({ productId, ...input }).returning({ id: schema.merchColors.id });
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'merch.color_create', entity: 'merch_product', entityId: productId, after: { id: row!.id, ...input } });
  return adminProduct(ctx.db, productId);
}

export async function updateColor(ctx: Ctx, colorId: number, patch: Partial<{ name: string; hex: string; sort: number }>, actor: StaffPrincipal) {
  const productId = await productOfColor(ctx.db, colorId);
  await ctx.db.update(schema.merchColors).set(patch).where(eq(schema.merchColors.id, colorId));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'merch.color_update', entity: 'merch_product', entityId: productId, after: { colorId, ...patch } });
  return adminProduct(ctx.db, productId);
}

export async function deleteColor(ctx: Ctx, colorId: number, actor: StaffPrincipal) {
  const productId = await productOfColor(ctx.db, colorId);
  const p = await adminProduct(ctx.db, productId);
  if (p.colors.length <= 1) throw badRequest('last_color', 'У вещи должен остаться хотя бы один цвет');
  const sizes = p.colors.find((c) => c.id === colorId)?.sizes ?? [];
  if (sizes.some((s) => s.reserved + s.paid + s.issued > 0) || (await hasAnyOrders(ctx.db, sizes.map((s) => s.id)))) {
    throw conflict('has_orders', 'Этот цвет уже заказывали - удалить нельзя, поставьте остаток 0');
  }
  await ctx.db.delete(schema.merchColors).where(eq(schema.merchColors.id, colorId));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'merch.color_delete', entity: 'merch_product', entityId: productId, before: { colorId } });
  return adminProduct(ctx.db, productId);
}

async function hasAnyOrders(db: DbLike, variantIds: number[]): Promise<boolean> {
  if (variantIds.length === 0) return false;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.merchOrderItems)
    .where(inArray(schema.merchOrderItems.variantId, variantIds));
  return (row?.n ?? 0) > 0;
}

export async function addSize(ctx: Ctx, colorId: number, input: { size: string; stock: number; sort: number }, actor: StaffPrincipal) {
  const productId = await productOfColor(ctx.db, colorId);
  try {
    await ctx.db.insert(schema.merchVariants).values({ colorId, ...input });
  } catch (err) {
    if (isUniqueViolation(err, 'merch_variants_uq')) throw conflict('duplicate_size', 'Такой размер у этого цвета уже есть');
    throw err;
  }
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'merch.size_create', entity: 'merch_product', entityId: productId, after: { colorId, ...input } });
  return adminProduct(ctx.db, productId);
}

/** Остаток меньше, чем уже в заказах, поставить нельзя - иначе продали бы то, чего нет. */
export async function updateSize(ctx: Ctx, variantId: number, patch: Partial<{ size: string; stock: number; sort: number }>, actor: StaffPrincipal) {
  const productId = await productOfVariant(ctx.db, variantId);
  await ctx.db.transaction(async (tx) => {
    const [v] = await tx.select().from(schema.merchVariants).where(eq(schema.merchVariants.id, variantId)).for('update');
    if (patch.stock !== undefined) {
      const h = (await heldByVariant(tx, [variantId])).get(variantId);
      const inOrders = h ? h.reserved + h.paid + h.issued : 0;
      if (patch.stock < inOrders) throw badRequest('stock_below_orders', `В заказах уже ${inOrders} шт. - остаток не может быть меньше`);
    }
    try {
      await tx.update(schema.merchVariants).set(patch).where(eq(schema.merchVariants.id, variantId));
    } catch (err) {
      if (isUniqueViolation(err, 'merch_variants_uq')) throw conflict('duplicate_size', 'Такой размер у этого цвета уже есть');
      throw err;
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'merch.size_update', entity: 'merch_product', entityId: productId, before: v, after: patch });
  });
  return adminProduct(ctx.db, productId);
}

export async function deleteSize(ctx: Ctx, variantId: number, actor: StaffPrincipal) {
  const productId = await productOfVariant(ctx.db, variantId);
  if (await hasAnyOrders(ctx.db, [variantId])) throw conflict('has_orders', 'Этот размер уже заказывали - удалить нельзя, поставьте остаток 0');
  await ctx.db.delete(schema.merchVariants).where(eq(schema.merchVariants.id, variantId));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'merch.size_delete', entity: 'merch_product', entityId: productId, before: { variantId } });
  return adminProduct(ctx.db, productId);
}

/** Фото на набор: обложка и общие (без цвета) - до 10, у каждого цвета - до 10. 3D-модель - одна на набор. */
export const MAX_PHOTOS_PER_GROUP = 10;
const groupLabel = (colorId: number | null) => (colorId === null ? 'в обложке и общих фото' : 'у этого цвета');

/**
 * Можно ли добавить фото в набор - проверяем до сохранения файла, чтобы не копить лишние файлы.
 * 3D не ограничиваем: новая модель заменяет прежнюю в том же наборе.
 */
export async function assertMediaRoom(db: DbLike, productId: number, colorId: number | null, kind: MerchMediaKind): Promise<void> {
  const p = await adminProduct(db, productId);
  if (colorId !== null && !p.colors.some((c) => c.id === colorId)) throw badRequest('bad_color', 'Такого цвета у вещи нет');
  if (kind !== 'photo') return;
  const photos = p.media.filter((x) => x.kind === 'photo' && x.colorId === colorId).length;
  if (photos >= MAX_PHOTOS_PER_GROUP) {
    throw badRequest('too_many_photos', `Не больше ${MAX_PHOTOS_PER_GROUP} фото ${groupLabel(colorId)} - удалите лишние`);
  }
}

/** Добавить фото, модель или 360°. Модель и 360° в наборе по одной: новая заменяет прежнюю (файл прежней удаляет вызывающий). */
export async function addMedia(
  ctx: Ctx,
  productId: number,
  m: { kind: MerchMediaKind; file: string; thumb: string | null; width: number | null; height: number | null; bytes: number; colorId: number | null },
  actor: StaffPrincipal,
): Promise<{ product: AdminMerchProduct; files: string[] }> {
  await assertMediaRoom(ctx.db, productId, m.colorId, m.kind);
  const p = await adminProduct(ctx.db, productId);
  const sort = (p.media.at(-1)?.sort ?? 0) + 10;
  const old = m.kind !== 'photo' ? p.media.find((x) => x.kind === m.kind && x.colorId === m.colorId) : undefined;
  const [oldRow] = old ? await ctx.db.select().from(schema.merchMedia).where(eq(schema.merchMedia.id, old.id)) : [];
  await ctx.db.transaction(async (tx) => {
    if (oldRow) await tx.delete(schema.merchMedia).where(eq(schema.merchMedia.id, oldRow.id));
    await tx.insert(schema.merchMedia).values({ productId, ...m, sort: oldRow?.sort ?? sort });
    await audit(tx, { actorUserId: actor.user.id, action: 'merch.media_add', entity: 'merch_product', entityId: productId, before: oldRow ?? null, after: m });
  });
  const files = oldRow && oldRow.file !== m.file ? await unusedFiles(ctx.db, [oldRow.file, oldRow.thumb].filter((f): f is string => !!f)) : [];
  return { product: await adminProduct(ctx.db, productId), files };
}

export async function updateMedia(ctx: Ctx, mediaId: number, patch: Partial<{ colorId: number | null; sort: number }>, actor: StaffPrincipal) {
  const [m] = await ctx.db.select().from(schema.merchMedia).where(eq(schema.merchMedia.id, mediaId));
  if (!m) throw notFound('Файл не найден');
  if (patch.colorId != null && (await productOfColor(ctx.db, patch.colorId)) !== m.productId) throw badRequest('bad_color', 'Такого цвета у вещи нет');
  // Перенос в другой набор (другой цвет или общие) - с теми же ограничениями, что и загрузка.
  if (patch.colorId !== undefined && patch.colorId !== m.colorId) {
    if (m.kind === 'photo') await assertMediaRoom(ctx.db, m.productId, patch.colorId, 'photo');
    else {
      const p = await adminProduct(ctx.db, m.productId);
      if (p.media.some((x) => x.kind === m.kind && x.colorId === patch.colorId)) {
        throw conflict('model_exists', `${m.kind === 'spin' ? '360°' : '3D-модель'} ${groupLabel(patch.colorId)} уже есть - сначала удалите`);
      }
    }
  }
  await ctx.db.update(schema.merchMedia).set(patch).where(eq(schema.merchMedia.id, mediaId));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'merch.media_update', entity: 'merch_product', entityId: m.productId, after: { mediaId, ...patch } });
  return adminProduct(ctx.db, m.productId);
}

export async function deleteMedia(ctx: Ctx, mediaId: number, actor: StaffPrincipal): Promise<{ product: AdminMerchProduct; files: string[] }> {
  const [m] = await ctx.db.select().from(schema.merchMedia).where(eq(schema.merchMedia.id, mediaId));
  if (!m) throw notFound('Файл не найден');
  await ctx.db.delete(schema.merchMedia).where(eq(schema.merchMedia.id, mediaId));
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'merch.media_delete', entity: 'merch_product', entityId: m.productId, before: m });
  const files = await unusedFiles(ctx.db, [m.file, m.thumb].filter((f): f is string => !!f));
  return { product: await adminProduct(ctx.db, m.productId), files };
}

/** Из переданных - файлы, на которые больше не ссылается ни одно фото и ни одна модель (одинаковые файлы общие). */
async function unusedFiles(db: DbLike, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const used = await db
    .select({ file: schema.merchMedia.file, thumb: schema.merchMedia.thumb })
    .from(schema.merchMedia)
    .where(or(inArray(schema.merchMedia.file, files), inArray(schema.merchMedia.thumb, files)));
  const still = new Set(used.flatMap((u) => [u.file, u.thumb]));
  return files.filter((f) => !still.has(f));
}

/**
 * Редактор вещи: поля, «в витрине», цвета, размеры с остатками, фото и 3D с порядком - одной транзакцией.
 * Чего нет в присланном - удаляем; размер и цвет - только если их ни разу не заказывали.
 * `uploads` - новые файлы по имени (их проверил вызывающий). Файлы, на которые больше никто
 * не ссылается, удаляет вызывающий - после того как транзакция прошла.
 */
export async function saveProduct(
  ctx: Ctx,
  input: MerchProductSave,
  uploads: ReadonlyMap<string, StoredMedia>,
  actor: StaffPrincipal,
): Promise<{ product: AdminMerchProduct; files: string[] }> {
  const colorName = new Map(input.colors.map((c) => [c.key, c.name]));
  if (colorName.size !== input.colors.length) throw badRequest('bad_input', 'Цвета повторяются - обновите страницу');
  for (const c of input.colors) {
    const seen = new Set<string>();
    for (const s of c.sizes) {
      const k = s.size.toLowerCase();
      if (seen.has(k)) throw conflict('duplicate_size', `Размер ${s.size} у цвета «${c.name}» указан дважды`);
      seen.add(k);
    }
  }
  for (const m of input.media) {
    if ((m.id === null) === (m.file === null)) throw badRequest('bad_input', 'Неверный файл');
    if (m.color !== null && !colorName.has(m.color)) throw badRequest('bad_color', 'Такого цвета у вещи нет');
  }
  const groupName = (key: string | null) => (key === null ? 'в обложке и общих фото' : `у цвета «${colorName.get(key)}»`);

  let removed: string[] = [];
  const id = await ctx.db.transaction(async (tx) => {
    const fields = {
      title: input.title,
      subtitle: input.subtitle,
      descriptionMd: input.descriptionMd,
      price: input.price.toFixed(2),
      badge: input.badge,
      sort: input.sort,
      published: input.published,
    };
    let productId = input.id;
    let before: AdminMerchProduct | null = null;
    if (productId === null) {
      const [row] = await tx.insert(schema.merchProducts).values(fields).returning({ id: schema.merchProducts.id });
      productId = row!.id;
    } else {
      const [row] = await tx.select({ id: schema.merchProducts.id }).from(schema.merchProducts).where(eq(schema.merchProducts.id, productId)).for('update');
      if (!row) throw notFound('Товар не найден');
      // Размеры - под блокировкой, как при брони: остаток сверяем с заказами, которые уже не изменятся.
      await tx
        .select({ id: schema.merchVariants.id })
        .from(schema.merchVariants)
        .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
        .where(eq(schema.merchColors.productId, productId))
        .for('update', { of: schema.merchVariants });
      before = await adminProduct(tx, productId);
      await tx.update(schema.merchProducts).set({ ...fields, updatedAt: new Date() }).where(eq(schema.merchProducts.id, productId));
    }
    const pid = productId;

    // Цвета и размеры: присланные id - только этой вещи; остаток - не меньше, чем в заказах.
    const oldColors = new Map((before?.colors ?? []).map((c) => [c.id, c]));
    const oldSizes = new Map((before?.colors ?? []).flatMap((c) => c.sizes.map((s) => [s.id, { ...s, colorId: c.id, colorName: c.name }] as const)));
    for (const c of input.colors) {
      if (c.id !== null && !oldColors.has(c.id)) throw conflict('stale', 'Вещь уже изменили - обновите страницу');
      for (const s of c.sizes) {
        if (s.id === null) continue;
        const old = oldSizes.get(s.id);
        if (!old || old.colorId !== c.id) throw conflict('stale', 'Вещь уже изменили - обновите страницу');
        const inOrders = old.reserved + old.paid + old.issued;
        if (s.stock < inOrders) throw badRequest('stock_below_orders', `«${c.name}», ${old.size}: в заказах уже ${inOrders} шт. - остаток не может быть меньше`);
      }
    }
    const keptSizes = new Set(input.colors.flatMap((c) => c.sizes.flatMap((s) => (s.id === null ? [] : [s.id]))));
    const goneSizes = [...oldSizes.values()].filter((s) => !keptSizes.has(s.id));
    for (const s of goneSizes) {
      if (await hasAnyOrders(tx, [s.id])) {
        throw conflict('has_orders', `«${s.colorName}», ${s.size} уже заказывали - удалить нельзя, поставьте остаток 0`);
      }
    }

    // Файлы: присланные id - только этой вещи; в наборе до 10 фото, одна 3D-модель и один 360°.
    const oldMedia = new Map((before?.media ?? []).map((m) => [m.id, m]));
    const counts = new Map<string | null, Record<MerchMediaKind, number>>();
    for (const m of input.media) {
      const kind = m.id !== null ? oldMedia.get(m.id)?.kind : uploads.get(m.file!)?.kind;
      if (!kind) throw conflict('stale', 'Вещь уже изменили - обновите страницу');
      const n = counts.get(m.color) ?? { photo: 0, model: 0, spin: 0 };
      n[kind] += 1;
      counts.set(m.color, n);
      if (n.photo > MAX_PHOTOS_PER_GROUP) throw badRequest('too_many_photos', `Не больше ${MAX_PHOTOS_PER_GROUP} фото ${groupName(m.color)}`);
      if (n.model > 1) throw badRequest('model_exists', `3D-модель ${groupName(m.color)} может быть только одна`);
      if (n.spin > 1) throw badRequest('spin_exists', `360° ${groupName(m.color)} может быть только один`);
    }

    const keptMedia = new Set(input.media.flatMap((m) => (m.id === null ? [] : [m.id])));
    const goneMedia = [...oldMedia.values()].filter((m) => !keptMedia.has(m.id));
    if (goneMedia.length) {
      const rows = await tx.select().from(schema.merchMedia).where(inArray(schema.merchMedia.id, goneMedia.map((m) => m.id)));
      removed = rows.flatMap((r) => [r.file, r.thumb]).filter((f): f is string => !!f);
      await tx.delete(schema.merchMedia).where(inArray(schema.merchMedia.id, goneMedia.map((m) => m.id)));
    }
    if (goneSizes.length) await tx.delete(schema.merchVariants).where(inArray(schema.merchVariants.id, goneSizes.map((s) => s.id)));
    const keptColors = new Set(input.colors.flatMap((c) => (c.id === null ? [] : [c.id])));
    const goneColors = [...oldColors.keys()].filter((cid) => !keptColors.has(cid));
    if (goneColors.length) await tx.delete(schema.merchColors).where(inArray(schema.merchColors.id, goneColors));

    const colorIds = new Map<string, number>();
    for (const [i, c] of input.colors.entries()) {
      const values = { name: c.name, hex: c.hex, sort: i * 10 };
      if (c.id !== null) {
        await tx.update(schema.merchColors).set(values).where(eq(schema.merchColors.id, c.id));
        colorIds.set(c.key, c.id);
      } else {
        const [row] = await tx.insert(schema.merchColors).values({ productId: pid, ...values }).returning({ id: schema.merchColors.id });
        colorIds.set(c.key, row!.id);
      }
      const colorId = colorIds.get(c.key)!;
      // Переименования - через временное имя: иначе обмен M↔L упёрся бы в уникальность размера.
      for (const s of c.sizes) {
        if (s.id !== null && oldSizes.get(s.id)!.size !== s.size) {
          await tx.update(schema.merchVariants).set({ size: `~${s.id}` }).where(eq(schema.merchVariants.id, s.id));
        }
      }
      for (const [j, s] of c.sizes.entries()) {
        const values = { size: s.size, stock: s.stock, sort: j * 10 };
        if (s.id !== null) await tx.update(schema.merchVariants).set(values).where(eq(schema.merchVariants.id, s.id));
        else await tx.insert(schema.merchVariants).values({ colorId, ...values });
      }
    }

    for (const [i, m] of input.media.entries()) {
      const colorId = m.color === null ? null : colorIds.get(m.color)!;
      if (m.id !== null) await tx.update(schema.merchMedia).set({ colorId, sort: i * 10 }).where(eq(schema.merchMedia.id, m.id));
      else await tx.insert(schema.merchMedia).values({ productId: pid, ...uploads.get(m.file!)!, colorId, sort: i * 10 });
    }

    await audit(tx, {
      actorUserId: actor.user.id,
      action: before ? 'merch.product_save' : 'merch.product_create',
      entity: 'merch_product',
      entityId: pid,
      before,
      after: input,
    });
    return pid;
  });
  return { product: await adminProduct(ctx.db, id), files: await unusedFiles(ctx.db, removed) };
}

// ---------- заказы ----------

/**
 * Сколько цветов под этим названием: у вещи и у других вещей с тем же названием (разные принты заведены
 * отдельными вещами). Больше одного - в подписи нужен цвет, иначе «Футболка, M» не отличить.
 */
async function colorsByTitle(db: DbLike, productIds: number[]): Promise<Map<number, number>> {
  if (productIds.length === 0) return new Map();
  const res = await db.execute<{ id: string; n: number }>(sql`
    select p.id, (select count(*) from merch_colors c join merch_products p2 on p2.id = c.product_id where p2.title = p.title)::int as n
      from merch_products p where p.id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})`);
  return new Map(res.rows.map((r) => [Number(r.id), r.n]));
}

function orderLabel(product: { title: string }, color: { name: string }, size: string, colorsCount: number): string {
  return colorsCount > 1 ? `${product.title} - ${color.name}, ${size}` : `${product.title}, ${size}`;
}

async function orderViews(db: DbLike, orders: OrderRow[]): Promise<MerchOrderView[]> {
  if (orders.length === 0) return [];
  const items = await db
    .select({ item: schema.merchOrderItems, productId: schema.merchColors.productId, colorId: schema.merchColors.id })
    .from(schema.merchOrderItems)
    .innerJoin(schema.merchVariants, eq(schema.merchVariants.id, schema.merchOrderItems.variantId))
    .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
    .where(inArray(schema.merchOrderItems.orderId, orders.map((o) => o.id)))
    .orderBy(asc(schema.merchOrderItems.id));
  // Превью - первое фото цвета, иначе первое фото вещи.
  const pids = [...new Set(items.map((i) => i.productId))];
  const photos = pids.length
    ? await db
        .select()
        .from(schema.merchMedia)
        .where(and(inArray(schema.merchMedia.productId, pids), eq(schema.merchMedia.kind, 'photo')))
        .orderBy(asc(schema.merchMedia.sort), asc(schema.merchMedia.id))
    : [];
  const thumbFor = (productId: number, colorId: number) =>
    mediaUrl((photos.find((m) => m.productId === productId && m.colorId === colorId) ?? photos.find((m) => m.productId === productId && m.colorId === null) ?? photos.find((m) => m.productId === productId))?.thumb ?? null);
  return orders.map((o) => ({
    id: o.id,
    code: o.code,
    status: o.status as MerchOrderView['status'],
    total: o.total,
    paidAmount: o.paidAmount,
    paymentMethod: (o.paymentMethod as MerchOrderView['paymentMethod']) ?? null,
    expiresAt: o.expiresAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    issuedAt: o.issuedAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    receiptAt: o.receiptAt?.toISOString() ?? null,
    confirmBy: confirmByOf(o)?.toISOString() ?? null,
    confirmDrops: !o.confirmSoft,
    items: items
      .filter((i) => i.item.orderId === o.id)
      .map((i) => ({
        variantId: i.item.variantId,
        productId: i.productId,
        title: i.item.title,
        qty: i.item.qty,
        price: i.item.price,
        thumbUrl: thumbFor(i.productId, i.colorId),
      })),
  }));
}

/**
 * Заказы человека: свои брони и продажи на месте на кого-то из его семьи (продавец записывает их на себя,
 * указывая покупателя). Свои продажи другим людям продавцу здесь не показываем.
 */
export async function myOrders(db: DbLike, user: UserRow): Promise<MerchOrderView[]> {
  const family = db
    .select({ id: schema.participants.id })
    .from(schema.participants)
    .where(or(eq(schema.participants.ownerUserId, user.id), eq(schema.participants.holderUserId, user.id)));
  const rows = await db
    .select()
    .from(schema.merchOrders)
    .where(
      or(
        and(eq(schema.merchOrders.userId, user.id), isNull(schema.merchOrders.buyerParticipantId), isNull(schema.merchOrders.buyerName)),
        inArray(schema.merchOrders.buyerParticipantId, family),
      ),
    )
    .orderBy(desc(schema.merchOrders.createdAt));
  return orderViews(db, rows);
}

/** Кому писать о покупке на месте: аккаунт, у которого QR-код покупателя (или который его записал). */
async function buyerAccount(db: DbLike, participantId: number | null): Promise<number | null> {
  if (!participantId) return null;
  const [p] = await db
    .select({ owner: schema.participants.ownerUserId, holder: schema.participants.holderUserId })
    .from(schema.participants)
    .where(eq(schema.participants.id, participantId));
  return p ? (p.holder ?? p.owner) : null;
}

async function newCode(tx: Tx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = `M-${randomInt(1000, 10000)}`;
    const [taken] = await tx.select({ id: schema.merchOrders.id }).from(schema.merchOrders).where(eq(schema.merchOrders.code, code));
    if (!taken) return code;
  }
  return `M-${randomInt(10000, 100000)}`;
}

/**
 * Бронь: строки размеров блокируем - две брони на последнюю вещь не пройдут обе.
 * Повтор с тем же requestId возвращает тот же заказ. Срок брони - из настроек.
 */
export async function createOrder(
  ctx: Ctx,
  user: UserRow,
  input: MerchOrderCreate,
  opts: {
    staffSale?: StaffPrincipal;
    method?: MerchPayMethod;
    sale?: Omit<MerchSell, keyof MerchOrderCreate | 'method'>;
    /** Бронь для человека делает продавец (по заявке из переписки): обычная бронь, но без проверок «сам». */
    reservedBy?: StaffPrincipal;
  } = {},
): Promise<MerchOrderView> {
  const settings = await getSettings(ctx.db);
  const self = !opts.staffSale && !opts.reservedBy;
  if (self && !merchAccess(settings, await getRoles(ctx.db, user.id)).sales) {
    throw conflict('sales_closed', 'Бронь мерча пока закрыта');
  }
  if (self && !settings.merchSelfBooking) {
    throw conflict('booking_by_chat', 'Бронь - через чат: выберите размер и нажмите «Забронировать / спросить»');
  }
  const [existing] = await ctx.db.select().from(schema.merchOrders).where(eq(schema.merchOrders.requestId, input.requestId));
  if (existing) {
    if (existing.userId !== user.id) throw conflict('request_reused', 'Повторите заказ');
    return (await orderViews(ctx.db, [existing]))[0]!;
  }
  const qtyByVariant = new Map<number, number>();
  for (const it of input.items) qtyByVariant.set(it.variantId, (qtyByVariant.get(it.variantId) ?? 0) + it.qty);
  const variantIds = [...qtyByVariant.keys()].sort((a, b) => a - b);

  try {
    const order = await ctx.db.transaction(async (tx) => {
      if (self) {
        const [open] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.merchOrders)
          .where(and(eq(schema.merchOrders.userId, user.id), eq(schema.merchOrders.status, 'reserved')));
        if ((open?.n ?? 0) >= MAX_OPEN_ORDERS) {
          throw conflict('too_many_orders', `Неоплаченных броней уже ${MAX_OPEN_ORDERS} - оплатите или отмените какую-нибудь`);
        }
      }
      // Блокировка в одном порядке - две брони не встанут в тупик.
      const variants = await tx
        .select({ v: schema.merchVariants, c: schema.merchColors, p: schema.merchProducts })
        .from(schema.merchVariants)
        .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
        .innerJoin(schema.merchProducts, eq(schema.merchProducts.id, schema.merchColors.productId))
        .where(inArray(schema.merchVariants.id, variantIds))
        .orderBy(asc(schema.merchVariants.id))
        .for('update', { of: schema.merchVariants });
      if (variants.length !== variantIds.length || (self && variants.some((r) => !r.p.published))) {
        throw conflict('not_available', 'Этой вещи уже нет в витрине - обновите страницу');
      }
      const colorsCount = await colorsByTitle(tx, [...new Set(variants.map((r) => r.p.id))]);
      const held = await heldByVariant(tx, variantIds);
      for (const r of variants) {
        const h = held.get(r.v.id) ?? { reserved: 0, paid: 0, issued: 0 };
        const left = r.v.stock - h.reserved - h.paid - h.issued;
        const want = qtyByVariant.get(r.v.id)!;
        if (want > left) {
          const label = orderLabel(r.p, r.c, r.v.size, colorsCount.get(r.p.id) ?? 1);
          throw conflict('sold_out', left > 0 ? `«${label}»: осталось ${left} шт.` : `«${label}» закончился`, { variantId: r.v.id, left: Math.max(0, left) });
        }
      }
      const total = variants.reduce((s, r) => s + Number(r.p.price) * qtyByVariant.get(r.v.id)!, 0);
      const now = new Date();
      const staff = opts.staffSale;
      const sale = opts.sale;
      const method = opts.method ?? 'cash';
      // В долг: сразу внесённая часть; внесли всё - это обычная продажа.
      const paidNow = staff ? (sale?.debt ? Math.min(Number(sale.paidNow ?? 0), total) : total) : 0;
      const owed = !!staff && total - paidNow > 0.005;
      if (staff && sale?.buyerParticipantId) {
        const [p] = await tx.select({ id: schema.participants.id }).from(schema.participants).where(eq(schema.participants.id, sale.buyerParticipantId));
        if (!p) throw notFound('Участник не найден');
      }
      const expiresAt = !staff && settings.merchReservationHours ? new Date(now.getTime() + settings.merchReservationHours * 3600_000) : null;
      const [row] = await tx
        .insert(schema.merchOrders)
        .values({
          userId: user.id,
          code: await newCode(tx),
          requestId: input.requestId,
          // Продажа на месте: сразу оплачено и выдано; в долг - выдано, деньги потом.
          status: staff ? (owed ? 'owed' : 'issued') : 'reserved',
          total: total.toFixed(2),
          paidAmount: paidNow.toFixed(2),
          // Оплата онлайн выключена - бронь только «на месте», даже если старое приложение просит перевод.
          paymentMethod: staff ? (paidNow > 0 ? method : null) : onlinePayment(settings) ? input.paymentMethod : 'cash',
          expiresAt,
          note: staff ? (owed ? 'Продажа в долг' : 'Продажа на месте') : null,
          paidAt: staff && !owed ? now : null,
          paidBy: staff && !owed ? staff.user.id : null,
          issuedAt: staff ? now : null,
          issuedBy: staff ? staff.user.id : null,
          reservedBy: opts.reservedBy?.user.id ?? null,
          buyerParticipantId: staff ? (sale?.buyerParticipantId ?? null) : null,
          buyerName: staff ? sale?.buyerName?.trim() || null : null,
          buyerPhone: staff ? sale?.buyerPhone?.trim() || null : null,
        })
        .returning();
      await tx.insert(schema.merchOrderItems).values(
        variants.map((r) => ({
          orderId: row!.id,
          variantId: r.v.id,
          qty: qtyByVariant.get(r.v.id)!,
          price: r.p.price,
          title: orderLabel(r.p, r.c, r.v.size, colorsCount.get(r.p.id) ?? 1),
        })),
      );
      if (staff) await recordMerchMoney(tx, row!, paidNow, method, staff);
      await audit(tx, {
        actorUserId: staff?.user.id ?? opts.reservedBy?.user.id ?? user.id,
        action: staff ? (owed ? 'merch.order_sell_debt' : 'merch.order_sell') : opts.reservedBy ? 'merch.order_reserve' : 'merch.order_create',
        entity: 'merch_order',
        entityId: row!.id,
        after: { items: input.items, total: total.toFixed(2), code: row!.code, ...(staff ? { paid: paidNow.toFixed(2), method, buyer: sale ?? null } : {}) },
      });
      if (expiresAt) await enqueue(ctx.boss, 'merch.expire', { orderId: row!.id }, { tx, startAfter: expiresAt });
      // Купили на месте с оплатой - покупателю в бот: что купил и как оплатил.
      const buyer = staff && !owed ? await buyerAccount(tx, sale?.buyerParticipantId ?? null) : null;
      if (buyer) {
        await enqueue(
          ctx.boss,
          'notify.text',
          {
            kind: 'merch.notice',
            userId: buyer,
            text:
              `🛍 <b>Покупка мерча</b> - код <b>${esc(row!.code)}</b>\n` +
              variants.map((r) => `• ${esc(orderLabel(r.p, r.c, r.v.size, colorsCount.get(r.p.id) ?? 1))} × ${qtyByVariant.get(r.v.id)}`).join('\n') +
              `\nОплачено ${METHOD_LABEL[method]}: <b>${formatRub(total.toFixed(2))}</b>. Спасибо!`,
          },
          { tx },
        );
      }
      // Взяли в долг - покупателю в бот: что взял и сколько вернуть.
      const debtor = owed ? await buyerAccount(tx, sale?.buyerParticipantId ?? null) : null;
      if (debtor) {
        await enqueue(
          ctx.boss,
          'notify.text',
          {
            kind: 'merch.notice',
            userId: debtor,
            text:
              `🛍 <b>Мерч взят в долг</b> - код <b>${esc(row!.code)}</b>\n` +
              variants.map((r) => `• ${esc(orderLabel(r.p, r.c, r.v.size, colorsCount.get(r.p.id) ?? 1))} × ${qtyByVariant.get(r.v.id)}`).join('\n') +
              `\nИтого: ${formatRub(total.toFixed(2))}${paidNow > 0 ? `, внесено ${formatRub(paidNow.toFixed(2))}` : ''}\n` +
              `<b>Осталось оплатить: ${formatRub((total - paidNow).toFixed(2))}</b>\n\n` +
              `Оплатить - ${PLACE}. Назовите код или покажите QR-код участника. Долг видно в приложении: «Мерч» → «Мои заказы».`,
          },
          { tx },
        );
      }
      // Бронь продавца человеку сообщает сам продавец - сообщением в переписке.
      if (self) {
        await enqueue(
          ctx.boss,
          'notify.text',
          {
            kind: 'merch.notice',
            userId: user.id,
            text:
              `🛍 <b>Мерч забронирован</b> - код <b>${esc(row!.code)}</b>\n` +
              variants.map((r) => `• ${esc(orderLabel(r.p, r.c, r.v.size, colorsCount.get(r.p.id) ?? 1))} × ${qtyByVariant.get(r.v.id)}`).join('\n') +
              `\nИтого: <b>${formatRub(total.toFixed(2))}</b>\n\n` +
              holdLines(expiresAt, settings),
          },
          { tx },
        );
      }
      return row!;
    });
    return (await orderViews(ctx.db, [order]))[0]!;
  } catch (err) {
    // Две одинаковые отправки одновременно: вторая упала на уникальном requestId - вернём первый заказ.
    if (isUniqueViolation(err, 'merch_orders_request_id_unique')) {
      const [again] = await ctx.db.select().from(schema.merchOrders).where(eq(schema.merchOrders.requestId, input.requestId));
      if (again && again.userId === user.id) return (await orderViews(ctx.db, [again]))[0]!;
    }
    throw err;
  }
}

/**
 * Заявка на бронь из приложения («Забронировать / спросить»): проверяем вещи и запоминаем, как их видел человек.
 * Остатки не трогаем - бронь делает продавец, когда всё уточнит.
 */
export async function merchRequestItems(db: DbLike, user: UserRow, items: MerchOrderCreate['items']): Promise<ChatMerchItem[]> {
  const settings = await getSettings(db);
  if (!merchAccess(settings, await getRoles(db, user.id)).sales) throw conflict('sales_closed', 'Бронь мерча пока закрыта');
  const qty = new Map<number, number>();
  for (const it of items) qty.set(it.variantId, Math.min(10, (qty.get(it.variantId) ?? 0) + it.qty));
  const ids = [...qty.keys()];
  const rows = await db
    .select({ v: schema.merchVariants, c: schema.merchColors, p: schema.merchProducts })
    .from(schema.merchVariants)
    .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
    .innerJoin(schema.merchProducts, eq(schema.merchProducts.id, schema.merchColors.productId))
    .where(inArray(schema.merchVariants.id, ids));
  if (rows.length !== ids.length || rows.some((r) => !r.p.published)) {
    throw conflict('not_available', 'Этой вещи уже нет в витрине - обновите страницу');
  }
  const colorsCount = await colorsByTitle(db, [...new Set(rows.map((r) => r.p.id))]);
  return ids.map((id) => {
    const r = rows.find((x) => x.v.id === id)!;
    return { variantId: id, qty: qty.get(id)!, title: orderLabel(r.p, r.c, r.v.size, colorsCount.get(r.p.id) ?? 1), price: r.p.price };
  });
}

/** Ключ брони по заявке: два продавца нажали «Забронировать» одновременно - получится одна бронь. */
const requestKey = (messageId: number, previousOrderId: number | null) => {
  const h = createHash('sha256').update(`chat-merch:${messageId}:${previousOrderId ?? 0}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/**
 * Продавец бронирует вещи человеку из переписки: обычная бронь (держит остатки, срок - из настроек),
 * человеку - сообщение с кодом в переписку и бот. По заявке - на ней появляется «Забронировано»;
 * второй раз по той же заявке не забронировать, пока прежнюю бронь не отменили.
 */
export async function reserveForUser(
  ctx: Ctx,
  actor: StaffPrincipal,
  input: MerchReserve,
): Promise<{ order: AdminMerchOrderView; message: ChatMessageView | null }> {
  const user = await getUser(ctx.db, input.userId);
  if (!user) throw notFound('Человек не найден');
  let requestId = input.requestId;
  if (input.messageId) {
    const [m] = await ctx.db.select().from(schema.supportMessages).where(eq(schema.supportMessages.id, input.messageId));
    if (!m || m.userId !== user.id || !m.merchItems) throw notFound('Заявка не найдена');
    if (m.merchOrderId) {
      const [prev] = await ctx.db.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, m.merchOrderId));
      if (prev && prev.status !== 'cancelled' && prev.status !== 'expired') {
        throw conflict('already_reserved', `По этой заявке уже забронировано: ${prev.code}`);
      }
    }
    requestId = requestKey(m.id, m.merchOrderId);
  }
  const [before] = await ctx.db.select({ id: schema.merchOrders.id }).from(schema.merchOrders).where(eq(schema.merchOrders.requestId, requestId));
  const order = await createOrder(ctx, user, { requestId, items: input.items, paymentMethod: 'cash' }, { reservedBy: actor });
  // Повтор (двойное нажатие, второй продавец) - бронь та же, второе сообщение человеку не шлём.
  let fresh = !before;
  if (input.messageId) {
    const linked = await ctx.db
      .update(schema.supportMessages)
      .set({ merchOrderId: order.id })
      .where(and(eq(schema.supportMessages.id, input.messageId), sql`${schema.supportMessages.merchOrderId} is distinct from ${order.id}`))
      .returning({ id: schema.supportMessages.id });
    fresh = linked.length > 0;
  }
  let message: ChatMessageView | null = null;
  if (fresh) {
    const settings = await getSettings(ctx.db);
    const text =
      `🛍 Забронировали для вас - код ${order.code}\n` +
      order.items.map((it) => `• ${it.title} × ${it.qty}`).join('\n') +
      `\nИтого: ${formatRub(order.total)}\n\n` +
      holdLines(order.expiresAt ? new Date(order.expiresAt) : null, settings);
    message = await staffWrites(ctx, actor, user.id, { text }, { topic: 'merch' });
  }
  return { order: (await adminOrders(ctx.db, [order.id]))[0]!, message };
}

async function ownOrder(db: DbLike, user: UserRow, orderId: number): Promise<OrderRow> {
  const [o] = await db.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, orderId));
  if (!o || o.userId !== user.id) throw notFound('Заказ не найден');
  return o;
}

export async function cancelOwnOrder(ctx: Ctx, user: UserRow, orderId: number): Promise<MerchOrderView> {
  const o = await ownOrder(ctx.db, user, orderId);
  if (o.status !== 'reserved') throw conflict('not_reserved', 'Отменить можно только неоплаченную бронь - по оплаченной напишите организаторам');
  const [row] = await ctx.db
    .update(schema.merchOrders)
    .set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Отменил(а) сам(а)', updatedAt: new Date() })
    .where(and(eq(schema.merchOrders.id, orderId), eq(schema.merchOrders.status, 'reserved')))
    .returning();
  await audit(ctx.db, { actorUserId: user.id, action: 'merch.order_cancel', entity: 'merch_order', entityId: orderId, before: { status: o.status } });
  return (await orderViews(ctx.db, [row ?? o]))[0]!;
}

/** Где забрать мерч и что сказать. Код брони человек видит выше - здесь его не повторяем. */
const PLACE = 'у стола мерча в фойе церкви';
const SHOW = 'Назовите код брони или покажите QR-код участника';
export const PICKUP = `Забрать и оплатить - ${PLACE}. ${SHOW}`;
export const PICKUP_PAID = `Забрать - ${PLACE}. ${SHOW}`;

/** Хвост сообщения о брони: где забрать, когда снимется (если срок задан), можно ли перевести заранее. */
function holdLines(expiresAt: Date | null, s: Settings): string {
  const until = expiresAt
    ? `Бронь снимется ${new Intl.DateTimeFormat('ru-RU', { timeZone: s.eventTimezone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(expiresAt)}, если не оплатить.\n`
    : '';
  // Перевод - отдельным абзацем: куда нажать, чтобы увидеть реквизиты и прикрепить чек.
  return (
    `${until}${PICKUP}.` +
    (onlinePayment(s)
      ? '\n\n💳 Можно оплатить переводом заранее. В приложении откройте «Мерч» → «Мои заказы» и выберите «Переводом» - там реквизиты и кнопка «Прикрепить чек».'
      : '')
  );
}

// ---------- «точно заберёте?» ----------

/** Спросили и ещё не ответили - до какого времени ждём (без снятия брони - пока время не вышло). */
function confirmByOf(o: typeof schema.merchOrders.$inferSelect): Date | null {
  if (o.status !== 'reserved' || !o.confirmAskedAt || !o.confirmBy) return null;
  if (o.confirmedAt && o.confirmedAt >= o.confirmAskedAt) return null;
  if (o.confirmSoft && o.confirmBy.getTime() <= Date.now()) return null;
  return o.confirmBy;
}

/** Срок ответа на «Точно заберёте?» по настройкам: время вопроса + часы на ответ. */
export function confirmDeadline(s: Pick<Settings, 'merchConfirmAt' | 'merchConfirmHours'>): Date | null {
  return s.merchConfirmAt ? new Date(Date.parse(s.merchConfirmAt) + s.merchConfirmHours * 3600_000) : null;
}

/**
 * Кого спросить в этот раз (`round` - время вопроса из настроек): все неоплаченные брони, которых с этого времени ещё не спрашивали.
 * `soft` - без снятия брони: снимать выключено в настройках (`drop`) или человек уже подтверждал раньше.
 */
export async function ordersToConfirm(
  db: DbLike,
  round: Date,
  drop = true,
): Promise<{ id: number; userId: number; code: string; soft: boolean; items: string[] }[]> {
  const rows = await db
    .select({
      id: schema.merchOrders.id,
      userId: schema.merchOrders.userId,
      code: schema.merchOrders.code,
      confirmedAt: schema.merchOrders.confirmedAt,
    })
    .from(schema.merchOrders)
    .where(
      and(
        eq(schema.merchOrders.status, 'reserved'),
        sql`(${schema.merchOrders.confirmAskedAt} is null or ${schema.merchOrders.confirmAskedAt} < ${round.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(asc(schema.merchOrders.id));
  if (!rows.length) return [];
  const items = await orderItemLines(db, rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, userId: r.userId, code: r.code, soft: !drop || r.confirmedAt !== null, items: items.get(r.id) ?? [] }));
}

/** Оплаченные, но ещё не выданные заказы - им просто напоминаем забрать. */
export async function paidToRemind(db: DbLike): Promise<{ id: number; userId: number; code: string; items: string[] }[]> {
  const rows = await db
    .select({ id: schema.merchOrders.id, userId: schema.merchOrders.userId, code: schema.merchOrders.code })
    .from(schema.merchOrders)
    .where(eq(schema.merchOrders.status, 'paid'))
    .orderBy(asc(schema.merchOrders.id));
  if (!rows.length) return [];
  const items = await orderItemLines(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, items: items.get(r.id) ?? [] }));
}

async function orderItemLines(db: DbLike, ids: number[]): Promise<Map<number, string[]>> {
  const items = await db
    .select({ orderId: schema.merchOrderItems.orderId, title: schema.merchOrderItems.title, qty: schema.merchOrderItems.qty })
    .from(schema.merchOrderItems)
    .where(inArray(schema.merchOrderItems.orderId, ids))
    .orderBy(asc(schema.merchOrderItems.id));
  const out = new Map<number, string[]>();
  for (const i of items) out.set(i.orderId, [...(out.get(i.orderId) ?? []), `${i.title}${i.qty > 1 ? ` × ${i.qty}` : ''}`]);
  return out;
}

/** Вопрос дошёл до человека: ждём ответа до `by`. */
export async function markConfirmAsked(db: DbLike, orderId: number, at: Date, by: Date, soft: boolean): Promise<void> {
  await db.update(schema.merchOrders).set({ confirmAskedAt: at, confirmBy: by, confirmSoft: soft, updatedAt: new Date() }).where(eq(schema.merchOrders.id, orderId));
}

/** Время вопроса из настроек: «13:30» и «16:30» по часам конференции. */
export const confirmTime = (d: Date, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);

/** «Да, заберу» - из бота или приложения. */
export async function confirmOwnOrder(ctx: Ctx, user: UserRow, orderId: number): Promise<MerchOrderView> {
  const o = await ownOrder(ctx.db, user, orderId);
  if (o.status !== 'reserved') throw conflict('not_reserved', o.status === 'paid' ? 'Заказ уже оплачен - ждём вас у стола с мерчем' : 'Эта бронь уже снята');
  const [row] = await ctx.db.update(schema.merchOrders).set({ confirmedAt: new Date(), updatedAt: new Date() }).where(eq(schema.merchOrders.id, orderId)).returning();
  await audit(ctx.db, { actorUserId: user.id, action: 'merch.order_confirm', entity: 'merch_order', entityId: orderId });
  return (await orderViews(ctx.db, [row!]))[0]!;
}

/** Время ответа вышло: не подтвердили именно этот вопрос и не оплатили - снимаем бронь, вещи возвращаются в витрину. */
export async function dropUnconfirmed(ctx: Ctx, orderId: number, askedAt: string): Promise<boolean> {
  const [row] = await ctx.db
    .update(schema.merchOrders)
    .set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: DROPPED_REASON, updatedAt: new Date() })
    .where(
      and(
        eq(schema.merchOrders.id, orderId),
        eq(schema.merchOrders.status, 'reserved'),
        eq(schema.merchOrders.confirmSoft, false),
        sql`${schema.merchOrders.confirmAskedAt} = ${askedAt}::timestamptz`,
        sql`(${schema.merchOrders.confirmedAt} is null or ${schema.merchOrders.confirmedAt} < ${schema.merchOrders.confirmAskedAt})`,
      ),
    )
    .returning();
  if (!row) return false;
  await audit(ctx.db, { actorUserId: null, action: 'merch.order_unconfirmed', entity: 'merch_order', entityId: orderId });
  await enqueue(ctx.boss, 'notify.text', {
    kind: 'merch.notice',
    userId: row.userId,
    text: `⌛ Бронь мерча <b>${esc(row.code)}</b> снята - не получили ответа, что вы её заберёте. Вещи вернулись в витрину, можно забронировать заново.`,
  });
  return true;
}

/** Платить за бронь переводом из приложения: переводы включены и для мерча оплата онлайн не выключена. */
export const onlinePayment = (s: Settings) => s.transfersEnabled && s.merchOnlinePayment;

/** Роли, которым можно слать копии сообщений из «Мерча»: продавцы (по умолчанию да) и админы (по умолчанию нет). */
const NOTIFY_ROLES = ['seller', 'admin', 'superadmin'];

/** Кому слать копии сообщений из «Мерча»: продавцы и админы с отметкой «да / нет» (кого не отмечали - по умолчанию). */
export async function merchNotifyPeople(db: DbLike, s: Settings): Promise<MerchSettingsView['merchNotifyPeople']> {
  const rows = await db
    .select({ userId: schema.staffRoles.userId, role: schema.staffRoles.role })
    .from(schema.staffRoles)
    .where(inArray(schema.staffRoles.role, NOTIFY_ROLES));
  const roles = new Map<number, string[]>();
  for (const r of rows) roles.set(r.userId, [...(roles.get(r.userId) ?? []), r.role]);
  const names = await namesOf(db, [...roles.keys()]);
  return [...roles]
    .map(([userId, rs]) => ({
      userId,
      name: names.get(userId)?.name ?? 'Без имени',
      roles: NOTIFY_ROLES.filter((r) => rs.includes(r)),
      on: s.merchNotify[String(userId)] ?? rs.includes('seller'),
    }))
    .sort((a, b) => Number(b.roles.includes('seller')) - Number(a.roles.includes('seller')) || a.name.localeCompare(b.name, 'ru'));
}

/** Кому сейчас слать копии сообщений из «Мерча». */
export async function merchNotifyRecipients(db: DbLike): Promise<number[]> {
  return (await merchNotifyPeople(db, await getSettings(db))).filter((p) => p.on).map((p) => p.userId);
}

async function merchSettingsView(db: DbLike, s: Settings): Promise<MerchSettingsView> {
  return {
    merchVisible: s.merchVisible,
    merchAdminsOnly: s.merchAdminsOnly,
    merchSalesEnabled: s.merchSalesEnabled,
    merchSelfBooking: s.merchSelfBooking,
    merchReservationHours: s.merchReservationHours,
    merchOnlinePayment: s.merchOnlinePayment,
    merchPaymentInstructions: s.merchPaymentInstructions,
    merchConfirmAt: s.merchConfirmAt,
    merchConfirmHours: s.merchConfirmHours,
    merchConfirmDrop: s.merchConfirmDrop,
    merchNotify: s.merchNotify,
    transfersEnabled: s.transfersEnabled,
    merchNotifyPeople: await merchNotifyPeople(db, s),
  };
}

/** Настройки мерча для продавца: только поля мерча, остальные настройки он не видит и не меняет. */
export async function getMerchSettings(db: DbLike): Promise<MerchSettingsView> {
  return merchSettingsView(db, await getSettings(db, { fresh: true }));
}

export async function patchMerchSettings(db: DbLike, patch: Partial<MerchSettings>, actorUserId: number): Promise<MerchSettingsView> {
  return merchSettingsView(db, await patchSettings(db, patch, actorUserId));
}

export async function setOwnPaymentMethod(ctx: Ctx, user: UserRow, orderId: number, method: 'cash' | 'transfer'): Promise<MerchOrderView> {
  if (method === 'transfer' && !onlinePayment(await getSettings(ctx.db))) throw badRequest('transfers_disabled', 'Переводом сейчас не принимаем - оплатите на месте');
  const o = await ownOrder(ctx.db, user, orderId);
  if (o.status !== 'reserved') throw conflict('not_reserved', 'Заказ уже оплачен или снят');
  const [row] = await ctx.db.update(schema.merchOrders).set({ paymentMethod: method, updatedAt: new Date() }).where(eq(schema.merchOrders.id, orderId)).returning();
  return (await orderViews(ctx.db, [row!]))[0]!;
}

/** Чек перевода к брони: файл уже сохранён в закрытую папку, здесь - привязка. */
export async function attachOwnReceipt(ctx: Ctx, user: UserRow, orderId: number, file: { file: string; mime: string }): Promise<{ order: MerchOrderView; replaced: string | null }> {
  const o = await ownOrder(ctx.db, user, orderId);
  if (o.status !== 'reserved') throw conflict('not_reserved', 'Заказ уже оплачен или снят');
  const [row] = await ctx.db
    .update(schema.merchOrders)
    .set({ paymentMethod: 'transfer', receiptFile: file.file, receiptMime: file.mime, receiptAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.merchOrders.id, orderId))
    .returning();
  // Чек виден и в «Чеках» (вид «Мерч»): заменили файл до проверки - это тот же чек.
  const [open] = await ctx.db
    .select({ id: schema.paymentReceipts.id })
    .from(schema.paymentReceipts)
    .where(and(eq(schema.paymentReceipts.merchOrderId, orderId), eq(schema.paymentReceipts.status, 'pending')))
    .limit(1);
  const receipt = { storedFile: file.file, mimeType: file.mime, fileKind: file.mime.startsWith('image/') ? 'photo' : 'document' };
  let receiptId = open?.id;
  if (open) await ctx.db.update(schema.paymentReceipts).set({ ...receipt, createdAt: new Date() }).where(eq(schema.paymentReceipts.id, open.id));
  else {
    const [created] = await ctx.db
      .insert(schema.paymentReceipts)
      .values({ ...receipt, userId: user.id, participantIds: [], kind: 'merch', merchOrderId: orderId, status: 'pending' })
      .returning({ id: schema.paymentReceipts.id });
    receiptId = created?.id;
  }
  // Продавцам - в бот: чек пришёл, проверьте и подтвердите оплату.
  if (receiptId) await enqueue(ctx.boss, 'merch.receipt_notify', { receiptId });
  await audit(ctx.db, { actorUserId: user.id, action: 'merch.order_receipt', entity: 'merch_order', entityId: orderId, after: { file: file.file } });
  const replaced = o.receiptFile && o.receiptFile !== file.file ? o.receiptFile : null;
  return { order: (await orderViews(ctx.db, [row!]))[0]!, replaced };
}

/** Бронь истекла: снимаем, если её так и не оплатили (задача могла прийти после оплаты или отмены). */
export async function expireOrder(ctx: Ctx, orderId: number): Promise<boolean> {
  const [row] = await ctx.db
    .update(schema.merchOrders)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(schema.merchOrders.id, orderId), eq(schema.merchOrders.status, 'reserved'), sql`${schema.merchOrders.expiresAt} <= now()`))
    .returning();
  if (!row) return false;
  await audit(ctx.db, { actorUserId: null, action: 'merch.order_expire', entity: 'merch_order', entityId: orderId });
  await enqueue(ctx.boss, 'notify.text', {
    kind: 'merch.notice',
    userId: row.userId,
    text: `⌛ Бронь мерча <b>${esc(row.code)}</b> снята - её не оплатили вовремя. Вещи вернулись в витрину, можно забронировать заново.`,
  });
  return true;
}

// ---------- заказы в админке ----------

export async function adminOrders(db: DbLike, ids?: number[]): Promise<AdminMerchOrderView[]> {
  const rows = await db
    .select({ o: schema.merchOrders, u: schema.users, b: { lastName: schema.participants.lastName, firstName: schema.participants.firstName, phone: schema.participants.phone } })
    .from(schema.merchOrders)
    .innerJoin(schema.users, eq(schema.users.id, schema.merchOrders.userId))
    .leftJoin(schema.participants, eq(schema.participants.id, schema.merchOrders.buyerParticipantId))
    .where(ids ? inArray(schema.merchOrders.id, ids.length ? ids : [-1]) : sql`true`)
    .orderBy(desc(schema.merchOrders.createdAt))
    .limit(3000);
  const views = await orderViews(db, rows.map((r) => r.o));
  const receipts = await pendingReceipts(db, rows.map((r) => r.o.id));
  const staffIds = [...new Set(rows.flatMap((r) => [r.o.paidBy, r.o.issuedBy]).filter((x): x is number => x != null))];
  const staff = staffIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, staffIds)) : [];
  const nameOf = (id: number | null) => (id == null ? null : (staff.find((u) => u.id === id) ? userDisplayName(staff.find((u) => u.id === id)!) : null));
  return rows.map((r, i) => ({
    ...views[i]!,
    userId: r.u.id,
    userName: userDisplayName(r.u),
    username: r.u.username,
    note: r.o.note,
    receiptUrl: r.o.receiptFile ? `/api/admin/merch/orders/${r.o.id}/receipt` : null,
    paidByName: nameOf(r.o.paidBy),
    issuedByName: nameOf(r.o.issuedBy),
    buyerParticipantId: r.o.buyerParticipantId,
    buyerName: r.b?.lastName ? `${r.b.lastName} ${r.b.firstName}` : r.o.buyerName,
    buyerPhone: r.o.buyerPhone ?? r.b?.phone ?? null,
    confirm: confirmStateOf(r.o),
    receipt: receipts.get(r.o.id) ?? null,
  }));
}

/** Чеки за мерч на проверке (последний по заказу) - со сколькими файлами. */
async function pendingReceipts(db: DbLike, orderIds: number[]): Promise<Map<number, NonNullable<AdminMerchOrderView['receipt']>>> {
  if (!orderIds.length) return new Map();
  const rows = await db
    .select({
      id: schema.paymentReceipts.id,
      orderId: schema.paymentReceipts.merchOrderId,
      at: schema.paymentReceipts.createdAt,
      mime: schema.paymentReceipts.mimeType,
      comment: schema.paymentReceipts.comment,
      extra: sql<number>`(select count(*)::int from payment_receipt_files f where f.receipt_id = ${schema.paymentReceipts.id})`,
    })
    .from(schema.paymentReceipts)
    .where(and(inArray(schema.paymentReceipts.merchOrderId, orderIds), eq(schema.paymentReceipts.kind, 'merch'), eq(schema.paymentReceipts.status, 'pending')))
    .orderBy(desc(schema.paymentReceipts.createdAt));
  const out = new Map<number, NonNullable<AdminMerchOrderView['receipt']>>();
  for (const r of rows) {
    if (r.orderId && !out.has(r.orderId)) out.set(r.orderId, { id: r.id, at: r.at.toISOString(), files: 1 + r.extra, mime: r.mime, comment: r.comment });
  }
  return out;
}

/** Чек за мерч - для продавца (у него нет доступа к «Оплатам и чекам»): только вид «Мерч». */
export async function merchReceiptOrderId(db: DbLike, receiptId: number): Promise<number> {
  const [r] = await db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, receiptId));
  if (!r || r.kind !== 'merch' || !r.merchOrderId) throw notFound('Чек за мерч не найден');
  return r.merchOrderId;
}

/** Кому и что написать о новом чеке за мерч: продавцам (по настройке копий) - код, покупатель, состав, сумма. */
export async function merchReceiptNotice(db: DbLike, receiptId: number): Promise<{ recipients: number[]; text: string; buyerId: number } | null> {
  const [r] = await db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, receiptId));
  if (!r || r.kind !== 'merch' || !r.merchOrderId || r.status !== 'pending') return null;
  const [o] = await db.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, r.merchOrderId));
  if (!o || o.status !== 'reserved') return null;
  const items = (await orderItemLines(db, [o.id])).get(o.id) ?? [];
  const name = (await namesOf(db, [o.userId])).get(o.userId)?.name ?? 'Участник';
  const text =
    `🧾 <b>Чек за мерч</b> - код <b>${esc(o.code)}</b> · ${esc(name)}\n` +
    items.map((i) => `• ${esc(i)}`).join('\n') +
    `\nСумма: <b>${formatRub(o.total)}</b>${r.comment ? `\nКомментарий: ${esc(r.comment.slice(0, 300))}` : ''}\n\n` +
    'Проверьте чек и подтвердите оплату: «Мерч» → «Заказы» → «Чеки».';
  return { recipients: (await merchNotifyRecipients(db)).filter((u) => u !== o.userId), text, buyerId: o.userId };
}

/** Бронь сняли, потому что не ответили на «Точно заберёте?» (см. dropUnconfirmed). */
const DROPPED_REASON = 'Бронь снята: не подтвердили, что заберёте';

/** Как прошёл «Точно заберёте?» по брони - для админки. */
function confirmStateOf(o: typeof schema.merchOrders.$inferSelect): AdminMerchOrderView['confirm'] {
  if (!o.confirmAskedAt) return null;
  const base = { askedAt: o.confirmAskedAt.toISOString(), by: o.confirmBy?.toISOString() ?? null };
  if (o.confirmedAt && o.confirmedAt >= o.confirmAskedAt) return { ...base, state: 'yes' };
  if (o.status === 'cancelled' && o.cancelReason === DROPPED_REASON) return { ...base, state: 'dropped' };
  if (o.status === 'reserved') return { ...base, state: o.confirmBy && o.confirmBy.getTime() <= Date.now() ? 'missed' : 'waiting' };
  return null;
}

/**
 * Выдача по QR-коду участника: человек с семьёй и взносом (как на кассе, без отметки входа) и его заказы.
 * Заказы - с аккаунта, который записывал семью, и с аккаунта, которому передан этот QR-код,
 * плюс продажи на месте на любого из семьи.
 */
export async function scanForMerch(db: DbLike, code: string): Promise<MerchScanResponse> {
  const found = await findForPayment(db, { code });
  if (!found.found) return found;
  const familyIds = [found.card.id, ...found.family.map((f) => f.id)];
  const [me] = await db
    .select({ owner: schema.participants.ownerUserId, holder: schema.participants.holderUserId })
    .from(schema.participants)
    .where(eq(schema.participants.id, found.card.id));
  const accounts = [me!.owner, me!.holder].filter((x): x is number => x != null);
  const rows = await db
    .select({ id: schema.merchOrders.id })
    .from(schema.merchOrders)
    .where(
      and(
        or(inArray(schema.merchOrders.userId, accounts), inArray(schema.merchOrders.buyerParticipantId, familyIds)),
        notInArray(schema.merchOrders.status, ['cancelled', 'expired']),
      ),
    );
  const settings = await getSettings(db);
  return {
    found: true,
    codeStatus: found.codeStatus,
    card: found.card,
    family: found.family,
    paymentsEnabled: settings.paymentsEnabled,
    orders: rows.length ? await adminOrders(db, rows.map((r) => r.id)) : [],
  };
}

async function adminOrder(db: DbLike, id: number): Promise<AdminMerchOrderView> {
  const [o] = await adminOrders(db, [id]);
  if (!o) throw notFound('Заказ не найден');
  return o;
}

const METHOD_LABEL: Record<MerchPayMethod, string> = { cash: 'наличными', card: 'картой', transfer: 'переводом' };

/** Оплата принята (касса, перевод проверен). Истёкшую бронь не оживляем - вещь могли уже забрать. */
/** Бронь оплатили - её чек на проверке (из бота или приложения) принят тем же действием. */
async function acceptOrderReceipts(tx: Tx, o: OrderRow, actor: StaffPrincipal): Promise<void> {
  await tx
    .update(schema.paymentReceipts)
    .set({ status: 'accepted', reviewedBy: actor.user.id, reviewedAt: new Date(), amount: o.total })
    .where(and(eq(schema.paymentReceipts.merchOrderId, o.id), eq(schema.paymentReceipts.status, 'pending')));
}

export async function markOrderPaid(ctx: Ctx, id: number, method: MerchPayMethod, actor: StaffPrincipal): Promise<AdminMerchOrderView> {
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, id)).for('update');
    if (!o) throw notFound('Заказ не найден');
    if (o.status !== 'reserved') throw conflict('not_reserved', o.status === 'expired' ? 'Бронь уже истекла - оформите новую' : 'Заказ уже оплачен или снят');
    await tx
      .update(schema.merchOrders)
      .set({ status: 'paid', paymentMethod: method, paidAmount: o.total, paidAt: new Date(), paidBy: actor.user.id, expiresAt: null, updatedAt: new Date() })
      .where(eq(schema.merchOrders.id, id));
    await recordMerchMoney(tx, o, Number(o.total), method, actor);
    await acceptOrderReceipts(tx, o, actor);
    await audit(tx, { actorUserId: actor.user.id, action: 'merch.order_paid', entity: 'merch_order', entityId: id, before: { status: o.status }, after: { method } });
    await enqueue(
      ctx.boss,
      'notify.text',
      { kind: 'merch.notice', userId: o.userId, text: `✅ <b>Оплата за мерч принята</b> - ${METHOD_LABEL[method]}, ${formatRub(o.total)}.\nКод брони <b>${esc(o.code)}</b>.\n${PICKUP_PAID}.` },
      { tx },
    );
  });
  return adminOrder(ctx.db, id);
}

/** Выдали вещи. Неоплаченную бронь на месте - сразу «оплачено и выдано» (способ оплаты обязателен). */
export async function markOrderIssued(ctx: Ctx, id: number, method: MerchPayMethod | null, actor: StaffPrincipal): Promise<AdminMerchOrderView> {
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, id)).for('update');
    if (!o) throw notFound('Заказ не найден');
    if (o.status !== 'paid' && o.status !== 'reserved') throw conflict('not_payable', 'Заказ уже выдан или снят');
    if (o.status === 'reserved' && !method) throw badRequest('method_required', 'Укажите, как оплатили');
    const now = new Date();
    await tx
      .update(schema.merchOrders)
      .set({
        status: 'issued',
        issuedAt: now,
        issuedBy: actor.user.id,
        expiresAt: null,
        updatedAt: now,
        ...(o.status === 'reserved' ? { paymentMethod: method, paidAmount: o.total, paidAt: now, paidBy: actor.user.id } : {}),
      })
      .where(eq(schema.merchOrders.id, id));
    if (o.status === 'reserved') {
      await recordMerchMoney(tx, o, Number(o.total), method!, actor);
      await acceptOrderReceipts(tx, o, actor);
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'merch.order_issued', entity: 'merch_order', entityId: id, before: { status: o.status }, after: { method } });
    // Человеку - что выдали и как оплатили (оплатил на месте картой или наличными - тоже видно в боте).
    await enqueue(
      ctx.boss,
      'notify.text',
      {
        kind: 'merch.notice',
        userId: o.userId,
        text:
          `🛍 <b>Мерч выдан</b> - код <b>${esc(o.code)}</b>` +
          (o.status === 'reserved' ? `\nОплачено ${METHOD_LABEL[method!]}: ${formatRub(o.total)}.` : '') +
          '\nСпасибо!',
      },
      { tx },
    );
  });
  return adminOrder(ctx.db, id);
}

export async function cancelOrderByStaff(ctx: Ctx, id: number, reason: string | null, actor: StaffPrincipal): Promise<AdminMerchOrderView> {
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, id)).for('update');
    if (!o) throw notFound('Заказ не найден');
    if (o.status !== 'reserved' && o.status !== 'paid' && o.status !== 'owed') {
      throw conflict('not_cancellable', 'Выданный или уже снятый заказ отменить нельзя');
    }
    // Деньги за заказ - возврат: записи в журнале отменяются с причиной, в выручке их больше нет.
    const refunded = await tx
      .update(schema.payments)
      .set({ undoneAt: new Date(), undoneBy: actor.user.id, undoReason: `Возврат: ${reason || 'заказ отменён'}` })
      .where(and(eq(schema.payments.merchOrderId, id), sql`${schema.payments.undoneAt} is null`))
      .returning({ id: schema.payments.id, amount: schema.payments.amount });
    await tx
      .update(schema.merchOrders)
      .set({ status: 'cancelled', paidAmount: '0', cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() })
      .where(eq(schema.merchOrders.id, id));
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'merch.order_cancel',
      entity: 'merch_order',
      entityId: id,
      before: { status: o.status, paidAmount: o.paidAmount },
      after: { reason, refunded: refunded.map((r) => r.id) },
    });
    // Продажу на месте оформлял сам сотрудник - себе уведомление не шлём.
    if (o.userId !== actor.user.id) await enqueue(
      ctx.boss,
      'notify.text',
      {
        kind: 'merch.notice',
        userId: o.userId,
        text: `❗️ Заказ мерча <b>${esc(o.code)}</b> отменили организаторы.${reason ? `\nПричина: ${esc(reason)}` : ''}${Number(o.paidAmount) > 0 ? '\nПо возврату денег напишите организаторам.' : ''}`,
      },
      { tx },
    );
  });
  return adminOrder(ctx.db, id);
}

/** Деньги мерча - в общий журнал: кто принял, сколько, каким способом, за какой заказ. */
async function recordMerchMoney(tx: Tx, o: Pick<OrderRow, 'id' | 'code'>, amount: number, method: MerchPayMethod, actor: StaffPrincipal): Promise<void> {
  await recordPayment(tx, {
    participantId: null,
    kind: 'merch',
    source: 'merch',
    amount,
    method,
    acceptedBy: actor.user.id,
    merchOrderId: o.id,
    comment: `Заказ ${o.code}`,
  });
}

/** Погашение долга за мерч - полностью или частью. Набралась вся сумма - заказ «выдан, оплачено». */
export async function repayDebt(ctx: Ctx, id: number, amount: number, method: MerchPayMethod, actor: StaffPrincipal): Promise<AdminMerchOrderView> {
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, id)).for('update');
    if (!o) throw notFound('Заказ не найден');
    if (o.status !== 'owed') throw conflict('not_owed', 'По этому заказу долга нет');
    const left = Number(o.total) - Number(o.paidAmount);
    if (amount > left + 0.005) throw badRequest('too_much', `Долг - ${formatRub(left.toFixed(2))}, больше принять нельзя`);
    const paid = Number(o.paidAmount) + amount;
    const done = paid >= Number(o.total) - 0.005;
    const now = new Date();
    await tx
      .update(schema.merchOrders)
      .set({
        paidAmount: paid.toFixed(2),
        paymentMethod: method,
        updatedAt: now,
        ...(done ? { status: 'issued', paidAt: now, paidBy: actor.user.id } : {}),
      })
      .where(eq(schema.merchOrders.id, id));
    await recordMerchMoney(tx, o, amount, method, actor);
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'merch.debt_repay',
      entity: 'merch_order',
      entityId: id,
      before: { status: o.status, paidAmount: o.paidAmount },
      after: { amount: amount.toFixed(2), method, paidAmount: paid.toFixed(2), done },
    });
    const debtor = await buyerAccount(tx, o.buyerParticipantId);
    if (debtor) {
      await enqueue(
        ctx.boss,
        'notify.text',
        {
          kind: 'merch.notice',
          userId: debtor,
          text: done
            ? `✅ Долг за мерч <b>${esc(o.code)}</b> оплачен полностью. Спасибо!`
            : `💳 По долгу за мерч <b>${esc(o.code)}</b> внесено ${formatRub(amount.toFixed(2))}\nОсталось оплатить: <b>${formatRub((Number(o.total) - paid).toFixed(2))}</b>`,
        },
        { tx },
      );
    }
  });
  return adminOrder(ctx.db, id);
}

/** Статистика мерча: проданное по вещам и размерам, деньги по способам и продавцам, долги, что заканчивается. */
export async function merchStats(db: DbLike): Promise<MerchStats> {
  const sold = ['paid', 'issued', 'owed'];
  const [items, orders, money, sellers, debt, products] = await Promise.all([
    db
      .select({
        variantId: schema.merchOrderItems.variantId,
        productId: schema.merchColors.productId,
        title: schema.merchOrderItems.title,
        qty: sql<number>`sum(${schema.merchOrderItems.qty})::int`,
        amount: sql<string>`sum(${schema.merchOrderItems.qty} * ${schema.merchOrderItems.price})::text`,
      })
      .from(schema.merchOrderItems)
      .innerJoin(schema.merchOrders, eq(schema.merchOrders.id, schema.merchOrderItems.orderId))
      .innerJoin(schema.merchVariants, eq(schema.merchVariants.id, schema.merchOrderItems.variantId))
      .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
      .where(inArray(schema.merchOrders.status, sold))
      .groupBy(schema.merchOrderItems.variantId, schema.merchColors.productId, schema.merchOrderItems.title),
    db
      .select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${schema.merchOrders.total}), 0)::text` })
      .from(schema.merchOrders)
      .where(inArray(schema.merchOrders.status, sold)),
    db.execute<{ method: 'cash' | 'card' | 'transfer'; amount: string; count: number }>(sql`
      select method, sum(amount)::text as amount, count(*)::int as count
        from payments where kind = 'merch' and undone_at is null group by method order by sum(amount) desc`),
    db.execute<{ user_id: string | null; amount: string; count: number }>(sql`
      select accepted_by as user_id, sum(amount)::text as amount, count(*)::int as count
        from payments where kind = 'merch' and undone_at is null
       group by accepted_by order by sum(amount) desc`),
    db
      .select({ n: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${schema.merchOrders.total} - ${schema.merchOrders.paidAmount}), 0)::text` })
      .from(schema.merchOrders)
      .where(eq(schema.merchOrders.status, 'owed')),
    adminProducts(db),
  ]);
  const sellerIds = sellers.rows.flatMap((r) => (r.user_id == null ? [] : [Number(r.user_id)]));
  const sellerUsers = sellerIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, sellerIds)) : [];
  const byProduct = new Map<number, { productId: number; title: string; qty: number; amount: number }>();
  for (const it of items) {
    const p = products.find((x) => x.id === it.productId);
    const cur = byProduct.get(it.productId) ?? { productId: it.productId, title: p?.title ?? it.title, qty: 0, amount: 0 };
    cur.qty += it.qty;
    cur.amount += Number(it.amount);
    byProduct.set(it.productId, cur);
  }
  const lowStock = products.flatMap((p) =>
    p.colors.flatMap((c) =>
      c.sizes
        .filter((s) => s.stock > 0 && s.left <= 3)
        .map((s) => ({ variantId: s.id, title: orderLabel(p, c, s.size, p.colors.length), left: s.left, stock: s.stock })),
    ),
  );
  return {
    soldQty: items.reduce((n, it) => n + it.qty, 0),
    orders: orders[0]?.n ?? 0,
    revenue: money.rows.reduce((n, r) => n + Number(r.amount), 0).toFixed(2),
    salesTotal: Number(orders[0]?.total ?? 0).toFixed(2),
    debt: { count: debt[0]?.n ?? 0, amount: Number(debt[0]?.amount ?? 0).toFixed(2) },
    byItem: items
      .map((it) => ({ productId: it.productId, title: it.title, qty: it.qty, amount: Number(it.amount).toFixed(2) }))
      .sort((a, b) => b.qty - a.qty),
    byProduct: [...byProduct.values()].sort((a, b) => b.qty - a.qty).map((p) => ({ ...p, amount: p.amount.toFixed(2) })),
    byMethod: money.rows.map((r) => ({ method: r.method, amount: Number(r.amount).toFixed(2), count: r.count })),
    bySeller: sellers.rows.map((r) => {
      const u = sellerUsers.find((x) => x.id === Number(r.user_id));
      return { userId: r.user_id == null ? null : Number(r.user_id), name: u ? userDisplayName(u) : 'Без имени', amount: Number(r.amount).toFixed(2), count: r.count };
    }),
    lowStock: lowStock.sort((a, b) => a.left - b.left),
  };
}

/** Покупатель в долг - участник из базы: поиск по фамилии, имени или телефону (продавцу без доступа к базе). */
export async function searchBuyers(db: DbLike, q: string): Promise<{ id: number; name: string; phone: string | null; city: string | null }[]> {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3);
  if (words.length === 0) return [];
  const digits = q.replace(/\D/g, '');
  const rows = await db.execute<{ id: string; last_name: string; first_name: string; phone: string | null; city: string | null }>(sql`
    select id, last_name, first_name, phone, city from participants
     where status = 'active'
       and (${sql.join(
         words.map((w) => sql`(lower(last_name) like ${`${w}%`} or lower(first_name) like ${`${w}%`})`),
         sql` and `,
       )} ${digits.length >= 4 ? sql`or regexp_replace(coalesce(phone, ''), '\D', '', 'g') like ${`%${digits}%`}` : sql``})
     order by last_name, first_name limit 12`);
  return rows.rows.map((r) => ({ id: Number(r.id), name: `${r.last_name} ${r.first_name}`, phone: r.phone, city: r.city }));
}

export async function orderReceipt(db: DbLike, id: number): Promise<{ file: string; mime: string }> {
  const [o] = await db.select({ file: schema.merchOrders.receiptFile, mime: schema.merchOrders.receiptMime }).from(schema.merchOrders).where(eq(schema.merchOrders.id, id));
  if (!o?.file) throw notFound('Чека нет');
  return { file: o.file, mime: o.mime ?? 'application/octet-stream' };
}
