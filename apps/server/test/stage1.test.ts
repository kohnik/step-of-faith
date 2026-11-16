import { randomUUID } from 'node:crypto';
import { registrationSubmitSchema, type ParticipantInputRaw } from '@sof/shared';
import { eq, sql } from 'drizzle-orm';
import { GrammyError, type Api } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { rememberMessages, wipeChat } from '../src/lib/message-tracking.ts';
import { deleteActivity, registerForActivity, staffEnroll } from '../src/services/activity.service.ts';
import { updateParticipant } from '../src/services/admin.service.ts';
import { wipeDatabase } from '../src/services/dev.service.ts';
import { getMe, updateOwnParticipant } from '../src/services/participants.service.ts';
import { submitRegistration } from '../src/services/registration.service.ts';
import { getSettings, invalidateSettingsCache, updateSettings } from '../src/services/settings.service.ts';
import { setRoles } from '../src/services/staff.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let actorId = 0;
beforeAll(async () => {
  env = await setupTestEnv();
  actorId = (await makeUser(env, 'Настройщик')).id;
});
afterAll(async () => env?.teardown());

async function setSettings(patch: Record<string, unknown>) {
  const s = await getSettings(env.db, { fresh: true });
  await updateSettings(env.db, { ...s, ...patch } as typeof s, actorId);
  invalidateSettingsCache();
}

async function makeActivity(over: Partial<typeof schema.activities.$inferInsert> = {}) {
  const [a] = await env.db
    .insert(schema.activities)
    .values({
      title: 'Семинар',
      kind: 'Семинар',
      startsAt: new Date(Date.now() + 24 * 3600_000),
      endsAt: new Date(Date.now() + 25 * 3600_000),
      registrationMode: 'required',
      capacity: 10,
      ...over,
    })
    .returning();
  return a!;
}

async function jobs(name: string) {
  return (await env.pool.query<{ data: Record<string, unknown> }>(`select data from pgboss.job where name = $1`, [name])).rows.map(
    (r) => r.data,
  );
}

let phoneSeq = 1000;
const person = (lastName: string, over: Partial<ParticipantInputRaw> = {}): ParticipantInputRaw => ({
  lastName,
  firstName: 'Тест',
  middleName: null,
  birthDate: '2000-01-01',
  gender: 'm',
  city: 'Минск',
  church: 'Благодать',
  phone: `+37529${String(++phoneSeq).padStart(7, '0')}`,
  relation: 'self',
  tier: 'fee35',
  paymentMethod: 'cash',
  ...over,
});
const submit = (participants: ParticipantInputRaw[]) =>
  registrationSubmitSchema.parse({ idempotencyKey: randomUUID(), participants, consent: { pd: true, documentVersion: 'x' } });

describe('запись на мероприятия выключателем', () => {
  it('до открытия - not_open; волонтёр записывает и при закрытой записи', async () => {
    await setSettings({ activityRegistrationOpen: false });
    const a = await makeActivity();
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const res = await registerForActivity(env, owner, a.id, participant.id);
    expect(res.outcome).toBe('not_open');

    const admin = await makeStaff(env, ['admin']);
    expect((await staffEnroll(env, admin, a.id, participant.id)).outcome).toBe('registered');

    await setSettings({ activityRegistrationOpen: true });
    const { participant: other } = await makeParticipant(env, owner);
    expect((await registerForActivity(env, owner, a.id, other.id)).outcome).toBe('registered');
  });
});

describe('удаление мероприятия', () => {
  it('удаляет записи и сообщает записавшимся', async () => {
    await setSettings({ activityRegistrationOpen: true });
    const a = await makeActivity({ title: 'Удаляемый' });
    const owner = await makeUser(env, 'Оля');
    const { participant } = await makeParticipant(env, owner);
    await registerForActivity(env, owner, a.id, participant.id);
    const admin = await makeStaff(env, ['admin']);

    const res = await deleteActivity(env, admin, a.id);
    expect(res.notified).toBe(1);
    expect(await env.db.query.activities.findFirst({ where: eq(schema.activities.id, a.id) })).toBeUndefined();
    const regs = await env.db.select().from(schema.activityRegistrations).where(eq(schema.activityRegistrations.activityId, a.id));
    expect(regs).toHaveLength(0);
    const notes = await jobs('notify.text');
    expect(notes.some((n) => n.userId === owner.id && String(n.text).includes('Удаляемый'))).toBe(true);
  });

  it('если на нём уже отмечали людей - нельзя, только отменить', async () => {
    const a = await makeActivity({ title: 'С отметками' });
    const [cp] = await env.db.insert(schema.checkpoints).values({ kind: 'activity', name: a.title, activityId: a.id }).returning();
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const admin = await makeStaff(env, ['admin']);
    await env.db.insert(schema.checkIns).values({
      checkpointId: cp!.id,
      participantId: participant.id,
      clientEventId: randomUUID(),
      scannedBy: admin.user.id,
      method: 'scan',
      deviceId: 'test',
      clientTs: new Date(),
    } as typeof schema.checkIns.$inferInsert);
    await expect(deleteActivity(env, admin, a.id)).rejects.toMatchObject({ code: 'has_checkins' });
  });
});

