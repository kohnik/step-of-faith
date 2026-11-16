import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userWrites } from '../src/services/chat.service.ts';
import { staffOverview } from '../src/services/overview.service.ts';
import { makeParticipant, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

describe('статистика для команды', () => {
  it('регистрации за сегодня, кто едет, варианты и что требует внимания', async () => {
    const owner = await makeUser(env);
    await makeParticipant(env, owner, { city: 'Минск', church: 'Благодать', gender: 'f', birthDate: '2012-01-01', tier: 'fee35', breakfast: true });
    await makeParticipant(env, owner, { city: ' минск ', church: 'благодать', gender: 'm', birthDate: '1990-05-05', tier: 'fee35' });
    await makeParticipant(env, owner, { city: 'Брест', gender: 'm', birthDate: '2009-03-03', tier: 'fee10', breakfast: true });
    await makeParticipant(env, owner, { city: 'Гродно', gender: 'f', birthDate: '2004-07-07', tier: 'fee35', status: 'cancelled' });
    await userWrites(env.db, owner, 'Во сколько начало?');

    const o = await staffOverview(env);
    expect(o.registrations).toMatchObject({ participants: 3, accounts: 1, cancelled: 1, today: 3, week: 3 });
    expect(o.registrations.byDay).toHaveLength(14);
    expect(o.registrations.byDay.at(-1)!.n).toBe(3);

    // «Минск» и « минск » - один город.
    expect(o.people.cities[0]).toEqual({ name: expect.stringMatching(/^[Мм]инск$/), n: 2 });
    expect(o.people.citiesTotal).toBe(2);
    expect(o.people.churches).toHaveLength(1);
    expect(o.people.gender).toEqual({ m: 2, f: 1 });
    expect(o.people.ages).toEqual({ under16: 1, from16to17: 1, from18to25: 0, over25: 1 });

    expect(o.tiers.find((t) => t.tier === 'fee35')).toMatchObject({ total: 2, limit: 250, label: expect.any(String) });
    expect(o.tiers.find((t) => t.tier === 'fee10')).toMatchObject({ total: 1, limit: null });
    // Обед и ужин - у всех с чёрным браслетом (здесь - вариант за 35); завтрак - по галочке, в том числе к «Только взнос». Отменённые не считаем.
    expect(o.meals).toEqual({
      lunchDinner: 2,
      breakfast: 2,
      breakfastLimit: 100,
      bracelets: { black: { total: 2, arrived: expect.any(Number) }, white: { total: 1, arrived: expect.any(Number) } },
    });
    expect(o.arrival.flow).toHaveLength(12);
    expect(o.counseling).toBeNull();
    expect(o.attention).toMatchObject({ openQuestions: 1, duplicates: 0 });
  });
});
