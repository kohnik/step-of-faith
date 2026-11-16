import { formatRub, fullName, hasPermission, type MarkPaidRequest, type MarkPaidResponse, type PaymentMethod, type PaymentStatus, type ReceiptView, type UnsentDraftView } from '@sof/shared';
import { and, arrayOverlaps, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike, type Tx } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { firstTime } from '../lib/once.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import { telegramDownload } from '../lib/telegram-net.ts';
import { readStored, savePrivate } from './media.service.ts';
import { reconcilePayments, recordPayment } from './ledger.service.ts';
import { markOrderPaid } from './merch.service.ts';
import { getSettings } from './settings.service.ts';
import { asTier } from './tiers.ts';
import { esc } from '../bot/format.ts';
import type { UserRow } from './users.service.ts';

/**
 * Оплата - у каждого человека своя. Кто бы ни платил (сам, записавший, друг, наличными в 504-м,
 * переводом без Telegram), отмечается конкретный участник: unpaid → pending (чек на проверке) → paid / partial.
 */

/** Кого можно выбрать в новый чек: не оплачено или оплачено частично (не «на проверке»). */
const OPEN = ['unpaid', 'partial'];
/** Сколько минут кассир может отменить свой приём. */
export const UNDO_MINUTES = 15;

export interface ReceiptFile {
  fileId: string;
  fileUniqueId: string;
  kind: 'photo' | 'document';
  mimeType?: string | null;
}

export interface ReceiptPerson {
  id: number;
  fullName: string;
  /** Сколько осталось внести. */
  due: number;
  included: boolean;
}

export type CreateReceiptResult =
  /** Один человек - чек сразу ушёл на проверку. */
  | { status: 'sent'; receiptId: number; people: ReceiptPerson[] }
  /** Несколько - черновик: человек отмечает, за кого чек, и жмёт «Отправить». */
  | { status: 'draft'; receiptId: number; people: ReceiptPerson[] }
  /** Фото подряд: добавили к недавнему чеку (черновику или только что отправленному). */
  | { status: 'added'; receiptId: number; files: number; draft: boolean; people: ReceiptPerson[] }
  | { status: 'duplicate' }
  | { status: 'nothing_to_pay' };

/**
 * Недавний чек человека (неотправленный черновик или только что отправленный): следующее фото без кнопки -
 * к нему или такого же вида, а не вопрос «это чек?».
 */
export async function recentReceipt(db: DbLike, userId: number): Promise<{ kind: string; merchOrderId: number | null } | null> {
  const res = await db.execute<{ kind: string; merch_order_id: string | null }>(sql`
    select kind, merch_order_id from payment_receipts
     where user_id = ${userId}
       and ((status = 'draft' and created_at > now() - interval '30 minutes') or (status = 'pending' and created_at > now() - interval '15 minutes'))
     order by created_at desc limit 1`);
  const r = res.rows[0];
  return r ? { kind: r.kind, merchOrderId: r.merch_order_id === null ? null : Number(r.merch_order_id) } : null;
}

/** Сколько ждём следующее фото того же платежа: черновик - пока его не отправили (до 30 минут), отправленный - 15 минут. */
const DRAFT_ATTACH_MS = 30 * 60_000;
const PENDING_ATTACH_MS = 15 * 60_000;

/** Этот файл уже присылали (первым файлом чека или следом) - второй раз не берём. */
async function knownFile(tx: Tx, userId: number, fileUniqueId: string): Promise<'main' | 'extra' | null> {
  const [main] = await tx
    .select({ id: schema.paymentReceipts.id })
    .from(schema.paymentReceipts)
    .where(and(eq(schema.paymentReceipts.userId, userId), eq(schema.paymentReceipts.fileUniqueId, fileUniqueId)))
    .limit(1);
  if (main) return 'main';
  const res = await tx.execute(sql`
    select 1 from payment_receipt_files f join payment_receipts r on r.id = f.receipt_id
     where r.user_id = ${userId} and f.file_unique_id = ${fileUniqueId} limit 1`);
  return res.rows.length ? 'extra' : null;
}

/**
 * Фото подряд - один чек: альбом или «вот ещё перевод». Неотправленный черновик или чек на проверке,
 * отправленный только что и ещё не проверенный, - файл добавляется к нему. null - подходящего чека нет.
 */
async function attachToRecent(
  tx: Tx,
  user: UserRow,
  file: ReceiptFile,
  match: { kind: 'fee' } | ReceiptPurpose,
  /** Взнос: к отправленному чеку - только если платить больше не за кого (иначе это чек за других - новый черновик). */
  othersOpen = false,
): Promise<{ receipt: typeof schema.paymentReceipts.$inferSelect; files: number } | null> {
  const [r] = await tx
    .select()
    .from(schema.paymentReceipts)
    .where(
      and(
        eq(schema.paymentReceipts.userId, user.id),
        eq(schema.paymentReceipts.kind, match.kind),
        match.kind === 'merch' ? eq(schema.paymentReceipts.merchOrderId, match.orderId) : undefined,
        inArray(schema.paymentReceipts.status, ['draft', 'pending']),
      ),
    )
    .orderBy(desc(schema.paymentReceipts.createdAt))
    .limit(1)
    .for('update');
  if (!r) return null;
  const age = Date.now() - r.createdAt.getTime();
  if (age > (r.status === 'draft' ? DRAFT_ATTACH_MS : PENDING_ATTACH_MS)) return null;
  if (r.status === 'pending' && othersOpen) return null;
  await tx
    .insert(schema.paymentReceiptFiles)
    .values({ receiptId: r.id, fileId: file.fileId, fileUniqueId: file.fileUniqueId, fileKind: file.kind, mimeType: file.mimeType ?? null })
    .onConflictDoNothing();
  const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.paymentReceiptFiles).where(eq(schema.paymentReceiptFiles.receiptId, r.id));
  return { receipt: r, files: (n?.n ?? 0) + 1 };
}

type ParticipantRow = typeof schema.participants.$inferSelect;

const dueOf = (p: ParticipantRow) => Math.max(0, Number(p.amountDue ?? 0) - Number(p.amountPaid ?? 0));

/** Свои и переданные мне (узнанные по нику) участники, за которых ещё можно заплатить. */
async function openPeople(db: DbLike, userId: number): Promise<ParticipantRow[]> {
  return db
    .select()
    .from(schema.participants)
    .where(
      and(
        or(eq(schema.participants.ownerUserId, userId), eq(schema.participants.holderUserId, userId)),
        eq(schema.participants.status, 'active'),
        inArray(schema.participants.paymentStatus, OPEN),
      ),
    )
    .orderBy(schema.participants.id);
}

function toPeople(rows: ParticipantRow[], included: Iterable<number>): ReceiptPerson[] {
  const set = new Set(included);
  return rows.map((p) => ({ id: p.id, fullName: fullName(p), due: dueOf(p), included: set.has(p.id) }));
}

