import { randomUUID } from 'node:crypto';
import type { CheckInEvent } from '@sof/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { processCheckIns } from '../src/services/checkin.service.ts';
import { addSize, attachOwnReceipt, createProduct, markOrderPaid, reserveForUser } from '../src/services/merch.service.ts';
import { createPurposeReceipt, createReceipt, listReceipts, promiseTransfer, receiptsToArchive, reviewReceipt } from '../src/services/payment.service.ts';
import { getSettings, invalidateSettingsCache, patchSettings } from '../src/services/settings.service.ts';
import { personPaymentText } from '../src/services/tiers.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let entranceId: number;
beforeAll(async () => {
  env = await setupTestEnv();
  const [cp] = await env.db.insert(schema.checkpoints).values({ kind: 'entrance', name: 'Вход' }).returning();
  entranceId = cp!.id;
});
afterAll(async () => env?.teardown());

const setSettings = async (patch: Parameters<typeof patchSettings>[1]) => {
  await patchSettings(env.db, patch, (await makeUser(env, 'Настройщик')).id);
  invalidateSettingsCache();
};
const event = (participantId: number, over: Partial<CheckInEvent> = {}): CheckInEvent => ({
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
});
const jobs = async (name: string) => (await env.pool.query(`select data from pgboss.job where name = $1`, [name])).rows.map((r) => r.data);
let fileSeq = 0;
const tgFile = () => ({ fileId: `file-${++fileSeq}`, fileUniqueId: `uniq-${fileSeq}`, kind: 'photo' as const, mimeType: 'image/jpeg' });

describe('вход и касса', () => {
  it('чек на проверке - пускаем сразу; не оплачено - на кассу', async () => {
    await setSettings({ paymentsEnabled: true, allowUnpaidEntry: false, eventStartsAt: null });
    const scanner = await makeStaff(env, ['scanner']);
    const owner = await makeUser(env);
    const { participant: withReceipt } = await makeParticipant(env, owner, { paymentStatus: 'pending' });
    const { participant: unpaid } = await makeParticipant(env, owner, { paymentStatus: 'unpaid' });
    const [a] = await processCheckIns(env, scanner, [event(withReceipt.id)]);
    expect(a!.outcome).toBe('new');
    const [b] = await processCheckIns(env, scanner, [event(unpaid.id)]);
    expect(b!.outcome).toBe('unpaid');
  });

  it('«оплатит переводом»: статус «не оплачено», способ «перевод», в бот реквизиты и «пришлите чек»; кассир пропускает', async () => {
    await setSettings({ paymentsEnabled: true, allowUnpaidEntry: false, eventStartsAt: null, paymentInstructions: 'Карта 1234' });
    const cashier = await makeStaff(env, ['cashier']);
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', paymentMethod: 'cash', amountDue: '10.00' });
    expect(await promiseTransfer(env, cashier, [participant.id])).toEqual({ notified: 1 });
    const after = await env.db.query.participants.findFirst({ where: eq(schema.participants.id, participant.id) });
    expect(after).toMatchObject({ paymentStatus: 'unpaid', paymentMethod: 'transfer' });
    const notes = (await jobs('notify.text')).filter((d) => d.userId === owner.id);
    expect(notes.at(-1).text).toContain('Карта 1234');
    expect(notes.at(-1).text).toContain('пришлите сюда');
    const [mark] = await processCheckIns(env, cashier, [event(participant.id, { overrideUnpaid: true })]);
    expect(mark!.outcome).toBe('new');
  });
});

