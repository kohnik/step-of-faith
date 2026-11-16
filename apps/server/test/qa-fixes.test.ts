import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, registrationSubmitSchema, settingsSchema, type CheckInEvent } from '@sof/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { SESSION_COOKIE } from '../src/api/auth.ts';
import { schema } from '../src/db/client.ts';
import { bulkUpdate, exportSeminarBlockXlsx } from '../src/services/admin.service.ts';
import ExcelJS from 'exceljs';
import { createActivity, getActivityView, listActivities, registerForActivity, updateActivity } from '../src/services/activity.service.ts';
import { bookCounseling, createCounselor, publicCounseling, updateCounselor } from '../src/services/counseling.service.ts';
import { buildManifest, processCheckIns, revokeCheckInByEvent } from '../src/services/checkin.service.ts';
import { wipeDatabase } from '../src/services/dev.service.ts';
import { confirmReceipt, createReceipt, markPaid, reviewReceipt, undoPayment } from '../src/services/payment.service.ts';
import { createBlock, createTopic, getBlock, listRooms, publicSeminars, publishSeminars, updateBlock } from '../src/services/seminar.service.ts';
import { createSession } from '../src/services/sessions.service.ts';
import { getSettings, invalidateSettingsCache, isBeforeEvent, patchSettings } from '../src/services/settings.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let actorId = 0;
beforeAll(async () => {
  env = await setupTestEnv();
  actorId = (await makeUser(env, 'Настройщик')).id;
});
afterAll(async () => env?.teardown());

const row = async (id: number) => (await env.db.query.participants.findFirst({ where: eq(schema.participants.id, id) }))!;
const file = () => ({ fileId: randomUUID(), fileUniqueId: randomUUID(), kind: 'photo' as const });