/** Черновик чека для напоминания: null, если его уже отправили, отменили или некого оплачивать. */
export async function draftForReminder(db: DbLike, receiptId: number): Promise<{ userId: number; people: ReceiptPerson[] } | null> {
  const receipt = await db.query.paymentReceipts.findFirst({ where: eq(schema.paymentReceipts.id, receiptId) });
  if (!receipt || receipt.status !== 'draft') return null;
  const people = await openPeople(db, receipt.userId);
  if (people.length === 0) return null;
  return { userId: receipt.userId, people: toPeople(people, receipt.participantIds) };
}

/** Есть ли у аккаунта кого оплачивать (для вопроса «это чек?» на случайное фото). */
export async function hasOpenPayments(db: DbLike, userId: number): Promise<boolean> {
  return (await openPeople(db, userId)).length > 0;
}

/** Статус «на проверке» → обратно: частично, если что-то уже внесено, иначе «не оплачено». */
const revertPending = sql`case when ${schema.participants.amountPaid} > 0 then 'partial' else 'unpaid' end`;

async function markPending(tx: Tx, ids: number[]) {
  if (ids.length === 0) return;
  await tx
    .update(schema.participants)
    // Прислал чек - значит, платит переводом, даже если при регистрации выбрал «наличными» (выгрузка для бухгалтерии).
    .set({ paymentStatus: 'pending', paymentMethod: 'transfer', updatedAt: new Date() })
    .where(and(inArray(schema.participants.id, ids), inArray(schema.participants.paymentStatus, OPEN)));
}

async function revertFromPending(tx: Tx, ids: number[]) {
  if (ids.length === 0) return;
  await tx
    .update(schema.participants)
    .set({ paymentStatus: revertPending as never, updatedAt: new Date() })
    .where(and(inArray(schema.participants.id, ids), eq(schema.participants.paymentStatus, 'pending')));
}

/**
 * Чек из бота. Один человек к оплате - сразу на проверку. Несколько - черновик: заранее отмечены те,
 * кто выбрал «перевод» (если таких нет - никто), человек сам отмечает, за кого чек.
 */
export async function createReceipt(
  ctx: Pick<AppContext, 'db' | 'boss'>,
  user: UserRow,
  file: ReceiptFile,
  comment?: string | null,
): Promise<CreateReceiptResult> {
  return ctx.db.transaction(async (tx) => {
    const known = await knownFile(tx, user.id, file.fileUniqueId);
    if (known === 'extra') return { status: 'duplicate' as const };
    if (!known) {
      const othersOpen = (await openPeople(tx, user.id)).length > 0;
      const attached = await attachToRecent(tx, user, file, { kind: 'fee' }, othersOpen);
      if (attached) {
        await enqueue(ctx.boss, 'receipt.archive', { receiptId: attached.receipt.id }, { tx });
        await audit(tx, { actorUserId: user.id, action: 'receipt.add_file', entity: 'receipt', entityId: attached.receipt.id, after: { files: attached.files } });
        const draft = attached.receipt.status === 'draft';
        return {
          status: 'added' as const,
          receiptId: attached.receipt.id,
          files: attached.files,
          draft,
          people: draft ? toPeople(await openPeople(tx, user.id), attached.receipt.participantIds) : [],
        };
      }
    }
    const people = await openPeople(tx, user.id);
    if (people.length === 0) return { status: 'nothing_to_pay' as const };
    const single = people.length === 1;
    const preselected = single ? people : people.filter((p) => p.paymentMethod === 'transfer');
    const [row] = await tx
      .insert(schema.paymentReceipts)
      .values({
        userId: user.id,
        participantIds: preselected.map((p) => p.id),
        fileId: file.fileId,
        fileUniqueId: file.fileUniqueId,
        fileKind: file.kind,
        mimeType: file.mimeType ?? null,
        comment: comment?.slice(0, 1000) ?? null,
        status: single ? 'pending' : 'draft',
      })
      .onConflictDoNothing()
      .returning({ id: schema.paymentReceipts.id });
    let receiptId = row?.id;
    // Новый файл - сразу копию к нам: Telegram может его потерять.
    if (receiptId) await enqueue(ctx.boss, 'receipt.archive', { receiptId }, { tx });
    if (!receiptId) {
      // Тот же файл ещё раз: если это незаконченный черновик - продолжаем его.
      const existing = await tx.query.paymentReceipts.findFirst({
        where: and(eq(schema.paymentReceipts.userId, user.id), eq(schema.paymentReceipts.fileUniqueId, file.fileUniqueId)),
      });
      if (existing?.status === 'draft') {
        return { status: 'draft' as const, receiptId: existing.id, people: toPeople(people, existing.participantIds) };
      }
      if (existing?.status !== 'rejected') return { status: 'duplicate' as const };
      // Отклонённый чек прислали снова (просили «пришлите заново») - проверяем его ещё раз.
      await tx
        .update(schema.paymentReceipts)
        .set({
          participantIds: preselected.map((p) => p.id),
          comment: comment?.slice(0, 1000) ?? null,
          status: single ? 'pending' : 'draft',
          createdAt: new Date(),
          reviewedBy: null,
          reviewedAt: null,
          rejectReason: null,
        })
        .where(eq(schema.paymentReceipts.id, existing.id));
      receiptId = existing.id;
    }
    if (single) {
      await markPending(tx, [people[0]!.id]);
      await audit(tx, { actorUserId: user.id, action: 'receipt.create', entity: 'receipt', entityId: receiptId });
      return { status: 'sent' as const, receiptId, people: toPeople(people, [people[0]!.id]) };
    }
    return { status: 'draft' as const, receiptId, people: toPeople(people, preselected.map((p) => p.id)) };
  });
}

/** Зачем чек, кроме взноса: пожертвование или оплата брони мерча. */
export type ReceiptPurpose = { kind: 'donation' } | { kind: 'merch'; orderId: number };

/**
 * Чек пожертвования или за мерч (кнопки в боте и в приложении): сразу на проверку, людей в нём нет.
 * Из бота - файл Telegram (копию к нам снимем фоном), из приложения - сразу наш файл.
 */
export async function createPurposeReceipt(
  ctx: Pick<AppContext, 'db' | 'boss'>,
  user: UserRow,
  purpose: ReceiptPurpose,
  file: { telegram?: ReceiptFile; stored?: { file: string; mime: string } },
  comment?: string | null,
): Promise<
  | { status: 'sent'; receiptId: number; orderCode: string | null }
  | { status: 'added'; receiptId: number; files: number; orderCode: string | null }
  | { status: 'duplicate' }
  | { status: 'not_reserved' }
