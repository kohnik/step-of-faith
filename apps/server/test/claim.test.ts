import { createHmac, randomUUID } from 'node:crypto';
import { registrationSubmitSchema, type ClaimableResponse, type MeResponse, type ParticipantInputRaw } from '@sof/shared';
import { sign } from '@tma.js/init-data-node';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { staffEnroll, staffUnenroll } from '../src/services/activity.service.ts';
import { claim, findClaimable, phoneFromSignedContact, setVerifiedPhone } from '../src/services/claim.service.ts';
import { submitRegistration } from '../src/services/registration.service.ts';
import { getUserByTgId } from '../src/services/users.service.ts';
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

/** Ответ Telegram на requestContact: подписан ботом так же, как initData. */
function signedContact(contact: { user_id: number; phone_number: string }, token = env.config.BOT_TOKEN): string {
  const params: Record<string, string> = {
    contact: JSON.stringify({ ...contact, first_name: 'Тест' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

const tma = (tgId: number) =>
  `tma ${sign({ user: { id: tgId, first_name: 'Друг', allows_write_to_pm: true } } as never, env.config.BOT_TOKEN, new Date())}`;

const friend = (lastName: string, firstName: string, phone: string, over: Partial<ParticipantInputRaw> = {}): ParticipantInputRaw => ({
  lastName,
  firstName,
  middleName: null,
  birthDate: '2001-02-03',
  gender: 'm',
  city: 'Минск',
  church: 'Благодать',
  phone,
  relation: 'friend',
  tier: 'fee35',
  paymentMethod: 'cash',
  ...over,
});

const submit = (participants: ParticipantInputRaw[], notDuplicate = false) =>
  registrationSubmitSchema.parse({
    idempotencyKey: randomUUID(),
    participants,
    notDuplicate,
    consent: { pd: true, photo: false, documentVersion: '2026-09' },
  });

async function jobs(name: string) {
  return (await env.pool.query<{ data: Record<string, unknown> }>(`select data from pgboss.job where name = $1`, [name])).rows.map((r) => r.data);
}

describe('«Меня уже зарегистрировали»', () => {
  it('a friend registered without a nick finds himself by the phone Telegram confirms', async () => {
    const owner = await makeUser(env, 'Саша');
    await submitRegistration(env, owner, submit([friend('Петров', 'Петя', '+375 33 700-00-01')]));
    const [row] = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, owner.id) });

    const petya = await makeUser(env, 'Петя');
    expect((await findClaimable(env.db, petya)).candidates).toEqual([]); // номера ещё нет

    // Telegram присылает номер без «+»; совпадает и с номером, набранным как 80 33 …
    const verified = await setVerifiedPhone(env.db, petya, '+375337000001');
    const found = await findClaimable(env.db, verified);
    expect(found.candidates).toEqual([{ id: row!.id, fullName: 'Петров Петя', registeredBy: 'Саша' }]);

    const res = await claim(env, verified, [row!.id]);
    expect(res.claimed).toEqual([{ id: row!.id, fullName: 'Петров Петя' }]);
    const after = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, row!.id) });
    expect(after!.holderUserId).toBe(petya.id);
    expect(after!.ownerUserId).toBe(owner.id); // у записавшего всё остаётся

    const sent = await jobs('tickets.send');
    expect(sent.some((d) => d.userId === petya.id && d.reason === 'found')).toBe(true);
    const notes = await jobs('notify.text');
    expect(notes.some((d) => d.userId === owner.id && String(d.text).includes('Петров Петя'))).toBe(true);
    const audit = await env.db.query.auditLog.findFirst({
      where: and(eq(schema.auditLog.action, 'participant.link_by_phone'), eq(schema.auditLog.actorUserId, petya.id)),
    });
    expect(audit).toBeTruthy();

    // Второй раз забрать нельзя.
    await expect(claim(env, verified, [row!.id])).rejects.toMatchObject({ code: 'not_claimable' });
  });

  it('never offers someone else’s held, cancelled or own registrations, or other numbers', async () => {
    const owner = await makeUser(env, 'Оля');
    const phone = '+375447000002';
    const taken = await makeUser(env, 'Уже');
    const { participant: held } = await makeParticipant(env, owner, { phone, holderUserId: taken.id });
    const { participant: cancelled } = await makeParticipant(env, owner, { phone, status: 'cancelled' });
    const { participant: other } = await makeParticipant(env, owner, { phone: '+375447000999' });
    const me = await setVerifiedPhone(env.db, await makeUser(env), phone);
    const { participant: mine } = await makeParticipant(env, me, { phone });

    expect((await findClaimable(env.db, me)).candidates).toEqual([]);
    await expect(claim(env, me, [held.id, cancelled.id, other.id, mine.id])).rejects.toMatchObject({ code: 'not_claimable' });
    const heldAfter = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, held.id) });
    expect(heldAfter!.holderUserId).toBe(taken.id);
  });

  it('two accounts claiming the same registration at once: only one gets it', async () => {
    const owner = await makeUser(env);
    const phone = '+375297000003';
    const { participant } = await makeParticipant(env, owner, { phone });
    const a = await setVerifiedPhone(env.db, await makeUser(env), phone);
    const b = await setVerifiedPhone(env.db, await makeUser(env), phone);
    const results = await Promise.allSettled([claim(env, a, [participant.id]), claim(env, b, [participant.id])]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('accepts only a contact signed by Telegram for this very account', () => {
    const raw = signedContact({ user_id: 42, phone_number: '375291112233' });
    expect(phoneFromSignedContact(raw, env.config.BOT_TOKEN, 42)).toBe('+375291112233');
    expect(() => phoneFromSignedContact(raw, env.config.BOT_TOKEN, 43)).toThrow(/другого аккаунта/);
    const forged = signedContact({ user_id: 42, phone_number: '375291112233' }, '999:OTHER-BOT');
    expect(() => phoneFromSignedContact(forged, env.config.BOT_TOKEN, 42)).toThrow(/проверить номер/);
    expect(() => phoneFromSignedContact(raw.replace('1112233', '1112234'), env.config.BOT_TOKEN, 42)).toThrow(/проверить номер/);
  });

  it('HTTP: share the number in the Mini App, confirm, and the ticket shows up', async () => {
    const owner = await makeUser(env, 'Лена');
    await submitRegistration(env, owner, submit([friend('Кузнецова', 'Катя', '+375 25 700-00-04', { gender: 'f' })]));
    const tgId = 8_800_004;
    const auth = { authorization: tma(tgId) };

    const bad = await app.inject({ method: 'POST', url: '/api/me/phone', headers: auth, payload: { contact: 'contact=%7B%7D&auth_date=1&hash=00' } });
    expect(bad.statusCode).toBe(400);
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/me/phone',
      headers: auth,
      payload: { contact: signedContact({ user_id: tgId + 1, phone_number: '375257000004' }) },
    });
    expect(foreign.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/me/phone',
      headers: auth,
      payload: { contact: signedContact({ user_id: tgId, phone_number: '375257000004' }) },
    });
    expect(ok.statusCode).toBe(200);
    const found = ok.json() as ClaimableResponse;
    expect(found.phone).toBe('+375257000004');
    expect(found.candidates.map((c) => c.fullName)).toEqual(['Кузнецова Катя']);

    // Кэш initData не мешает: номер уже сохранён, забираем сразу.
    const claimed = await app.inject({ method: 'POST', url: '/api/me/claim', headers: auth, payload: { participantIds: [found.candidates[0]!.id] } });
    expect(claimed.statusCode).toBe(200);
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: auth })).json() as MeResponse;
    expect(me.participants.map((p) => [p.fullName, p.transferredToMe])).toEqual([['Кузнецова Катя', true]]);
    expect((await getUserByTgId(env.db, tgId))!.phone).toBe('+375257000004');
  });
});