describe('оплаты', () => {
  it('смена цены варианта: ручное «без взноса» и скидка не трогаются, частичная - от внесённого, цена с копейками', async () => {
    const owner = await makeUser(env);
    const s = await getSettings(env.db, { fresh: true });
    const old = s.tiers.fee35.amount.toFixed(2);
    const volunteer = (await makeParticipant(env, owner, { tier: 'fee35', paymentStatus: 'exempt', amountDue: old })).participant;
    const discount = (await makeParticipant(env, owner, { tier: 'fee35', paymentStatus: 'unpaid', amountDue: '20.00' })).participant;
    const regular = (await makeParticipant(env, owner, { tier: 'fee35', paymentStatus: 'unpaid', amountDue: old })).participant;
    const partial = (await makeParticipant(env, owner, { tier: 'fee35', paymentStatus: 'partial', amountDue: old, amountPaid: '30.00' }))
      .participant;
    await patchSettings(env.db, { tiers: { ...s.tiers, fee35: { ...s.tiers.fee35, amount: 30.5 } } }, actorId);
    expect((await row(volunteer.id)).paymentStatus).toBe('exempt');
    expect((await row(discount.id)).amountDue).toBe('20.00');
    expect(await row(regular.id)).toMatchObject({ amountDue: '30.50', paymentStatus: 'unpaid' });
    expect(await row(partial.id)).toMatchObject({ amountDue: '30.50', paymentStatus: 'partial' });
    await patchSettings(env.db, { tiers: s.tiers }, actorId);
    invalidateSettingsCache();
  });

  it('касса не принимает сумму больше остатка; отмена после чужого приёма - 409', async () => {
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '35.00' });
    const a = await makeStaff(env, ['cashier'], 'Кассир А');
    const b = await makeStaff(env, ['cashier'], 'Кассир Б');
    await expect(markPaid(env, a, { participantIds: [p.id], method: 'cash', amount: '50', note: null })).rejects.toMatchObject({ code: 'overpay' });
    await markPaid(env, a, { participantIds: [p.id], method: 'cash', amount: '10', note: null });
    await markPaid(env, b, { participantIds: [p.id], method: 'cash', amount: '5', note: null });
    // Кассир А отменяет - но после него принимал Б: А уже не последний.
    await expect(undoPayment(env, a, p.id)).rejects.toMatchObject({ statusCode: 403 });
    await undoPayment(env, b, p.id);
    expect(await row(p.id)).toMatchObject({ paymentStatus: 'partial', amountPaid: '10.00' });
  });

  it('чек: за нескольких сумма меньше нужной - 400; оплатившие наличными не зачисляются; без живого чека «на проверке» не возвращается', async () => {
    const owner = await makeUser(env);
    const admin = await makeStaff(env, ['admin']);
    const cashier = await makeStaff(env, ['cashier']);
    const p1 = (await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '35.00', paymentMethod: 'transfer' })).participant;
    const p2 = (await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '45.00', paymentMethod: 'transfer' })).participant;
    const draft = await createReceipt(env, owner, file());
    expect(draft.status).toBe('draft');
    await confirmReceipt(env, owner, (draft as { receiptId: number }).receiptId);
    const receiptId = (draft as { receiptId: number }).receiptId;
    await expect(reviewReceipt(env, receiptId, admin, 'accept', { amount: '35' })).rejects.toMatchObject({ code: 'amount_too_small' });

    // Один из двоих заплатил наличными, пока чек ждал проверки, - зачисляем только второму.
    await markPaid(env, cashier, { participantIds: [p1.id], method: 'cash', amount: null, note: null });
    await reviewReceipt(env, receiptId, admin, 'accept', {});
    expect(await row(p1.id)).toMatchObject({ paymentStatus: 'paid', amountPaid: '35.00' });
    expect(await row(p2.id)).toMatchObject({ paymentStatus: 'paid', amountPaid: '45.00' });

    // Наличные при чеке на проверке, чек отклонили, кассир отменил приём - не «на проверке» навсегда.
    const p3 = (await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '35.00' })).participant;
    const single = await createReceipt(env, owner, file());
    expect(single.status).toBe('sent');
    await markPaid(env, cashier, { participantIds: [p3.id], method: 'cash', amount: null, note: null });
    await expect(reviewReceipt(env, (single as { receiptId: number }).receiptId, admin, 'accept', {})).rejects.toMatchObject({
      code: 'already_paid',
    });
    await reviewReceipt(env, (single as { receiptId: number }).receiptId, admin, 'reject', { reason: 'оплачено наличными' });
    await undoPayment(env, cashier, p3.id);
    expect((await row(p3.id)).paymentStatus).toBe('unpaid');
  });

  it('массовые «оплачено» и «снять» не трогают «чек на проверке»', async () => {
    const owner = await makeUser(env);
    const admin = await makeStaff(env, ['admin']);
    const p = (await makeParticipant(env, owner, { paymentStatus: 'pending', amountDue: '35.00' })).participant;
    const res = await bulkUpdate(env, { action: 'mark_paid', ids: [p.id] }, admin);
    expect(res.updated).toBe(0);
    expect((await row(p.id)).paymentStatus).toBe('pending');
  });
});