> {
  return ctx.db.transaction(async (tx) => {
    let orderCode: string | null = null;
    const tgFile = file.telegram;
    if (tgFile) {
      if (await knownFile(tx, user.id, tgFile.fileUniqueId)) return { status: 'duplicate' as const };
      const attached = await attachToRecent(tx, user, tgFile, purpose);
      if (attached) {
        await enqueue(ctx.boss, 'receipt.archive', { receiptId: attached.receipt.id }, { tx });
        await audit(tx, { actorUserId: user.id, action: 'receipt.add_file', entity: 'receipt', entityId: attached.receipt.id, after: { files: attached.files } });
        const code = attached.receipt.merchOrderId
          ? ((await tx.select({ code: schema.merchOrders.code }).from(schema.merchOrders).where(eq(schema.merchOrders.id, attached.receipt.merchOrderId)))[0]?.code ?? null)
          : null;
        return { status: 'added' as const, receiptId: attached.receipt.id, files: attached.files, orderCode: code };
      }
    }
    if (purpose.kind === 'merch') {
      const [o] = await tx.select().from(schema.merchOrders).where(eq(schema.merchOrders.id, purpose.orderId)).for('update');
      if (!o || o.userId !== user.id || o.status !== 'reserved') return { status: 'not_reserved' as const };
      orderCode = o.code;
    }
    const tg = file.telegram;
    const mime = tg?.mimeType ?? file.stored?.mime ?? null;
    const [row] = await tx
      .insert(schema.paymentReceipts)
      .values({
        userId: user.id,
        participantIds: [],
        kind: purpose.kind,
        merchOrderId: purpose.kind === 'merch' ? purpose.orderId : null,
        fileId: tg?.fileId ?? null,
        fileUniqueId: tg?.fileUniqueId ?? null,
        fileKind: tg?.kind ?? (mime?.startsWith('image/') ? 'photo' : 'document'),
        mimeType: mime,
        storedFile: file.stored?.file ?? null,
        comment: comment?.slice(0, 1000) ?? null,
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: schema.paymentReceipts.id });
    if (!row) return { status: 'duplicate' as const };
    if (purpose.kind === 'merch') {
      await tx
        .update(schema.merchOrders)
        .set({ paymentMethod: 'transfer', receiptAt: new Date(), updatedAt: new Date(), ...(file.stored ? { receiptFile: file.stored.file, receiptMime: file.stored.mime } : {}) })
        .where(eq(schema.merchOrders.id, purpose.orderId));
    }
    if (tg) await enqueue(ctx.boss, 'receipt.archive', { receiptId: row.id }, { tx });
    if (purpose.kind === 'merch') await enqueue(ctx.boss, 'merch.receipt_notify', { receiptId: row.id }, { tx });
    await audit(tx, { actorUserId: user.id, action: 'receipt.create', entity: 'receipt', entityId: row.id, after: purpose });
    return { status: 'sent' as const, receiptId: row.id, orderCode };
  });
}