describe('чеки: пожертвование и мерч', () => {
  it('пожертвование: отдельный вид, без людей; принять - только с суммой, она в журнале денег; повтор файла - дубль', async () => {
    await setSettings({ paymentsEnabled: true, transfersEnabled: true });
    const user = await makeUser(env);
    const reviewer = await makeStaff(env, ['admin'], 'Проверяющий');
    const file = tgFile();
    const sent = await createPurposeReceipt(env, user, { kind: 'donation' }, { telegram: file }, 'на нуждающихся');
    expect(sent).toMatchObject({ status: 'sent' });
    const id = (sent as { receiptId: number }).receiptId;
    expect(await createPurposeReceipt(env, user, { kind: 'donation' }, { telegram: file })).toEqual({ status: 'duplicate' });
    const [view] = await listReceipts(env, undefined, [id]);
    expect(view).toMatchObject({ kind: 'donation', participants: [], amount: null, status: 'pending', merchOrder: null });
    // Копия файла к нам - задачей; пока её нет, чек в списке на копирование.
    expect((await jobs('receipt.archive')).some((d) => d.receiptId === id)).toBe(true);
    expect(await receiptsToArchive(env.db)).toContain(id);

    await expect(reviewReceipt(env, id, reviewer, 'accept', {})).rejects.toMatchObject({ code: 'amount_required' });
    const accepted = await reviewReceipt(env, id, reviewer, 'accept', { amount: '25' });
    expect(accepted).toMatchObject({ status: 'accepted', amount: '25.00' });
    const money = await env.db.select().from(schema.payments).where(eq(schema.payments.receiptId, id));
    expect(money).toHaveLength(1);
    expect(money[0]).toMatchObject({ kind: 'donation', method: 'transfer', amount: '25.00' });
    expect((await jobs('receipt.reviewed')).some((d) => d.receiptId === id)).toBe(true);

    const other = (await createPurposeReceipt(env, user, { kind: 'donation' }, { telegram: tgFile() })) as { receiptId: number };
    expect(await reviewReceipt(env, other.receiptId, reviewer, 'reject', { reason: 'не тот получатель' })).toMatchObject({ status: 'rejected', rejectReason: 'не тот получатель' });
  });

  it('мерч: чек к брони; принять = бронь оплачена; чек из приложения - тоже в «Чеках», оплата брони его принимает', async () => {
    await setSettings({ paymentsEnabled: true, transfersEnabled: true, merchVisible: true, merchAdminsOnly: false, merchSalesEnabled: true, merchReservationHours: null });
    const admin = await makeStaff(env, ['admin'], 'Админ');
    const seller = await makeStaff(env, ['seller'], 'Продавец');
    const p = await createProduct(env, { title: 'Худи', subtitle: null, descriptionMd: '', price: 60, badge: null, sort: 0, published: true }, admin);
    const variantId = (await addSize(env, p.colors[0]!.id, { size: 'M', stock: 5, sort: 0 }, admin)).colors[0]!.sizes[0]!.id;
    const buyer = await makeUser(env);
    const reserve = async () => (await reserveForUser(env, seller, { requestId: randomUUID(), userId: buyer.id, items: [{ variantId, qty: 1 }] })).order;

    // Из бота: чек за бронь → в «Чеках» с бронью; принять - бронь «оплачено», чек принят.
    const o1 = await reserve();
    const sent = (await createPurposeReceipt(env, buyer, { kind: 'merch', orderId: o1.id }, { telegram: tgFile() })) as { status: string; receiptId: number; orderCode: string };
    expect(sent).toMatchObject({ status: 'sent', orderCode: o1.code });
    const [view] = await listReceipts(env, undefined, [sent.receiptId]);
    expect(view).toMatchObject({
      kind: 'merch',
      merchOrder: { id: o1.id, code: o1.code, status: 'reserved', items: [{ product: 'Худи', color: expect.any(String), size: 'M', qty: 1 }] },
      amount: '60.00',
    });
    const accepted = await reviewReceipt(env, sent.receiptId, admin, 'accept', {});
    expect(accepted).toMatchObject({ status: 'accepted', amount: '60.00', merchOrder: { status: 'paid' } });
    const paidOrder = await env.db.query.merchOrders.findFirst({ where: eq(schema.merchOrders.id, o1.id) });
    expect(paidOrder).toMatchObject({ status: 'paid', paymentMethod: 'transfer' });
    // За оплаченную бронь чек больше не отправить.
    expect(await createPurposeReceipt(env, buyer, { kind: 'merch', orderId: o1.id }, { telegram: tgFile() })).toEqual({ status: 'not_reserved' });

    // Из приложения: файл к брони → чек вида «Мерч»; продавец отметил оплату в заказе - чек принят тем же действием.
    const o2 = await reserve();
    await attachOwnReceipt(env, buyer, o2.id, { file: 'merch-receipts/abc.jpg', mime: 'image/jpeg' });
    const [appReceipt] = await env.db.select().from(schema.paymentReceipts).where(and(eq(schema.paymentReceipts.merchOrderId, o2.id), eq(schema.paymentReceipts.kind, 'merch')));
    expect(appReceipt).toMatchObject({ status: 'pending', storedFile: 'merch-receipts/abc.jpg', fileId: null });
    await markOrderPaid(env, o2.id, 'transfer', seller);
    const after = await env.db.query.paymentReceipts.findFirst({ where: eq(schema.paymentReceipts.id, appReceipt!.id) });
    expect(after).toMatchObject({ status: 'accepted', amount: '60.00' });
  });
});

describe('несколько файлов в одном чеке', () => {
  it('один человек: чек ушёл сразу, второе фото за 15 минут - к нему же; оба файла в чеке и в списке на копирование', async () => {
    const owner = await makeUser(env);
    const { participant } = await makeParticipant(env, owner, { paymentStatus: 'unpaid', paymentMethod: 'transfer', amountDue: '10.00' });
    const first = await createReceipt(env, owner, tgFile());
    expect(first).toMatchObject({ status: 'sent' });
    const second = await createReceipt(env, owner, tgFile());
    expect(second).toMatchObject({ status: 'added', files: 2, draft: false });
    const id = (first as { receiptId: number }).receiptId;
    const [view] = await listReceipts(env, undefined, [id]);
    expect(view!.files).toHaveLength(2);
    expect(view!.participants.map((p) => p.id)).toEqual([participant.id]);
    expect(await receiptsToArchive(env.db)).toContain(id);
    // Через 15 минут - уже новый платёж: не приклеиваем.
    await env.db.update(schema.paymentReceipts).set({ createdAt: new Date(Date.now() - 16 * 60_000) }).where(eq(schema.paymentReceipts.id, id));
    expect(await createReceipt(env, owner, tgFile())).toMatchObject({ status: 'nothing_to_pay' });
  });
});

describe('мягкие подписи оплаты на дни конференции', () => {
  it('чек на проверке - «чек получен ✓», не оплачено - «не забудьте оплатить»; выключено - как обычно', async () => {
    const base = { tier: 'fee10', amountDue: '10.00', paymentMethod: 'transfer' };
    await setSettings({ softPaymentLabels: true, transfersEnabled: true });
    const soft = await getSettings(env.db, { fresh: true });
    expect(personPaymentText(soft, { ...base, paymentStatus: 'pending' })).toContain('чек получен ✓');
    expect(personPaymentText(soft, { ...base, paymentStatus: 'unpaid' })).toContain('не забудьте оплатить');
    await setSettings({ softPaymentLabels: false });
    const plain = await getSettings(env.db, { fresh: true });
    expect(personPaymentText(plain, { ...base, paymentStatus: 'pending' })).toContain('чек на проверке');
    expect(personPaymentText(plain, { ...base, paymentStatus: 'unpaid' })).toContain('к оплате');
  });
});
