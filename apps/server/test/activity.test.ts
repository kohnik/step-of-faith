import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { makeParticipant, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

async function makeActivity(capacity: number | null, waitlist = true) {
  const [a] = await env.db
    .insert(schema.activities)
    .values({
      title: 'Семинар',
      startsAt: new Date(Date.now() + 24 * 3600_000),
      endsAt: new Date(Date.now() + 25 * 3600_000),
      registrationMode: 'required',
      capacity,
      waitlistEnabled: waitlist,
    })
    .returning();
  return a!;
}

async function register(activityId: number, participantId: number): Promise<string> {
  const r = await env.db.execute<{ r: string }>(sql`select register_activity(${activityId}, ${participantId}, null) as r`);
  return r.rows[0]!.r;
}

describe('activity registration under concurrency', () => {
  it('200 simultaneous sign-ups for 30 seats: exactly 30 registered, 170 on the waitlist', async () => {
    const activity = await makeActivity(30);
    const owner = await makeUser(env);
    const people = await Promise.all(Array.from({ length: 200 }, () => makeParticipant(env, owner)));
    const outcomes = await Promise.all(people.map(({ participant }) => register(activity.id, participant.id)));
    expect(outcomes.filter((o) => o === 'registered')).toHaveLength(30);
    expect(outcomes.filter((o) => o === 'waitlist')).toHaveLength(170);

    const counts = await env.db.execute<{ status: string; n: number }>(
      sql`select status, count(*)::int as n from activity_registrations where activity_id = ${activity.id} group by status`,
    );
    expect(Object.fromEntries(counts.rows.map((r) => [r.status, r.n]))).toEqual({ registered: 30, waitlist: 170 });
  });

  it('double tap is idempotent', async () => {
    const activity = await makeActivity(5);
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => register(activity.id, participant.id)));
    expect(outcomes.filter((o) => o === 'registered')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_registered')).toHaveLength(9);
  });

  it('cancel promotes the earliest waitlisted person; concurrent cancels never overbook', async () => {
    const activity = await makeActivity(3);
    const owner = await makeUser(env);
    const people: (typeof schema.participants.$inferSelect)[] = [];
    for (let i = 0; i < 8; i++) people.push((await makeParticipant(env, owner)).participant);
    for (const p of people) await register(activity.id, p.id);
    // Места: 0,1,2; лист ожидания по порядку: 3..7.
    const res = await Promise.all(
      [0, 1].map((i) =>
        env.db.execute<{ was_cancelled: boolean; promoted: string[] }>(
          sql`select * from cancel_activity_registration(${activity.id}, ${people[i]!.id})`,
        ),
      ),
    );
    const promoted = res.flatMap((r) => r.rows[0]!.promoted.map(Number)).sort((a, b) => a - b);
    expect(promoted).toEqual([people[3]!.id, people[4]!.id]);

    const reg = await env.db.execute<{ n: number }>(
      sql`select count(*)::int as n from activity_registrations where activity_id = ${activity.id} and status = 'registered'`,
    );
    expect(reg.rows[0]!.n).toBe(3);
  });

  it('full without waitlist, re-registration after cancel, closed and age limits', async () => {
    const activity = await makeActivity(1, false);
    const owner = await makeUser(env);
    const a = (await makeParticipant(env, owner)).participant;
    const b = (await makeParticipant(env, owner)).participant;
    expect(await register(activity.id, a.id)).toBe('registered');
    expect(await register(activity.id, b.id)).toBe('full');
    await env.db.execute(sql`select * from cancel_activity_registration(${activity.id}, ${a.id})`);
    expect(await register(activity.id, b.id)).toBe('registered');
    expect(await register(activity.id, a.id)).toBe('full');

    const kids = await makeActivity(null);
    await env.db.update(schema.activities).set({ maxAge: 12 }).where(eq(schema.activities.id, kids.id));
    expect(await register(kids.id, a.id)).toBe('age_restricted');
    const child = (await makeParticipant(env, owner, { birthDate: `${new Date().getFullYear() - 8}-06-01` })).participant;
    expect(await register(kids.id, child.id)).toBe('registered');

    await env.db.update(schema.activities).set({ status: 'cancelled' }).where(eq(schema.activities.id, kids.id));
    expect(await register(kids.id, a.id)).toBe('closed');
  });
});