/** Прислали чек, но больше 15 минут не нажимают «Отправить»: в админке не видно - команда пишет человеку. */
export async function unsentDrafts(db: DbLike): Promise<UnsentDraftView[]> {
  const rows = await db
    .select({ receipt: schema.paymentReceipts, user: schema.users })
    .from(schema.paymentReceipts)
    .innerJoin(schema.users, eq(schema.users.id, schema.paymentReceipts.userId))
    .where(and(eq(schema.paymentReceipts.status, 'draft'), sql`${schema.paymentReceipts.createdAt} < now() - interval '15 minutes'`))
    .orderBy(desc(schema.paymentReceipts.createdAt))
    .limit(100);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.receipt.id);
  const pids = [...new Set(rows.flatMap((r) => r.receipt.participantIds))];
  const [people, extra] = await Promise.all([
    pids.length ? db.select().from(schema.participants).where(inArray(schema.participants.id, pids)) : [],
    db
      .select({ receiptId: schema.paymentReceiptFiles.receiptId, n: sql<number>`count(*)::int` })
      .from(schema.paymentReceiptFiles)
      .where(inArray(schema.paymentReceiptFiles.receiptId, ids))
      .groupBy(schema.paymentReceiptFiles.receiptId),
  ]);
  return rows.map(({ receipt: r, user }) => ({
    id: r.id,
    userId: user.id,
    userName: userDisplayName(user),
    people: r.participantIds.map((id) => people.find((p) => p.id === id)).filter((p): p is ParticipantRow => !!p).map((p) => fullName(p)),
    files: 1 + (extra.find((e) => e.receiptId === r.id)?.n ?? 0),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Неоплаченные брони мерча человека - за них можно прислать чек. */
export async function reservedOrders(db: DbLike, userId: number): Promise<{ id: number; code: string; total: string }[]> {
  return db
    .select({ id: schema.merchOrders.id, code: schema.merchOrders.code, total: schema.merchOrders.total })
    .from(schema.merchOrders)
    .where(and(eq(schema.merchOrders.userId, userId), eq(schema.merchOrders.status, 'reserved')))
    .orderBy(schema.merchOrders.id);
}

async function ownDraft(tx: Tx, user: UserRow, receiptId: number) {
  const [receipt] = await tx.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, receiptId)).for('update');
  if (!receipt || receipt.userId !== user.id) return { kind: 'not_found' as const };
  if (receipt.status !== 'draft') return { kind: 'locked' as const, receipt };
  return { kind: 'ok' as const, receipt };
}

/** Галочка «✅/⬜ Имя» в черновике чека. */
export async function toggleReceiptPerson(
  ctx: Pick<AppContext, 'db'>,
  user: UserRow,
  receiptId: number,
  participantId: number,
): Promise<{ status: 'ok'; people: ReceiptPerson[] } | { status: 'locked' | 'not_found' }> {
  return ctx.db.transaction(async (tx) => {
    const d = await ownDraft(tx, user, receiptId);
    if (d.kind !== 'ok') return { status: d.kind };
    const people = await openPeople(tx, user.id);
    if (!people.some((p) => p.id === participantId)) return { status: 'not_found' as const };
    const current = d.receipt.participantIds.filter((id) => people.some((p) => p.id === id));
    const next = current.includes(participantId) ? current.filter((id) => id !== participantId) : [...current, participantId];
    await tx.update(schema.paymentReceipts).set({ participantIds: next }).where(eq(schema.paymentReceipts.id, receiptId));
    return { status: 'ok' as const, people: toPeople(people, next) };
  });
}

/** «Отправить на проверку»: отмеченные люди становятся «чек на проверке». */
export async function confirmReceipt(
  ctx: Pick<AppContext, 'db'>,
  user: UserRow,
  receiptId: number,
): Promise<{ status: 'sent'; people: ReceiptPerson[] } | { status: 'empty' | 'locked' | 'not_found' }> {
  return ctx.db.transaction(async (tx) => {
    const d = await ownDraft(tx, user, receiptId);
    if (d.kind !== 'ok') return { status: d.kind };
    const people = await openPeople(tx, user.id);
    const ids = d.receipt.participantIds.filter((id) => people.some((p) => p.id === id));
    if (ids.length === 0) return { status: 'empty' as const };
    await tx
      .update(schema.paymentReceipts)
      .set({ status: 'pending', participantIds: ids, createdAt: new Date() })
      .where(eq(schema.paymentReceipts.id, receiptId));
    await markPending(tx, ids);
    await audit(tx, { actorUserId: user.id, action: 'receipt.create', entity: 'receipt', entityId: receiptId, after: { participantIds: ids } });
    return { status: 'sent' as const, people: toPeople(people, ids).filter((p) => p.included) };
  });
}

/** «Отмена» черновика - файл можно будет прислать заново. */
export async function cancelDraftReceipt(ctx: Pick<AppContext, 'db'>, user: UserRow, receiptId: number): Promise<boolean> {
  const rows = await ctx.db
    .delete(schema.paymentReceipts)
    .where(and(eq(schema.paymentReceipts.id, receiptId), eq(schema.paymentReceipts.userId, user.id), eq(schema.paymentReceipts.status, 'draft')))
    .returning({ id: schema.paymentReceipts.id });
  return rows.length > 0;
}

// ---------- зачисление оплаты ----------

type Settled = { id: number; fullName: string; paymentStatus: 'paid' | 'partial'; amountPaid: string; amountDue: string | null; added: string };

/**
 * Зачислить оплату людям. `amount` - сколько внесли (только когда человек один); иначе каждому - его остаток.
 * Хватает на «к оплате» → «оплачено», меньше → «частично». Уже оплаченных и «без взноса» не трогаем.
 */
async function settle(
  tx: Tx,
  ids: number[],
  amount: string | null | undefined,
  note: string,
  actorUserId: number,
  action: string,
  entry: { method: PaymentMethod; source: 'desk' | 'receipt'; receiptId?: number },
  { rejectOverpay = false, includeCancelled = false } = {},
): Promise<Settled[]> {
  const rows = await tx
    .select()
    .from(schema.participants)
    .where(includeCancelled ? inArray(schema.participants.id, ids) : and(inArray(schema.participants.id, ids), eq(schema.participants.status, 'active')))
    .for('update');
  const out: Settled[] = [];
  for (const p of rows) {
    if (p.paymentStatus === 'paid' || p.paymentStatus === 'exempt') continue;
    const add = amount != null && ids.length === 1 ? Number(amount) : dueOf(p);
    // Касса и админка: сумма больше остатка - скорее всего устаревшая подсказка или опечатка.
    if (rejectOverpay && add > dueOf(p) + 0.005) {
      throw badRequest('overpay', `Сумма больше, чем осталось внести: ${formatRub(dueOf(p).toFixed(2))}`);
    }
    const paid = Number(p.amountPaid ?? 0) + add;
    const status = paid + 1e-9 >= Number(p.amountDue ?? 0) ? 'paid' : 'partial';
    const before = { paymentStatus: p.paymentStatus, amountPaid: p.amountPaid, paidAt: p.paidAt, paymentNote: p.paymentNote };
    const [row] = await tx
      .update(schema.participants)
      .set({
        paymentStatus: status,
        amountPaid: paid.toFixed(2),
        paidAt: status === 'paid' ? (p.paidAt ?? new Date()) : p.paidAt,
        paymentNote: [p.paymentNote, note].filter(Boolean).join('; '),
        // Способ - как заплатили на самом деле (карта на кассе - как было выбрано при регистрации).
        paymentMethod: entry.method === 'card' ? p.paymentMethod : entry.method,
        updatedAt: new Date(),
      })
      .where(eq(schema.participants.id, p.id))
      .returning();
    await audit(tx, { actorUserId, action, entity: 'participant', entityId: p.id, before, after: { paymentStatus: status, amountPaid: paid.toFixed(2), method: entry.method } });
    await recordPayment(tx, { participantId: p.id, amount: add, method: entry.method, source: entry.source, acceptedBy: actorUserId, receiptId: entry.receiptId });
    out.push({ id: p.id, fullName: fullName(p), paymentStatus: status, amountPaid: row!.amountPaid, amountDue: p.amountDue, added: add.toFixed(2) });
  }
  return out;
}

const METHOD_LABEL = { cash: 'наличные', card: 'карта', transfer: 'перевод' } as const;

/** Касса (Mini App, сканер) и админка: принять оплату за конкретных людей. */
/**
 * Касса на входе: не оплатил и заплатит переводом потом. Статус остаётся «не оплачено», способ - «перевод»,
 * в бот - реквизиты и просьба прислать чек (одно сообщение на аккаунт). Вход отмечает сканер отдельно.
 */
export async function promiseTransfer(ctx: Pick<AppContext, 'db' | 'boss'>, staff: StaffPrincipal, participantIds: number[]): Promise<{ notified: number }> {
  const settings = await getSettings(ctx.db);
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.participants)
      .set({ paymentMethod: 'transfer', updatedAt: new Date() })
      .where(and(inArray(schema.participants.id, participantIds), eq(schema.participants.status, 'active'), inArray(schema.participants.paymentStatus, OPEN)))
      .returning();
    const byUser = new Map<number, ParticipantRow[]>();
    for (const p of rows) {
      const uid = p.holderUserId ?? p.ownerUserId;
      byUser.set(uid, [...(byUser.get(uid) ?? []), p]);
    }
    for (const [userId, people] of byUser) {
      const lines = people.map((p) => `👤 ${esc(fullName(p))} - ${formatRub(dueOf(p).toFixed(2))}`).join('\n');
      await enqueue(
        ctx.boss,
        'notify.text',
        {
          kind: 'payment.notice',
          userId,
          text:
            `💳 <b>Взнос - переводом</b>\n${lines}\n\n${esc(settings.paymentInstructions)}\n` +
            `В комментарии к переводу укажите фамилию и имя.\n\n❗️ <b>После перевода пришлите сюда фото, скриншот или PDF чека.</b>`,
        },
        { tx },
      );
    }
    await audit(tx, { actorUserId: staff.user.id, action: 'payment.promise_transfer', entity: 'participant', entityId: participantIds[0]!, after: { participantIds: rows.map((p) => p.id) } });
    return { notified: byUser.size };
  });
}

