import { sign } from '@tma.js/init-data-node';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.ts';
import { schema } from '../src/db/client.ts';
import { markPaid } from '../src/services/payment.service.ts';
import { patchSettings } from '../src/services/settings.service.ts';
import { getUserByTgId } from '../src/services/users.service.ts';
import { makeParticipant, makeStaff, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let app: FastifyInstance;
let base = '';
let listener: pg.Client;
const notes: { k: string; u?: number[] }[] = [];

beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp(env);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  listener = new pg.Client({ connectionString: env.container.getConnectionUri() });
  await listener.connect();
  listener.on('notification', (m) => notes.push(JSON.parse(m.payload!)));
  await listener.query('LISTEN sof_events');
});
afterAll(async () => {
  await listener?.end();
  await app?.close();
  await env?.teardown();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tma = (tgId: number) =>
  `tma ${sign({ user: { id: tgId, first_name: 'Поток', allows_write_to_pm: true } } as never, env.config.BOT_TOKEN, new Date())}`;

/** Открыть поток как Mini App и собирать имена событий. */
async function openStream(tgId: number) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { authorization: tma(tgId) }, signal: ctrl.signal });
  const events: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = block.split('\n').find((l) => l.startsWith('event: '));
          if (ev) events.push(ev.slice(7));
        }
      }
    } catch {
      /* закрыли */
    }
  })();
  return { status: res.status, events, close: () => ctrl.abort() };
}

describe('триггеры', () => {
  it('оплата - подсказка владельцу; откат транзакции - тишина', async () => {
    const tgId = 7_100_001;
    await fetch(`${base}/api/me`, { headers: { authorization: tma(tgId) } });
    const owner = (await getUserByTgId(env.db, tgId))!;
    const { participant: p } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '35.00' });
    const cashier = await makeStaff(env, ['cashier']);
    notes.length = 0;
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: null, note: null });
    await sleep(200);
    expect(notes).toContainEqual({ k: 'me', u: [owner.id] });

    notes.length = 0;
    await env.db
      .transaction(async (tx) => {
        await tx.update(schema.participants).set({ paymentStatus: 'unpaid' }).where(sql`id = ${p.id}`);
        throw new Error('rollback');
      })
      .catch(() => undefined);
    await sleep(200);
    expect(notes).toEqual([]);
  });

  it('настройки и программа - общие подсказки', async () => {
    notes.length = 0;
    const admin = await makeStaff(env, ['admin']);
    await patchSettings(env.db, { activityRegistrationOpen: true }, admin.user.id);
    await env.db.insert(schema.activities).values({ title: 'Т', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) });
    await sleep(200);
    const kinds = notes.map((n) => n.k);
    expect(kinds).toContain('settings');
    expect(kinds).toContain('schedule');
    expect(kinds).toContain('seminars');
  });
});

describe('поток /api/events', () => {
  it('без входа - 401; выключено или нет мест - 503 (приложение остаётся на опросе)', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
    const headers = { authorization: tma(7_100_020) };
    env.config.REALTIME_ENABLED = false;
    expect((await fetch(`${base}/api/events`, { headers })).status).toBe(503);
    env.config.REALTIME_ENABLED = true;
    const max = env.config.REALTIME_MAX_STREAMS;
    env.config.REALTIME_MAX_STREAMS = app.realtime.connections;
    expect((await fetch(`${base}/api/events`, { headers })).status).toBe(503);
    env.config.REALTIME_MAX_STREAMS = max;
  });

  it('личное - только адресату, общее - всем и не чаще раза в 2 секунды', async () => {
    const a = 7_100_010;
    const b = 7_100_011;
    const sa = await openStream(a);
    const sb = await openStream(b);
    expect(sa.status).toBe(200);
    await sleep(300);
    expect(sa.events).toEqual(['hello']);
    expect(app.realtime.connections).toBeGreaterThanOrEqual(2);

    const ownerA = (await getUserByTgId(env.db, a))!;
    const { participant: p } = await makeParticipant(env, ownerA, { paymentStatus: 'unpaid', amountDue: '35.00' });
    const cashier = await makeStaff(env, ['cashier']);
    await sleep(2200); // создание участника - тоже «me»: дождёмся и очистим
    sa.events.length = 0;
    sb.events.length = 0;
    await markPaid(env, cashier, { participantIds: [p.id], method: 'cash', amount: null, note: null });
    await sleep(300);
    expect(sa.events).toEqual(['me']);
    expect(sb.events).toEqual([]);

    // Пачка изменений программы: сразу одна подсказка, потом одна отложенная.
    for (let i = 0; i < 5; i++) {
      await env.db.insert(schema.activities).values({ title: `П${i}`, startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) });
    }
    await sleep(300);
    const first = sb.events.filter((e) => e === 'schedule').length;
    expect(first).toBe(1);
    await sleep(2200);
    expect(sb.events.filter((e) => e === 'schedule').length).toBe(2);
    expect(sa.events.filter((e) => e === 'schedule').length).toBe(2);

    sa.close();
    sb.close();
    await sleep(200);
  });
});
