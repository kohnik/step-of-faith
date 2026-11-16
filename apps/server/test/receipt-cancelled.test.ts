import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { cancelOwnParticipant } from '../src/services/participants.service.ts';
import { createReceipt, reviewReceipt } from '../src/services/payment.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

describe('чек человека, который потом отменил регистрацию', () => {
  it('принимается: оплата засчитывается, чек уходит в «Принятые»', async () => {
    const owner = await makeUser(env);
    const admin = await makeStaff(env, ['admin']);
    const { participant: p } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', amountDue: '10.00', paymentMethod: 'transfer' });
    const r = await createReceipt(env, owner, { fileId: 'F-c', fileUniqueId: 'U-cancelled-1', kind: 'photo' });
    expect(r.status).toBe('sent');
    await cancelOwnParticipant(env, owner, p.id);
    const view = await reviewReceipt(env, (r as { receiptId: number }).receiptId, admin, 'accept', {});
    expect(view.status).toBe('accepted');
    const row = (await env.db.query.participants.findFirst({ where: eq(schema.participants.id, p.id) }))!;
    expect(row).toMatchObject({ status: 'cancelled', paymentStatus: 'paid', amountPaid: '10.00' });
  });
});
