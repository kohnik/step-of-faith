import { randomUUID } from 'node:crypto';
import { registrationSubmitSchema, type ParticipantInputRaw as ParticipantInput, type RegistrationSubmit } from '@sof/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { autoLinkByUsername, unlinkByHolder } from '../src/services/link.service.ts';
import { changePaymentMethod } from '../src/services/participants.service.ts';
import { submitRegistration } from '../src/services/registration.service.ts';
import { getSettings, updateSettings } from '../src/services/settings.service.ts';
import { upsertTelegramUser } from '../src/services/users.service.ts';
import { makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

const person = (lastName: string, over: Partial<ParticipantInput> = {}): ParticipantInput => ({
  lastName,
  firstName: 'Мария',
  middleName: null,
  birthDate: '1990-05-17',
  gender: 'f',
  city: 'Гродно',
  church: 'Благодать',
  phone: '+375 29 123-45-67',
  relation: 'self',
  tier: 'fee35',
  paymentMethod: 'transfer',
  ...over,
});

// Через ту же zod-схему, что и API: обрезка пробелов и проверки - как в проде.
const submit = (participants: ParticipantInput[], key = randomUUID()): RegistrationSubmit =>
  registrationSubmitSchema.parse({
    idempotencyKey: key,
    participants,
    consent: { pd: true, photo: true, documentVersion: '2026-09' },
  });

describe('registration', () => {
  it('ten identical submissions (double taps, retries) create the family exactly once', async () => {
    const user = await makeUser(env);
    const body = submit([
      person('Петрова'),
      person('Петров', { firstName: 'Павел', gender: 'm', relation: 'spouse' }),
      person('Петров', { firstName: 'Миша', gender: 'm', relation: 'child', birthDate: '2016-02-02' }),
    ]);
    const results = await Promise.all(Array.from({ length: 10 }, () => submitRegistration(env, user, body)));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.created).toHaveLength(3);

    const rows = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id) });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.firstName === 'Миша')?.category).toBe('child');
    const tickets = await env.db.select().from(schema.tickets);
    for (const r of rows) expect(tickets.filter((t) => t.participantId === r.id && t.status === 'active')).toHaveLength(1);
    const consents = await env.db.select().from(schema.consents);
    expect(consents.filter((c) => rows.some((r) => r.id === c.participantId))).toHaveLength(6);
  });

  it('same person again (new submission) is skipped, not duplicated', async () => {
    const user = await makeUser(env);
    await submitRegistration(env, user, submit([person('Сидорова')]));
    const again = await submitRegistration(env, user, submit([person('  сидорова ', { firstName: 'МАРИЯ' })]));
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toEqual([{ fullName: 'сидорова МАРИЯ', reason: 'already_registered' }]);
  });

  it('enforces the per-account limit even with parallel submissions', async () => {
    const user = await makeUser(env);
    const batch = (prefix: string) =>
      submit(Array.from({ length: 4 }, (_, i) => person(`${prefix}${i}`, { relation: 'other' })));
    const settled = await Promise.allSettled([submitRegistration(env, user, batch('А')), submitRegistration(env, user, batch('Б'))]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'too_many_participants' });
    const rows = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id) });
    expect(rows).toHaveLength(4);
  });

  it('refuses to reuse a key with a different payload', async () => {
    const user = await makeUser(env);
    const key = randomUUID();
    await submitRegistration(env, user, submit([person('Кузнецова')], key));
    await expect(submitRegistration(env, user, submit([person('Смирнова')], key))).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('enqueues ticket delivery in the same transaction', async () => {
    const user = await makeUser(env);
    const r = await submitRegistration(env, user, submit([person('Волкова')]));
    const jobs = await env.pool.query(`select data from pgboss.job where name = 'tickets.send'`);
    expect(jobs.rows.some((j) => j.data.userId === user.id && j.data.participantIds[0] === r.created[0]!.id)).toBe(true);
  });

  it('prices each person by tier and breakfast; «без взноса» counts as paid at the door', async () => {
    const user = await makeUser(env);
    await submitRegistration(
      env,
      user,
      submit([
        person('Тарифова', { tier: 'fee10', paymentMethod: 'cash', breakfast: true }),
        person('Тарифов', { firstName: 'Олег', gender: 'm', relation: 'spouse', tier: 'fee35', breakfast: true, phone: '+48 601 234 567' }),
        // Завтрак к «Без взноса» не ставится.
        person('Тарифов', {
          firstName: 'Лёша',
          gender: 'm',
          relation: 'child',
          tier: 'nofee',
          breakfast: true,
          paymentMethod: 'cash',
          phone: null,
          birthDate: '2012-01-01',
        }),
        person('Тарифов', { firstName: 'Ян', gender: 'm', relation: 'friend', tier: 'fee35', phone: '+375 29 765-43-21' }),
      ]),
    );
    const rows = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id), orderBy: (p, { asc }) => [asc(p.id)] });
    expect(rows.map((r) => [r.tier, r.breakfast, r.amountDue, r.paymentStatus, r.paymentMethod])).toEqual([
      ['fee10', true, '20.00', 'unpaid', 'cash'],
      ['fee35', true, '45.00', 'unpaid', 'transfer'],
      ['nofee', false, '0.00', 'exempt', null],
      ['fee35', false, '35.00', 'unpaid', 'transfer'],
    ]);
    expect(rows[0]!.phone).toBe('+375291234567');
    expect(rows[1]!.phone).toBe('+48601234567');
    expect(rows[0]!.church).toBe('Благодать');
  });

  it('requires consent, a phone (except kids) and a payment method for paid tiers', () => {
    const base = { idempotencyKey: randomUUID(), participants: [person('Без')] };
    expect(registrationSubmitSchema.safeParse(base).success).toBe(false);
    expect(registrationSubmitSchema.safeParse({ ...base, consent: { pd: false, documentVersion: 'x' } }).success).toBe(false);
    const withConsent = (p: ParticipantInput) => ({ ...base, participants: [p], consent: { pd: true, documentVersion: 'x' } });
    expect(registrationSubmitSchema.safeParse(withConsent(person('Без', { phone: null }))).success).toBe(false);
    expect(registrationSubmitSchema.safeParse(withConsent(person('Без', { phone: '12' }))).success).toBe(false);
    expect(registrationSubmitSchema.safeParse(withConsent(person('Без', { paymentMethod: null }))).success).toBe(false);
    expect(registrationSubmitSchema.safeParse(withConsent(person('Без', { tier: 'nofee', paymentMethod: null }))).success).toBe(true);
    expect(registrationSubmitSchema.safeParse(withConsent(person('Без', { relation: 'child', phone: null }))).success).toBe(true);
  });

  it('an old form with the removed «с завтраком» tier registers as «Взнос и питание» + breakfast', () => {
    const body = submit([person('Старова', { tier: 'fee45' as never })]);
    expect(body.participants[0]).toMatchObject({ tier: 'fee35', breakfast: true });
  });

  it('links a friend by @username when they come to the bot, and «not me» undoes it', async () => {
    const owner = await makeUser(env);
    await submitRegistration(
      env,
      owner,
      submit([person('Друзьяшкин', { firstName: 'Петя', gender: 'm', relation: 'friend', telegramUsername: '@Petya_Test1' })]),
    );
    const [row] = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, owner.id) });
    expect(row!.telegramUsername).toBe('Petya_Test1');
    expect(row!.holderUserId).toBeNull();

    const petya = await upsertTelegramUser(env.db, { id: 7_700_001, first_name: 'Петя', username: 'petya_test1' });
    expect(await autoLinkByUsername(env, petya)).toBe(1);
    const linked = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, row!.id) });
    expect(linked!.holderUserId).toBe(petya.id);
    const jobs = await env.pool.query(`select data from pgboss.job where name = 'tickets.send'`);
    expect(jobs.rows.some((j) => j.data.userId === petya.id && j.data.reason === 'linked')).toBe(true);

    expect(await unlinkByHolder(env, petya, row!.id)).toBe(true);
    const after = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, row!.id) });
    expect(after!.holderUserId).toBeNull();
    expect(after!.telegramUsername).toBeNull();
  });

  it('links right away when the friend is already in the bot', async () => {
    const vasya = await upsertTelegramUser(env.db, { id: 7_700_002, first_name: 'Вася', username: 'vasya_here' });
    const owner = await makeUser(env);
    await submitRegistration(env, owner, submit([person('Васин', { firstName: 'Вася', gender: 'm', relation: 'friend', telegramUsername: 'VASYA_HERE' })]));
    const [row] = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, owner.id) });
    expect(row!.holderUserId).toBe(vasya.id);
  });

  it('new prices apply to people who have not paid yet', async () => {
    const user = await makeUser(env);
    await submitRegistration(env, user, submit([person('Ценова', { tier: 'fee10' })]));
    const s = await getSettings(env.db, { fresh: true });
    await updateSettings(env.db, { ...s, tiers: { ...s.tiers, fee10: { ...s.tiers.fee10, amount: 12 } } }, 1);
    const [row] = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id) });
    expect(row!.amountDue).toBe('12.00');
    await updateSettings(env.db, s, 1);
  });

  it('a new breakfast price applies only to unpaid people with breakfast', async () => {
    const user = await makeUser(env);
    await submitRegistration(
      env,
      user,
      submit([
        person('Завтракова', { breakfast: true }),
        person('Обедов', { firstName: 'Пётр', gender: 'm', relation: 'friend', phone: '+375 29 555-00-11' }),
      ]),
    );
    const s = await getSettings(env.db, { fresh: true });
    await updateSettings(env.db, { ...s, breakfast: { ...s.breakfast, amount: 12 } }, 1);
    const due = async () =>
      (await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id), orderBy: (p, { asc }) => [asc(p.id)] })).map(
        (r) => r.amountDue,
      );
    expect(await due()).toEqual(['47.00', '35.00']);
    // Поменяли цену варианта - у тех, кто с завтраком, к оплате и вариант, и завтрак.
    await updateSettings(env.db, { ...s, breakfast: { ...s.breakfast, amount: 12 }, tiers: { ...s.tiers, fee35: { ...s.tiers.fee35, amount: 30 } } }, 1);
    expect(await due()).toEqual(['42.00', '30.00']);
    await updateSettings(env.db, s, 1);
    expect(await due()).toEqual(['45.00', '35.00']);
  });

  it('payment method can be switched after registration until the fee is paid', async () => {
    const user = await makeUser(env);
    await submitRegistration(env, user, submit([person('Методова', { tier: 'fee10', paymentMethod: 'transfer' })]));
    const [row] = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id) });
    const updated = await changePaymentMethod(env, user, row!.id, 'cash');
    expect(updated.paymentMethod).toBe('cash');
    const stranger = await makeUser(env);
    await expect(changePaymentMethod(env, stranger, row!.id, 'transfer')).rejects.toMatchObject({ statusCode: 404 });
    await env.db.update(schema.participants).set({ paymentStatus: 'paid' }).where(eq(schema.participants.id, row!.id));
    await expect(changePaymentMethod(env, user, row!.id, 'transfer')).rejects.toMatchObject({ code: 'already_paid' });
  });
});

