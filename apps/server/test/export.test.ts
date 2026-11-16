import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { exportParticipantsXlsx } from '../src/services/admin.service.ts';
import { makeParticipant, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

describe('выгрузка участников для бухгалтерии', () => {
  it('активные и отменённые с оплатой; отменённых без оплаты нет', async () => {
    const user = await makeUser(env);
    const { participant: active } = await makeParticipant(env, user, { firstName: 'Активный', paymentStatus: 'unpaid' });
    const { participant: dropped } = await makeParticipant(env, user, { firstName: 'Отменил', paymentStatus: 'unpaid' });
    const { participant: paidDropped } = await makeParticipant(env, user, { firstName: 'Оплатил', amountPaid: '10.00' });
    await env.db.update(schema.participants).set({ status: 'cancelled' }).where(eq(schema.participants.id, dropped.id));
    await env.db.update(schema.participants).set({ status: 'cancelled' }).where(eq(schema.participants.id, paidDropped.id));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await exportParticipantsXlsx(env)) as never);
    const ids: number[] = [];
    wb.worksheets[0]!.eachRow((row, i) => {
      if (i > 1) ids.push(Number(row.getCell(1).value));
    });
    expect(ids).toContain(active.id);
    expect(ids).toContain(paidDropped.id);
    expect(ids).not.toContain(dropped.id);
  });
});
