import { randomUUID } from 'node:crypto';
import { guestRegistrationSchema, type GuestRegistration } from '@sof/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { participantRows } from '../src/services/admin.service.ts';
import { findForPayment } from '../src/services/checkin.service.ts';
import { getMe, updateOwnParticipant } from '../src/services/participants.service.ts';
import { submitGuestRegistration } from '../src/services/registration.service.ts';
import { invalidateSettingsCache, patchSettings } from '../src/services/settings.service.ts';
import { makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let actorId = 0;
beforeAll(async () => {
  env = await setupTestEnv();
  actorId = (await makeUser(env, 'Настройщик')).id;
});
afterAll(async () => env?.teardown());

const setSettings = async (patch: Parameters<typeof patchSettings>[1]) => {
  await patchSettings(env.db, patch, actorId);
  invalidateSettingsCache();
};
let phoneSeq = 1000000;
const guest = (over: Partial<GuestRegistration> = {}): GuestRegistration =>
  guestRegistrationSchema.parse({
    idempotencyKey: randomUUID(),
    lastName: 'Гостева',
    firstName: 'Оля',
    phone: `+37529${++phoneSeq}`,
    gender: 'f',
    consent: { pd: true, documentVersion: 'v1' },
    ...over,
  });

describe('регистрация «Гость» на месте', () => {
  it('выключена - отказ; включена - «Только взнос» 10 руб., без питания, только за себя, с меткой «на месте»', async () => {
    const user = await makeUser(env);
    await setSettings({ onSiteRegistration: false });
    await expect(submitGuestRegistration(env, user, guest())).rejects.toMatchObject({ code: 'registration_closed' });

    // Даты регистрации уже прошли - на месте всё равно можно.
    await setSettings({ onSiteRegistration: true, registrationClosesAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect((await getMe(env, user)).registration).toMatchObject({ open: true, onSite: true });
    const res = await submitGuestRegistration(env, user, guest());
    expect(res.created).toHaveLength(1);
    const [p] = await env.db.select().from(schema.participants).where(eq(schema.participants.id, res.created[0]!.id));
    expect(p).toMatchObject({
      tier: 'fee10',
      breakfast: false,
      relation: 'self',
      amountDue: '10.00',
      paymentStatus: 'unpaid',
      onSite: true,
      birthDate: null,
      city: null,
    });

    // Гость правит фамилию без даты рождения и города - можно; вариант и завтрак - нет.
    const renamed = await updateOwnParticipant(env, user, p!.id, { lastName: 'Гостева-Новая' });
    expect(renamed).toMatchObject({ lastName: 'Гостева-Новая', onSite: true, birthDate: null });
    await expect(updateOwnParticipant(env, user, p!.id, { tier: 'fee35' })).rejects.toMatchObject({ code: 'guest_tier' });
    await expect(updateOwnParticipant(env, user, p!.id, { breakfast: true })).rejects.toMatchObject({ code: 'guest_tier' });

    // Второй раз за себя - нельзя.
    await expect(submitGuestRegistration(env, user, guest())).rejects.toMatchObject({ code: 'self_exists' });

    // Гость без даты рождения не ломает таблицу админки и кассу.
    const row = (await participantRows(env)).find((r) => r.id === p!.id)!;
    expect(row).toMatchObject({ onSite: true, age: null, under16: false, city: null });
    const card = await findForPayment(env.db, { participantId: p!.id });
    expect(card.found && card.card.age).toBeNull();
    await setSettings({ onSiteRegistration: false, registrationClosesAt: null });
  });

  it('повтор того же запроса не создаёт второго; тот же человек с другого аккаунта - «уже зарегистрировал(а)»', async () => {
    await setSettings({ onSiteRegistration: true });
    const user = await makeUser(env);
    const body = guest({ lastName: 'Повторов', firstName: 'Петя', gender: 'm' });
    const a = await submitGuestRegistration(env, user, body);
    const b = await submitGuestRegistration(env, user, body);
    expect(b.created.map((c) => c.id)).toEqual(a.created.map((c) => c.id));
    const other = await makeUser(env);
    await expect(submitGuestRegistration(env, other, { ...body, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'registered_by_other',
    });
    await setSettings({ onSiteRegistration: false });
  });
});
