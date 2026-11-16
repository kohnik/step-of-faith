import { randomUUID } from 'node:crypto';
import type { CheckInEvent } from '@sof/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { processCheckIns, revokeCheckIn } from '../src/services/checkin.service.ts';
import { updateSettings, getSettings } from '../src/services/settings.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let entranceId: number;

beforeAll(async () => {
  env = await setupTestEnv();
  const [cp] = await env.db.insert(schema.checkpoints).values({ kind: 'entrance', name: 'Вход' }).returning();
  entranceId = cp!.id;
});
afterAll(async () => env?.teardown());

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

describe('check-in under concurrency', () => {
  it('50 scanners hitting the same ticket at once produce exactly one check-in', async () => {
    const owner = await makeUser(env);
    const { participant, ticket } = await makeParticipant(env, owner);
    const scanners = await Promise.all(Array.from({ length: 5 }, (_, i) => makeStaff(env, ['scanner'], `Сканер ${i}`)));

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        processCheckIns(env, scanners[i % 5]!, [event(participant.id, { code: ticket.code })]).then((r) => r[0]!),
      ),
    );
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'new')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(49);
    // Все «повторы» видят одну и ту же отметку.
    expect(new Set(results.map((r) => r.checkInId)).size).toBe(1);

    const rows = await env.db.select().from(schema.checkIns).where(eq(schema.checkIns.participantId, participant.id));
    expect(rows).toHaveLength(1);
    const p = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, participant.id) });
    expect(p?.arrivedAt).not.toBeNull();
  });

  it('a retried request (same clientEventId) is recognised as a retry, not a duplicate', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const staff = await makeStaff(env, ['scanner']);
    const ev = event(participant.id);
    const [first] = await processCheckIns(env, staff, [ev]);
    const retries = await Promise.all(Array.from({ length: 10 }, () => processCheckIns(env, staff, [ev])));
    expect(first!.outcome).toBe('new');
    for (const [r] of retries) {
      expect(r!.outcome).toBe('retry');
      expect(r!.checkInId).toBe(first!.checkInId);
    }
  });

  it('revoke is soft and allows a fresh check-in; a late retry does not resurrect it', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const staff = await makeStaff(env, ['scanner']);
    const admin = await makeStaff(env, ['admin']);
    const ev = event(participant.id);
    const [first] = await processCheckIns(env, staff, [ev]);
    await revokeCheckIn(env, admin, first!.checkInId!);

    let p = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, participant.id) });
    expect(p?.arrivedAt).toBeNull();

    const [late] = await processCheckIns(env, staff, [ev]);
    expect(late!.outcome).toBe('check_in_undone'); // повтор отменённой - сканер не покажет «отмечен»

    const [again] = await processCheckIns(env, staff, [event(participant.id)]);
    expect(again!.outcome).toBe('new');
    p = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, participant.id) });
    expect(p?.arrivedAt).not.toBeNull();
  });

  it('scanner may revoke only own recent check-ins', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const a = await makeStaff(env, ['scanner']);
    const b = await makeStaff(env, ['scanner']);
    const [r] = await processCheckIns(env, a, [event(participant.id)]);
    await expect(revokeCheckIn(env, b, r!.checkInId!)).rejects.toMatchObject({ statusCode: 403 });
    await expect(revokeCheckIn(env, a, r!.checkInId!)).resolves.toBeUndefined();
  });

  it('unpaid tickets are stopped at the entrance unless a cashier overrides', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner, { paymentStatus: 'unpaid' } as never);
    await env.db.update(schema.participants).set({ paymentStatus: 'unpaid' }).where(eq(schema.participants.id, participant.id));
    const scanner = await makeStaff(env, ['scanner']);
    const cashier = await makeStaff(env, ['cashier']);
    const settings = await getSettings(env.db, { fresh: true });
    await updateSettings(env.db, { ...settings, paymentsEnabled: true, allowUnpaidEntry: false }, scanner.user.id);

    const [blocked] = await processCheckIns(env, scanner, [event(participant.id, { overrideUnpaid: true })]);
    expect(blocked!.outcome).toBe('unpaid');
    const [ok] = await processCheckIns(env, cashier, [event(participant.id, { overrideUnpaid: true })]);
    expect(ok!.outcome).toBe('new');
  });

  it('rejects codes that belong to someone else and revoked codes', async () => {
    const owner = await makeUser(env);
    const a = await makeParticipant(env, owner);
    const b = await makeParticipant(env, owner);
    const staff = await makeStaff(env, ['scanner']);
    const [mismatch] = await processCheckIns(env, staff, [event(a.participant.id, { code: b.ticket.code })]);
    expect(mismatch!.outcome).toBe('not_found');

    await env.db.update(schema.tickets).set({ status: 'revoked' }).where(eq(schema.tickets.id, a.ticket.id));
    const [revoked] = await processCheckIns(env, staff, [event(a.participant.id, { code: a.ticket.code })]);
    expect(revoked!.outcome).toBe('revoked_ticket');
  });
});

describe('payments switched off', () => {
  it('lets unpaid people in without any payment talk', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    await env.db.update(schema.participants).set({ paymentStatus: 'unpaid' }).where(eq(schema.participants.id, participant.id));
    const scanner = await makeStaff(env, ['scanner']);
    const settings = await getSettings(env.db, { fresh: true });
    await updateSettings(env.db, { ...settings, paymentsEnabled: false, allowUnpaidEntry: false }, scanner.user.id);
    const [r] = await processCheckIns(env, scanner, [event(participant.id)]);
    expect(r!.outcome).toBe('new');
  });

  it('до начала конференции вход не отмечается (сканер работает как касса)', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const scanner = await makeStaff(env, ['scanner'], 'Сканер ранний');
    const s = await getSettings(env.db, { fresh: true });
    await updateSettings(env.db, { ...s, eventStartsAt: new Date(Date.now() + 86_400_000).toISOString() }, owner.id);
    const [early] = await processCheckIns(env, scanner, [event(participant.id)]);
    expect(early!.outcome).toBe('before_event');
    const p = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, participant.id) });
    expect(p?.arrivedAt).toBeNull();

    await updateSettings(env.db, { ...s, eventStartsAt: new Date(Date.now() - 60_000).toISOString() }, owner.id);
    const [onTime] = await processCheckIns(env, scanner, [event(participant.id)]);
    expect(onTime!.outcome).toBe('new');
    await updateSettings(env.db, s, owner.id);
  });
});
