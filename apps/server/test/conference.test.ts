import { randomUUID } from 'node:crypto';
import { checkpointUpdateSchema, markPaidSchema, type CheckInEvent } from '@sof/shared';
import { and, eq } from 'drizzle-orm';
import { Api } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { runJob } from '../src/jobs/workers.ts';
import { bulkUpdate, ensureDailyEntrances, updateParticipant } from '../src/services/admin.service.ts';
import { createBroadcast } from '../src/services/broadcast.service.ts';
import { processCheckIns, revokeCheckInByEvent } from '../src/services/checkin.service.ts';
import { arrivedToday } from '../src/services/dashboard.service.ts';
import { markPaid } from '../src/services/payment.service.ts';
import { getSettings, invalidateSettingsCache, patchSettings } from '../src/services/settings.service.ts';
import { ageRefDate } from '../src/services/tiers.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let actorId = 0;
let entranceId = 0;
beforeAll(async () => {
  env = await setupTestEnv();
  actorId = (await makeUser(env, 'Настройщик')).id;
  const [cp] = await env.db.insert(schema.checkpoints).values({ kind: 'entrance', name: 'Вход' }).returning();
  entranceId = cp!.id;
});
afterAll(async () => env?.teardown());

/** Поддельный Telegram: запоминает вызовы, на отправку отвечает сообщением. */
function fakeTelegram() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let seq = 5000;
  const api = new Api('123456:TEST-TOKEN-NOT-REAL');
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method.startsWith('send')
      ? { message_id: ++seq, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' } }
      : true;
    return { ok: true, result } as never;
  });
  const sent = (chatId?: number) =>
    calls.filter((c) => c.method === 'sendMessage' && (chatId === undefined || c.payload.chat_id === chatId));
  return { ctx: { ...env, tg: api }, calls, sent };
}

async function setSettings(patch: Parameters<typeof patchSettings>[1]) {
  await patchSettings(env.db, patch, actorId);
  invalidateSettingsCache();
}

function event(participantId: number, over: Partial<CheckInEvent> = {}): CheckInEvent {
  return {
    clientEventId: randomUUID(),
    checkpointId: entranceId,
    participantId,
    code: null,
    clientTs: new Date().toISOString(),
    deviceId: 'dev-1',
    method: 'scan',
    offline: false,
    overrideUnpaid: false,
    ...over,
  };
}

async function jobs(name: string) {
  return (await env.pool.query<{ data: Record<string, unknown> }>(`select data from pgboss.job where name = $1 order by created_on`, [name])).rows.map(
    (r) => r.data,
  );
}

