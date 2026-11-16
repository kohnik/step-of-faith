import { Api } from 'grammy';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { runJob } from '../src/jobs/workers.ts';
import { confirmReceipt, createReceipt } from '../src/services/payment.service.ts';
import { makeTestBot } from './bot-harness.ts';
import { makeParticipant, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

/** Поддельный Telegram: записывает вызовы, `failOn` - номер вызова sendPhoto, который упадёт (сеть). */
function fakeTg(failPhotoAt?: number) {
  const calls: string[] = [];
  let photos = 0;
  let msg = 1;
  const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
  tg.config.use(async (_prev, method, payload) => {
    if (method === 'sendPhoto' && ++photos === failPhotoAt) {
      calls.push('sendPhoto:fail');
      throw new Error('network down');
    }
    calls.push(method);
    const chat = (payload as { chat_id: number }).chat_id;
    const result =
      method === 'sendPhoto'
        ? { message_id: ++msg, date: 0, chat: { id: chat, type: 'private' }, photo: [{ file_id: `f${msg}`, file_unique_id: `u${msg}`, width: 1, height: 1 }] }
        : method === 'sendMessage'
          ? { message_id: ++msg, date: 0, chat: { id: chat, type: 'private' }, text: '' }
          : true;
    return { ok: true, result } as never;
  });
  return { tg, calls };
}

describe('tickets.send delivery', () => {
  it('a retry after a failure in the middle sends only what did not arrive', async () => {
    const user = await makeUser(env);
    const a = await makeParticipant(env, user);
    const b = await makeParticipant(env, user);
    const { tg, calls } = fakeTg(2);
    const ctx = { ...env, tg };
    const data = { userId: user.id, participantIds: [a.participant.id, b.participant.id], reason: 'registered' as const };
    await expect(runJob(ctx, 'tickets.send', data, 'job-retry-1')).rejects.toThrow();
    expect(calls).toEqual(['sendMessage', 'sendPhoto', 'pinChatMessage', 'sendPhoto:fail']);
    calls.splice(0);
    // Повтор той же задачи очередью - и параллельная копия по истечении срока.
    await Promise.all([runJob(ctx, 'tickets.send', data, 'job-retry-1'), runJob(ctx, 'tickets.send', data, 'job-retry-1')]);
    expect(calls).toEqual(['sendPhoto', 'sendMessage']);
    const [u] = await env.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(u!.lastTicketsSentAt).not.toBeNull();
    const tickets = await env.db.select().from(schema.tickets).where(eq(schema.tickets.participantId, b.participant.id));
    expect(tickets[0]!.imageFileId).toMatch(/\|f\d+$/);
  });

  it('tries to deliver even if the user is marked as having blocked the bot', async () => {
    const user = await makeUser(env);
    const a = await makeParticipant(env, user);
    await env.db.update(schema.users).set({ botBlocked: true }).where(eq(schema.users.id, user.id));
    const { tg, calls } = fakeTg();
    await runJob({ ...env, tg }, 'tickets.send', { userId: user.id, participantIds: [a.participant.id], reason: 'resend' }, 'job-blocked-1');
    expect(calls).toContain('sendPhoto');
    const [u] = await env.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(u!.botBlocked).toBe(false);
  });

  it('/start queues the QR codes for someone who registered but never got them', async () => {
    const t = makeTestBot(env);
    const user = await makeUser(env);
    await makeParticipant(env, user);
    const count = async () =>
      Number((await env.db.execute<{ n: string }>(sql`select count(*) as n from pgboss.job where name = 'tickets.send' and data->>'userId' = ${String(user.id)}`)).rows[0]!.n);
    await t.text(user.tgId!, '/start');
    expect(await count()).toBe(1);
    // Задача уже в очереди - второй /start не ставит ещё одну.
    await t.text(user.tgId!, '/start');
    expect(await count()).toBe(1);
  });

  it('reminds once about a receipt draft that was never sent, and not after it is sent', async () => {
    const user = await makeUser(env);
    await makeParticipant(env, user, { paymentStatus: 'unpaid', amountDue: '35.00', paymentMethod: 'transfer' });
    await makeParticipant(env, user, { paymentStatus: 'unpaid', amountDue: '10.00', paymentMethod: 'transfer' });
    const res = await createReceipt(env, user, { fileId: 'F1', fileUniqueId: 'U-draft-1', kind: 'photo' });
    expect(res.status).toBe('draft');
    const receiptId = (res as { receiptId: number }).receiptId;
    const { tg, calls } = fakeTg();
    await runJob({ ...env, tg }, 'receipt.draft_reminder', { receiptId }, 'job-draft-1');
    await runJob({ ...env, tg }, 'receipt.draft_reminder', { receiptId }, 'job-draft-2');
    expect(calls).toEqual(['sendMessage']);
    const user2 = await makeUser(env);
    await makeParticipant(env, user2, { paymentStatus: 'unpaid', amountDue: '35.00', paymentMethod: 'transfer' });
    await makeParticipant(env, user2, { paymentStatus: 'unpaid', amountDue: '10.00', paymentMethod: 'transfer' });
    const r2 = (await createReceipt(env, user2, { fileId: 'F2', fileUniqueId: 'U-draft-2', kind: 'photo' })) as { receiptId: number };
    await confirmReceipt(env, user2, r2.receiptId);
    calls.splice(0);
    await runJob({ ...env, tg }, 'receipt.draft_reminder', { receiptId: r2.receiptId }, 'job-draft-3');
    expect(calls).toEqual([]);
  });
});