export async function markPaid(
  ctx: Pick<AppContext, 'db' | 'boss'>,
  staff: StaffPrincipal,
  req: MarkPaidRequest,
): Promise<MarkPaidResponse> {
  const note = [
    `${METHOD_LABEL[req.method]}${req.amount && req.participantIds.length === 1 ? ` ${formatRub(req.amount)}` : ''}`,
    req.note,
    `принял(а) ${staff.name}`,
  ]
    .filter(Boolean)
    .join(', ');
  return ctx.db.transaction(async (tx) => {
    // Повтор того же приёма (касса не дождалась ответа и нажала снова) - второй раз не зачисляем.
    if (req.requestId && !(await firstTime(tx, `pay:${req.requestId}`))) {
      const rows = await tx.select().from(schema.participants).where(inArray(schema.participants.id, req.participantIds));
      return {
        updated: 0,
        duplicate: true,
        people: rows.map((p) => ({
          id: p.id,
          fullName: fullName(p),
          paymentStatus: p.paymentStatus as PaymentStatus,
          amountPaid: p.amountPaid,
          amountDue: p.amountDue,
        })),
      };
    }
    const settled = await settle(tx, req.participantIds, req.amount, note, staff.user.id, 'payment.mark_paid', { method: req.method, source: 'desk' }, {
      rejectOverpay: true,
    });
    // Взнос уже оплачен (экран устарел), а кассир принимает «без сдачи» - деньги не должны пропасть молча.
    if (settled.length === 0 && req.donation) {
      throw conflict('already_paid', 'Взнос уже оплачен - пожертвование добавьте кнопкой «Добавить пожертвование»');
    }
    // «Без сдачи»: остаток - пожертвованием от первого в списке (того, чей QR-код отсканировали), тем же способом.
    if (settled.length > 0 && req.donation) {
      await recordPayment(tx, {
        kind: 'donation',
        participantId: req.participantIds[0]!,
        amount: Number(req.donation),
        method: req.method,
        source: 'desk',
        acceptedBy: staff.user.id,
      });
    }
    if (settled.length > 0) {
      await enqueue(
        ctx.boss,
        'payment.confirmed',
        {
          participantIds: settled.map((s) => s.id),
          method: req.method,
          amounts: Object.fromEntries(settled.map((s) => [s.id, s.added])),
          ...(req.donation ? { donation: Number(req.donation).toFixed(2) } : {}),
        },
        { tx },
      );
    }
    return {
      updated: settled.length,
      people: settled.map((s) => ({ id: s.id, fullName: s.fullName, paymentStatus: s.paymentStatus, amountPaid: s.amountPaid, amountDue: s.amountDue })),
    };
  });
}

/**
 * Отменить приём (ошиблись человеком): свой - в течение 15 минут, админ (participants:write) - всегда.
 * Возвращает всё как было до приёма.
 */
export async function undoPayment(
  ctx: Pick<AppContext, 'db'>,
  staff: StaffPrincipal,
  participantId: number,
): Promise<{ ok: true }> {
  // Админ и банкир (все деньги под его контролем) отменяют любой приём, кассир - свой в течение 15 минут.
  const isAdmin = hasPermission(staff.roles, 'participants:write') || hasPermission(staff.roles, 'money:manage');
  await ctx.db.transaction(async (tx) => {
    // Сначала блокируем человека: параллельный приём другого кассира дождётся отмены, и наоборот.
    const [p] = await tx.select().from(schema.participants).where(eq(schema.participants.id, participantId)).for('update');
    if (!p) throw notFound('Участник не найден');
    const [last] = await tx
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entity, 'participant'),
          eq(schema.auditLog.entityId, String(participantId)),
          inArray(schema.auditLog.action, ['payment.mark_paid', 'receipt.accept_person']),
        ),
      )
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    const fresh = last && last.createdAt.getTime() > Date.now() - UNDO_MINUTES * 60_000;
    if (!isAdmin && (!last || last.actorUserId !== staff.user.id || !fresh)) {
      throw forbidden(`Отменить можно только свой приём в течение ${UNDO_MINUTES} минут - дальше через админку`);
    }
    const before = (last?.before ?? null) as { paymentStatus: string; amountPaid: string; paidAt: string | null; paymentNote: string | null } | null;
    const after = (last?.after ?? null) as { paymentStatus?: string; amountPaid?: string } | null;
    if (before && fresh && after && (after.paymentStatus !== p.paymentStatus || Number(after.amountPaid) !== Number(p.amountPaid))) {
      // После этого приёма оплату уже поменяли (другой приём, правка в админке) - «вернуть как было» затёрло бы их.
      throw conflict('payment_changed', 'Оплату уже изменили после этого приёма - поправьте сумму в карточке участника');
    }
    let restoredStatus = before?.paymentStatus ?? 'unpaid';
    if (before && fresh && restoredStatus === 'pending') {
      // До приёма был чек на проверке - но его могли уже отклонить или принять: тогда «на проверке» не возвращаем.
      const [stillPending] = await tx
        .select({ id: schema.paymentReceipts.id })
        .from(schema.paymentReceipts)
        .where(and(eq(schema.paymentReceipts.status, 'pending'), sql`${participantId} = any(${schema.paymentReceipts.participantIds})`))
        .limit(1);
      if (!stillPending) restoredStatus = Number(before.amountPaid) > 0 ? 'partial' : 'unpaid';
    }
    const next =
      before && fresh
        ? {
            paymentStatus: restoredStatus,
            amountPaid: before.amountPaid,
            paidAt: before.paidAt ? new Date(before.paidAt) : null,
            paymentNote: before.paymentNote,
          }
        : // Админ отменяет давнюю оплату - просто «не оплачено».
          { paymentStatus: 'unpaid', amountPaid: '0', paidAt: null };
    await tx
      .update(schema.participants)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(schema.participants.id, participantId));
    // «Без сдачи»: пожертвование записано тем же приёмом, что и последний взнос (одна транзакция - одно время).
    // Сравниваем в базе: время там точнее миллисекунд, а в коде округляется.
    await tx.execute(sql`
      update payments d set undone_at = now(), undone_by = ${staff.user.id}
       where d.participant_id = ${participantId} and d.kind = 'donation' and d.undone_at is null
         and d.created_at = (select f.created_at from payments f
                              where f.participant_id = ${participantId} and f.kind = 'fee' and f.undone_at is null
                              order by f.id desc limit 1)`);
    await reconcilePayments(tx, participantId, Number(next.amountPaid ?? 0), staff.user.id, 'cash');
    await audit(tx, {
      actorUserId: staff.user.id,
      action: 'payment.undo',
      entity: 'participant',
      entityId: participantId,
      before: { paymentStatus: p.paymentStatus, amountPaid: p.amountPaid, paidAt: p.paidAt, paymentNote: p.paymentNote },
      after: next,
    });
  });
  return { ok: true };
}

