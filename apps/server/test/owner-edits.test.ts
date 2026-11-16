import { randomUUID } from 'node:crypto';
import { registrationSubmitSchema } from '@sof/shared';
import { sign } from '@tma.js/init-data-node';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Api } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { runJob } from '../src/jobs/workers.ts';
import { participantRows, updateParticipant } from '../src/services/admin.service.ts';
import { createCounselor } from '../src/services/counseling.service.ts';
import { updateOwnParticipant } from '../src/services/participants.service.ts';
import { submitRegistration } from '../src/services/registration.service.ts';
import { createBlock, createTopic, listRooms, saveSeminarVotes } from '../src/services/seminar.service.ts';
import { createSession } from '../src/services/sessions.service.ts';
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

const base = Date.now() + 30 * 86_400_000;
const row = async (id: number) => (await env.db.query.participants.findFirst({ where: eq(schema.participants.id, id) }))!;
const setSettings = async (patch: Parameters<typeof patchSettings>[1]) => {
  await patchSettings(env.db, patch, actorId);
  invalidateSettingsCache();
};
const tma = (u: UserRow) => `tma ${sign({ user: { id: u.tgId!, first_name: 'Тест', allows_write_to_pm: true } } as never, env.config.BOT_TOKEN, new Date())}`;
const bearer = async (userId: number) => `Bearer ${(await createSession(env.db, userId, 'web', 1)).token}`;

/** Поддельный Telegram: запоминает метод и тело каждого вызова. */
function fakeTg() {
  const calls: { method: string; p: Record<string, unknown> }[] = [];
  let msg = 100;
  const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
  tg.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls.push({ method, p });
    const chat = { id: p.chat_id as number, type: 'private' };
    const result =
      method === 'sendPhoto'
        ? { message_id: ++msg, date: 0, chat, photo: [{ file_id: `f${msg}`, file_unique_id: `u${msg}`, width: 1, height: 1 }] }
        : method === 'sendMessage'
          ? { message_id: ++msg, date: 0, chat, text: '' }
          : true;
    return { ok: true, result } as never;
  });
  return { tg, calls };
}

const person = (over: Record<string, unknown> = {}) => ({
  lastName: `Петрова${randomUUID().slice(0, 6)}`,
  firstName: 'Мария',
  birthDate: '1990-05-06',
  gender: 'f',
  city: 'Минск',
  church: 'Благодать',
  phone: '80291234567',
  relation: 'self',
  tier: 'fee35',
  paymentMethod: 'cash',
  ...over,
});
const submit = (user: UserRow, participants: Record<string, unknown>[], sponsorOffer?: boolean) =>
  submitRegistration(
    env,
    user,
    registrationSubmitSchema.parse({
      idempotencyKey: randomUUID(),
      participants,
      consent: { pd: true, photo: false, documentVersion: '2026-09' },
      ...(sponsorOffer === undefined ? {} : { sponsorOffer }),
    }),
  );

const updatedJobs = async (participantId: number) =>
  Number(
    (
      await env.db.execute<{ n: string }>(
        sql`select count(*) as n from pgboss.job where name = 'tickets.send' and data->>'reason' = 'updated'
             and data->'participantIds' @> ${JSON.stringify([participantId])}::jsonb`,
      )
    ).rows[0]!.n,
  );

describe('сообщение после регистрации', () => {
  it('«не удаляйте чат-бот» - всегда; строка про расписание - только когда оно открыто участникам', async () => {
    const finalText = async () => {
      const user = await makeUser(env);
      const { participant } = await makeParticipant(env, user);
      const { tg, calls } = fakeTg();
      await runJob({ ...env, tg }, 'tickets.send', { userId: user.id, participantIds: [participant.id], reason: 'registered' }, randomUUID());
      return calls.filter((c) => c.method === 'sendMessage').at(-1)!.p.text as string;
    };
    await setSettings({ scheduleVisible: false });
    const hidden = await finalText();
    expect(hidden).toContain('Пожалуйста, не удаляйте чат-бот до окончания конференции!');
    expect(hidden).toContain('предусматривающие предпочтения / выбор самих участников конференции');
    expect(hidden).not.toContain('Расписание и запись на семинары');

    await setSettings({ scheduleVisible: true });
    const shown = await finalText();
    expect(shown).toContain('Расписание и запись на семинары - в приложении.');
    expect(shown).toContain('Пожалуйста, не удаляйте чат-бот до окончания конференции!');
  });
});

