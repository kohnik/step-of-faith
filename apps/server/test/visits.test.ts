import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { dashboard } from '../src/services/dashboard.service.ts';
import { recordVisit } from '../src/services/visits.service.ts';
import { makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

describe('заходы в бота и Mini App', () => {
  it('одна отметка на человека в день и источник; в сводке - разные люди за день', async () => {
    const a = await makeUser(env);
    const b = await makeUser(env);
    await recordVisit(env.db, a.id, 'bot');
    await recordVisit(env.db, a.id, 'bot');
    await recordVisit(env.db, a.id, 'app');
    await Promise.all([recordVisit(env.db, b.id, 'app'), recordVisit(env.db, b.id, 'app')]);

    expect(await env.db.select().from(schema.userVisits)).toHaveLength(3);
    const d = await dashboard(env);
    expect(d.visits).toHaveLength(14);
    expect(d.visits.at(-1)).toMatchObject({ total: 2, bot: 1, app: 2, new: 2 });
    expect(d.visits.at(-2)).toMatchObject({ total: 0, bot: 0, app: 0 });
  });
});