export async function listReceipts(
  ctx: Pick<AppContext, 'db'>,
  status?: 'pending' | 'accepted' | 'rejected',
  receiptIds?: number[],
): Promise<ReceiptView[]> {
  // Черновики (человек ещё выбирает, за кого чек) админам не показываем.
  const conds = [sql`${schema.paymentReceipts.status} <> 'draft'`];
  if (status) conds.push(eq(schema.paymentReceipts.status, status));
  if (receiptIds) conds.push(inArray(schema.paymentReceipts.id, receiptIds.length ? receiptIds : [-1]));
  const rows = await ctx.db
    .select({ receipt: schema.paymentReceipts, user: schema.users })
    .from(schema.paymentReceipts)
    .innerJoin(schema.users, eq(schema.users.id, schema.paymentReceipts.userId))
    .where(and(...conds))
    .orderBy(desc(schema.paymentReceipts.createdAt))
    .limit(2000);
  const pids = [...new Set(rows.flatMap((r) => r.receipt.participantIds))];
  const reviewerIds = [...new Set(rows.map((r) => r.receipt.reviewedBy).filter((x): x is number => x != null))];
  const orderIds = [...new Set(rows.map((r) => r.receipt.merchOrderId).filter((x): x is number => x != null))];
  const [people, reviewers, orders] = await Promise.all([
    pids.length ? ctx.db.select().from(schema.participants).where(inArray(schema.participants.id, pids)) : [],
    reviewerIds.length ? ctx.db.select().from(schema.users).where(inArray(schema.users.id, reviewerIds)) : [],
    orderIds.length
      ? ctx.db
          .select({ id: schema.merchOrders.id, code: schema.merchOrders.code, total: schema.merchOrders.total, status: schema.merchOrders.status })
          .from(schema.merchOrders)
          .where(inArray(schema.merchOrders.id, orderIds))
      : [],
  ]);
  // Что в бронях: полное название, цвет и размер - проверяющему видно, за что чек.
  const orderItems = orderIds.length
    ? await ctx.db
        .select({
          orderId: schema.merchOrderItems.orderId,
          qty: schema.merchOrderItems.qty,
          product: schema.merchProducts.title,
          color: schema.merchColors.name,
          size: schema.merchVariants.size,
        })
        .from(schema.merchOrderItems)
        .innerJoin(schema.merchVariants, eq(schema.merchVariants.id, schema.merchOrderItems.variantId))
        .innerJoin(schema.merchColors, eq(schema.merchColors.id, schema.merchVariants.colorId))
        .innerJoin(schema.merchProducts, eq(schema.merchProducts.id, schema.merchColors.productId))
        .where(inArray(schema.merchOrderItems.orderId, orderIds))
        .orderBy(schema.merchOrderItems.id)
    : [];
  const orderById = new Map(
    orders.map((o) => [o.id, { ...o, items: orderItems.filter((i) => i.orderId === o.id).map(({ orderId: _, ...rest }) => rest) }]),
  );
  const extraFiles = rows.length
    ? await ctx.db
        .select({ receiptId: schema.paymentReceiptFiles.receiptId, kind: schema.paymentReceiptFiles.fileKind, mimeType: schema.paymentReceiptFiles.mimeType })
        .from(schema.paymentReceiptFiles)
        .where(inArray(schema.paymentReceiptFiles.receiptId, rows.map((r) => r.receipt.id)))
        .orderBy(schema.paymentReceiptFiles.id)
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const reviewerName = new Map(reviewers.map((u) => [u.id, userDisplayName(u)]));
  return rows.map(({ receipt: r, user }) => {
    const ps = r.participantIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    const order = r.merchOrderId ? (orderById.get(r.merchOrderId) ?? null) : null;
    // Сколько должно быть в чеке: взнос - остатки людей, мерч - сумма брони, пожертвование - сколько угодно.
    const expected = r.kind === 'merch' ? Number(order?.total ?? 0) : ps.reduce((sum, p) => sum + dueOf(p), 0);
    return {
    id: r.id,
    kind: r.kind as ReceiptView['kind'],
    merchOrder: order,
    userId: user.id,
    userName: userDisplayName(user),
    paymentRef: user.paymentRef,
    participants: ps.map((p) => ({
      id: p.id,
      fullName: fullName(p),
      paymentStatus: p.paymentStatus as PaymentStatus,
      tier: asTier(p.tier),
      breakfast: p.breakfast,
      amountDue: p.amountDue,
      amountPaid: p.amountPaid,
    })),
    // Сколько должно быть в чеке: остатки (у частично оплативших - меньше полной цены).
    expectedTotal: expected.toFixed(2),
    // Сумма чека для таблицы и выгрузки: на проверке - сколько должно быть сейчас, проверенный - сохранённая.
    amount: r.status === 'pending' ? (r.kind === 'donation' ? null : expected.toFixed(2)) : r.amount,
    fileKind: r.fileKind as 'photo' | 'document',
    mimeType: r.mimeType,
    fileUrl: `/api/admin/receipts/${r.id}/file`,
    files: [
      { url: `/api/admin/receipts/${r.id}/file`, kind: r.fileKind as 'photo' | 'document', mimeType: r.mimeType },
      ...extraFiles
        .filter((f) => f.receiptId === r.id)
        .map((f, i) => ({ url: `/api/admin/receipts/${r.id}/file?n=${i + 1}`, kind: f.kind as 'photo' | 'document', mimeType: f.mimeType })),
    ],
    comment: r.comment,
    status: r.status as ReceiptView['status'],
    rejectReason: r.rejectReason,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewerName: r.reviewedBy ? (reviewerName.get(r.reviewedBy) ?? null) : null,
    };
  });
}