describe('душепопечение при скрытом расписании', () => {
  it('участник получает пустой список, команда - полный', async () => {
    const admin = await makeStaff(env, ['admin']);
    const startsAt = new Date(base + 1000 * 60_000).toISOString();
    const endsAt = new Date(base + 1060 * 60_000).toISOString();
    await createCounselor(env, { name: 'Служитель расписания', place: null, startsAt, endsAt, slotMinutes: 20, hidden: false, audience: 'all', tags: [] }, admin);
    const owner = await makeUser(env);
    await makeParticipant(env, owner);
    const get = async (u: UserRow) =>
      (await app.inject({ method: 'GET', url: '/api/counseling', headers: { authorization: tma(u) } })).json() as {
        counselors: { name: string }[];
      };

    await setSettings({ scheduleVisible: false });
    expect((await get(owner)).counselors).toEqual([]);
    expect((await get(admin.user)).counselors.some((c) => c.name === 'Служитель расписания')).toBe(true);

    await setSettings({ scheduleVisible: true });
    expect((await get(owner)).counselors.some((c) => c.name === 'Служитель расписания')).toBe(true);
  });
});

describe('«готов оплатить за другого»', () => {
  it('ставится одному: «Я» из анкеты, иначе уже зарегистрированному «Я», иначе первому', async () => {
    const withSelf = await makeUser(env);
    const r1 = await submit(withSelf, [person({ relation: 'child', firstName: 'Лёва', birthDate: '2015-01-01' }), person()], true);
    const [child, self] = await Promise.all(r1.created.map((c) => row(c.id)));
    expect(self!.relation).toBe('self');
    expect(self!.sponsorOffer).toBe(true);
    expect(child!.sponsorOffer).toBe(false);

    // Вторая анкета того же аккаунта - без «Я»: отметка уходит уже зарегистрированному «Я».
    const r2 = await submit(withSelf, [person({ relation: 'friend', firstName: 'Ольга' })], true);
    expect((await row(r2.created[0]!.id)).sponsorOffer).toBe(false);
    expect((await row(self!.id)).sponsorOffer).toBe(true);

    // Только друзья - первому из анкеты.
    const friendsOnly = await makeUser(env);
    const r3 = await submit(friendsOnly, [person({ relation: 'friend', firstName: 'Первый' }), person({ relation: 'friend', firstName: 'Второй' })], true);
    expect((await row(r3.created[0]!.id)).sponsorOffer).toBe(true);
    expect((await row(r3.created[1]!.id)).sponsorOffer).toBe(false);

    // Без галочки (и в старом клиенте, где поля нет) - ни у кого.
    const none = await makeUser(env);
    const r4 = await submit(none, [person()]);
    expect((await row(r4.created[0]!.id)).sponsorOffer).toBe(false);

    const rows = await participantRows(env, sql`p.id in (${sql.join([self!.id, r4.created[0]!.id].map((id) => sql`${id}`), sql`, `)})`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.sponsorOffer]))).toEqual({ [self!.id]: true, [r4.created[0]!.id]: false });

    // Админ может снять и поставить.
    const admin = await makeStaff(env, ['admin']);
    expect((await updateParticipant(env, self!.id, { sponsorOffer: false }, admin)).sponsorOffer).toBe(false);
  });
});

