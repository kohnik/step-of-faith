import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminMerchOrderView, AdminMerchProduct, MerchCatalogResponse, MerchOrderView } from '@sof/shared';
import { sign } from '@tma.js/init-data-node';
import { Api } from 'grammy';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { runJob } from '../src/jobs/workers.ts';
import {
  addSize,
  adminOrders,
  adminProducts,
  attachOwnReceipt,
  cancelOwnOrder,
  catalog,
  createOrder,
  createProduct,
  dropUnconfirmed,
  markOrderIssued,
  markOrderPaid,
  ordersToConfirm,
  scanForMerch,
  updateSize,
} from '../src/services/merch.service.ts';
import { createSession } from '../src/services/sessions.service.ts';
import { getMe } from '../src/services/participants.service.ts';
import { getSettings, invalidateSettingsCache, patchSettings } from '../src/services/settings.service.ts';
import type { UserRow } from '../src/services/users.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
let actorId = 0;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
  actorId = (await makeUser(env, 'Настройщик')).id;
});
afterAll(async () => {
  await app?.close();
  await env?.teardown();
});

const setSettings = async (patch: Parameters<typeof patchSettings>[1]) => {
  await patchSettings(env.db, patch, actorId);
  invalidateSettingsCache();
};
const tma = (u: UserRow) => `tma ${sign({ user: { id: u.tgId!, first_name: 'Тест', allows_write_to_pm: true } } as never, env.config.BOT_TOKEN, new Date())}`;
const bearer = async (userId: number) => `Bearer ${(await createSession(env.db, userId, 'web', 1)).token}`;

