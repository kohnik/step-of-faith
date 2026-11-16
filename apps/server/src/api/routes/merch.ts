import {
  merchColorInputSchema,
  merchColorUpdateSchema,
  merchMediaUpdateSchema,
  merchOrderCancelSchema,
  merchOrderCreateSchema,
  merchOrderPaySchema,
  merchProductInputSchema,
  merchProductSaveSchema,
  merchProductUpdateSchema,
  merchRepaySchema,
  merchReserveSchema,
  merchSellSchema,
  merchSettingsPatchSchema,
  merchSizeInputSchema,
  merchSizeUpdateSchema,
  receiptDecisionSchema,
  type MerchUploadView,
  type Permission,
} from '@sof/shared';
import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extname } from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.ts';
import { badRequest } from '../../lib/errors.ts';
import { excelTime, sheet } from '../../services/admin.service.ts';
import {
  MEDIA_TYPES,
  MODEL_MAX_BYTES,
  PHOTO_MAX_BYTES,
  readStored,
  removeStored,
  saveModel,
  savePhoto,
  savePrivate,
  saveSpin,
  storedMedia,
  type StoredMedia,
} from '../../services/media.service.ts';
import {
  addColor,
  addMedia,
  addSize,
  assertMediaRoom,
  adminOrders,
  adminProducts,
  attachOwnReceipt,
  cancelOrderByStaff,
  cancelOwnOrder,
  confirmOwnOrder,
  catalog,
  createOrder,
  createProduct,
  deleteColor,
  deleteMedia,
  deleteProduct,
  deleteSize,
  getMerchSettings,
  markOrderIssued,
  markOrderPaid,
  reserveForUser,
  merchStats,
  myOrders,
  orderReceipt,
  patchMerchSettings,
  repayDebt,
  searchBuyers,
  saveProduct,
  scanForMerch,
  onlinePayment,
  setOwnPaymentMethod,
  updateColor,
  updateMedia,
  updateProduct,
  updateSize,
  merchReceiptOrderId,
} from '../../services/merch.service.ts';
import { receiptFile, reviewReceipt } from '../../services/payment.service.ts';
import { getSettings } from '../../services/settings.service.ts';
import { getRoles } from '../../services/users.service.ts';
import { requireParticipant, requireStaff } from '../auth.ts';
import { idParam, oneFile, parse, tooManyRequests, UserRateLimiter } from '../http.ts';

const orderLimiter = new UserRateLimiter(10, 0.2);
const uploadLimiter = new UserRateLimiter(6, 0.1);

const STATUS_LABEL = { reserved: 'Бронь', paid: 'Оплачен', issued: 'Выдан', owed: 'В долг', cancelled: 'Отменён', expired: 'Истёк' } as const;
const METHOD_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' } as const;

function sendFile(reply: FastifyReply, data: Buffer, file: string, cache: string) {
  const type = MEDIA_TYPES[extname(file).slice(1)] ?? 'application/octet-stream';
  return reply.header('Content-Type', type).header('Cache-Control', cache).send(data);
}