describe('расписание', () => {
  const base = Date.now() + 5 * 24 * 3600_000;
  const input = (title: string, startMin: number, endMin: number) => ({
    title,
    description: null,
    location: null,
    host: null,
    kind: 'Семинар',
    startsAt: new Date(base + startMin * 60_000).toISOString(),
    endsAt: new Date(base + endMin * 60_000).toISOString(),
    registrationMode: 'required' as const,
    capacity: null,
    waitlistEnabled: false,
    registrationOpensAt: null,
    registrationClosesAt: null,
    minAge: null,
    maxAge: null,
    status: 'published' as const,
  });

  it('две параллельные записи одного человека на пересекающиеся активности - проходит одна', async () => {
    const admin = await makeStaff(env, ['admin']);
    const owner = await makeUser(env);
    for (let i = 0; i < 10; i++) {
      const a = await createActivity(env, input(`A${i}`, i * 200, i * 200 + 60), admin);
      const b = await createActivity(env, input(`B${i}`, i * 200 + 30, i * 200 + 90), admin);
      const { participant: p } = await makeParticipant(env, owner);
      const [r1, r2] = await Promise.all([
        env.db.execute<{ r: string }>(sql`select register_activity(${a.id}::bigint, ${p.id}::bigint, null::bigint) as r`),
        env.db.execute<{ r: string }>(sql`select register_activity(${b.id}::bigint, ${p.id}::bigint, null::bigint) as r`),
      ]);
      expect([r1.rows[0]!.r, r2.rows[0]!.r].sort()).toEqual(['registered', 'time_conflict']);
    }
  });

  it('скрытая тема всё равно занимает время: вторую тему блока не взять, но можно перейти', async () => {
    const admin = await makeStaff(env, ['admin']);
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner);
    const t1 = await createActivity(env, input('Т1', 7000, 7060), admin);
    const t2 = await createActivity(env, input('Т2', 7000, 7060), admin);
    const reg = async (id: number) =>
      (await env.db.execute<{ r: string }>(sql`select register_activity(${id}::bigint, ${p.id}::bigint, null::bigint) as r`)).rows[0]!.r;
    expect(await reg(t1.id)).toBe('registered');
    await updateActivity(env, t1.id, { status: 'draft' }, admin);
    expect(await reg(t2.id)).toBe('time_conflict');
  });

  it('правка названия после отмены не возвращает мероприятие в программу; черновик участнику не виден', async () => {
    const admin = await makeStaff(env, ['admin']);
    const a = await createActivity(env, input('Отменяемое', 5000, 5060), admin);
    await updateActivity(env, a.id, { status: 'cancelled' }, admin);
    await updateActivity(env, a.id, { title: 'Новое название' }, admin);
    expect((await getActivityView(env, a.id)).status).toBe('cancelled');

    const d = await createActivity(env, { ...input('Черновик', 6000, 6060), status: 'draft' }, admin);
    await expect(getActivityView(env, d.id, actorId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await getActivityView(env, d.id)).title).toBe('Черновик');
  });

  it('скрытый блок: участник не видит его и его темы, записаться нельзя; показали - всё как было', async () => {
    const admin = await makeStaff(env, ['admin']);
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner);
    const rooms = await listRooms(env.db);
    const at = new Date(base + 11000 * 60_000).toISOString();
    const end = new Date(base + 11060 * 60_000).toISOString();
    const block = await createBlock(env, { title: 'Скрываемый', startsAt: at, endsAt: end, roomIds: [rooms[0]!.id], registrationOpen: true, hidden: false }, admin);
    await createTopic(env, { title: 'Тема скрытого', host: null, description: null, hidden: false }, admin);
    await publishSeminars(env, admin);
    const topicId = (await getBlock(env.db, block.id)).topics.find((t) => t.title === 'Тема скрытого')!.id;
    await updateBlock(env, block.id, { registrationOpen: true }, admin);
    const visible = async () => ({
      inBlocks: (await publicSeminars(env, owner.id)).topics.some((t) => t.title === 'Тема скрытого'),
      inSchedule: (await listActivities(env, { userId: owner.id })).some((a) => a.id === topicId),
    });
    expect(await visible()).toEqual({ inBlocks: true, inSchedule: true });

    await updateBlock(env, block.id, { hidden: true }, admin);
    expect(await visible()).toEqual({ inBlocks: false, inSchedule: false });
    await expect(registerForActivity(env, owner, topicId, p.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await env.db.query.activityRegistrations.findMany({ where: eq(schema.activityRegistrations.activityId, topicId) })).length).toBe(0);
    await expect(getActivityView(env, topicId, owner.id)).rejects.toMatchObject({ statusCode: 404 });

    await updateBlock(env, block.id, { hidden: false }, admin);
    expect(await visible()).toEqual({ inBlocks: true, inSchedule: true });
    expect((await getActivityView(env, topicId)).status).toBe('published');
  });

  it('скрытый служитель: участник не видит, записаться нельзя; скрытие не трогает окошки и записи', async () => {
    const admin = await makeStaff(env, ['admin']);
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner);
    await patchSettings(env.db, { counselingOpen: true }, admin.user.id);
    invalidateSettingsCache();
    const startsAt = new Date(base + 12000 * 60_000).toISOString();
    const endsAt = new Date(base + 12060 * 60_000).toISOString();
    const view = await createCounselor(env, { name: 'Скрываемый служитель', place: null, startsAt, endsAt, slotMinutes: 20, hidden: false, audience: 'all', tags: [] }, admin);
    const c = view.counselors.find((x) => x.name === 'Скрываемый служитель')!;
    await bookCounseling(env, owner, { counselorId: c.id, slotStart: c.slots[0]!, participantId: p.id });

    const after = await updateCounselor(env, c.id, { hidden: true }, admin);
    const hidden = after.counselors.find((x) => x.id === c.id)!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.slots).toEqual(c.slots);
    expect(hidden.bookings.length).toBe(1);
    expect((await publicCounseling(env, owner.id)).counselors.some((x) => x.id === c.id)).toBe(false);
    await expect(bookCounseling(env, owner, { counselorId: c.id, slotStart: c.slots[1]!, participantId: p.id })).rejects.toMatchObject({
      statusCode: 404,
    });
    await updateCounselor(env, c.id, { hidden: false }, admin);
    expect((await publicCounseling(env, owner.id)).counselors.some((x) => x.id === c.id)).toBe(true);
  });

  it('блок нулевой длины не создаётся; после публикации залов тема вмещает не больше зала', async () => {
    const admin = await makeStaff(env, ['admin']);
    const rooms = await listRooms(env.db);
    const at = new Date(base + 9000 * 60_000).toISOString();
    await expect(
      createBlock(env, { title: 'Пустой', startsAt: at, endsAt: at, roomIds: [rooms[0]!.id], registrationOpen: false, hidden: false }, admin),
    ).rejects.toMatchObject({ code: 'invalid_time' });
    const end = new Date(base + 9060 * 60_000).toISOString();
    const block = await createBlock(env, { title: 'Блок', startsAt: at, endsAt: end, roomIds: [rooms[0]!.id], registrationOpen: true, hidden: false }, admin);
    await createTopic(env, { title: 'Тема', host: null, description: null, hidden: false }, admin);
    await publishSeminars(env, admin);
    const withRoom = (await getBlock(env.db, block.id)).topics.find((t) => t.roomId !== null)!;
    expect((await getActivityView(env, withRoom.id)).capacity).toBe(rooms[0]!.capacity);

    // Списки потока: лист на сеанс, в нём записавшийся.
    await createTopic(env, { title: 'Тема: вторая?', host: 'Ведущий', description: null, hidden: false }, admin);
    const second = (await getBlock(env.db, block.id)).topics.find((t) => t.title === 'Тема: вторая?')!;
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner, { lastName: 'Списочный' });
    await env.db.insert(schema.activityRegistrations).values({ activityId: second.id, participantId: p.id, status: 'registered' });
    const { body } = await exportSeminarBlockXlsx(env, block.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as never);
    expect(wb.worksheets.length).toBe((await getBlock(env.db, block.id)).topics.length);
    const sheet = wb.worksheets.find((w) => String(w.getRow(1).getCell(1).value) === 'Тема: вторая?')!;
    expect(sheet.name).not.toMatch(/[:?]/);
    const names: string[] = [];
    sheet.eachRow((r) => names.push(String(r.getCell(2).value ?? '')));
    expect(names.some((n) => n.includes('Списочный'))).toBe(true);
  });
});

