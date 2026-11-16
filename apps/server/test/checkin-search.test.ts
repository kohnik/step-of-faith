import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchParticipants } from '../src/services/checkin.service.ts';
import { makeParticipant, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

describe('поиск человека на входе и в кассе', () => {
  it('по фамилии, по телефону с плюсом и пробелами, по куску номера', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner, { lastName: 'Ёжикова', firstName: 'Анна', phone: '+375297503291' });
    const ids = async (q: string) => (await searchParticipants(env.db, q, null)).map((c) => c.id);
    expect(await ids('ежик')).toContain(participant.id);
    expect(await ids('Ёжикова Анна')).toContain(participant.id);
    expect(await ids('+375 29 750-32-91')).toContain(participant.id);
    expect(await ids('+37529750')).toContain(participant.id);
    expect(await ids('7503291')).toContain(participant.id);
    expect(await ids('Ёжикова 3291')).toContain(participant.id);
    expect(await ids('Петрова')).not.toContain(participant.id);
  });
});