describe('завтрак у участника', () => {
  it('добавляет и снимает сам, пока не оплатил; с «Без взноса» завтрак снимается', async () => {
    const user = await makeUser(env);
    const { participant: p } = await makeParticipant(env, user, { tier: 'fee10', paymentStatus: 'unpaid', amountDue: '10.00', relation: 'self' });
    expect(await updateOwnParticipant(env, user, p.id, { breakfast: true })).toMatchObject({ breakfast: true, amountDue: '20.00', paymentStatus: 'unpaid' });
    expect(await updateOwnParticipant(env, user, p.id, { tier: 'fee35' })).toMatchObject({ breakfast: true, amountDue: '45.00' });
    expect(await updateOwnParticipant(env, user, p.id, { tier: 'nofee' })).toMatchObject({ breakfast: false, amountDue: '0.00', paymentStatus: 'exempt' });
    await updateOwnParticipant(env, user, p.id, { tier: 'fee35', breakfast: true, paymentMethod: 'cash' });
    // Оплатил - завтрак меняют только организаторы.
    await env.db.update(schema.participants).set({ paymentStatus: 'paid', amountPaid: '45.00' }).where(eq(schema.participants.id, p.id));
    await expect(updateOwnParticipant(env, user, p.id, { breakfast: false })).rejects.toMatchObject({ code: 'tier_locked' });
  });

  it('оплатил без завтрака - докупает сам: «частично», доплата за завтрак; чек на проверке - нельзя; сменить вариант - нельзя', async () => {
    const user = await makeUser(env);
    const { participant: p } = await makeParticipant(env, user, { tier: 'fee35', paymentStatus: 'paid', amountDue: '35.00', amountPaid: '35.00', relation: 'self' });
    await expect(updateOwnParticipant(env, user, p.id, { tier: 'fee10' })).rejects.toMatchObject({ code: 'tier_locked' });
    await expect(updateOwnParticipant(env, user, p.id, { tier: 'fee10', breakfast: true })).rejects.toMatchObject({ code: 'tier_locked' });
    expect(await updateOwnParticipant(env, user, p.id, { breakfast: true })).toMatchObject({
      breakfast: true,
      amountDue: '45.00',
      amountPaid: '35.00',
      paymentStatus: 'partial',
    });
    // Передумал, пока за завтрак не заплатил, - снимает сам, снова «оплачено».
    expect(await updateOwnParticipant(env, user, p.id, { breakfast: false })).toMatchObject({ breakfast: false, amountDue: '35.00', paymentStatus: 'paid' });
    // Докупил и доплатил - убрать уже только через организаторов (нужен возврат).
    await updateOwnParticipant(env, user, p.id, { breakfast: true });
    await env.db.update(schema.participants).set({ paymentStatus: 'paid', amountPaid: '45.00' }).where(eq(schema.participants.id, p.id));
    await expect(updateOwnParticipant(env, user, p.id, { breakfast: false })).rejects.toMatchObject({ code: 'tier_locked' });

    const other = await makeUser(env);
    const { participant: q } = await makeParticipant(env, other, { tier: 'fee10', paymentStatus: 'pending', amountDue: '10.00', relation: 'self' });
    await expect(updateOwnParticipant(env, other, q.id, { breakfast: true })).rejects.toMatchObject({ code: 'tier_locked', message: expect.stringContaining('на проверке') });
  });

  it('админ добавил завтрак оплатившему - «частично», доплата 10', async () => {
    const admin = await makeStaff(env, ['admin']);
    const user = await makeUser(env);
    const { participant: p } = await makeParticipant(env, user, { tier: 'fee35', paymentStatus: 'paid', amountDue: '35.00', amountPaid: '35.00' });
    expect(await updateParticipant(env, p.id, { breakfast: true }, admin)).toMatchObject({
      breakfast: true,
      amountDue: '45.00',
      amountPaid: '35.00',
      paymentStatus: 'partial',
    });
  });
});

describe('новый QR в чат при смене данных', () => {
  it('правки участника: вариант, завтрак и ФИО - одна задача на несколько быстрых правок; прочее - без задачи', async () => {
    const user = await makeUser(env);
    const { participant: p } = await makeParticipant(env, user, { tier: 'fee35', paymentStatus: 'unpaid', amountDue: '35.00', relation: 'self' });
    await updateOwnParticipant(env, user, p.id, { city: 'Гродно' });
    expect(await updatedJobs(p.id)).toBe(0);
    await updateOwnParticipant(env, user, p.id, { breakfast: true });
    await updateOwnParticipant(env, user, p.id, { firstName: 'Пётр' });
    expect(await updatedJobs(p.id)).toBe(1);
    const [job] = (
      await env.db.execute<{ data: { userId: number; participantIds: number[] }; start_after: Date }>(
        sql`select data, start_after from pgboss.job where name = 'tickets.send' and data->>'reason' = 'updated'
             and data->'participantIds' @> ${JSON.stringify([p.id])}::jsonb`,
      )
    ).rows;
    expect(job!.data).toMatchObject({ userId: user.id, participantIds: [p.id] });
    // Отправка - через полминуты: несколько правок подряд дают одно сообщение с последними данными.
    expect(new Date(job!.start_after).getTime()).toBeGreaterThan(Date.now() + 15_000);
  });

  it('правка админом: ФИО или категория - задача; оплата и пересчёт цен вариантов - нет', async () => {
    const admin = await makeStaff(env, ['admin']);
    const user = await makeUser(env);
    const { participant: p } = await makeParticipant(env, user, { tier: 'fee35', paymentStatus: 'unpaid', amountDue: '35.00' });
    await updateParticipant(env, p.id, { paymentNote: 'обещал занести', amountPaid: '10' }, admin);
    expect(await updatedJobs(p.id)).toBe(0);

    const s = await getSettings(env.db, { fresh: true });
    await setSettings({ tiers: { ...s.tiers, fee35: { ...s.tiers.fee35, amount: 36 } } });
    expect((await row(p.id)).amountDue).toBe('36.00');
    expect(await updatedJobs(p.id)).toBe(0);
    await setSettings({ tiers: s.tiers });

    await updateParticipant(env, p.id, { lastName: 'Сидоров' }, admin);
    expect(await updatedJobs(p.id)).toBe(1);

    const other = (await makeParticipant(env, user)).participant;
    await updateParticipant(env, other.id, { category: 'volunteer' }, admin);
    expect(await updatedJobs(other.id)).toBe(1);
  });

  it('tickets.send «updated»: новая подпись, прежний QR откреплён и подписан устаревшим', async () => {
    const user = await makeUser(env);
    const { participant: p } = await makeParticipant(env, user, { tier: 'fee35', paymentStatus: 'unpaid', amountDue: '35.00' });
    const { tg, calls } = fakeTg();
    const ctx = { ...env, tg };
    await runJob(ctx, 'tickets.send', { userId: user.id, participantIds: [p.id], reason: 'registered' }, randomUUID());
    const oldId = (calls.find((c) => c.method === 'pinChatMessage')!.p.message_id as number) ?? 0;
    const tracked = async () =>
      (await env.db.select().from(schema.ticketMessages).where(eq(schema.ticketMessages.participantId, p.id))).map((m) => m.messageId);
    expect(await tracked()).toEqual([oldId]);

    await env.db.update(schema.participants).set({ breakfast: true, amountDue: '45.00', firstName: 'Павел', updatedAt: new Date() }).where(eq(schema.participants.id, p.id));
    calls.splice(0);
    const jobId = randomUUID();
    await runJob(ctx, 'tickets.send', { userId: user.id, participantIds: [p.id], reason: 'updated' }, jobId);

    expect(calls.map((c) => c.method)).toEqual(['unpinChatMessage', 'editMessageCaption', 'sendMessage', 'sendPhoto', 'pinChatMessage']);
    expect(calls[0]!.p.message_id).toBe(oldId);
    expect(calls[1]!.p).toMatchObject({ message_id: oldId, caption: 'Данные изменились - актуальный QR-код ниже.' });
    const intro = calls[2]!.p.text as string;
    expect(intro).toContain('✏️ <b>Данные участника изменились</b>\nВот актуальный QR-код.');
    expect(intro).toContain('45');
    const caption = calls[3]!.p.caption as string;
    expect(caption).toContain('Павел');
    const s = await getSettings(env.db);
    expect(caption).toContain(`${s.tiers.fee35.short} + завтрак`);
    const newId = calls[4]!.p.message_id as number;
    expect(await tracked()).toEqual([newId]);

    // Повтор той же задачи ничего не шлёт и новый QR не трогает.
    calls.splice(0);
    await runJob(ctx, 'tickets.send', { userId: user.id, participantIds: [p.id], reason: 'updated' }, jobId);
    expect(calls).toEqual([]);
    expect(await tracked()).toEqual([newId]);
  });
});