describe('вход', () => {
  let entrance = 0;
  const ev = (participantId: number, over: Partial<CheckInEvent> = {}): CheckInEvent => ({
    clientEventId: randomUUID(),
    checkpointId: entrance,
    participantId,
    code: null,
    clientTs: new Date().toISOString(),
    deviceId: 'qa',
    method: 'manual',
    offline: false,
    overrideUnpaid: false,
    ...over,
  });

  beforeAll(async () => {
    const [cp] = await env.db.insert(schema.checkpoints).values({ kind: 'entrance', name: 'Вход QA' }).returning();
    entrance = cp!.id;
  });

  it('до начала - по дню: в день начала вход открыт с утра, накануне - нет', () => {
    const s = { ...DEFAULT_SETTINGS, eventStartsAt: '2026-11-06T15:00:00.000Z', eventTimezone: 'Europe/Minsk' };
    expect(isBeforeEvent(s, new Date('2026-11-06T06:00:00Z'))).toBe(false); // 9:00 по Минску, программа в 18:00
    expect(isBeforeEvent(s, new Date('2026-11-05T20:00:00Z'))).toBe(true); // 23:00 накануне
  });

  it('пропущенный без оплаты при повторном скане - «уже отмечен», пропуск в журнале', async () => {
    const owner = await makeUser(env);
    const cashier = await makeStaff(env, ['cashier']);
    const scanner = await makeStaff(env, ['scanner']);
    await patchSettings(env.db, { paymentsEnabled: true, allowUnpaidEntry: false }, actorId);
    invalidateSettingsCache();
    const { participant: p } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '35.00' });
    const [blocked] = await processCheckIns(env, scanner, [ev(p.id)]);
    expect(blocked!.outcome).toBe('unpaid');
    const [ok] = await processCheckIns(env, cashier, [ev(p.id, { overrideUnpaid: true })]);
    expect(ok!.outcome).toBe('new');
    const [again] = await processCheckIns(env, scanner, [ev(p.id)]);
    expect(again!.outcome).toBe('duplicate');
    const audit = await env.db.query.auditLog.findMany({ where: eq(schema.auditLog.action, 'checkin.override_unpaid') });
    expect(audit.some((a) => a.entityId === String(p.id))).toBe(true);
  });

  it('повтор отменённой отметки - не «отмечен»; в базе сканера нет дат рождения', async () => {
    const owner = await makeUser(env);
    const scanner = await makeStaff(env, ['scanner']);
    const { participant: p } = await makeParticipant(env, owner);
    const e = ev(p.id);
    expect((await processCheckIns(env, scanner, [e]))[0]!.outcome).toBe('new');
    expect((await revokeCheckInByEvent(env, scanner, e.clientEventId)).revoked).toBe(true);
    expect((await processCheckIns(env, scanner, [e]))[0]!.outcome).toBe('check_in_undone');

    const manifest = await buildManifest(env);
    const mine = manifest.participants.find((x) => x.id === p.id)!;
    expect(mine).not.toHaveProperty('birthDate');
    expect(mine.age).toBeGreaterThan(16);
    expect(mine.under16).toBe(false);
  });

  it('офлайн-отметка на выключенный общий вход уходит на вход дня', async () => {
    const owner = await makeUser(env);
    const scanner = await makeStaff(env, ['scanner']);
    const { participant: p } = await makeParticipant(env, owner);
    const tz = (await getSettings(env.db)).eventTimezone;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const [old] = await env.db.insert(schema.checkpoints).values({ kind: 'entrance', name: 'Старый вход', isActive: false }).returning();
    const [daily] = await env.db.insert(schema.checkpoints).values({ kind: 'entrance', name: 'Вход сегодня', day: today }).returning();
    const [r] = await processCheckIns(env, scanner, [ev(p.id, { checkpointId: old!.id, offline: true })]);
    expect(r!.outcome).toBe('new');
    const mark = await env.db.query.checkIns.findFirst({ where: eq(schema.checkIns.participantId, p.id) });
    expect(mark!.checkpointId).toBe(daily!.id);
    await env.db.update(schema.checkpoints).set({ isActive: false }).where(eq(schema.checkpoints.id, daily!.id));
  });
});

