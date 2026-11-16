import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registrationSubmitSchema, type ParticipantInputRaw } from '@sof/shared';
import { eq, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { exportReceiptsXlsx } from '../src/services/admin.service.ts';
import { confirmReceipt, createReceipt, listReceipts, reviewReceipt } from '../src/services/payment.service.ts';
import { submitRegistration } from '../src/services/registration.service.ts';
import { makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

const person = (lastName: string, over: Partial<ParticipantInputRaw> = {}): ParticipantInputRaw => ({
  lastName,
  firstName: 'Аня',
  birthDate: '1995-01-01',
  gender: 'f',
  city: 'Минск',
  church: 'Благодать',
  phone: '+375291112233',
  relation: 'self',
  tier: 'fee35',
  paymentMethod: 'transfer',
  ...over,
});

let fileSeq = 0;

/** Аня (35) и Ваня (35 + завтрак) платят переводом - чек на обоих, «должно быть» 80. */
async function receiptFor() {
  const user = await makeUser(env);
  await submitRegistration(
    env,
    user,
    registrationSubmitSchema.parse({
      idempotencyKey: randomUUID(),
      consent: { pd: true, documentVersion: 'x' },
      participants: [
        person('Чеков', { phone: `+37529${String(user.id % 10_000_000).padStart(7, '0')}` }),
        person('Чеков', { firstName: 'Ваня', gender: 'm', relation: 'friend', breakfast: true }),
      ],
    }),
  );
  const people = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id), orderBy: (p, { asc }) => [asc(p.id)] });
  fileSeq += 1;
  const res = await createReceipt(env, user, { fileId: `rt${fileSeq}`, fileUniqueId: `rtu${fileSeq}`, kind: 'photo' });
  if (res.status !== 'draft') throw new Error('expected draft');
  await confirmReceipt(env, user, res.receiptId);
  return { receiptId: res.receiptId, anya: people[0]!, vanya: people[1]! };
}

const viewOf = async (id: number) => (await listReceipts(env, undefined, [id]))[0]!;

describe('чеки: сумма для таблицы и выгрузки', () => {
  it('на проверке - сколько должно быть; принятый - сколько зачли; отклонённый - сколько должно было быть', async () => {
    const admin = await makeStaff(env, ['admin'], 'Админ');
    const a = await receiptFor();
    expect((await viewOf(a.receiptId)).amount).toBe('80.00');
    await reviewReceipt(env, a.receiptId, admin, 'accept', { participantIds: [a.anya.id] });
    expect(await viewOf(a.receiptId)).toMatchObject({ status: 'accepted', amount: '35.00' });

    const b = await receiptFor();
    await reviewReceipt(env, b.receiptId, admin, 'accept', {});
    expect((await viewOf(b.receiptId)).amount).toBe('80.00');

    const c = await receiptFor();
    await reviewReceipt(env, c.receiptId, admin, 'reject', { reason: 'не тот чек' });
    expect(await viewOf(c.receiptId)).toMatchObject({ status: 'rejected', amount: '80.00' });
  });

  it('миграция восстанавливает сумму уже принятых чеков по журналу', async () => {
    const admin = await makeStaff(env, ['admin'], 'Админ');
    const a = await receiptFor();
    await reviewReceipt(env, a.receiptId, admin, 'accept', { participantIds: [a.vanya.id] });
    // Как до миграции: суммы у чека нет.
    await env.db.update(schema.paymentReceipts).set({ amount: null }).where(eq(schema.paymentReceipts.id, a.receiptId));
    const backfill = readFileSync(new URL('../src/db/migrations/0016_receipt_amount.sql', import.meta.url), 'utf8').split('--> statement-breakpoint')[1]!;
    await env.db.execute(sql.raw(backfill));
    expect((await viewOf(a.receiptId)).amount).toBe('45.00');
  });

  it('выгрузка в Excel - только переданные чеки, «Прислан» с датой и временем', async () => {
    const one = await receiptFor();
    await receiptFor();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await exportReceiptsXlsx(env, [one.receiptId])) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Чеки')!;
    expect(ws.rowCount).toBe(2);
    const row = ws.getRow(2);
    expect(row.getCell(1).value).toBe(one.receiptId);
    expect(row.getCell(2).value).toBe(80);
    expect(row.getCell(3).value).toBeInstanceOf(Date);
    expect(ws.getColumn(3).numFmt).toBe('dd.mm.yyyy hh:mm');
    expect(row.getCell(6).value).toBe('На проверке');
  });
});