describe('общий выключатель записи на семинары', () => {
  it('открывает и закрывает все блоки сразу, пишет в журнал; без права - 403', async () => {
    const admin = await makeStaff(env, ['admin']);
    const organizer = await makeStaff(env, ['organizer']);
    const rooms = await listRooms(env.db);
    const at = (m: number) => new Date(base + m * 60_000).toISOString();
    const a = await createBlock(env, { title: 'Семинар А', startsAt: at(2000), endsAt: at(2060), roomIds: [rooms[0]!.id], registrationOpen: true, hidden: false }, admin);
    const b = await createBlock(env, { title: 'Семинар Б', startsAt: at(2100), endsAt: at(2160), roomIds: [rooms[0]!.id], registrationOpen: false, hidden: false }, admin);
    const topic = (await createTopic(env, { title: 'Тема Б', host: null, description: null, hidden: false }, admin)).topics.at(-1)!;
    const states = async () =>
      Object.fromEntries(
        (await env.db.select().from(schema.seminarBlocks)).filter((x) => [a.id, b.id].includes(x.id)).map((x) => [x.id, x.registrationOpen]),
      );
    const patch = async (auth: string, open: boolean) =>
      app.inject({ method: 'PATCH', url: '/api/admin/seminars/registration', headers: { authorization: auth }, payload: { open } });

    expect((await patch(await bearer(organizer.user.id), false)).statusCode).toBe(403);
    expect(await states()).toEqual({ [a.id]: true, [b.id]: false });

    const auth = await bearer(admin.user.id);
    const opened = await patch(auth, true);
    expect(opened.statusCode).toBe(200);
    expect(await states()).toEqual({ [a.id]: true, [b.id]: true });
    expect((opened.json() as { id: number; registrationOpen: boolean }[]).every((x) => x.registrationOpen)).toBe(true);

    expect((await patch(auth, false)).statusCode).toBe(200);
    expect(await states()).toEqual({ [a.id]: false, [b.id]: false });
    const log = await env.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'seminar_block.registration_all'), eq(schema.auditLog.actorUserId, admin.user.id)));
    expect(log).toHaveLength(2);

    // Закрыто - участник тему не выбирает.
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    await expect(saveSeminarVotes(env, owner, { participantId: participant.id, topicIds: [topic.id] })).rejects.toMatchObject({
      code: 'voting_closed',
    });
  });
});