describe('безопасность и настройки', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp(env);
  });
  afterAll(async () => app?.close());

  it('изменения по cookie админки - только со страницы админки', async () => {
    const admin = await makeStaff(env, ['admin']);
    const { token } = await createSession(env.db, admin.user.id, 'web', 1);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const url = '/api/admin/checkpoints';
    const payload = { kind: 'entrance', name: 'CSRF' };
    const evil = await app.inject({ method: 'POST', url, headers: { cookie, origin: 'https://evil.sslip.io' }, payload });
    expect(evil.statusCode).toBe(403);
    const good = await app.inject({ method: 'POST', url, headers: { cookie, origin: env.config.ADMIN_URL }, payload });
    expect(good.statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url, headers: { cookie, origin: 'https://evil.sslip.io' } });
    expect(read.statusCode).toBe(200);
  });

  it('касса видит базу участников (после приёма - полная строка); массовые правки ей запрещены', async () => {
    const owner = await makeUser(env);
    const { participant: p } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '35.00', phone: '+375291112233' });
    const cashier = await makeStaff(env, ['cashier']);
    const { token } = await createSession(env.db, cashier.user.id, 'web', 1);
    const headers = { authorization: `Bearer ${token}` };
    const res = await app.inject({ method: 'POST', url: `/api/admin/participants/${p.id}/payment`, headers, payload: { method: 'cash' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('phone', '+375291112233');
    expect(res.json().paymentStatus).toBe('paid');
    const again = await app.inject({ method: 'POST', url: `/api/admin/participants/${p.id}/payment`, headers, payload: { method: 'cash' } });
    expect(again.statusCode).toBe(409);
    const bulk = await app.inject({ method: 'POST', url: '/api/admin/participants/bulk', headers, payload: { action: 'mark_unpaid', ids: [p.id] } });
    expect(bulk.statusCode).toBe(403);
  });

  it('сломанное поле настроек сбрасывается отдельно, остальное сохраняется; часовой пояс проверяется', async () => {
    expect(settingsSchema.shape.eventTimezone.safeParse('Europe/Minsk').success).toBe(true);
    expect(settingsSchema.shape.eventTimezone.safeParse('Europe/Minks').success).toBe(false);
    const s = await getSettings(env.db, { fresh: true });
    await env.db
      .update(schema.settings)
      .set({ value: { ...s, eventName: 'Своё название', eventTimezone: 'Nowhere/Zone' } })
      .where(eq(schema.settings.key, 'app'));
    invalidateSettingsCache();
    const salvaged = await getSettings(env.db, { fresh: true });
    expect(salvaged.eventName).toBe('Своё название');
    expect(salvaged.eventTimezone).toBe('Europe/Minsk');
    await env.db.update(schema.settings).set({ value: s }).where(eq(schema.settings.key, 'app'));
    invalidateSettingsCache();
  });

  it('регистрация: «Я» один на заявку, дата рождения не из будущего', () => {
    const person = {
      lastName: 'Петров',
      firstName: 'Пётр',
      birthDate: '1990-01-01',
      gender: 'm',
      city: 'Минск',
      church: 'Благодать',
      phone: '+375291112233',
      relation: 'self',
      tier: 'nofee',
    };
    const base = { idempotencyKey: randomUUID(), consent: { pd: true, documentVersion: '1' } };
    expect(registrationSubmitSchema.safeParse({ ...base, participants: [person] }).success).toBe(true);
    expect(registrationSubmitSchema.safeParse({ ...base, participants: [person, { ...person, firstName: 'Павел' }] }).success).toBe(false);
    expect(registrationSubmitSchema.safeParse({ ...base, participants: [{ ...person, birthDate: '2999-01-01' }] }).success).toBe(false);
  });

  it('очистка базы: журнал действий остаётся, при настоящих регистрациях - отказ', async () => {
    const keep = await makeUser(env, 'Чистильщик');
    const before = (await env.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log`)).rows[0]!.n;
    const n = (await env.db.execute<{ n: number }>(sql`select count(*)::int as n from participants`)).rows[0]!.n;
    if (n > 20) {
      await expect(wipeDatabase(env, keep.id)).rejects.toMatchObject({ code: 'too_many_to_wipe' });
      await env.db.execute(sql`delete from activity_registrations`);
      await env.db.execute(sql`delete from check_ins`);
      await env.db.execute(sql`delete from scan_log`);
      await env.db.execute(sql`delete from payment_receipts`);
      await env.db.execute(sql`delete from counseling_bookings`);
      await env.db.execute(sql`delete from tickets`);
      await env.db.execute(sql`delete from participants`);
    }
    await wipeDatabase(env, keep.id);
    const after = (await env.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log`)).rows[0]!.n;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