describe('вход в разные дни конференции', () => {
  it('точки входа на каждый день: на 2-й день отметка новая, приветствие одно, «сегодня» считается', async () => {
    const admin = await makeStaff(env, ['admin']);
    await setSettings({ eventStartsAt: '2026-11-05T21:00:00.000Z', eventEndsAt: '2026-11-08T20:59:00.000Z' });
    const list = await ensureDailyEntrances(env, admin);
    const days = list.filter((c) => c.kind === 'entrance' && c.day).map((c) => c.day);
    expect(days).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']);
    // Повторно не дублирует.
    expect((await ensureDailyEntrances(env, admin)).filter((c) => c.day).length).toBe(3);
    await setSettings({ eventStartsAt: null, eventEndsAt: null });

    const day1 = list.find((c) => c.day === '2026-11-06')!.id;
    const day2 = list.find((c) => c.day === '2026-11-07')!.id;
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const scanner = await makeStaff(env, ['scanner']);
    const before = (await jobs('checkin.welcome')).length;
    expect((await processCheckIns(env, scanner, [event(participant.id, { checkpointId: day1 })]))[0]!.outcome).toBe('new');
    expect((await processCheckIns(env, scanner, [event(participant.id, { checkpointId: day1 })]))[0]!.outcome).toBe('duplicate');
    expect((await processCheckIns(env, scanner, [event(participant.id, { checkpointId: day2 })]))[0]!.outcome).toBe('new');
    // Приветствие ставится только при первом приходе.
    expect((await jobs('checkin.welcome')).length - before).toBe(1);
    expect(await arrivedToday(env.db, 'Europe/Minsk')).toBeGreaterThanOrEqual(1);
  });

  it('офлайн-отметка получает время сканирования, а не синхронизации', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const scanner = await makeStaff(env, ['scanner']);
    const scannedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const [r] = await processCheckIns(env, scanner, [event(participant.id, { offline: true, clientTs: scannedAt })]);
    expect(r!.outcome).toBe('new');
    expect(Math.abs(new Date(r!.checkedAt!).getTime() - new Date(scannedAt).getTime())).toBeLessThan(1000);
    const p = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, participant.id) });
    expect(Math.abs(p!.arrivedAt!.getTime() - new Date(scannedAt).getTime())).toBeLessThan(1000);
    // Часы устройства в будущем - время сервера.
    const { participant: other } = await makeParticipant(env, owner);
    const [f] = await processCheckIns(env, scanner, [
      event(other.id, { offline: true, clientTs: new Date(Date.now() + 3600_000).toISOString() }),
    ]);
    expect(Math.abs(new Date(f!.checkedAt!).getTime() - Date.now())).toBeLessThan(10_000);
  });

  it('событие из офлайн-очереди про удалённого человека не роняет пачку', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const scanner = await makeStaff(env, ['scanner']);
    const results = await processCheckIns(env, scanner, [
      event(987654, { offline: true }),
      event(participant.id, { offline: true }),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['not_found', 'new']);
  });

  it('«Отменить» по номеру события снимает отметку, которая успела дойти до сервера', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const scanner = await makeStaff(env, ['scanner']);
    const ev = event(participant.id);
    await processCheckIns(env, scanner, [ev]);
    expect(await revokeCheckInByEvent(env, scanner, ev.clientEventId)).toEqual({ revoked: true });
    expect(await revokeCheckInByEvent(env, scanner, ev.clientEventId)).toEqual({ revoked: false });
    expect(await revokeCheckInByEvent(env, scanner, randomUUID())).toEqual({ revoked: false });
    const p = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, participant.id) });
    expect(p!.arrivedAt).toBeNull();
  });

  it('чек на проверке: пускает и сканер - чек прислан, проверим после конференции', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner, { paymentStatus: 'pending', amountDue: '35.00' });
    const scanner = await makeStaff(env, ['scanner']);
    expect((await processCheckIns(env, scanner, [event(participant.id)]))[0]!.outcome).toBe('new');
  });
});

describe('касса', () => {
  it('повтор того же приёма не удваивает оплату; ноль не принимаем', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '45.00', amountPaid: '0' });
    const cashier = await makeStaff(env, ['cashier']);
    const requestId = randomUUID();
    const first = await markPaid(env, cashier, { participantIds: [participant.id], amount: '20', method: 'cash', requestId });
    const again = await markPaid(env, cashier, { participantIds: [participant.id], amount: '20', method: 'cash', requestId });
    expect(first.updated).toBe(1);
    expect(again).toMatchObject({ updated: 0, duplicate: true });
    expect(again.people[0]).toMatchObject({ paymentStatus: 'partial', amountPaid: '20.00' });
    expect(markPaidSchema.safeParse({ participantIds: [1], amount: '0', method: 'cash' }).success).toBe(false);
  });

  it('массово «Снять оплату» не трогает людей без взноса', async () => {
    const owner = await makeUser(env);
    const { participant: free } = await makeParticipant(env, owner, { paymentStatus: 'exempt', amountDue: '0.00' });
    const { participant: paid } = await makeParticipant(env, owner, { paymentStatus: 'paid', amountDue: '35.00', amountPaid: '35.00' });
    const admin = await makeStaff(env, ['admin']);
    const res = await bulkUpdate(env, { action: 'mark_unpaid', ids: [free.id, paid.id] }, admin);
    expect(res.updated).toBe(1);
    const rows = await env.db.query.participants.findMany({ where: (t, { inArray }) => inArray(t.id, [free.id, paid.id]) });
    expect(rows.find((r) => r.id === free.id)!.paymentStatus).toBe('exempt');
    expect(rows.find((r) => r.id === paid.id)!.paymentStatus).toBe('unpaid');
    const hist = await env.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entity, 'participant'), eq(schema.auditLog.entityId, String(paid.id))));
    expect(hist.some((h) => h.action === 'participant.bulk.mark_unpaid')).toBe(true);
    // «Отметить оплату» не превращает «без взноса» в «оплачено».
    await bulkUpdate(env, { action: 'mark_paid', ids: [free.id] }, admin);
    expect((await env.db.query.participants.findFirst({ where: eq(schema.participants.id, free.id) }))!.paymentStatus).toBe('exempt');
  });
});