describe('лимиты вариантов', () => {
  it('последнее место в варианте достаётся одному, дальше - tier_full', async () => {
    const s = await getSettings(env.db, { fresh: true });
    const used = await env.db.execute<{ n: number }>(sql`select count(*)::int as n from participants where tier = 'fee35' and status = 'active'`);
    await setSettings({ tiers: { ...s.tiers, fee35: { ...s.tiers.fee35, limit: used.rows[0]!.n + 1 } } });

    const a = await makeUser(env);
    const b = await makeUser(env);
    const results = await Promise.allSettled([
      submitRegistration(env, a, submit([person('Гонкин')])),
      submitRegistration(env, b, submit([person('Гонкина', { gender: 'f' })])),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'tier_full' });

    // Другой вариант по-прежнему доступен.
    const c = await makeUser(env);
    const ok = await submitRegistration(env, c, submit([person('Взносов', { tier: 'fee10' })]));
    expect(ok.created).toHaveLength(1);
    await setSettings({ tiers: s.tiers });
  });

  it('последний завтрак достаётся одному, дальше - breakfast_full; без завтрака регистрируют', async () => {
    const s = await getSettings(env.db, { fresh: true });
    const used = await env.db.execute<{ n: number }>(sql`select count(*)::int as n from participants where breakfast and status = 'active'`);
    await setSettings({ breakfast: { ...s.breakfast, limit: used.rows[0]!.n + 1 } });

    const a = await makeUser(env);
    const b = await makeUser(env);
    const results = await Promise.allSettled([
      submitRegistration(env, a, submit([person('Завтраков', { tier: 'fee10', breakfast: true })])),
      submitRegistration(env, b, submit([person('Завтракова', { gender: 'f', breakfast: true })])),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'breakfast_full' });

    // Без завтрака места есть.
    const c = await makeUser(env);
    expect((await submitRegistration(env, c, submit([person('Беззавтраков')]))).created).toHaveLength(1);
    // К «Без взноса» завтрак не ставится и лимит не занимает.
    const d = await makeUser(env);
    const free = await submitRegistration(env, d, submit([person('Бесплатнов', { tier: 'nofee', paymentMethod: null, breakfast: true })]));
    const row = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, free.created[0]!.id) });
    expect(row).toMatchObject({ tier: 'nofee', breakfast: false, amountDue: '0.00', paymentStatus: 'exempt' });
    await setSettings({ breakfast: s.breakfast });
  });

  it('выключенные вариант и завтрак: новые не записываются и не переходят, у записанных остаётся, админ ставит', async () => {
    const s = await getSettings(env.db, { fresh: true });
    const early = await makeUser(env);
    const kept = await submitRegistration(env, early, submit([person('Раннев', { breakfast: true })]));
    await setSettings({ tiers: { ...s.tiers, fee35: { ...s.tiers.fee35, enabled: false } }, breakfast: { ...s.breakfast, enabled: false } });

    const late = await makeUser(env);
    await expect(submitRegistration(env, late, submit([person('Поздняков')]))).rejects.toMatchObject({ code: 'tier_closed' });
    await expect(submitRegistration(env, late, submit([person('Поздняков', { tier: 'fee10', breakfast: true })]))).rejects.toMatchObject({
      code: 'breakfast_closed',
    });
    const ok = await submitRegistration(env, late, submit([person('Поздняков', { tier: 'fee10' })]));
    expect(ok.created).toHaveLength(1);

    // Сам перейти на выключенный вариант или добавить завтрак нельзя.
    await expect(updateOwnParticipant(env, late, ok.created[0]!.id, { tier: 'fee35' })).rejects.toMatchObject({ code: 'tier_closed' });
    await expect(updateOwnParticipant(env, late, ok.created[0]!.id, { breakfast: true })).rejects.toMatchObject({ code: 'breakfast_closed' });
    // Записанный раньше со своим вариантом и завтраком остаётся и спокойно правит остальное.
    const mine = await updateOwnParticipant(env, early, kept.created[0]!.id, { city: 'Гродно' });
    expect(mine).toMatchObject({ tier: 'fee35', breakfast: true, city: 'Гродно' });
    // Организатор вручную ставит любой вариант.
    const admin = await makeStaff(env, ['admin']);
    const row = await updateParticipant(env, ok.created[0]!.id, { tier: 'fee35' }, admin);
    expect(row.tier).toBe('fee35');

    await setSettings({ tiers: s.tiers, breakfast: s.breakfast });
  });

  it('админ может поставить сверх лимита - сохраняем и предупреждаем', async () => {
    const s = await getSettings(env.db, { fresh: true });
    const owner = await makeUser(env);
    await makeParticipant(env, owner, { tier: 'fee35', breakfast: true });
    const { participant } = await makeParticipant(env, owner, { tier: 'fee10' });
    const used = await env.db.execute<{ tier: number; breakfast: number }>(sql`
      select count(*) filter (where tier = 'fee35')::int as tier, count(*) filter (where breakfast)::int as breakfast
        from participants where status = 'active'`);
    await setSettings({
      tiers: { ...s.tiers, fee35: { ...s.tiers.fee35, limit: used.rows[0]!.tier } },
      breakfast: { ...s.breakfast, limit: used.rows[0]!.breakfast },
    });
    const admin = await makeStaff(env, ['admin']);

    const row = await updateParticipant(env, participant.id, { tier: 'fee35' }, admin);
    expect(row.tier).toBe('fee35');
    expect(row.warning).toMatch(/лимит превышен/);
    const withBreakfast = await updateParticipant(env, participant.id, { breakfast: true }, admin);
    expect(withBreakfast).toMatchObject({ breakfast: true, amountDue: '45.00' });
    expect(withBreakfast.warning).toMatch(/Завтраков: \d+ из \d+ - лимит превышен/);
    // Правка без смены варианта и завтрака - без предупреждения.
    expect((await updateParticipant(env, participant.id, { city: 'Гродно' }, admin)).warning).toBeUndefined();
    await setSettings({ tiers: s.tiers, breakfast: s.breakfast });
  });

  it('/api/me показывает остаток мест и завтраков', async () => {
    const s = await getSettings(env.db, { fresh: true });
    await setSettings({ tiers: { ...s.tiers, fee35: { ...s.tiers.fee35, limit: 500 } }, breakfast: { ...s.breakfast, limit: 400 } });
    const user = await makeUser(env);
    const me = await getMe(env, user);
    const used = await env.db.execute<{ tier: number; breakfast: number }>(sql`
      select count(*) filter (where tier = 'fee35')::int as tier, count(*) filter (where breakfast)::int as breakfast
        from participants where status = 'active'`);
    expect(me.registration.tierLeft.fee35).toBe(500 - used.rows[0]!.tier);
    expect(me.registration.tierLeft.fee10).toBeUndefined();
    expect(me.registration.breakfastLeft).toBe(400 - used.rows[0]!.breakfast);
    await setSettings({ tiers: s.tiers, breakfast: s.breakfast });
  });
});