describe('двойная регистрация', () => {
  it('registering «me» with the phone and name someone already used suggests claiming instead', async () => {
    const owner = await makeUser(env, 'Дима');
    await submitRegistration(env, owner, submit([friend('Сидоров', 'Олег', '+375 29 700-00-05')]));

    const oleg = await makeUser(env, 'Олег');
    const self = friend('СИДОРОВ', 'олег', '80 29 700 00 05', { relation: 'self', birthDate: '2001-02-04' });
    await expect(submitRegistration(env, oleg, submit([self]))).rejects.toMatchObject({
      code: 'registered_by_other',
      details: { fullName: 'Сидоров Олег', registeredBy: 'Дима' },
    });
    // Другой человек с тем же номером (например, брат) - регистрируется как обычно.
    const brother = await submitRegistration(env, oleg, submit([{ ...self, firstName: 'Игорь' }]));
    expect(brother.created).toHaveLength(1);
  });

  it('«это не я» registers anyway', async () => {
    const owner = await makeUser(env);
    await submitRegistration(env, owner, submit([friend('Смирнов', 'Иван', '+375 29 700-00-06')]));
    const ivan = await makeUser(env);
    const res = await submitRegistration(env, ivan, submit([friend('Смирнов', 'Иван', '+375 29 700-00-06', { relation: 'self' })], true));
    expect(res.created).toHaveLength(1);
  });
});

describe('запись на семинар волонтёром', () => {
  it('enrolls with the same rules and frees the seat on removal', async () => {
    const [activity] = await env.db
      .insert(schema.activities)
      .values({
        title: 'Семинар',
        startsAt: new Date(Date.now() + 24 * 3600_000),
        endsAt: new Date(Date.now() + 25 * 3600_000),
        registrationMode: 'required',
        capacity: 1,
        waitlistEnabled: true,
      })
      .returning();
    const owner = await makeUser(env);
    const { participant: a } = await makeParticipant(env, owner);
    const { participant: b } = await makeParticipant(env, owner);
    const admin = await makeStaff(env, ['admin']);

    expect((await staffEnroll(env, admin, activity!.id, a.id)).outcome).toBe('registered');
    const second = await staffEnroll(env, admin, activity!.id, b.id);
    expect(second.outcome).toBe('waitlist');
    expect(second.rows.map((r) => [r.participantId, r.status])).toEqual([
      [a.id, 'registered'],
      [b.id, 'waitlist'],
    ]);
    expect((await staffEnroll(env, admin, activity!.id, a.id)).outcome).toBe('already_registered');

    const rows = await staffUnenroll(env, admin, activity!.id, a.id);
    expect(rows.find((r) => r.participantId === b.id)?.status).toBe('registered');

    const scanner = await makeStaff(env, ['scanner']);
    await expect(staffEnroll(env, scanner, activity!.id, a.id)).rejects.toMatchObject({ statusCode: 403 });
  });
});