export function merchRoutes(app: FastifyInstance, ctx: AppContext) {
  const participant = { preHandler: requireParticipant(ctx) };
  const need = (...perms: Permission[]) => ({ preHandler: requireStaff(ctx, perms) });
  const me = (req: FastifyRequest) => req.tgUser!;
  const staff = (req: FastifyRequest) => req.staff!;
  const { MEDIA_DIR, PRIVATE_DIR } = ctx.config;
  const dropFiles = async (files: string[]) => {
    for (const f of files) await removeStored(MEDIA_DIR, f).catch(() => undefined);
  };

  // В разработке картинки и модели отдаёт API (в проде - Caddy из того же тома).
  if (ctx.config.NODE_ENV === 'development') {
    app.get('/media/*', async (req, reply) => {
      const rel = (req.params as { '*': string })['*'];
      try {
        return sendFile(reply, await readStored(MEDIA_DIR, rel), rel, 'public, max-age=3600');
      } catch {
        return reply.code(404).send({ error: 'not_found', message: 'Нет файла' });
      }
    });
  }

  // ---------- Mini App ----------

  /** Витрина: видна, когда включена в настройках (с галочкой «только администраторам» - только им). */
  app.get('/api/merch', participant, async (req) => catalog(ctx, { roles: await getRoles(ctx.db, me(req).id) }));

  app.get('/api/merch/orders', participant, async (req) => myOrders(ctx.db, me(req)));

  app.post('/api/merch/orders', participant, async (req) => {
    if (!orderLimiter.take(`o:${me(req).id}`)) throw tooManyRequests();
    return createOrder(ctx, me(req), parse(merchOrderCreateSchema, req.body));
  });

  app.post('/api/merch/orders/:id/cancel', participant, async (req) => cancelOwnOrder(ctx, me(req), idParam(req.params)));
  app.post('/api/merch/orders/:id/confirm', participant, async (req) => confirmOwnOrder(ctx, me(req), idParam(req.params)));

  app.post('/api/merch/orders/:id/method', participant, async (req) =>
    setOwnPaymentMethod(ctx, me(req), idParam(req.params), parse(z.object({ method: z.enum(['cash', 'transfer']) }), req.body).method),
  );

  /** Чек перевода - прямо из приложения, в закрытую папку. */
  app.post('/api/merch/orders/:id/receipt', participant, async (req) => {
    if (!uploadLimiter.take(`r:${me(req).id}`)) throw tooManyRequests();
    const settings = await getSettings(ctx.db);
    if (!onlinePayment(settings)) throw badRequest('transfers_disabled', 'Переводом сейчас не принимаем - оплатите на месте');
    const { data } = await oneFile(req, PHOTO_MAX_BYTES);
    const saved = await savePrivate(PRIVATE_DIR, 'merch-receipts', data);
    const { order, replaced } = await attachOwnReceipt(ctx, me(req), idParam(req.params), saved);
    if (replaced) await removeStored(PRIVATE_DIR, replaced).catch(() => undefined);
    return order;
  });

  // ---------- админка: каталог ----------

  app.get('/api/admin/merch', need('merch:stock', 'merch:sell', 'merch:stats'), async () => adminProducts(ctx.db));

  app.post('/api/admin/merch', need('merch:stock'), async (req) => createProduct(ctx, parse(merchProductInputSchema, req.body), staff(req)));

  app.patch('/api/admin/merch/:id', need('merch:stock'), async (req) =>
    updateProduct(ctx, idParam(req.params), parse(merchProductUpdateSchema, req.body), staff(req)),
  );

  app.delete('/api/admin/merch/:id', need('merch:stock'), async (req) => {
    const { files } = await deleteProduct(ctx, idParam(req.params), staff(req));
    await dropFiles(files);
    return { deleted: true };
  });

  app.post('/api/admin/merch/:id/colors', need('merch:stock'), async (req) =>
    addColor(ctx, idParam(req.params), parse(merchColorInputSchema, req.body), staff(req)),
  );
  app.patch('/api/admin/merch-colors/:id', need('merch:stock'), async (req) =>
    updateColor(ctx, idParam(req.params), parse(merchColorUpdateSchema, req.body), staff(req)),
  );
  app.delete('/api/admin/merch-colors/:id', need('merch:stock'), async (req) => deleteColor(ctx, idParam(req.params), staff(req)));

  app.post('/api/admin/merch-colors/:id/sizes', need('merch:stock'), async (req) =>
    addSize(ctx, idParam(req.params), parse(merchSizeInputSchema, req.body), staff(req)),
  );
  app.patch('/api/admin/merch-sizes/:id', need('merch:stock'), async (req) =>
    updateSize(ctx, idParam(req.params), parse(merchSizeUpdateSchema, req.body), staff(req)),
  );
  app.delete('/api/admin/merch-sizes/:id', need('merch:stock'), async (req) => deleteSize(ctx, idParam(req.params), staff(req)));

  /**
   * Фото (JPG/PNG/WebP → WebP), 3D-модель (.glb) или 360° (.spin). Поле colorId - для какого цвета (пусто - обложка и общие).
   * До 10 фото на набор; новая 3D-модель или 360° заменяет прежнюю в том же наборе.
   */
  app.post('/api/admin/merch/:id/media', need('merch:stock'), async (req) => {
    const productId = idParam(req.params);
    const { data, mime, name, fields } = await oneFile(req, MODEL_MAX_BYTES);
    const colorId = fields.colorId ? Number(fields.colorId) : null;
    if (colorId !== null && !(Number.isInteger(colorId) && colorId > 0)) throw badRequest('bad_color', 'Неверный цвет');
    const isModel = name.toLowerCase().endsWith('.glb') || mime === 'model/gltf-binary';
    const isSpin = name.toLowerCase().endsWith('.spin');
    // Лимит - до сохранения: отказ не оставит лишнего файла.
    await assertMediaRoom(ctx.db, productId, colorId, isSpin ? 'spin' : isModel ? 'model' : 'photo');
    const spinOf = async () => {
      const { frames: _frames, ...saved } = await saveSpin(MEDIA_DIR, 'merch', data);
      return { kind: 'spin' as const, ...saved };
    };
    const media = isSpin
      ? await spinOf()
      : isModel
        ? { kind: 'model' as const, thumb: null, width: null, height: null, ...(await saveModel(MEDIA_DIR, 'merch', data)) }
        : { kind: 'photo' as const, ...(await savePhoto(MEDIA_DIR, 'merch', data, mime)) };
    const { product, files } = await addMedia(ctx, productId, { ...media, colorId }, staff(req));
    await dropFiles(files);
    return product;
  });

  /** Файл для редактора вещи: обрабатываем и кладём в папку; к вещи его привяжет «Сохранить». */
  app.post('/api/admin/merch/uploads', need('merch:stock'), async (req): Promise<MerchUploadView> => {
    const { data, mime, name } = await oneFile(req, MODEL_MAX_BYTES);
    if (name.toLowerCase().endsWith('.spin')) {
      const saved = await saveSpin(MEDIA_DIR, 'merch', data);
      return { file: saved.file, kind: 'spin', url: `/media/${saved.file}`, thumbUrl: `/media/${saved.thumb}`, bytes: saved.bytes };
    }
    if (name.toLowerCase().endsWith('.glb') || mime === 'model/gltf-binary') {
      const saved = await saveModel(MEDIA_DIR, 'merch', data);
      return { file: saved.file, kind: 'model', url: `/media/${saved.file}`, thumbUrl: null, bytes: saved.bytes };
    }
    const saved = await savePhoto(MEDIA_DIR, 'merch', data, mime);
    return { file: saved.file, kind: 'photo', url: `/media/${saved.file}`, thumbUrl: `/media/${saved.thumb}`, bytes: saved.bytes };
  });

  /** Редактор вещи: всё набранное - одной транзакцией (новая вещь - `id: null`). */
  app.post('/api/admin/merch/save', need('merch:stock'), async (req) => {
    const input = parse(merchProductSaveSchema, req.body);
    const uploads = new Map<string, StoredMedia>();
    for (const m of input.media) if (m.file && !uploads.has(m.file)) uploads.set(m.file, await storedMedia(MEDIA_DIR, m.file));
    const { product, files } = await saveProduct(ctx, input, uploads, staff(req));
    await dropFiles(files);
    return product;
  });

  app.patch('/api/admin/merch-media/:id', need('merch:stock'), async (req) =>
    updateMedia(ctx, idParam(req.params), parse(merchMediaUpdateSchema, req.body), staff(req)),
  );

  app.delete('/api/admin/merch-media/:id', need('merch:stock'), async (req) => {
    const { product, files } = await deleteMedia(ctx, idParam(req.params), staff(req));
    await dropFiles(files);
    return product;
  });

  // ---------- админка: заказы ----------

  app.get('/api/admin/merch/orders', need('merch:sell'), async () => adminOrders(ctx.db));

  /** Выдача по QR-коду участника (тот же, что на вход): человек, взнос и его заказы. */
  app.post('/api/admin/merch/scan', need('merch:sell'), async (req) =>
    scanForMerch(ctx.db, parse(z.object({ code: z.string().trim().min(1).max(200) }), req.body).code),
  );

  app.post('/api/admin/merch/orders/:id/pay', need('merch:sell'), async (req) =>
    markOrderPaid(ctx, idParam(req.params), parse(merchOrderPaySchema, req.body).method, staff(req)),
  );

  // Чеки за мерч - продавцу без доступа к «Оплатам и чекам»: посмотреть файл, принять (бронь оплачена) или отклонить.
  app.get('/api/admin/merch/receipts/:id/file', need('merch:sell'), async (req, reply) => {
    const id = idParam(req.params);
    await merchReceiptOrderId(ctx.db, id);
    const n = Number((req.query as Record<string, string | undefined>).n ?? 0);
    const file = await receiptFile(ctx, id, Number.isInteger(n) && n >= 0 && n < 50 ? n : 0);
    reply.header('Content-Type', file.contentType).header('Cache-Control', 'private, max-age=600');
    return reply.send(file.body);
  });
  app.post('/api/admin/merch/receipts/:id/accept', need('merch:sell'), async (req) => {
    const id = idParam(req.params);
    const orderId = await merchReceiptOrderId(ctx.db, id);
    await reviewReceipt(ctx, id, staff(req), 'accept', {});
    return (await adminOrders(ctx.db, [orderId]))[0];
  });
  app.post('/api/admin/merch/receipts/:id/reject', need('merch:sell'), async (req) => {
    const id = idParam(req.params);
    const orderId = await merchReceiptOrderId(ctx.db, id);
    await reviewReceipt(ctx, id, staff(req), 'reject', parse(receiptDecisionSchema, req.body ?? {}));
    return (await adminOrders(ctx.db, [orderId]))[0];
  });

  app.post('/api/admin/merch/orders/:id/issue', need('merch:sell'), async (req) => {
    const body = parse(z.object({ method: merchOrderPaySchema.shape.method.nullish() }), req.body ?? {});
    return markOrderIssued(ctx, idParam(req.params), body.method ?? null, staff(req));
  });

  app.post('/api/admin/merch/orders/:id/cancel', need('merch:sell'), async (req) =>
    cancelOrderByStaff(ctx, idParam(req.params), parse(merchOrderCancelSchema, req.body ?? {}).reason ?? null, staff(req)),
  );

  /** Бронь человеку из переписки: продавец всё уточнил и бронирует - остаток уменьшается только теперь. */
  app.post('/api/admin/merch/reserve', need('merch:sell'), async (req) => reserveForUser(ctx, staff(req), parse(merchReserveSchema, req.body)));

  /** Продажа на месте без брони: сразу «оплачено и выдано», остаток уменьшается. */
  app.post('/api/admin/merch/sell', need('merch:sell'), async (req) => {
    const { requestId, items, paymentMethod, method, ...sale } = parse(merchSellSchema, req.body);
    const order = await createOrder(ctx, staff(req).user, { requestId, items, paymentMethod }, { staffSale: staff(req), method, sale });
    // Админке - полная строка заказа (покупатель, пометка «Продажа на месте»), как в списке.
    return (await adminOrders(ctx.db, [order.id]))[0];
  });

  /** Погашение долга - полностью или частью; каждая доплата - запись в журнале денег. */
  app.post('/api/admin/merch/orders/:id/repay', need('merch:sell'), async (req) => {
    const body = parse(merchRepaySchema, req.body);
    return repayDebt(ctx, idParam(req.params), Number(body.amount), body.method, staff(req));
  });

  app.get('/api/admin/merch/stats', need('merch:stats'), async () => merchStats(ctx.db));

  /** Показ витрины, бронь, оплата переводом: продавец управляет мерчем, как админ. */
  app.get('/api/admin/merch-settings', need('merch:stock', 'settings:write'), async () => getMerchSettings(ctx.db));
  app.patch('/api/admin/merch-settings', need('merch:stock', 'settings:write'), async (req) =>
    patchMerchSettings(ctx.db, parse(merchSettingsPatchSchema, req.body), staff(req).user.id),
  );

  app.get('/api/admin/merch/buyers', need('merch:sell'), async (req) =>
    searchBuyers(ctx.db, String((req.query as Record<string, string | undefined>).q ?? '').slice(0, 80)),
  );

  app.get('/api/admin/merch/orders/:id/receipt', need('merch:sell'), async (req, reply) => {
    const r = await orderReceipt(ctx.db, idParam(req.params));
    return reply.header('Content-Type', r.mime).header('Cache-Control', 'private, max-age=600').send(await readStored(PRIVATE_DIR, r.file));
  });

  /** Заказы в Excel - только переданные (отобранные фильтром или отмеченные). */
  app.get('/api/admin/merch/orders/export.xlsx', need('merch:sell'), async (req, reply) => {
    const ids = String((req.query as Record<string, string | undefined>).ids ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 5000);
    if (ids.length === 0) throw badRequest('no_orders', 'Нет заказов для выгрузки');
    const [orders, settings] = await Promise.all([adminOrders(ctx.db, ids), getSettings(ctx.db)]);
    const tz = settings.eventTimezone;
    const wb = new ExcelJS.Workbook();
    const ws = sheet(wb, 'Заказы мерча', [
      { header: 'Код', key: 'code', width: 10 },
      { header: 'Создан', key: 'createdAt', width: 18 },
      { header: 'Покупатель', key: 'userName', width: 24 },
      { header: 'Username', key: 'username', width: 16 },
      { header: 'Состав', key: 'items', width: 46 },
      { header: 'Телефон', key: 'phone', width: 16 },
      { header: 'Сумма, руб.', key: 'total', width: 12 },
      { header: 'Оплачено, руб.', key: 'paid', width: 12 },
      { header: 'Долг, руб.', key: 'debt', width: 11 },
      { header: 'Статус', key: 'status', width: 11 },
      { header: 'Оплата', key: 'method', width: 11 },
      { header: 'Оплачен', key: 'paidAt', width: 18 },
      { header: 'Выдан', key: 'issuedAt', width: 18 },
      { header: 'Чек', key: 'receipt', width: 7 },
      { header: 'Причина отмены', key: 'cancelReason', width: 24 },
    ]);
    for (const k of ['createdAt', 'paidAt', 'issuedAt']) ws.getColumn(k).numFmt = 'dd.mm.yyyy hh:mm';
    for (const k of ['total', 'paid', 'debt']) ws.getColumn(k).numFmt = '0.00';
    for (const o of [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      ws.addRow({
        code: o.code,
        createdAt: excelTime(o.createdAt, tz),
        // Продажа на месте: покупатель - тот, кого записал продавец.
        userName: o.buyerName ?? o.userName,
        username: o.buyerName ? '' : o.username ? `@${o.username}` : '',
        phone: o.buyerPhone ?? '',
        items: o.items.map((i) => `${i.title} × ${i.qty}`).join('; '),
        total: Number(o.total),
        paid: Number(o.paidAmount),
        debt: o.status === 'owed' ? Number(o.total) - Number(o.paidAmount) : '',
        status: STATUS_LABEL[o.status],
        method: o.paymentMethod ? METHOD_LABEL[o.paymentMethod] : '',
        paidAt: o.paidAt ? excelTime(o.paidAt, tz) : '',
        issuedAt: o.issuedAt ? excelTime(o.issuedAt, tz) : '',
        receipt: o.receiptAt ? 'да' : '',
        cancelReason: o.cancelReason ?? '',
      });
    }
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`merch-orders-${new Date().toISOString().slice(0, 10)}.xlsx`)}`)
      .send(Buffer.from(await wb.xlsx.writeBuffer()));
  });
}