describe('главные администраторы', () => {
  it('роль суперадмина у главного не снимается, а очистка базы его сохраняет', async () => {
    const lavor = await makeUser(env, 'Лавор');
    await env.db.insert(schema.staffRoles).values({ userId: lavor.id, role: 'superadmin' });
    (env.config.SUPERADMIN_TG_IDS as number[]).push(lavor.tgId!);
    const boss = await makeStaff(env, ['superadmin']);
    await expect(setRoles(env, lavor.id, ['admin'], boss)).rejects.toMatchObject({ code: 'permanent_superadmin' });

    // Переписка: свежие номера удалим, сообщение трёхдневной давности Telegram удалить не даст - его не берём.
    await rememberMessages(env.db, lavor.tgId!, [75, 77, 76]);
    await rememberMessages(env.db, lavor.tgId!, [77]);
    await env.db.insert(schema.chatMessages).values({ chatId: lavor.tgId!, messageId: 5, at: new Date(Date.now() - 72 * 3600_000) });
    const res = await wipeDatabase(env, boss.user.id);
    expect(res.chats.find((c) => c.tgId === lavor.tgId)?.messageIds).toEqual([77, 76, 75]);
    expect(await env.db.select().from(schema.chatMessages)).toHaveLength(0);
    const kept = await env.db.query.users.findFirst({ where: eq(schema.users.id, lavor.id) });
    expect(kept).toBeTruthy();
    const roles = await env.db.select().from(schema.staffRoles).where(eq(schema.staffRoles.userId, lavor.id));
    expect(roles.map((r) => r.role)).toEqual(['superadmin']);
  });

  it('очистка чата: пачки по 100 от новых; пачку с неудаляемым сообщением делит пополам', async () => {
    const deleted = new Set<number>();
    let requests = 0;
    const api = {
      unpinAllChatMessages: async () => true,
      deleteMessages: async (_chatId: number, ids: number[]) => {
        requests += 1;
        // Как Telegram: одно сообщение удалить нельзя - отказ всей пачке.
        if (ids.includes(150)) {
          throw new GrammyError("Call to 'deleteMessages' failed!", { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }, 'deleteMessages', {});
        }
        for (const id of ids) deleted.add(id);
        return true;
      },
    } as unknown as Api;
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const ok = await wipeChat(api, 42, ids, { pauseMs: 0 });
    expect(ok).toBe(249);
    expect(deleted.has(150)).toBe(false);
    expect(deleted.size).toBe(249);
    // 3 пачки, одна из них разделена до одного сообщения - это ещё ~14 запросов, а не 100.
    expect(requests).toBeLessThan(20);
  });

  it('номера сообщений запоминаются без повторов и только для личных чатов', async () => {
    await rememberMessages(env.db, 555, [10, 11]);
    await rememberMessages(env.db, 555, [11, 12]);
    await rememberMessages(env.db, -100123, [1]);
    const rows = await env.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.chatId, 555));
    expect(rows.map((r) => r.messageId).sort()).toEqual([10, 11, 12]);
    expect(await env.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.chatId, -100123))).toHaveLength(0);
  });
});