describe('parallel activities and switching', () => {
  const base = Date.now() + 3 * 24 * 3600_000;
  async function act(startMin: number, endMin: number, capacity: number | null, waitlist = true) {
    const [a] = await env.db
      .insert(schema.activities)
      .values({
        title: `Семинар ${startMin}`,
        startsAt: new Date(base + startMin * 60_000),
        endsAt: new Date(base + endMin * 60_000),
        registrationMode: 'required',
        capacity,
        waitlistEnabled: waitlist,
      })
      .returning();
    return a!;
  }
  const status = async (activityId: number, participantId: number) =>
    (
      await env.db.execute<{ status: string }>(
        sql`select status from activity_registrations where activity_id = ${activityId} and participant_id = ${participantId}`,
      )
    ).rows[0]?.status;
  const switchTo = async (from: number, to: number, pid: number) =>
    (
      await env.db.execute<{ outcome: string; promoted: string[] }>(
        sql`select * from switch_activity(${from}::bigint, ${to}::bigint, ${pid}::bigint, null::bigint)`,
      )
    ).rows[0]!;

  it('four seminars at the same time: a second one is a time_conflict, a later one is fine', async () => {
    const owner = await makeUser(env);
    const p = (await makeParticipant(env, owner)).participant;
    const [a, b, c, d] = await Promise.all([act(0, 60, 10), act(0, 60, 10), act(30, 90, 10), act(60, 120, 10)]);
    expect(await register(a!.id, p.id)).toBe('registered');
    expect(await register(b!.id, p.id)).toBe('time_conflict');
    expect(await register(c!.id, p.id)).toBe('time_conflict');
    expect(await register(d!.id, p.id)).toBe('registered'); // начинается ровно когда кончается A
  });

  it('switch moves the person and hands the old seat to the first in the waitlist', async () => {
    const owner = await makeUser(env);
    const p1 = (await makeParticipant(env, owner)).participant;
    const p2 = (await makeParticipant(env, owner)).participant;
    const a = await act(200, 260, 1);
    const b = await act(200, 260, 5);
    expect(await register(a.id, p1.id)).toBe('registered');
    expect(await register(a.id, p2.id)).toBe('waitlist');
    const r = await switchTo(a.id, b.id, p1.id);
    expect(r.outcome).toBe('registered');
    expect(r.promoted.map(Number)).toEqual([p2.id]);
    expect(await status(a.id, p1.id)).toBe('cancelled');
    expect(await status(b.id, p1.id)).toBe('registered');
    expect(await status(a.id, p2.id)).toBe('registered');
  });

  it('switch into a full activity changes nothing', async () => {
    const owner = await makeUser(env);
    const p1 = (await makeParticipant(env, owner)).participant;
    const p2 = (await makeParticipant(env, owner)).participant;
    const a = await act(400, 460, 5);
    const b = await act(400, 460, 1);
    expect(await register(b.id, p2.id)).toBe('registered');
    expect(await register(a.id, p1.id)).toBe('registered');
    expect((await switchTo(a.id, b.id, p1.id)).outcome).toBe('full');
    expect(await status(a.id, p1.id)).toBe('registered');
    expect(await status(b.id, p1.id)).toBeUndefined();
  });

  it('two people switching into the last seat at once: exactly one wins, the other keeps the old seat', async () => {
    const owner = await makeUser(env);
    const p1 = (await makeParticipant(env, owner)).participant;
    const p2 = (await makeParticipant(env, owner)).participant;
    const a1 = await act(600, 660, 5);
    const a2 = await act(600, 660, 5);
    const target = await act(600, 660, 1);
    await register(a1.id, p1.id);
    await register(a2.id, p2.id);
    const [r1, r2] = await Promise.all([switchTo(a1.id, target.id, p1.id), switchTo(a2.id, target.id, p2.id)]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['full', 'registered']);
    const loser = r1.outcome === 'full' ? { from: a1.id, pid: p1.id } : { from: a2.id, pid: p2.id };
    expect(await status(loser.from, loser.pid)).toBe('registered');
    const taken = await env.db.execute<{ n: number }>(
      sql`select count(*)::int as n from activity_registrations where activity_id = ${target.id} and status = 'registered'`,
    );
    expect(taken.rows[0]!.n).toBe(1);
  });
});