/** multipart/form-data руками: один файл и поля. */
function multipart(file: { name: string; type: string; data: Buffer }, fields: Record<string, string> = {}) {
  const boundary = `----sof${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Худи: один цвет, размер M - 2 шт. */
async function hoodie(stock = 2) {
  const admin = await makeStaff(env, ['admin'], 'Админ');
  const p = await createProduct(env, { title: 'Худи «Шаг веры»', subtitle: null, descriptionMd: '', price: 60, badge: 'NEW', sort: 0, published: true }, admin);
  const withSize = await addSize(env, p.colors[0]!.id, { size: 'M', stock, sort: 0 }, admin);
  return { admin, product: withSize, variantId: withSize.colors[0]!.sizes[0]!.id };
}

describe('мерч: витрина', () => {
  it('по умолчанию выключена для всех, даже для админов и команды', async () => {
    await hoodie();
    const s = await getSettings(env.db, { fresh: true });
    expect(s).toMatchObject({ merchVisible: false, merchAdminsOnly: true, merchSalesEnabled: false, merchSelfBooking: false });
    for (const roles of [[], ['cashier'], ['admin'], ['superadmin']]) expect((await catalog(env, { roles })).products).toHaveLength(0);
    const admin = await makeStaff(env, ['admin']);
    expect((await getMe(env, admin.user)).features).toMatchObject({ merch: false, merchSales: false });
  });

  it('«только администраторам»: витрину и бронь видят админы, участники и кассиры - нет; без галочки - все', async () => {
    const { variantId } = await hoodie();
    await setSettings({ merchVisible: true, merchAdminsOnly: true, merchSalesEnabled: true, merchSelfBooking: true });
    expect((await catalog(env, { roles: [] })).products).toHaveLength(0);
    expect((await catalog(env, { roles: ['cashier', 'scanner'] })).products).toHaveLength(0);
    const asAdmin = await catalog(env, { roles: ['admin'] });
    expect(asAdmin.products[0]).toMatchObject({ title: 'Худи «Шаг веры»', price: '60.00', available: true });
    expect(asAdmin.sales).toBe(true);
    const admin = await makeStaff(env, ['admin']);
    const user = await makeUser(env);
    expect((await getMe(env, admin.user)).features).toMatchObject({ merch: true, merchSales: true });
    expect((await getMe(env, user)).features).toMatchObject({ merch: false, merchSales: false });
    await expect(createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' })).rejects.toMatchObject({ code: 'sales_closed' });
    expect((await createOrder(env, admin.user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' })).status).toBe('reserved');

    await setSettings({ merchAdminsOnly: false, merchSalesEnabled: false });
    const all = await catalog(env, { roles: [] });
    expect(all.products.length).toBeGreaterThan(0);
    expect(all.sales).toBe(false);
    expect((await getMe(env, user)).features).toMatchObject({ merch: true, merchSales: false });
  });

  it('бронь через продавца: заявка в переписке остатки не трогает, бронь продавца - держит; по заявке второй раз не забронировать', async () => {
    const { variantId } = await hoodie(2);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: false });
    const user = await makeUser(env);
    const left = async () => (await catalog(env, { roles: [] })).products.find((p) => p.colors[0]!.sizes[0]!.id === variantId)!.colors[0]!.sizes[0]!.left;
    expect((await catalog(env, { roles: [] })).selfBooking).toBe(false);
    await expect(createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' })).rejects.toMatchObject({ code: 'booking_by_chat' });

    // Заявка: вещь и размер в сообщении, папка «Мерч», остаток прежний.
    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { authorization: tma(user) },
      payload: { text: 'Можно примерить?', topic: 'merch', items: [{ variantId, qty: 1 }] },
    });
    expect(sent.statusCode).toBe(200);
    const request = sent.json();
    // В тестах несколько вещей «Худи «Шаг веры»» - одинаковое название, поэтому в подписи и цвет.
    expect(request.merch).toMatchObject({ items: [{ variantId, qty: 1, title: expect.stringMatching(/^Худи «Шаг веры».*, M$/), price: '60.00' }], order: null });
    expect(request.merch.items[0].detail).toMatchObject({ product: 'Худи «Шаг веры»', size: 'M', color: expect.any(String), hex: expect.stringMatching(/^#/) });
    expect(request.text).toContain('Хочу забронировать');
    expect(request.text).toContain('Можно примерить?');
    expect(await left()).toBe(2);
    const thread = await env.db.query.supportThreads.findFirst({ where: eq(schema.supportThreads.userId, user.id) });
    expect(thread?.topic).toBe('merch');

    // Продавец бронирует по заявке: остаток уменьшился, человеку - сообщение с кодом, на заявке - бронь.
    const seller = await makeStaff(env, ['seller'], 'Продавец');
    const auth = { authorization: await bearer(seller.user.id) };
    const body = { requestId: randomUUID(), userId: user.id, items: [{ variantId, qty: 1 }], messageId: request.id };
    const reserved = await app.inject({ method: 'POST', url: '/api/admin/merch/reserve', headers: auth, payload: body });
    expect(reserved.statusCode).toBe(200);
    const { order, message } = reserved.json();
    expect(order).toMatchObject({ status: 'reserved', total: '60.00' });
    expect(message.text).toContain(order.code);
    expect(await left()).toBe(1);
    const mine = await app.inject({ method: 'GET', url: '/api/merch/orders', headers: { authorization: tma(user) } });
    expect(mine.json().map((o: MerchOrderView) => o.code)).toContain(order.code);
    const view = await app.inject({ method: 'GET', url: `/api/admin/chats/${user.id}`, headers: auth });
    expect(view.json().messages.find((m: { id: number }) => m.id === request.id).merch.order).toMatchObject({ code: order.code, status: 'reserved' });

    const again = await app.inject({ method: 'POST', url: '/api/admin/merch/reserve', headers: auth, payload: { ...body, requestId: randomUUID() } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'already_reserved' });
    expect(await left()).toBe(1);

    // Бронь отменили - по той же заявке можно забронировать снова.
    await cancelOwnOrder(env, user, order.id);
    const retry = await app.inject({ method: 'POST', url: '/api/admin/merch/reserve', headers: auth, payload: { ...body, requestId: randomUUID() } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().order.code).not.toBe(order.code);
    expect(await left()).toBe(1);

    // Бронь команды «Точно заберёте?» тоже спрашивает; снимать ли без ответа - по настройке.
    const teamOrderId = retry.json().order.id as number;
    expect((await ordersToConfirm(env.db, new Date())).find((o) => o.id === teamOrderId)).toMatchObject({ soft: false });
    expect((await ordersToConfirm(env.db, new Date(), false)).find((o) => o.id === teamOrderId)).toMatchObject({ soft: true });
  });

  it('фото загружается через админку: WebP до 1600 px и превью; не фото и не .glb - отказ', async () => {
    const { admin, product } = await hoodie();
    const auth = await bearer(admin.user.id);
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#d0352c' } }).jpeg().toBuffer();
    const body = multipart({ name: 'hoodie.jpg', type: 'image/jpeg', data: big }, { colorId: String(product.colors[0]!.id) });
    const ok = await app.inject({ method: 'POST', url: `/api/admin/merch/${product.id}/media`, payload: body.payload, headers: { ...body.headers, authorization: auth } });
    expect(ok.statusCode).toBe(200);
    const updated = ok.json() as AdminMerchProduct;
    const photo = updated.media.at(-1)!;
    expect(photo).toMatchObject({ kind: 'photo', width: 1600, height: 1067, colorId: product.colors[0]!.id });
    expect(photo.url).toMatch(/^\/media\/merch\/[0-9a-f]{20}\.webp$/);
    expect(existsSync(join(env.config.MEDIA_DIR, photo.url.replace('/media/', '')))).toBe(true);

    const glb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(40)]);
    const model = multipart({ name: 'hoodie.glb', type: 'application/octet-stream', data: glb });
    const m = await app.inject({ method: 'POST', url: `/api/admin/merch/${product.id}/media`, payload: model.payload, headers: { ...model.headers, authorization: auth } });
    expect(m.statusCode).toBe(200);
    expect((m.json() as AdminMerchProduct).media.at(-1)).toMatchObject({ kind: 'model' });

    const fake = multipart({ name: 'virus.glb', type: 'application/octet-stream', data: Buffer.from('MZ not a model at all') });
    const bad = await app.inject({ method: 'POST', url: `/api/admin/merch/${product.id}/media`, payload: fake.payload, headers: { ...fake.headers, authorization: auth } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'bad_model' });

    // Участнику загрузка недоступна.
    const user = await makeUser(env);
    const denied = await app.inject({ method: 'POST', url: `/api/admin/merch/${product.id}/media`, payload: body.payload, headers: { ...body.headers, authorization: tma(user) } });
    expect(denied.statusCode).toBe(401);
  });
});

describe('мерч: обложка и фото по цветам', () => {
  it('до 10 фото на обложку и на каждый цвет; 11-е - отказ; новая 3D-модель заменяет прежнюю', async () => {
    const { admin, product } = await hoodie();
    const auth = await bearer(admin.user.id);
    const colorId = product.colors[0]!.id;
    const upload = async (file: { name: string; type: string; data: Buffer }, color: number | null) => {
      const body = multipart(file, color === null ? {} : { colorId: String(color) });
      return app.inject({ method: 'POST', url: `/api/admin/merch/${product.id}/media`, payload: body.payload, headers: { ...body.headers, authorization: auth } });
    };
    const photo = async (i: number) => ({
      name: `p${i}.png`,
      type: 'image/png',
      data: await sharp({ create: { width: 40, height: 50, channels: 3, background: { r: i * 20, g: 10, b: 10 } } }).png().toBuffer(),
    });
    for (let i = 0; i < 10; i++) expect((await upload(await photo(i), null)).statusCode).toBe(200);
    const eleventh = await upload(await photo(11), null);
    expect(eleventh.statusCode).toBe(400);
    expect(eleventh.json()).toMatchObject({ error: 'too_many_photos' });
    // У цвета - свои 10.
    const forColor = await upload(await photo(12), colorId);
    expect(forColor.statusCode).toBe(200);
    expect((forColor.json() as AdminMerchProduct).media.filter((m) => m.colorId === colorId)).toHaveLength(1);

    const glb = (n: number) => ({ name: `m${n}.glb`, type: 'application/octet-stream', data: Buffer.concat([Buffer.from('glTF'), Buffer.alloc(40 + n)]) });
    await upload(glb(1), colorId);
    const second = (await upload(glb(2), colorId)).json() as AdminMerchProduct;
    const models = second.media.filter((m) => m.kind === 'model' && m.colorId === colorId);
    expect(models).toHaveLength(1);
    expect(models[0]!.bytes).toBe(46);
  });
});

describe('мерч: редактор сохраняет всё одной кнопкой', () => {
  const save = async (auth: string, body: unknown) => app.inject({ method: 'POST', url: '/api/admin/merch/save', payload: body as object, headers: { authorization: auth } });
  const uploadFile = async (auth: string, file: { name: string; type: string; data: Buffer }) => {
    const body = multipart(file);
    const res = await app.inject({ method: 'POST', url: '/api/admin/merch/uploads', payload: body.payload, headers: { ...body.headers, authorization: auth } });
    expect(res.statusCode).toBe(200);
    return res.json() as { file: string; kind: string; thumbUrl: string | null };
  };
  const png = (r: number) => sharp({ create: { width: 30, height: 40, channels: 3, background: { r, g: 0, b: 0 } } }).png().toBuffer();

  it('новая вещь целиком: цвета, размеры, обложка и фото цвета; потом порядок, обмен размеров и удаление', async () => {
    const admin = await makeStaff(env, ['admin'], 'Редактор');
    const auth = await bearer(admin.user.id);
    const red = await uploadFile(auth, { name: 'red.png', type: 'image/png', data: await png(200) });
    const white = await uploadFile(auth, { name: 'white.png', type: 'image/png', data: await png(250) });
    const model = await uploadFile(auth, { name: 'tee.glb', type: 'application/octet-stream', data: Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60)]) });
    expect(red).toMatchObject({ kind: 'photo' });
    expect(model).toMatchObject({ kind: 'model', thumbUrl: null });
    // Загрузка сама ничего не привязывает.
    expect((await adminProducts(env.db)).flatMap((p) => p.media).some((m) => m.url === `/media/${red.file}`)).toBe(false);

    const base = { title: 'Футболка', subtitle: null, descriptionMd: '', price: 25, badge: null, sort: 5, published: true };
    const created = await save(auth, {
      ...base,
      id: null,
      colors: [
        { id: null, key: 'a', name: 'Красный', hex: '#d0352c', sizes: [{ id: null, size: 'M', stock: 3 }, { id: null, size: 'L', stock: 1 }] },
        { id: null, key: 'b', name: 'Белый', hex: '#ffffff', sizes: [{ id: null, size: 'M', stock: 2 }] },
      ],
      media: [
        { id: null, file: red.file, color: null },
        { id: null, file: white.file, color: 'b' },
        { id: null, file: model.file, color: 'a' },
      ],
    });
    expect(created.statusCode).toBe(200);
    const p = created.json() as AdminMerchProduct;
    expect(p.colors.map((c) => [c.name, c.sizes.map((s) => `${s.size}:${s.stock}`)])).toEqual([
      ['Красный', ['M:3', 'L:1']],
      ['Белый', ['M:2']],
    ]);
    const [redC, whiteC] = p.colors;
    expect(p.media.map((m) => [m.kind, m.colorId])).toEqual([
      ['photo', null],
      ['photo', whiteC!.id],
      ['model', redC!.id],
    ]);
    expect(p.media[0]).toMatchObject({ width: 30, height: 40 });

    // Бронь на красный M: удалить его нельзя, остаток ниже заказанного - тоже.
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true });
    const buyer = await makeUser(env);
    await createOrder(env, buyer, { requestId: randomUUID(), items: [{ variantId: redC!.sizes[0]!.id, qty: 2 }], paymentMethod: 'cash' });
    const sizesOf = (c: typeof redC) => c!.sizes.map((s) => ({ id: s.id, size: s.size, stock: s.stock }));
    const colorsNow = (over: Partial<Record<'red' | 'white', unknown>> = {}) => [
      { id: redC!.id, key: 'a', name: 'Красный', hex: '#d0352c', sizes: over.red ?? sizesOf(redC) },
      { id: whiteC!.id, key: 'b', name: 'Белый', hex: '#ffffff', sizes: over.white ?? sizesOf(whiteC) },
    ];
    const mediaNow = p.media.map((m) => ({ id: m.id, file: null, color: m.colorId === redC!.id ? 'a' : m.colorId === whiteC!.id ? 'b' : null }));
    const gone = await save(auth, { ...base, id: p.id, colors: colorsNow({ red: [sizesOf(redC)[1]] }), media: mediaNow });
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toMatchObject({ error: 'has_orders' });
    const low = await save(auth, { ...base, id: p.id, colors: colorsNow({ red: [{ ...sizesOf(redC)[0], stock: 1 }, sizesOf(redC)[1]] }), media: mediaNow });
    expect(low.json()).toMatchObject({ error: 'stock_below_orders' });
    const tooMany = await save(auth, { ...base, id: p.id, colors: colorsNow(), media: [...mediaNow, { id: null, file: model.file, color: 'a' }] });
    expect(tooMany.json()).toMatchObject({ error: 'model_exists' });
    // Ничего из отклонённого не применилось.
    expect((await adminProducts(env.db, [p.id]))[0]!.colors[0]!.sizes).toHaveLength(2);

    // Обмен названий M↔L, новое фото первым в обложке, белое фото удаляем, белый цвет удаляем - одним сохранением.
    const swapped = await save(auth, {
      ...base,
      title: 'Футболка «Верой»',
      published: false,
      id: p.id,
      colors: [{ id: redC!.id, key: 'a', name: 'Алый', hex: '#ff0000', sizes: [{ id: redC!.sizes[0]!.id, size: 'L', stock: 5 }, { id: redC!.sizes[1]!.id, size: 'M', stock: 0 }] }],
      media: [{ id: null, file: white.file, color: null }, mediaNow[0], mediaNow[2]],
    });
    expect(swapped.statusCode).toBe(200);
    const after = swapped.json() as AdminMerchProduct;
    expect(after).toMatchObject({ title: 'Футболка «Верой»', published: false });
    expect(after.colors).toHaveLength(1);
    expect(after.colors[0]).toMatchObject({ name: 'Алый', hex: '#ff0000' });
    expect(after.colors[0]!.sizes.map((s) => `${s.size}:${s.stock}:${s.reserved}`)).toEqual(['L:5:2', 'M:0:0']);
    expect(after.media.map((m) => [m.url, m.colorId])).toEqual([
      [`/media/${white.file}`, null],
      [`/media/${red.file}`, null],
      [`/media/${model.file}`, redC!.id],
    ]);
    // Белое фото осталось (оно же - новая обложка), файлы на месте.
    expect(existsSync(join(env.config.MEDIA_DIR, white.file))).toBe(true);

    // Чужой id и несуществующий файл - отказ.
    const stale = await save(auth, { ...base, id: p.id, colors: [{ id: 999999, key: 'a', name: 'X', hex: '#000000', sizes: [] }], media: [] });
    expect(stale.statusCode).toBe(409);
    const missing = await save(auth, { ...base, id: p.id, colors: colorsNow().slice(0, 1), media: [{ id: null, file: 'merch/00000000000000000000.webp', color: null }] });
    expect(missing.json()).toMatchObject({ error: 'file_missing' });
    const denied = await save(tma(buyer), { ...base, id: p.id, colors: colorsNow().slice(0, 1), media: [] });
    expect(denied.statusCode).toBe(401);
  });

  it('удалённое фото, на которое больше никто не ссылается, удаляется с диска', async () => {
    const admin = await makeStaff(env, ['admin'], 'Редактор 2');
    const auth = await bearer(admin.user.id);
    const only = await uploadFile(auth, { name: 'only.png', type: 'image/png', data: await png(77) });
    const base = { title: 'Кепка', subtitle: null, descriptionMd: '', price: 10, badge: null, sort: 0, published: false };
    const color = { id: null, key: 'x', name: 'Основной', hex: '#111111', sizes: [{ id: null, size: 'One', stock: 0 }] };
    const p = (await save(auth, { ...base, id: null, colors: [color], media: [{ id: null, file: only.file, color: null }] })).json() as AdminMerchProduct;
    expect(existsSync(join(env.config.MEDIA_DIR, only.file))).toBe(true);
    const res = await save(auth, { ...base, id: p.id, colors: [{ ...color, id: p.colors[0]!.id, sizes: [{ id: p.colors[0]!.sizes[0]!.id, size: 'One', stock: 0 }] }], media: [] });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(env.config.MEDIA_DIR, only.file))).toBe(false);
  });
});

describe('мерч: бронь и продажа', () => {
  it('пока продажа выключена - бронь закрыта', async () => {
    const { variantId } = await hoodie();
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: false });
    const user = await makeUser(env);
    await expect(createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' })).rejects.toMatchObject({
      code: 'sales_closed',
    });
  });

  it('последнюю вещь забирает один; повтор запроса не создаёт второй заказ; остаток не ниже заказанного', async () => {
    const { admin, variantId } = await hoodie(1);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true, merchReservationHours: 48 });
    const [a, b] = [await makeUser(env), await makeUser(env)];
    const results = await Promise.allSettled([
      createOrder(env, a, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' }),
      createOrder(env, b, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'sold_out' });

    const c = await makeUser(env);
    const { variantId: v2 } = await hoodie(3);
    const requestId = randomUUID();
    const first = await createOrder(env, c, { requestId, items: [{ variantId: v2, qty: 2 }], paymentMethod: 'transfer' });
    const again = await createOrder(env, c, { requestId, items: [{ variantId: v2, qty: 2 }], paymentMethod: 'transfer' });
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: 'reserved', total: '120.00', paymentMethod: 'transfer' });
    expect(first.code).toMatch(/^M-\d{4,5}$/);
    expect(first.expiresAt).not.toBeNull();
    await expect(updateSize(env, v2, { stock: 1 }, admin)).rejects.toMatchObject({ code: 'stock_below_orders' });
    const [p] = (await adminProducts(env.db)).filter((x) => x.colors[0]!.sizes[0]!.id === v2);
    expect(p!.colors[0]!.sizes[0]).toMatchObject({ stock: 3, reserved: 2, left: 1 });
  });

  it('истёкшая бронь возвращает вещь; оплаченную - не трогает; на кассе: оплатить и выдать', async () => {
    const { admin, variantId } = await hoodie(2);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true, merchReservationHours: 1 });
    const user = await makeUser(env);
    const o1 = await createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' });
    const o2 = await createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' });
    await markOrderPaid(env, o2.id, 'cash', admin);
    // Срок прошёл.
    await env.db.update(schema.merchOrders).set({ expiresAt: new Date(Date.now() - 1000) });
    await runJob(env, 'merch.expire', { orderId: o1.id });
    await runJob(env, 'merch.expire', { orderId: o2.id });
    const status = async (id: number) => (await env.db.query.merchOrders.findFirst({ where: eq(schema.merchOrders.id, id) }))!.status;
    expect(await status(o1.id)).toBe('expired');
    expect(await status(o2.id)).toBe('paid');
    await expect(markOrderPaid(env, o1.id, 'cash', admin)).rejects.toMatchObject({ code: 'not_reserved' });
    expect((await markOrderIssued(env, o2.id, null, admin)).status).toBe('issued');

    // Неоплаченную бронь на месте - сразу «оплачено и выдано», но со способом оплаты.
    const o3: MerchOrderView = await createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' });
    await expect(markOrderIssued(env, o3.id, null, admin)).rejects.toMatchObject({ code: 'method_required' });
    expect(await markOrderIssued(env, o3.id, 'card', admin)).toMatchObject({ status: 'issued', paymentMethod: 'card' });
  });

  it('чек перевода - из приложения в закрытую папку; админ его открывает, участник - нет', async () => {
    const { admin, variantId } = await hoodie(3);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true, transfersEnabled: true });
    const user = await makeUser(env);
    const order = await createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'transfer' });
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    const body = multipart({ name: 'чек.png', type: 'image/png', data: png });
    const res = await app.inject({ method: 'POST', url: `/api/merch/orders/${order.id}/receipt`, payload: body.payload, headers: { ...body.headers, authorization: tma(user) } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MerchOrderView).receiptAt).not.toBeNull();
    const pdfLike = multipart({ name: 'x.exe', type: 'application/octet-stream', data: Buffer.from('MZ....') });
    const bad = await app.inject({ method: 'POST', url: `/api/merch/orders/${order.id}/receipt`, payload: pdfLike.payload, headers: { ...pdfLike.headers, authorization: tma(user) } });
    expect(bad.json()).toMatchObject({ error: 'bad_file' });
    const file = await app.inject({ method: 'GET', url: `/api/admin/merch/orders/${order.id}/receipt`, headers: { authorization: await bearer(admin.user.id) } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    const denied = await app.inject({ method: 'GET', url: `/api/admin/merch/orders/${order.id}/receipt`, headers: { authorization: tma(user) } });
    expect(denied.statusCode).toBe(401);
  });

  it('«Оплата переводом в приложении» выключена: только бронь, перевод и чек - отказ; включили - снова можно', async () => {
    const { variantId } = await hoodie(3);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true, transfersEnabled: true, merchOnlinePayment: false });
    const user = await makeUser(env);
    const cat = await app.inject({ method: 'GET', url: '/api/merch', headers: { authorization: tma(user) } });
    expect((cat.json() as MerchCatalogResponse).paymentInstructions).toBe('');
    const order = await createOrder(env, user, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'transfer' });
    expect(order.paymentMethod).toBe('cash');
    const method = await app.inject({ method: 'POST', url: `/api/merch/orders/${order.id}/method`, payload: { method: 'transfer' }, headers: { authorization: tma(user) } });
    expect(method.json()).toMatchObject({ error: 'transfers_disabled' });
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    const body = multipart({ name: 'чек.png', type: 'image/png', data: png });
    const receipt = await app.inject({ method: 'POST', url: `/api/merch/orders/${order.id}/receipt`, payload: body.payload, headers: { ...body.headers, authorization: tma(user) } });
    expect(receipt.json()).toMatchObject({ error: 'transfers_disabled' });

    await setSettings({ merchOnlinePayment: true });
    const again = await app.inject({ method: 'GET', url: '/api/merch', headers: { authorization: tma(user) } });
    expect((again.json() as MerchCatalogResponse).paymentInstructions).not.toBe('');
    const ok = await app.inject({ method: 'POST', url: `/api/merch/orders/${order.id}/method`, payload: { method: 'transfer' }, headers: { authorization: tma(user) } });
    expect(ok.json()).toMatchObject({ paymentMethod: 'transfer' });
  });

  it('выдача по QR-коду участника: человек, взнос и его брони; чужие и снятые - нет; только продавцу', async () => {
    const { variantId } = await hoodie(5);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true });
    const parent = await makeUser(env);
    const { participant: kid } = await makeParticipant(env, parent, { firstName: 'Петя' });
    const mine = await createOrder(env, parent, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' });
    const dropped = await createOrder(env, parent, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' });
    await cancelOwnOrder(env, parent, dropped.id);
    await createOrder(env, await makeUser(env), { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' });
    const ticket = (await env.db.query.tickets.findFirst({ where: eq(schema.tickets.participantId, kid.id) }))!;

    const r = await scanForMerch(env.db, ticket.code);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.card).toMatchObject({ id: kid.id, paymentStatus: 'paid' });
    expect(r.orders.map((o) => o.id)).toEqual([mine.id]);
    expect(await scanForMerch(env.db, 'not-a-ticket')).toMatchObject({ found: false });

    const seller = await makeStaff(env, ['seller'], 'Продавец');
    const ok = await app.inject({ method: 'POST', url: '/api/admin/merch/scan', payload: { code: ticket.code }, headers: { authorization: await bearer(seller.user.id) } });
    expect(ok.statusCode).toBe(200);
    const scanner = await makeStaff(env, ['scanner'], 'Сканер');
    const denied = await app.inject({ method: 'POST', url: '/api/admin/merch/scan', payload: { code: ticket.code }, headers: { authorization: await bearer(scanner.user.id) } });
    expect(denied.statusCode).toBe(403);
  });

  it('настройки мерча: продавец их меняет, как админ; чужие поля и общие настройки - нет; сканеру - отказ', async () => {
    await setSettings({ merchVisible: false, merchSalesEnabled: false, eventName: 'Шаг веры 2026' });
    const seller = await makeStaff(env, ['seller'], 'Продавец');
    const auth = { authorization: await bearer(seller.user.id) };
    const view = await app.inject({ method: 'GET', url: '/api/admin/merch-settings', headers: auth });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ merchVisible: false, merchSalesEnabled: false, transfersEnabled: expect.any(Boolean) });
    expect(view.json()).not.toHaveProperty('eventName');

    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/admin/merch-settings',
      headers: auth,
      payload: { merchVisible: true, merchSalesEnabled: true, merchSelfBooking: true, merchReservationHours: 24 },
    });
    expect(saved.statusCode).toBe(200);
    const s = await getSettings(env.db, { fresh: true });
    expect(s).toMatchObject({ merchVisible: true, merchSalesEnabled: true, merchSelfBooking: true, merchReservationHours: 24, eventName: 'Шаг веры 2026' });

    const foreign = await app.inject({ method: 'PATCH', url: '/api/admin/merch-settings', headers: auth, payload: { eventName: 'Взлом' } });
    expect(foreign.statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth, payload: { merchVisible: false } })).statusCode).toBe(403);
    const scanner = await makeStaff(env, ['scanner'], 'Сканер');
    expect((await app.inject({ method: 'GET', url: '/api/admin/merch-settings', headers: { authorization: await bearer(scanner.user.id) } })).statusCode).toBe(403);
  });

  it('«точно заберёте?» во время из настроек: всем с бронью, ответ - до срока; молчание снимает бронь, подтверждённую раньше - нет', async () => {
    const { variantId, admin } = await hoodie(6);
    const at = new Date(Date.now() - 60_000);
    await setSettings({
      merchVisible: true,
      merchAdminsOnly: false,
      merchSalesEnabled: true,
      merchSelfBooking: true,
      merchReservationHours: null,
      merchConfirmAt: at.toISOString(),
      merchConfirmHours: 3,
    });
    const [yes, silent, before] = [await makeUser(env), await makeUser(env), await makeUser(env)];
    const order = (u: UserRow) => createOrder(env, u, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'cash' });
    const [oYes, oSilent, oBefore] = [await order(yes), await order(silent), await order(before)];
    const paid = await order(yes);
    await markOrderPaid(env, paid.id, 'cash', admin);
    // Подтвердил ещё на прошлом вопросе - теперь только напоминаем, бронь не снимаем.
    await env.db.update(schema.merchOrders).set({ confirmedAt: new Date(at.getTime() - 3600_000) }).where(eq(schema.merchOrders.id, oBefore.id));

    const sent: { chat: number; text: string; buttons: string[] }[] = [];
    const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
    tg.config.use(async (_prev, method, payload) => {
      const p = payload as { chat_id: number; text: string; reply_markup?: { inline_keyboard: { callback_data?: string }[][] } };
      if (method === 'sendMessage') sent.push({ chat: p.chat_id, text: p.text, buttons: (p.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '') });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' }, text: '' } } as never;
    });
    // Время подошло - «тик» ставит вопрос один раз на это время.
    await runJob({ ...env, tg }, 'merch.confirm_tick', {});
    await runJob({ ...env, tg }, 'merch.confirm_tick', {});
    const jobs = await env.pool.query(`select data from pgboss.job where name = 'merch.confirm_ask'`);
    expect(jobs.rows.map((r) => r.data)).toEqual([{ at: at.toISOString() }]);

    await runJob({ ...env, tg }, 'merch.confirm_ask', { at: at.toISOString() });
    const until = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Minsk', hour: '2-digit', minute: '2-digit' }).format(new Date(at.getTime() + 3 * 3600_000));
    const asks = sent.filter((m) => m.buttons.length > 0);
    expect(asks.map((m) => m.buttons.slice(0, 2))).toEqual(
      expect.arrayContaining([
        [`v1:mcy:${oYes.id}`, `v1:mcn:${oYes.id}`],
        [`v1:mcy:${oSilent.id}`, `v1:mcn:${oSilent.id}`],
        [`v1:mcy:${oBefore.id}`, `v1:mcn:${oBefore.id}`],
      ]),
    );
    expect(asks.find((m) => m.chat === silent.tgId)!.text).toContain(`до ${until} - иначе бронь снимется`);
    expect(asks.find((m) => m.chat === before.tgId)!.text).not.toContain('снимется');
    // Оплаченный, но не забранный заказ - напоминание забрать.
    expect(sent.find((m) => m.text.includes(paid.code))!.text).toContain('оплачен и ждёт вас');
    const total = sent.length;
    // Второй прогон на то же время никого не дёргает.
    await runJob({ ...env, tg }, 'merch.confirm_ask', { at: at.toISOString() });
    expect(sent).toHaveLength(total);

    const view = (await app.inject({ method: 'GET', url: '/api/merch/orders', headers: { authorization: tma(yes) } })).json() as MerchOrderView[];
    expect(view.find((o) => o.id === oYes.id)).toMatchObject({ confirmBy: new Date(at.getTime() + 3 * 3600_000).toISOString(), confirmDrops: true });
    const ok = await app.inject({ method: 'POST', url: `/api/merch/orders/${oYes.id}/confirm`, headers: { authorization: tma(yes) } });
    expect(ok.json()).toMatchObject({ status: 'reserved', confirmBy: null });

    const asked = async (id: number) => (await env.db.query.merchOrders.findFirst({ where: eq(schema.merchOrders.id, id) }))!;
    expect(await dropUnconfirmed(env, oYes.id, (await asked(oYes.id)).confirmAskedAt!.toISOString())).toBe(false);
    expect(await dropUnconfirmed(env, oBefore.id, (await asked(oBefore.id)).confirmAskedAt!.toISOString())).toBe(false);
    expect(await dropUnconfirmed(env, oSilent.id, (await asked(oSilent.id)).confirmAskedAt!.toISOString())).toBe(true);
    expect((await asked(oSilent.id)).status).toBe('cancelled');
    expect((await asked(oBefore.id)).status).toBe('reserved');
    expect((await asked(paid.id)).confirmAskedAt).toBeNull();
  });

  it('чек за мерч: продавцам - в бот, в заказах «чек на проверке»; продавец принимает или отклоняет без доступа к «Чекам»', async () => {
    const { variantId } = await hoodie(3);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true });
    const seller = await makeStaff(env, ['seller'], 'Продавец');
    const buyer = await makeUser(env);
    const order = await createOrder(env, buyer, { requestId: randomUUID(), items: [{ variantId, qty: 1 }], paymentMethod: 'transfer' });
    await attachOwnReceipt(env, buyer, order.id, { file: 'merch-receipts/test.jpg', mime: 'image/jpeg' });
    const notify = (await env.pool.query(`select data from pgboss.job where name = 'merch.receipt_notify'`)).rows.map((r) => r.data);
    expect(notify.length).toBeGreaterThan(0);
    const [view] = await adminOrders(env.db, [order.id]);
    expect(view!.receipt).toMatchObject({ files: 1, mime: 'image/jpeg' });
    const receiptId = view!.receipt!.id;

    const auth = { authorization: await bearer(seller.user.id) };
    // В общие «Чеки» продавцу нельзя, в чек за мерч - можно.
    expect((await app.inject({ method: 'POST', url: `/api/admin/receipts/${receiptId}/accept`, headers: auth, payload: {} })).statusCode).toBe(403);
    const rejected = await app.inject({ method: 'POST', url: `/api/admin/merch/receipts/${receiptId}/reject`, headers: auth, payload: { reason: 'сумма не та' } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'reserved', receipt: null });

    // Прислали новый - принимаем: бронь оплачена.
    await attachOwnReceipt(env, buyer, order.id, { file: 'merch-receipts/test2.jpg', mime: 'image/jpeg' });
    const again = (await adminOrders(env.db, [order.id]))[0]!.receipt!;
    const accepted = await app.inject({ method: 'POST', url: `/api/admin/merch/receipts/${again.id}/accept`, headers: auth, payload: {} });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'paid', paymentMethod: 'transfer', receipt: null });
  });

  it('продажа в долг на участника: долг виден ему в «Моих заказах» (а не продавцу), в бот - что взял и сколько вернуть', async () => {
    const { variantId } = await hoodie(3);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true });
    const seller = await makeStaff(env, ['seller'], 'Продавец');
    const buyer = await makeUser(env);
    const { participant } = await makeParticipant(env, buyer);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/merch/sell',
      headers: { authorization: await bearer(seller.user.id) },
      payload: { requestId: randomUUID(), items: [{ variantId, qty: 1 }], method: 'cash', debt: true, paidNow: '20', buyerParticipantId: participant.id },
    });
    expect(res.json()).not.toHaveProperty('error');
    const sale = res.json() as AdminMerchOrderView;
    expect(sale.status).toBe('owed');
    const mine = (await app.inject({ method: 'GET', url: '/api/merch/orders', headers: { authorization: tma(buyer) } })).json() as MerchOrderView[];
    expect(mine.map((o) => o.id)).toContain(sale.id);
    expect(mine.find((o) => o.id === sale.id)).toMatchObject({ status: 'owed', paidAmount: '20.00', total: '60.00' });
    const sellers = (await app.inject({ method: 'GET', url: '/api/merch/orders', headers: { authorization: tma(seller.user) } })).json() as MerchOrderView[];
    expect(sellers.map((o) => o.id)).not.toContain(sale.id);
    const notes = (await env.pool.query(`select data from pgboss.job where name = 'notify.text'`)).rows.map((r) => r.data).filter((d) => d.userId === buyer.id);
    const debt = notes.find((d) => String(d.text).includes('Мерч взят в долг'));
    expect(debt?.text).toContain('Осталось оплатить: 40');

    // Вернул долг - и об этом сообщение.
    const repaid = await app.inject({ method: 'POST', url: `/api/admin/merch/orders/${sale.id}/repay`, headers: { authorization: await bearer(seller.user.id) }, payload: { amount: '40', method: 'cash' } });
    expect(repaid.statusCode).toBe(200);
    const after = (await env.pool.query(`select data from pgboss.job where name = 'notify.text'`)).rows.map((r) => r.data).filter((d) => d.userId === buyer.id);
    expect(after.some((d) => String(d.text).includes('оплачен полностью'))).toBe(true);
  });

  it('продажа на месте: сразу «выдано», остаток уменьшается, в ответе - полная строка для админки', async () => {
    const { admin, variantId } = await hoodie(2);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/merch/sell',
      headers: { authorization: await bearer(admin.user.id) },
      payload: { requestId: randomUUID(), items: [{ variantId, qty: 2 }], method: 'card' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'issued', paymentMethod: 'card', note: 'Продажа на месте', userName: expect.any(String), total: '120.00' });
    const [p] = (await adminProducts(env.db)).filter((x) => x.colors[0]!.sizes[0]!.id === variantId);
    expect(p!.colors[0]!.sizes[0]).toMatchObject({ issued: 2, left: 0 });
    const more = await app.inject({
      method: 'POST',
      url: '/api/admin/merch/sell',
      headers: { authorization: await bearer(admin.user.id) },
      payload: { requestId: randomUUID(), items: [{ variantId, qty: 1 }], method: 'cash' },
    });
    expect(more.json()).toMatchObject({ error: 'sold_out' });
  });

  it('участник бронирует и отменяет через API; витрина показывает остаток', async () => {
    const { variantId } = await hoodie(5);
    await setSettings({ merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchSelfBooking: true });
    const user = await makeUser(env);
    const res = await app.inject({
      method: 'POST',
      url: '/api/merch/orders',
      headers: { authorization: tma(user) },
      payload: { requestId: randomUUID(), items: [{ variantId, qty: 2 }], paymentMethod: 'cash' },
    });
    expect(res.statusCode).toBe(200);
    const order = res.json() as MerchOrderView;
    const cat = (await app.inject({ method: 'GET', url: '/api/merch', headers: { authorization: tma(user) } })).json() as MerchCatalogResponse;
    const size = cat.products.flatMap((p) => p.colors.flatMap((c) => c.sizes)).find((s) => s.id === variantId)!;
    expect(size.left).toBe(3);
    const cancel = await app.inject({ method: 'POST', url: `/api/merch/orders/${order.id}/cancel`, headers: { authorization: tma(user) } });
    expect((cancel.json() as MerchOrderView).status).toBe('cancelled');
    const mine = (await app.inject({ method: 'GET', url: '/api/merch/orders', headers: { authorization: tma(user) } })).json() as MerchOrderView[];
    expect(mine).toHaveLength(1);
  });
});