describe('сообщения бота', () => {
  it('напоминание за 15 минут уходит один раз, сколько бы копий задачи ни накопилось', async () => {
    const { ctx, sent } = fakeTelegram();
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const startsAt = new Date(Date.now() + 2 * 3600_000);
    const [a] = await env.db
      .insert(schema.activities)
      .values({ title: 'Молитва', kind: 'Служение', startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), registrationMode: 'required', capacity: 10 })
      .returning();
    await env.db.insert(schema.activityRegistrations).values({ activityId: a!.id, participantId: participant.id, status: 'registered' });
    const data = { activityId: a!.id, startsAt: startsAt.toISOString() };
    await runJob(ctx, 'activity.reminder', data);
    await runJob(ctx, 'activity.reminder', data);
    await Promise.all([runJob(ctx, 'activity.reminder', data), runJob(ctx, 'activity.reminder', data)]);
    expect(sent(owner.tgId!)).toHaveLength(1);
    expect(String(sent(owner.tgId!)[0]!.payload.text)).toContain('Через 15 минут');
    // Перенесли - старая задача молчит.
    await runJob(ctx, 'activity.reminder', { activityId: a!.id, startsAt: new Date(startsAt.getTime() + 60_000).toISOString() });
    expect(sent(owner.tgId!)).toHaveLength(1);
  });

  it('пункт программы без записи (перерыв, сессия) - напоминание за 15 минут всем участникам, каждому один раз', async () => {
    const { ctx, sent } = fakeTelegram();
    const [u1, u2] = [await makeUser(env), await makeUser(env)];
    await makeParticipant(env, u1);
    await makeParticipant(env, u2);
    const startsAt = new Date(Date.now() + 20 * 60_000);
    const [a] = await env.db
      .insert(schema.activities)
      .values({ title: 'Coffee break', kind: 'Перерыв', location: 'Малый зал', startsAt, endsAt: new Date(startsAt.getTime() + 1800_000), registrationMode: 'none' })
      .returning();
    const data = { activityId: a!.id, startsAt: startsAt.toISOString() };
    await runJob(ctx, 'activity.reminder', data);
    await runJob(ctx, 'activity.reminder', data);
    for (const u of [u1, u2]) {
      expect(sent(u.tgId!)).toHaveLength(1);
      expect(String(sent(u.tgId!)[0]!.payload.text)).toContain('«<b>Coffee break</b>»');
    }
  });

  it('обед и завтрак: у кого есть - личное «Вы в списке» (одно, с именами в семье), остальным - общее', async () => {
    const { ctx, sent } = fakeTelegram();
    const [eats, family, none] = [await makeUser(env), await makeUser(env), await makeUser(env)];
    await makeParticipant(env, eats, { tier: 'fee35' });
    await makeParticipant(env, family, { tier: 'nofee', firstName: 'Аня', breakfast: false });
    await makeParticipant(env, family, { tier: 'fee10', firstName: 'Петя', breakfast: true });
    await makeParticipant(env, none, { tier: 'free' });
    const meal = async (title: string, m: 'lunch' | 'breakfast') => {
      const startsAt = new Date(Date.now() + 20 * 60_000 + Math.random() * 60_000);
      const [a] = await env.db
        .insert(schema.activities)
        .values({ title, kind: 'Перерыв', location: 'Столовая', startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), registrationMode: 'none', meal: m })
        .returning();
      const data = { activityId: a!.id, startsAt: startsAt.toISOString() };
      await runJob(ctx, 'activity.reminder', data);
      await runJob(ctx, 'activity.reminder', data);
    };
    const last = (u: { tgId: number | null }) => String(sent(u.tgId!).at(-1)!.payload.text);

    await meal('Обед', 'lunch');
    for (const u of [eats, family, none]) expect(sent(u.tgId!)).toHaveLength(1);
    expect(last(eats)).toContain('Вы в списке на обед - не забудьте браслет');
    expect(last(eats)).not.toContain('Для:');
    expect(last(family)).toContain('Вы в списке на обед');
    expect(last(family)).toContain('Для: Аня');
    expect(last(family)).not.toContain('Петя');
    expect(last(none)).toContain('⏰ Через 15 минут - «<b>Обед</b>»');
    expect(last(none)).not.toContain('Вы в списке');

    await meal('Завтрак', 'breakfast');
    for (const u of [eats, family, none]) expect(sent(u.tgId!)).toHaveLength(2);
    expect(last(family)).toContain('Вы в списке на завтрак');
    expect(last(family)).toContain('Для: Петя');
    expect(last(family)).not.toContain('браслет');
    expect(last(eats)).not.toContain('Вы в списке');
  });

  it('приветствие на входе одно; без расписания - без кнопки', async () => {
    const { ctx, sent } = fakeTelegram();
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    await setSettings({ scheduleVisible: false });
    await runJob(ctx, 'checkin.welcome', { participantId: participant.id });
    await runJob(ctx, 'checkin.welcome', { participantId: participant.id });
    await setSettings({ scheduleVisible: true });
    expect(sent(owner.tgId!)).toHaveLength(1);
    expect(sent(owner.tgId!)[0]!.payload.reply_markup).toBeUndefined();
    expect(String(sent(owner.tgId!)[0]!.payload.text)).toContain('добро пожаловать');
  });

  it('смена места у мероприятия - сообщение записанным', async () => {
    const { ctx, sent } = fakeTelegram();
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const startsAt = new Date(Date.now() + 3600_000);
    const [a] = await env.db
      .insert(schema.activities)
      .values({ title: 'Сессия', kind: 'Сессия', location: 'Малый зал', startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), registrationMode: 'required' })
      .returning();
    await env.db.insert(schema.activityRegistrations).values({ activityId: a!.id, participantId: participant.id, status: 'registered' });
    const admin = await makeStaff(env, ['admin']);
    const { updateActivity } = await import('../src/services/activity.service.ts');
    await updateActivity(env, a!.id, { location: '324 ауд. ТИ' }, admin);
    const changed = (await jobs('activity.changed')).filter((j) => j.activityId === a!.id);
    expect(changed.at(-1)).toMatchObject({ change: 'place' });
    await runJob(ctx, 'activity.changed', { activityId: a!.id, change: 'place' });
    expect(String(sent(owner.tgId!)[0]!.payload.text)).toContain('в другом месте');
  });

  it('отмена участия админом - сообщение; возврат - новый QR', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const admin = await makeStaff(env, ['admin']);
    await updateParticipant(env, participant.id, { status: 'cancelled' }, admin);
    const notes = await jobs('notify.text');
    expect(notes.some((n) => n.userId === owner.id && String(n.text).includes('Регистрация отменена'))).toBe(true);
    await updateParticipant(env, participant.id, { status: 'active' }, admin);
    const tickets = await jobs('tickets.send');
    expect(tickets.at(-1)).toMatchObject({ userId: owner.id, participantIds: [participant.id], reason: 'restored' });
  });

  it('отложенная рассылка «не пришли» берёт получателей в момент отправки', async () => {
    const { ctx, sent } = fakeTelegram();
    const admin = await makeStaff(env, ['admin']);
    const a = await makeUser(env);
    const b = await makeUser(env);
    await makeParticipant(env, a);
    const { participant: pb } = await makeParticipant(env, b);
    const view = await createBroadcast(
      env,
      { text: 'Ждём вас!', segment: { kind: 'not_arrived' }, test: false, alsoAnnouncement: false, scheduledAt: new Date(Date.now() + 3600_000).toISOString() },
      admin,
    );
    // Пока ждали отправки, b пришёл.
    await env.db.update(schema.participants).set({ arrivedAt: new Date() }).where(eq(schema.participants.id, pb.id));
    await runJob(ctx, 'broadcast.run', { broadcastId: view.id });
    expect(sent(a.tgId!)).toHaveLength(1);
    expect(sent(b.tgId!)).toHaveLength(0);
  });
});

describe('настройки и схемы', () => {
  it('сохранение настроек трогает только присланные поля', async () => {
    await setSettings({ counselingOpen: true });
    await setSettings({ welcomeText: 'Привет!' });
    const s = await getSettings(env.db, { fresh: true });
    expect(s.counselingOpen).toBe(true);
    expect(s.welcomeText).toBe('Привет!');
  });

  it('правка точки не включает её обратно', () => {
    expect(checkpointUpdateSchema.parse({ name: 'Вход 2' })).toEqual({ name: 'Вход 2' });
  });

  it('возраст считается на день начала по часам конференции', async () => {
    const s = await getSettings(env.db, { fresh: true });
    expect(ageRefDate({ ...s, eventStartsAt: '2026-11-05T21:00:00.000Z', eventTimezone: 'Europe/Minsk' })).toBe('2026-11-06');
  });
});
