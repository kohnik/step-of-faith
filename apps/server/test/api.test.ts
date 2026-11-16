import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { MeResponse, RegistrationResult, StaffSessionResponse } from '@sof/shared';
import { sign } from '@tma.js/init-data-node';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { getSettings, updateSettings } from '../src/services/settings.service.ts';
import { getUserByTgId } from '../src/services/users.service.ts';
import { setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
let entranceId: number;

beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
  const [cp] = await env.db.insert(schema.checkpoints).values({ kind: 'entrance', name: 'Вход' }).returning();
  entranceId = cp!.id;
});
afterAll(async () => {
  await app?.close();
  await env?.teardown();
});

const tma = (tgId: number, name = 'Тест') =>
  `tma ${sign({ user: { id: tgId, first_name: name, allows_write_to_pm: true } } as never, env.config.BOT_TOKEN, new Date())}`;

async function grant(tgId: number, role: 'scanner' | 'admin' | 'cashier') {
  // Пользователь появляется при первом запросе с initData.
  await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: tma(tgId) } });
  const user = await getUserByTgId(env.db, tgId);
  await env.db.insert(schema.staffRoles).values({ userId: user!.id, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/staff-session', headers: { authorization: tma(tgId) } });
  expect(res.statusCode).toBe(200);
  return `Bearer ${(res.json() as StaffSessionResponse).token}`;
}

const family = [
  { lastName: 'Орлова', firstName: 'Анна', birthDate: '1988-03-04', gender: 'f', city: 'Минск', church: 'Благодать', phone: '80291234567', relation: 'self', tier: 'fee35', paymentMethod: 'cash' },
  { lastName: 'Орлов', firstName: 'Лёва', birthDate: '2015-07-09', gender: 'm', city: 'Минск', church: 'Благодать', relation: 'child', tier: 'nofee' },
];

describe('HTTP API', () => {
  let me: MeResponse;
  let paid: string;

  it('rejects requests without or with forged initData', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const forged = tma(5001).replace('first_name%22%3A%22', 'first_name%22%3A%22X');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: forged } })).statusCode).toBe(401);
  });

  it('registers a family once and issues tickets with a public web ticket', async () => {
    const auth = { authorization: tma(5001, 'Анна') };
    const body = { idempotencyKey: randomUUID(), participants: family, consent: { pd: true, photo: false, documentVersion: '2026-09' } };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/registrations', headers: auth, payload: body }),
      app.inject({ method: 'POST', url: '/api/registrations', headers: auth, payload: body }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect((a.json() as RegistrationResult).created).toHaveLength(2);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/registrations',
      headers: auth,
      payload: { ...body, idempotencyKey: randomUUID(), participants: [{ ...family[0], birthDate: 'вчера' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation_error');

    me = (await app.inject({ method: 'GET', url: '/api/me', headers: auth })).json();
    expect(me.participants).toHaveLength(2);
    const ticket = me.participants[0]!.ticket!;
    expect(ticket.code).toMatch(/^SF-/);
    const token = ticket.webUrl.split('/t/')[1]!;
    const pub = await app.inject({ method: 'GET', url: `/api/public/tickets/${token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().fullName).toBe('Орлова Анна');
    const png = await app.inject({ method: 'GET', url: `/api/public/tickets/${token}/image.png` });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });

  it('keeps staff endpoints closed to participants and admin endpoints closed to scanners', async () => {
    const participant = await app.inject({ method: 'POST', url: '/api/auth/staff-session', headers: { authorization: tma(5001) } });
    expect(participant.statusCode).toBe(403);
    const scanner = await grant(6001, 'scanner');
    expect((await app.inject({ method: 'GET', url: '/api/admin/participants', headers: { authorization: scanner } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/staff/checkpoints', headers: { authorization: scanner } })).statusCode).toBe(200);
    // До начала конференции сканер проверяет оплату (смотреть можно), а принять деньги - только касса.
    const cashFind = await app.inject({ method: 'POST', url: '/api/staff/payments/find', headers: { authorization: scanner }, payload: { participantId: 1 } });
    expect(cashFind.statusCode).toBe(200);
    const cashPay = await app.inject({
      method: 'POST',
      url: '/api/staff/payments/mark-paid',
      headers: { authorization: scanner },
      payload: { participantIds: [1], method: 'cash' },
    });
    expect(cashPay.statusCode).toBe(403);
  });

  it('checks a ticket in once; the second scanner sees who did it', async () => {
    const cashier = await grant(6002, 'cashier');
    const scanner = await grant(6003, 'scanner');
    const p = me.participants[0]!;
    const lookup = await app.inject({
      method: 'POST',
      url: '/api/staff/lookup',
      headers: { authorization: scanner },
      payload: { checkpointId: entranceId, code: ` ${p.ticket!.displayCode.toLowerCase()} ` },
    });
    expect(lookup.json()).toMatchObject({ found: true, card: { id: p.id }, family: [{ id: me.participants[1]!.id }] });

    const ev = (overrideUnpaid = false) => ({
      clientEventId: randomUUID(),
      checkpointId: entranceId,
      participantId: p.id,
      code: p.ticket!.code,
      clientTs: new Date().toISOString(),
      deviceId: 'test',
      method: 'scan',
      offline: false,
      overrideUnpaid,
    });
    // С выключенной оплатой «не оплачено» на входе не бывает - проверяем режим, когда оплата включена.
    const settings = await getSettings(env.db, { fresh: true });
    await updateSettings(env.db, { ...settings, paymentsEnabled: true, allowUnpaidEntry: false }, 1);
    // Не оплачено: сканер не пропускает, кассир принимает оплату на месте.
    const blocked = await app.inject({ method: 'POST', url: '/api/staff/check-ins', headers: { authorization: scanner }, payload: { events: [ev()] } });
    expect(blocked.json().results[0].outcome).toBe('unpaid');
    const pay = await app.inject({
      method: 'POST',
      url: '/api/staff/payments/mark-paid',
      headers: { authorization: cashier },
      payload: { participantIds: [p.id], method: 'cash' },
    });
    expect(pay.json()).toMatchObject({ updated: 1, people: [{ paymentStatus: 'paid' }] });
    paid = 'yes';

    const first = await app.inject({ method: 'POST', url: '/api/staff/check-ins', headers: { authorization: scanner }, payload: { events: [ev()] } });
    expect(first.json().results[0].outcome).toBe('new');
    const second = await app.inject({ method: 'POST', url: '/api/staff/check-ins', headers: { authorization: cashier }, payload: { events: [ev()] } });
    expect(second.json().results[0]).toMatchObject({ outcome: 'duplicate', byName: 'Тест' });
    // История сканера хранится на сервере: у сканера - два скана, свежий сверху.
    const recent = await app.inject({ method: 'GET', url: `/api/staff/recent?checkpointId=${entranceId}`, headers: { authorization: scanner } });
    expect(recent.json().map((r: { outcome: string }) => r.outcome)).toEqual(['new', 'unpaid']);
    expect(recent.json()[0].fullName).toBe('Орлова Анна');
    expect(recent.json()[0]).toMatchObject({ canUndo: true });
    expect(recent.json()[0].checkInId).toEqual(expect.any(Number));
    expect(recent.json()[1]).toMatchObject({ canUndo: false, checkInId: null });
  });

  it('serves the scanner manifest with ETag and 304', async () => {
    expect(paid).toBe('yes');
    const scanner = await grant(6004, 'scanner');
    const first = await app.inject({ method: 'GET', url: '/api/staff/manifest', headers: { authorization: scanner } });
    expect(first.statusCode).toBe(200);
    expect(first.json().codes.length).toBeGreaterThanOrEqual(2);
    const again = await app.inject({
      method: 'GET',
      url: '/api/staff/manifest',
      headers: { authorization: scanner, 'if-none-match': first.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
  });

  it('lets an admin create an activity and a parent register a child for it', async () => {
    const admin = await grant(6005, 'admin');
    const startsAt = new Date(Date.now() + 48 * 3600_000).toISOString();
    const endsAt = new Date(Date.now() + 49 * 3600_000).toISOString();
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/activities',
      headers: { authorization: admin },
      payload: { title: 'Детский клуб', kind: 'workshop', startsAt, endsAt, registrationMode: 'required', capacity: 1, maxAge: 12 },
    });
    expect(created.statusCode).toBe(200);
    const activityId = created.json().id as number;
    const auth = { authorization: tma(5001) };
    const [mom, kid] = me.participants;

    // До конференции запись закрыта выключателем - открываем, как организатор на месте.
    const closed = await app.inject({ method: 'POST', url: `/api/activities/${activityId}/register`, headers: auth, payload: { participantId: kid!.id } });
    expect(closed.json().outcome).toBe('not_open');
    const s = await getSettings(env.db, { fresh: true });
    await updateSettings(env.db, { ...s, activityRegistrationOpen: true }, 1);

    const tooOld = await app.inject({ method: 'POST', url: `/api/activities/${activityId}/register`, headers: auth, payload: { participantId: mom!.id } });
    expect(tooOld.json().outcome).toBe('age_restricted');
    const ok = await app.inject({ method: 'POST', url: `/api/activities/${activityId}/register`, headers: auth, payload: { participantId: kid!.id } });
    expect(ok.json().outcome).toBe('registered');
    expect(ok.json().activity.my).toEqual([{ participantId: kid!.id, status: 'registered' }]);
    // Чужой ребёнок: 404, а не запись.
    const stranger = await app.inject({ method: 'POST', url: `/api/activities/${activityId}/register`, headers: { authorization: tma(5099) }, payload: { participantId: kid!.id } });
    expect(stranger.statusCode).toBe(404);

    // Второй семинар в то же время: ответ с конфликтом, затем перезапись.
    const parallel = await app.inject({
      method: 'POST',
      url: '/api/admin/activities',
      headers: { authorization: admin },
      payload: { title: 'Параллельный клуб', kind: 'workshop', startsAt, endsAt, registrationMode: 'required', capacity: 5 },
    });
    const parallelId = parallel.json().id as number;
    const conflict = await app.inject({ method: 'POST', url: `/api/activities/${parallelId}/register`, headers: auth, payload: { participantId: kid!.id } });
    expect(conflict.json()).toMatchObject({ outcome: 'time_conflict', conflict: { activityId, title: 'Детский клуб' } });
    const switched = await app.inject({
      method: 'POST',
      url: `/api/activities/${parallelId}/switch`,
      headers: auth,
      payload: { participantId: kid!.id, fromActivityId: activityId },
    });
    expect(switched.json()).toMatchObject({ outcome: 'registered', activity: { id: parallelId }, fromActivity: { id: activityId, my: [] } });

    // «Админка» в приложении: ссылка только для админов.
    const scanner = await grant(6006, 'scanner');
    expect((await app.inject({ method: 'POST', url: '/api/staff/admin-link', headers: { authorization: scanner } })).statusCode).toBe(403);
    const link = await app.inject({ method: 'POST', url: '/api/staff/admin-link', headers: { authorization: admin } });
    expect(link.json().url).toMatch(/^https:\/\/admin\.example\.test\/login#token=/);

    const rows = await app.inject({ method: 'GET', url: '/api/admin/participants', headers: { authorization: admin } });
    expect(rows.json().items.length).toBeGreaterThanOrEqual(2);
    const xlsx = await app.inject({ method: 'GET', url: '/api/admin/participants/export.xlsx', headers: { authorization: admin } });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const counts = await app.inject({ method: 'GET', url: '/api/admin/counts', headers: { authorization: admin } });
    expect(counts.json()).toMatchObject({ confirmed: 1 });
    expect(counts.json().participants).toBeGreaterThanOrEqual(2);
    const dash = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { authorization: admin } });
    expect(dash.json().arrival).toMatchObject({ arrived: 1 });
  });

  it('dev wipe: hidden for everyone except DEV_WIPE_TG_IDS, keeps the caller', async () => {
    const admin = await grant(6100, 'admin');
    expect((await app.inject({ method: 'POST', url: '/api/staff/dev/wipe', headers: { authorization: admin } })).statusCode).toBe(404);
    env.config.DEV_WIPE_TG_IDS.push(6100);
    const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { authorization: admin } });
    expect(session.json().features.devTools).toBe(true);
    const wiped = await app.inject({ method: 'POST', url: '/api/staff/dev/wipe', headers: { authorization: admin } });
    expect(wiped.statusCode).toBe(200);
    expect(wiped.json().participants).toBeGreaterThan(0);
    const left = await env.db.execute<{ users: number; participants: number }>(
      sql`select (select count(*) from users)::int as users, (select count(*) from participants)::int as participants`,
    );
    expect(left.rows[0]).toEqual({ users: 1, participants: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/auth/session', headers: { authorization: admin } })).statusCode).toBe(200);
  });
});