export async function reviewReceipt(
  ctx: Pick<AppContext, 'db' | 'boss'>,
  receiptId: number,
  reviewer: StaffPrincipal,
  decision: 'accept' | 'reject',
  data: { amount?: string | null; reason?: string | null; participantIds?: number[] | null },
): Promise<ReceiptView> {
  const head = await ctx.db.query.paymentReceipts.findFirst({ where: eq(schema.paymentReceipts.id, receiptId) });
  if (head && head.kind !== 'fee') {
    await reviewPurposeReceipt(ctx, receiptId, reviewer, decision, data);
    const [view] = await listReceipts(ctx, undefined, [receiptId]);
    return view!;
  }
  await ctx.db.transaction(async (tx) => {
    const [receipt] = await tx
      .select()
      .from(schema.paymentReceipts)
      .where(eq(schema.paymentReceipts.id, receiptId))
      .for('update');
    if (!receipt || receipt.status === 'draft') throw notFound('Чек не найден');
    if (receipt.status !== 'pending') throw conflict('already_reviewed', 'Этот чек уже проверен');
    // Принять можно и частично: кого сняли - возвращается в «не оплачено».
    const accepted =
      decision === 'accept'
        ? data.participantIds?.length
          ? receipt.participantIds.filter((id) => data.participantIds!.includes(id))
          : receipt.participantIds
        : [];
    if (decision === 'accept' && accepted.length === 0) throw badRequest('nobody', 'Отметьте хотя бы одного человека');
    // Засчитываем только тем, кто всё ещё «чек на проверке»: остальные успели оплатить иначе (например, наличными).
    const people = accepted.length
      ? await tx.select().from(schema.participants).where(inArray(schema.participants.id, accepted)).for('update')
      : [];
    // Отменил регистрацию после перевода - деньги всё равно пришли: чек принимаем и засчитываем, чтобы сверка с выпиской сошлась.
    const credit = people.filter((p) => p.paymentStatus === 'pending');
    if (decision === 'accept' && credit.length === 0) {
      throw conflict('already_paid', 'Все отмеченные уже оплатили другим способом - этот чек нужно отклонить');
    }
    if (decision === 'accept' && data.amount && credit.length > 1) {
      const total = credit.reduce((sum, p) => sum + dueOf(p), 0);
      if (Number(data.amount) + 0.005 < total) {
        throw badRequest(
          'amount_too_small',
          `В чеке меньше, чем нужно за отмеченных (${formatRub(total.toFixed(2))}). Снимите лишних или принимайте по одному.`,
        );
      }
    }
    const rest = receipt.participantIds.filter((id) => !accepted.includes(id));
    // Отклонённый чек: запоминаем, сколько в нём должно было быть, - для сверки с выпиской.
    const rejectedDue =
      decision === 'reject' && receipt.participantIds.length
        ? (await tx.select().from(schema.participants).where(inArray(schema.participants.id, receipt.participantIds)))
            .reduce((sum, p) => sum + dueOf(p), 0)
            .toFixed(2)
        : null;
    await tx
      .update(schema.paymentReceipts)
      .set({
        status: decision === 'accept' ? 'accepted' : 'rejected',
        participantIds: decision === 'accept' ? credit.map((p) => p.id) : receipt.participantIds,
        reviewedBy: reviewer.user.id,
        reviewedAt: new Date(),
        rejectReason: decision === 'reject' ? (data.reason ?? null) : null,
        amount: rejectedDue,
      })
      .where(eq(schema.paymentReceipts.id, receiptId));
    await revertFromPending(tx, rest);
    if (credit.length > 0) {
      const ids = credit.map((p) => p.id);
      // Из «на проверке» - в «не оплачено», потом зачисляем по сумме (settle не трогает только paid/exempt).
      await revertFromPending(tx, ids);
      const note = `чек #${receiptId}${data.amount ? ` (${formatRub(data.amount)})` : ''}, принял(а) ${reviewer.name}`;
      const settled = await settle(tx, ids, data.amount, note, reviewer.user.id, 'receipt.accept_person', { method: 'transfer', source: 'receipt', receiptId }, {
        includeCancelled: true,
      });
      // Сумма чека: что вписал проверяющий (как в самом чеке), иначе - сколько зачли людям.
      const credited = settled.reduce((sum, s) => sum + Number(s.added), 0);
      await tx
        .update(schema.paymentReceipts)
        .set({ amount: data.amount ? Number(data.amount).toFixed(2) : credited.toFixed(2) })
        .where(eq(schema.paymentReceipts.id, receiptId));
    }
    await enqueue(ctx.boss, 'receipt.reviewed', { receiptId, notAccepted: rest }, { tx });
    await audit(tx, {
      actorUserId: reviewer.user.id,
      action: `receipt.${decision}`,
      entity: 'receipt',
      entityId: receiptId,
      after: { ...data, accepted, credited: credit.map((p) => p.id), rest },
    });
  });
  const [view] = await listReceipts(ctx, undefined, [receiptId]);
  return view!;
}

/**
 * Проверка чека пожертвования или за мерч. Мерч: принять = бронь «оплачено» (человеку - сообщение об оплате,
 * чек принимается там же). Пожертвование: сумму вписывает проверяющий, она идёт в журнал денег.
 */
async function reviewPurposeReceipt(
  ctx: Pick<AppContext, 'db' | 'boss'>,
  receiptId: number,
  reviewer: StaffPrincipal,
  decision: 'accept' | 'reject',
  data: { amount?: string | null; reason?: string | null },
): Promise<void> {
  const current = async (tx: Tx) => {
    const [r] = await tx.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, receiptId)).for('update');
    if (!r || r.status === 'draft') throw notFound('Чек не найден');
    if (r.status !== 'pending') throw conflict('already_reviewed', 'Этот чек уже проверен');
    return r;
  };
  if (decision === 'accept') {
    const r = await ctx.db.transaction(current);
    if (r.kind === 'merch') {
      if (!r.merchOrderId) throw conflict('order_gone', 'Этой брони больше нет - отклоните чек');
      await markOrderPaid(ctx, r.merchOrderId, 'transfer', reviewer);
      await audit(ctx.db, { actorUserId: reviewer.user.id, action: 'receipt.accept', entity: 'receipt', entityId: receiptId, after: { kind: r.kind, orderId: r.merchOrderId } });
      return;
    }
    const amount = Number(data.amount);
    if (!(amount > 0)) throw badRequest('amount_required', 'Впишите сумму пожертвования из чека');
    await ctx.db.transaction(async (tx) => {
      const fresh = await current(tx);
      const [self] = await tx
        .select({ id: schema.participants.id })
        .from(schema.participants)
        .where(and(eq(schema.participants.ownerUserId, fresh.userId), eq(schema.participants.relation, 'self')))
        .limit(1);
      const user = await tx.query.users.findFirst({ where: eq(schema.users.id, fresh.userId) });
      await recordPayment(tx, {
        kind: 'donation',
        participantId: self?.id ?? null,
        donorName: self ? null : user ? userDisplayName(user) : null,
        comment: `чек #${receiptId}, принял(а) ${reviewer.name}`,
        amount,
        method: 'transfer',
        source: 'receipt',
        acceptedBy: reviewer.user.id,
        receiptId,
      });
      await tx
        .update(schema.paymentReceipts)
        .set({ status: 'accepted', reviewedBy: reviewer.user.id, reviewedAt: new Date(), amount: amount.toFixed(2) })
        .where(eq(schema.paymentReceipts.id, receiptId));
      await enqueue(ctx.boss, 'receipt.reviewed', { receiptId }, { tx });
      await audit(tx, { actorUserId: reviewer.user.id, action: 'receipt.accept', entity: 'receipt', entityId: receiptId, after: { kind: fresh.kind, amount } });
    });
    return;
  }
  await ctx.db.transaction(async (tx) => {
    const r = await current(tx);
    await tx
      .update(schema.paymentReceipts)
      .set({ status: 'rejected', reviewedBy: reviewer.user.id, reviewedAt: new Date(), rejectReason: data.reason ?? null })
      .where(eq(schema.paymentReceipts.id, receiptId));
    await enqueue(ctx.boss, 'receipt.reviewed', { receiptId }, { tx });
    await audit(tx, { actorUserId: reviewer.user.id, action: 'receipt.reject', entity: 'receipt', entityId: receiptId, after: { kind: r.kind, reason: data.reason ?? null } });
  });
}

/**
 * Удалить чек насовсем (дубль, прислали не то). Оплату, зачисленную по принятому чеку, не трогаем.
 * Чек ещё на проверке - людям из него возвращаем «не оплачено» / «частично», иначе так и висели бы «на проверке».
 * Тот же файл после этого можно прислать заново.
 */
