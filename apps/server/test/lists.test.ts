import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { participantRow } from '../src/services/admin.service.ts';
import { createBroadcast, previewSegment } from '../src/services/broadcast.service.ts';
import { listThreads, searchMessages, staffWrites, userWrites } from '../src/services/chat.service.ts';
import {
  addToParticipantList,
  createParticipantList,
  deleteParticipantList,
  listParticipantLists,
  removeFromParticipantList,
} from '../src/services/lists.service.ts';
import { createSession } from '../src/services/sessions.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

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

describe('списки участников', () => {
  it('собрали «Россияне» - рассылка уходит только им', async () => {
    const admin = await makeStaff(env, ['admin']);
    const ru1 = await makeUser(env);
    const { participant: a } = await makeParticipant(env, ru1, { lastName: 'Иванов', firstName: 'Пётр' });
    const ru2 = await makeUser(env);
    const { participant: b } = await makeParticipant(env, ru2, { lastName: 'Петрова', firstName: 'Анна' });
    const blocked = await makeUser(env);
    const { participant: c } = await makeParticipant(env, blocked, { lastName: 'Сидоров', firstName: 'Олег' });
    await env.db.update(schema.users).set({ botBlocked: true }).where(eq(schema.users.id, blocked.id));
    const outsider = await makeUser(env);
    await makeParticipant(env, outsider, { lastName: 'Чужой', firstName: 'Ян' });

    const list = await createParticipantList(env.db, { name: 'Россияне' }, admin);
    await expect(createParticipantList(env.db, { name: 'россияне' }, admin)).rejects.toMatchObject({ code: 'list_exists' });
    const res = await addToParticipantList(env.db, list.id, [a.id, b.id, c.id, a.id], admin);
    expect(res.added).toBe(3);
    expect(res.list).toMatchObject({ count: 3, recipients: 2 });
    // Повторное добавление - без дублей.
    expect((await addToParticipantList(env.db, list.id, [a.id], admin)).added).toBe(0);
    expect((await participantRow(env, a.id)).lists).toEqual([list.id]);

    // Рассылка «Кому: Россияне»: только двое, у кого есть бот.
    expect(await previewSegment(env.db, { kind: 'list', listId: list.id })).toBe(2);
    const sent = await createBroadcast(env, { text: 'Привет, Россия!', segment: { kind: 'list', listId: list.id }, scheduledAt: null, test: false, alsoAnnouncement: false }, admin);
    expect(sent.total).toBe(2);
    const deliveries = await env.db.query.broadcastDeliveries.findMany({ where: eq(schema.broadcastDeliveries.broadcastId, sent.id) });
    expect(deliveries.map((d) => d.userId).sort()).toEqual([ru1.id, ru2.id].sort());

    const removed = await removeFromParticipantList(env.db, list.id, [b.id], admin);
    expect(removed).toMatchObject({ removed: 1, list: { count: 2, recipients: 1 } });

    await deleteParticipantList(env.db, list.id, admin);
    expect((await listParticipantLists(env.db)).some((l) => l.id === list.id)).toBe(false);
    expect((await participantRow(env, a.id)).lists).toEqual([]);
    await expect(
      createBroadcast(env, { text: 'x', segment: { kind: 'list', listId: list.id }, scheduledAt: null, test: false, alsoAnnouncement: false }, admin),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('через API: списки видит и тот, кто только рассылает; менять - только с правом на участников', async () => {
    const admin = await makeStaff(env, ['admin']);
    const cashier = await makeStaff(env, ['cashier']);
    const auth = async (userId: number) => `Bearer ${(await createSession(env.db, userId, 'web', 1)).token}`;
    const created = await app.inject({ method: 'POST', url: '/api/admin/lists', headers: { authorization: await auth(admin.user.id) }, payload: { name: 'Хор' } });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/admin/lists', headers: { authorization: await auth(cashier.user.id) } });
    expect((list.json() as { name: string }[]).map((l) => l.name)).toContain('Хор');
    const denied = await app.inject({ method: 'POST', url: '/api/admin/lists', headers: { authorization: await auth(cashier.user.id) }, payload: { name: 'Нельзя' } });
    expect(denied.statusCode).toBe(403);
  });
});

describe('поиск в «Сообщениях»', () => {
  it('по имени и фамилии в любом порядке, по ребёнку из семьи и по тексту сообщения', async () => {
    const admin = await makeStaff(env, ['admin']);
    const mom = await makeUser(env);
    await makeParticipant(env, mom, { lastName: 'Ёлкина', firstName: 'Мария' });
    await makeParticipant(env, mom, { lastName: 'Ёлкин', firstName: 'Тимофей', relation: 'child' });
    await userWrites(env.db, mom, 'Где взять бейдж для сына?');
    await staffWrites(env, admin, mom.id, { text: 'На ресепшене у главного входа' });

    const found = async (q: string) => (await listThreads(env, { search: q })).map((t) => t.userId);
    expect(await found('мария елкина')).toContain(mom.id);
    expect(await found('Ёлкина Мария')).toContain(mom.id);
    expect(await found('тимофей')).toContain(mom.id);
    expect(await found('мария петрова')).not.toContain(mom.id);

    const hits = await searchMessages(env, 'РЕСЕПШЕН');
    expect(hits[0]).toMatchObject({ userId: mom.id, name: 'Ёлкина Мария', fromStaff: true, text: 'На ресепшене у главного входа' });
    expect((await searchMessages(env, 'бейдж')).map((h) => h.userId)).toContain(mom.id);
    expect(await searchMessages(env, '100%')).toEqual([]);
  });
});
