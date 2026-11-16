import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { MeResponse, StaffSessionResponse } from '@sof/shared';
import { sign } from '@tma.js/init-data-node';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { getUserByTgId } from '../src/services/users.service.ts';
import { setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
});
afterAll(async () => {
  await app?.close();
  await env?.teardown();
});

const tma = (tgId: number) => `tma ${sign({ user: { id: tgId, first_name: 'T', allows_write_to_pm: true } } as never, env.config.BOT_TOKEN, new Date())}`;
async function grant(tgId: number, role: 'admin' | 'cashier' | 'scanner' | 'superadmin') {
  await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: tma(tgId) } });
  const user = await getUserByTgId(env.db, tgId);
  await env.db.insert(schema.staffRoles).values({ userId: user!.id, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/staff-session', headers: { authorization: tma(tgId) } });
  return `Bearer ${(res.json() as StaffSessionResponse).token}`;
}
const person = (lastName: string, over: Record<string, unknown> = {}) => ({ lastName, firstName: 'Тест', birthDate: '1990-01-01', gender: 'm', city: 'Минск', church: 'Благодать', phone: '+375291112200', relation: 'self', tier: 'fee10', paymentMethod: 'transfer', ...over });
async function register(tgId: number, people: Record<string, unknown>[]) {
  await app.inject({ method: 'POST', url: '/api/registrations', headers: { authorization: tma(tgId) }, payload: { idempotencyKey: randomUUID(), participants: people, consent: { pd: true, photo: false, documentVersion: 'x' } } });
  return (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: tma(tgId) } })).json() as MeResponse;
}

describe('admin deletes a participant', () => {
  it('only admin/superadmin may delete; with payment or receipt - refused; tickets, scan log, waitlist and audit are handled', async () => {
    const admin = await grant(7101, 'admin');
    const superadmin = await grant(7102, 'superadmin');
    const cashier = await grant(7103, 'cashier');
    const scanner = await grant(7104, 'scanner');

    const me = await register(7201, [
      person('Оплатилов'),
      person('Счеков', { firstName: 'Брат', relation: 'friend', phone: '+375291112201' }),
      person('Удаляемов', { firstName: 'Друг', relation: 'friend', phone: '+375291112202' }),
    ]);
    const [paid, withReceipt, victim] = me.participants;
    const ownerId = (await getUserByTgId(env.db, 7201))!.id;
    // Первый оплатил, у второго чек на проверке - их удалить нельзя (оплата и чек пропали бы).
    await env.db.update(schema.participants).set({ paymentStatus: 'paid', amountPaid: '10.00' }).where(eq(schema.participants.id, paid!.id));
    await env.db.insert(schema.paymentReceipts).values({ userId: ownerId, participantIds: [withReceipt!.id], fileId: 'f', fileUniqueId: 'u1', fileKind: 'photo', status: 'pending' });
    for (const p of [paid!, withReceipt!]) {
      const refused = await app.inject({ method: 'DELETE', url: `/api/admin/participants/${p.id}`, headers: { authorization: admin } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'has_money' });
      expect(await env.db.query.participants.findFirst({ where: eq(schema.participants.id, p.id) })).toBeDefined();
    }

    // Третий без денег: записан на мероприятие с местом 1, за ним в листе ожидания ещё один человек.
    const [act] = await env.db.insert(schema.activities).values({ title: 'Семинар', kind: 'Семинар', startsAt: new Date(Date.now() + 864e5), endsAt: new Date(Date.now() + 9e7), registrationMode: 'required', capacity: 1 }).returning();
    await env.db.insert(schema.activityRegistrations).values({ activityId: act!.id, participantId: victim!.id, status: 'registered' });
    await env.db.insert(schema.scanLog).values({ participantId: victim!.id, outcome: 'new', rawCode: victim!.ticket!.code });

    // Кассир и сканер удалить не могут.
    for (const auth of [cashier, scanner]) {
      expect((await app.inject({ method: 'DELETE', url: `/api/admin/participants/${victim!.id}`, headers: { authorization: auth } })).statusCode).toBe(403);
    }
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/participants/${victim!.id}`, headers: { authorization: admin } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });
    expect(await env.db.query.participants.findFirst({ where: eq(schema.participants.id, victim!.id) })).toBeUndefined();
    expect(await env.db.select().from(schema.tickets).where(eq(schema.tickets.participantId, victim!.id))).toHaveLength(0);
    // Повторное удаление - 404; суперадмин тоже может удалять (человека без денег).
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/participants/${victim!.id}`, headers: { authorization: admin } })).statusCode).toBe(404);
    const extra = await register(7202, [person('Лишнев', { phone: '+375291112203' })]);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/participants/${extra.participants[0]!.id}`, headers: { authorization: superadmin } })).statusCode).toBe(200);

    // Журнал сканов сохранён без ссылки; в журнале действий - снимок карточки и кода QR.
    const logs = await env.db.select().from(schema.scanLog).where(eq(schema.scanLog.rawCode, victim!.ticket!.code));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.participantId).toBeNull();
    const [a] = await env.db.select().from(schema.auditLog).where(sql`action = 'participant.delete' and entity_id = ${String(victim!.id)}`);
    expect(a!.before).toMatchObject({ participant: { lastName: 'Удаляемов' }, tickets: [{ code: victim!.ticket!.code }] });
    // Владелец в приложении удалённого больше не видит, двое с деньгами остались.
    const after = (await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: tma(7201) } })).json() as MeResponse;
    expect(after.participants.map((p) => p.id).sort()).toEqual([paid!.id, withReceipt!.id].sort());
  });

  it('frees the place on a waitlisted activity', async () => {
    const admin = await grant(7301, 'admin');
    const me1 = await register(7401, [person('Первый', { phone: '+375291112300' })]);
    const me2 = await register(7402, [person('Второй', { phone: '+375291112301' })]);
    const [act] = await env.db.insert(schema.activities).values({ title: 'Мастер-класс', kind: 'Семинар', startsAt: new Date(Date.now() + 864e5), endsAt: new Date(Date.now() + 9e7), registrationMode: 'required', capacity: 1 }).returning();
    await env.db.insert(schema.activityRegistrations).values([
      { activityId: act!.id, participantId: me1.participants[0]!.id, status: 'registered' },
      { activityId: act!.id, participantId: me2.participants[0]!.id, status: 'waitlist' },
    ]);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/participants/${me1.participants[0]!.id}`, headers: { authorization: admin } })).statusCode).toBe(200);
    const regs = await env.db.select().from(schema.activityRegistrations).where(eq(schema.activityRegistrations.activityId, act!.id));
    expect(regs.map((r) => [r.participantId, r.status])).toEqual([[me2.participants[0]!.id, 'registered']]);
  });
});