export async function deleteReceipt(ctx: Pick<AppContext, 'db'>, receiptId: number, actor: StaffPrincipal): Promise<{ deleted: true }> {
  await ctx.db.transaction(async (tx) => {
    const [receipt] = await tx
      .select()
      .from(schema.paymentReceipts)
      .where(eq(schema.paymentReceipts.id, receiptId))
      .for('update');
    if (!receipt) throw notFound('Чек не найден');
    await tx.delete(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, receiptId));
    if (receipt.status === 'pending' && receipt.participantIds.length) {
      // Кто есть и в другом чеке на проверке - остаётся «на проверке».
      const busy = await tx
        .select({ ids: schema.paymentReceipts.participantIds })
        .from(schema.paymentReceipts)
        .where(and(eq(schema.paymentReceipts.status, 'pending'), arrayOverlaps(schema.paymentReceipts.participantIds, receipt.participantIds)));
      const still = new Set(busy.flatMap((r) => r.ids));
      await revertFromPending(tx, receipt.participantIds.filter((id) => !still.has(id)));
    }
    await audit(tx, {
      actorUserId: actor.user.id,
      action: 'receipt.delete',
      entity: 'receipt',
      entityId: receiptId,
      before: {
        userId: receipt.userId,
        participantIds: receipt.participantIds,
        status: receipt.status,
        fileKind: receipt.fileKind,
        mimeType: receipt.mimeType,
        comment: receipt.comment,
        rejectReason: receipt.rejectReason,
        reviewedBy: receipt.reviewedBy,
        createdAt: receipt.createdAt.toISOString(),
      },
    });
  });
  for (const k of [...fileCache.keys()]) if (k.startsWith(`${receiptId}:`)) fileCache.delete(k);
  return { deleted: true };
}

/**
 * Копия файла чека к нам в закрытую папку: Telegram хранит файлы долго, но не обещает этого.
 * Чек за мерч - ещё и к брони, если там своего чека нет (продавец видит его в заказе).
 */
export async function archiveReceipt(ctx: Pick<AppContext, 'db' | 'tg' | 'config'>, receiptId: number): Promise<boolean> {
  const r = await ctx.db.query.paymentReceipts.findFirst({ where: eq(schema.paymentReceipts.id, receiptId) });
  if (!r) return false;
  const download = async (fileId: string) => {
    const file = await ctx.tg.getFile(fileId);
    if (!file.file_path) return null;
    const body = await telegramDownload(`https://api.telegram.org/file/bot${ctx.config.BOT_TOKEN}/${file.file_path}`, 30_000);
    return savePrivate(ctx.config.PRIVATE_DIR, 'receipts', body);
  };
  let copied = false;
  if (!r.storedFile && r.fileId) {
    const saved = await download(r.fileId);
    if (saved) {
      await ctx.db.update(schema.paymentReceipts).set({ storedFile: saved.file }).where(eq(schema.paymentReceipts.id, receiptId));
      if (r.kind === 'merch' && r.merchOrderId) {
        await ctx.db
          .update(schema.merchOrders)
          .set({ receiptFile: saved.file, receiptMime: saved.mime })
          .where(and(eq(schema.merchOrders.id, r.merchOrderId), sql`${schema.merchOrders.receiptFile} is null`));
      }
      copied = true;
    }
  }
  // Остальные файлы того же чека (фото подряд).
  const extras = await ctx.db
    .select()
    .from(schema.paymentReceiptFiles)
    .where(and(eq(schema.paymentReceiptFiles.receiptId, receiptId), sql`${schema.paymentReceiptFiles.storedFile} is null`, sql`${schema.paymentReceiptFiles.fileId} is not null`));
  for (const f of extras) {
    const saved = await download(f.fileId!);
    if (!saved) continue;
    await ctx.db.update(schema.paymentReceiptFiles).set({ storedFile: saved.file }).where(eq(schema.paymentReceiptFiles.id, f.id));
    copied = true;
  }
  return copied;
}

/** Чеки без нашей копии - по нескольку за раз, чтобы не упереться в лимиты Telegram. */
export async function receiptsToArchive(db: DbLike, limit = 40): Promise<number[]> {
  const res = await db.execute<{ id: number }>(sql`
    select id from payment_receipts where stored_file is null and file_id is not null
    union
    select receipt_id from payment_receipt_files where stored_file is null and file_id is not null
    order by id limit ${limit}`);
  return res.rows.map((r) => Number(r.id));
}

// Файлы чеков небольшие - держим последние в памяти: повторный просмотр не ходит в Telegram.
const fileCache = new Map<string, { body: Buffer; contentType: string }>();
const FILE_CACHE_MAX = 60;

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

/** Файл чека из Telegram - отдаём в админку через наш API (токен бота наружу не уходит). */
export async function receiptFile(
  ctx: Pick<AppContext, 'db' | 'tg' | 'config' | 'log'>,
  receiptId: number,
  /** 0 - первый файл чека, 1, 2… - присланные следом. */
  index = 0,
): Promise<{ body: Buffer; contentType: string }> {
  const key = `${receiptId}:${index}`;
  const cached = fileCache.get(key);
  if (cached) return cached;
  const main = await ctx.db.query.paymentReceipts.findFirst({ where: eq(schema.paymentReceipts.id, receiptId) });
  if (!main) throw notFound('Чек не найден');
  const extra =
    index > 0
      ? (
          await ctx.db
            .select()
            .from(schema.paymentReceiptFiles)
            .where(eq(schema.paymentReceiptFiles.receiptId, receiptId))
            .orderBy(schema.paymentReceiptFiles.id)
            .offset(index - 1)
            .limit(1)
        )[0]
      : undefined;
  if (index > 0 && !extra) throw notFound('Файла нет');
  const r = extra ?? main;
  const contentType = r.mimeType ?? (r.fileKind === 'photo' ? 'image/jpeg' : 'application/octet-stream');
  // Своя копия есть - Telegram не нужен.
  if (r.storedFile) {
    const body = await readStored(ctx.config.PRIVATE_DIR, r.storedFile).catch(() => null);
    if (body) return { body, contentType };
  }
  if (!r.fileId) throw notFound('Файла чека нет');
  const fileId = r.fileId;
  try {
    const body = await withRetry(async () => {
      const file = await ctx.tg.getFile(fileId);
      if (!file.file_path) throw new Error('no file_path');
      return telegramDownload(`https://api.telegram.org/file/bot${ctx.config.BOT_TOKEN}/${file.file_path}`, 20_000);
    });
    const out = { body, contentType };
    if (fileCache.size >= FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value!);
    fileCache.set(key, out);
    return out;
  } catch (err) {
    ctx.log.warn({ err, receiptId }, 'receipt file download failed');
    throw new AppError(502, 'telegram_unavailable', 'Не получилось загрузить чек из Telegram - обновите страницу через пару секунд');
  }
}
