import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
async function grant(tgId: number, role: 'admin' | 'cashier' | 'superadmin') {
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
const participant = async (id: number) => (await env.db.select().from(schema.participants).where(eq(schema.participants.id, id)))[0]!;
const receiptExists = async (id: number) => (await env.db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, id))).length > 0;

describe('superadmin deletes a receipt', () => {
  it('only superadmin; pending people go back to unpaid/partial, accepted payment stays, audit keeps a snapshot', async () => {
    const superadmin = await grant(7301, 'superadmin');
    const admin = await grant(7302, 'admin');
    const cashier = await grant(7303, 'cashier');

    const me = await register(7401, [
      person('Чеков'),
      person('Частичный', { firstName: 'Брат', relation: 'friend', phone: '+375291112201' }),
      person('Оплатов', { firstName: 'Сестра', relation: 'friend', phone: '+375291112202' }),
    ]);
    const [a, b, c] = me.participants;
    const userId = (await getUserByTgId(env.db, 7401))!.id;
    // b уже внёс часть, оба на проверке по одному чеку; c оплачен по принятому чеку.
    await env.db.update(schema.participants).set({ paymentStatus: 'pending' }).where(eq(schema.participants.id, a!.id));
    await env.db.update(schema.participants).set({ paymentStatus: 'pending', amountPaid: '4.00' }).where(eq(schema.participants.id, b!.id));
    await env.db.update(schema.participants).set({ paymentStatus: 'paid', amountPaid: '10.00' }).where(eq(schema.participants.id, c!.id));
    const [pending] = await env.db.insert(schema.paymentReceipts).values({ userId, participantIds: [a!.id, b!.id], fileId: 'f1', fileUniqueId: 'rd1', fileKind: 'photo', status: 'pending' }).returning();
    const [accepted] = await env.db.insert(schema.paymentReceipts).values({ userId, participantIds: [c!.id], fileId: 'f2', fileUniqueId: 'rd2', fileKind: 'document', mimeType: 'application/pdf', status: 'accepted' }).returning();

    // Админ и кассир удалить не могут.
    for (const auth of [admin, cashier]) {
      expect((await app.inject({ method: 'DELETE', url: `/api/admin/receipts/${pending!.id}`, headers: { authorization: auth } })).statusCode).toBe(403);
    }
    expect(await receiptExists(pending!.id)).toBe(true);

    // Чек на проверке: удаляется, люди возвращаются к оплате.
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/receipts/${pending!.id}`, headers: { authorization: superadmin } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });
    expect(await receiptExists(pending!.id)).toBe(false);
    expect((await participant(a!.id)).paymentStatus).toBe('unpaid');
    expect((await participant(b!.id)).paymentStatus).toBe('partial');
    expect((await participant(b!.id)).amountPaid).toBe('4.00');

    // Принятый чек: удаляется, оплата остаётся.
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/receipts/${accepted!.id}`, headers: { authorization: superadmin } })).statusCode).toBe(200);
    expect(await receiptExists(accepted!.id)).toBe(false);
    expect((await participant(c!.id)).paymentStatus).toBe('paid');
    expect((await participant(c!.id)).amountPaid).toBe('10.00');

    // Повторное удаление - 404; список чеков их больше не показывает.
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/receipts/${pending!.id}`, headers: { authorization: superadmin } })).statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/receipts', headers: { authorization: superadmin } })).json() as { id: number }[];
    expect(list.map((r) => r.id)).not.toContain(pending!.id);
    expect(list.map((r) => r.id)).not.toContain(accepted!.id);

    // В истории изменений - снимок удалённого чека.
    const logs = await env.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'receipt.delete'));
    const snap = logs.find((l) => l.entityId === String(pending!.id));
    expect(snap?.before).toMatchObject({ userId, participantIds: [a!.id, b!.id], status: 'pending' });

    // Тот же файл можно прислать заново (уникальность по файлу не мешает).
    await env.db.insert(schema.paymentReceipts).values({ userId, participantIds: [a!.id], fileId: 'f1', fileUniqueId: 'rd1', fileKind: 'photo', status: 'pending' });
  });

  it('person also in another pending receipt stays pending', async () => {
    const superadmin = await grant(7311, 'superadmin');
    const me = await register(7411, [person('Двойной')]);
    const [p] = me.participants;
    const userId = (await getUserByTgId(env.db, 7411))!.id;
    await env.db.update(schema.participants).set({ paymentStatus: 'pending' }).where(eq(schema.participants.id, p!.id));
    const [dup] = await env.db.insert(schema.paymentReceipts).values({ userId, participantIds: [p!.id], fileId: 'g1', fileUniqueId: 'rd3', fileKind: 'photo', status: 'pending' }).returning();
    await env.db.insert(schema.paymentReceipts).values({ userId, participantIds: [p!.id], fileId: 'g2', fileUniqueId: 'rd4', fileKind: 'photo', status: 'pending' });
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/receipts/${dup!.id}`, headers: { authorization: superadmin } })).statusCode).toBe(200);
    expect((await participant(p!.id)).paymentStatus).toBe('pending');
  });
});