describe('registration: pre-launch fixes', () => {
  it('a self-edit that duplicates another family member returns 409, not 500', async () => {
    const { updateOwnParticipant } = await import('../src/services/participants.service.ts');
    const user = await makeUser(env);
    const res = await submitRegistration(env, user, submit([person('Дублева'), person('Дублева', { firstName: 'Анна', relation: 'friend' })]));
    const [, second] = res.created;
    await expect(updateOwnParticipant(env, user, second!.id, { firstName: 'Мария' })).rejects.toMatchObject({ statusCode: 409, code: 'duplicate_person' });
  });

  it('an adult registered as «child» is not shown as a child', async () => {
    const user = await makeUser(env);
    const res = await submitRegistration(
      env,
      user,
      submit([
        person('Взрослова'),
        person('Взрослов', { firstName: 'Сын', gender: 'm', relation: 'child', birthDate: '1999-01-01', phone: null }),
        person('Взрослова', { firstName: 'Дочка', relation: 'child', birthDate: '2016-01-01', phone: null }),
      ]),
    );
    const rows = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id) });
    const cat = Object.fromEntries(rows.map((r) => [r.firstName, r.category]));
    expect(res.created).toHaveLength(3);
    expect(cat).toMatchObject({ Сын: 'participant', Дочка: 'child' });
  });
});
