import { eq } from 'drizzle-orm';
import { Api } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { enqueue } from '../src/jobs/queues.ts';
import { runJob } from '../src/jobs/workers.ts';
import { botMessagesForParticipant, botRun, botRuns, botScheduled, botUnreachable } from '../src/services/bot-log.service.ts';
import { makeParticipant, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

/** Telegram-заглушка: sendMessage отвечает сообщением с тем же текстом (без разметки - как настоящий). */
function fakeTg() {
  const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
  tg.config.use(async (_prev, method, payload) => {
    const p = payload as { chat_id: number; text?: string };
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' }, text: (p.text ?? '').replace(/<[^>]+>/g, '') } } as never;
  });
  return tg;
}

describe('журнал сообщений бота', () => {
  it('каждая отправка - в журнал: вид, дошло ли, начало текста; заблокировавшему - «бот заблокирован»', async () => {
    const tg = fakeTg();
    const a = await makeUser(env);
    const b = await makeUser(env);
    await env.db.update(schema.users).set({ botBlocked: true }).where(eq(schema.users.id, b.id));
    await runJob({ ...env, tg }, 'notify.text', { userId: a.id, text: '🛍 <b>Мерч взят в долг</b>', kind: 'merch.notice' });
    await runJob({ ...env, tg }, 'notify.text', { userId: b.id, text: 'Привет', kind: 'merch.notice' });
    const rows = await env.db.select().from(schema.botMessages).where(eq(schema.botMessages.kind, 'merch.notice'));
    expect(rows.find((r) => r.userId === a.id)).toMatchObject({ outcome: 'sent', preview: '🛍 Мерч взят в долг', campaign: null });
    expect(rows.find((r) => r.userId === b.id)).toMatchObject({ outcome: 'blocked', preview: null });

    // «По одному» - группой за час: в запуске двое, один не получил.
    const run = (await botRuns(env.db)).find((r) => r.kind === 'merch.notice')!;
    expect(run).toMatchObject({ label: 'Мерч: бронь, оплата, долг', topic: 'merch', total: 2, sent: 1, failed: 1 });
    const detail = await botRun(env.db, run.key);
    expect(detail.rows.map((r) => r.outcome)).toEqual(['blocked', 'sent']);
  });

  it('массовая отправка - одним запуском (по задаче); в карточке участника видны его сообщения', async () => {
    const tg = fakeTg();
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner);
    // Две задачи «Ваши семинары» - два запуска, даже в один час.
    await runJob({ ...env, tg }, 'seminar.assigned', { participantIds: [participant.id] }, 'job-sem-1');
    await runJob({ ...env, tg }, 'seminar.assigned', { participantIds: [participant.id] }, 'job-sem-2');
    const runs = (await botRuns(env.db)).filter((r) => r.kind === 'seminar.assigned');
    expect(runs.map((r) => r.key).sort()).toEqual(['c:seminar.assigned:job:job-sem-1', 'c:seminar.assigned:job:job-sem-2']);
    expect(runs[0]).toMatchObject({ total: 1, sent: 1, label: 'Семинары: ваши семинары' });
    const mine = await botMessagesForParticipant(env.db, participant.id);
    expect(mine.filter((m) => m.kind === 'seminar.assigned')).toHaveLength(2);
  });

  it('«Запланировано» - задачи со временем впереди; «не достучимся» - бот заблокирован или ни разу не открыт', async () => {
    const at = new Date(Date.now() + 2 * 3600_000);
    await enqueue(env.boss, 'merch.confirm_drop', { orderId: 999_001, askedAt: new Date().toISOString() }, { startAfter: at });
    await enqueue(env.boss, 'merch.confirm_drop', { orderId: 999_002, askedAt: new Date().toISOString() }, { startAfter: at });
    const item = (await botScheduled(env.db)).find((s) => s.name === 'merch.confirm_drop');
    expect(item).toMatchObject({ label: 'Мерч: снять бронь без ответа', count: 2 });

    const blocked = await makeUser(env, 'Заблокировал');
    await env.db.update(schema.users).set({ botBlocked: true }).where(eq(schema.users.id, blocked.id));
    await makeParticipant(env, blocked);
    const silent = await makeUser(env, 'Не открывал');
    await env.db.update(schema.users).set({ allowsWrite: false }).where(eq(schema.users.id, silent.id));
    await makeParticipant(env, silent);
    const list = await botUnreachable(env.db);
    expect(list.find((u) => u.userId === blocked.id)).toMatchObject({ reason: 'blocked', people: [expect.any(String)] });
    expect(list.find((u) => u.userId === silent.id)).toMatchObject({ reason: 'unreachable' });
  });
});
