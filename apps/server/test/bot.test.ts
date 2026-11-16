import { randomUUID } from 'node:crypto';
import { registrationSubmitSchema, type ParticipantInputRaw } from '@sof/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import { listReceipts, unsentDrafts } from '../src/services/payment.service.ts';
import { submitRegistration } from '../src/services/registration.service.ts';
import { upsertTelegramUser } from '../src/services/users.service.ts';
import { buttonsOf, makeTestBot } from './bot-harness.ts';
import { setupTestEnv, type TestEnv } from './helpers.ts';

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

async function registerFamily(tgId: number) {
  const user = await upsertTelegramUser(env.db, { id: tgId, first_name: 'Аня', allows_write_to_pm: true });
  await submitRegistration(
    env,
    user,
    registrationSubmitSchema.parse({
      idempotencyKey: randomUUID(),
      consent: { pd: true, documentVersion: 'x' },
      participants: [
        // Свой номер у каждого аккаунта: одинаковые «Я» с одним номером - это уже дубль.
        person('Ботова', { phone: `+37529${String(tgId % 10_000_000).padStart(7, '0')}` }),
        person('Ботов', { firstName: 'Петя', gender: 'm', relation: 'friend', tier: 'fee10', paymentMethod: 'cash' }),
        person('Ботов', { firstName: 'Ваня', gender: 'm', relation: 'friend', tier: 'fee35', breakfast: true }),
      ],
    }),
  );
  return user;
}

describe('bot: receipts', () => {
  it('photo → «за кого?», галочки перерисовывают сообщение, «отправить» уходит на проверку', async () => {
    const tg = 8_800_001;
    const user = await registerFamily(tg);
    const t = makeTestBot(env);

    await t.text(tg, '/pay');
    t.reset();
    await t.photo(tg, 'rcpt-1');
    const ask = t.calls.find((c) => c.method === 'sendMessage');
    expect(ask?.payload.text).toMatch(/За кого этот чек/);
    const buttons = buttonsOf(ask);
    expect(buttons.map(([text]) => text).join(' | ')).toMatch(/Ботова Аня/);

    // Заранее отмечены те, кто выбрал перевод (Аня, Ваня); Петя - наличные.
    expect(buttons.find(([text]) => text.includes('Петя'))?.[0]).toMatch(/^⬜/);
    // Клавиатура без пустых рядов - Telegram такие правки может не принять.
    const kbRows = (ask?.payload.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(kbRows.every((r) => r.length > 0)).toBe(true);
    // Снимаем галочку с Вани - сообщение должно перерисоваться.
    const vanya = buttons.find(([text]) => text.includes('Ваня'))!;
    const askId = 1; // id сообщения в тесте не важен - бот правит сообщение, под которым нажали
    t.reset();
    await t.tap(tg, askId, vanya[1]);
    const edit = t.calls.find((c) => c.method === 'editMessageText');
    expect(edit, JSON.stringify(t.calls)).toBeTruthy();
    expect(buttonsOf(edit).find(([text]) => text.includes('Ваня'))?.[0]).toMatch(/^⬜/);

    // Отправляем на проверку: за Аню (перевод), Ваню сняли, Петя (наличные) не отмечен.
    const send = buttonsOf(edit).find(([text]) => text.includes('Отправить'))!;
    t.reset();
    await t.tap(tg, askId, send[1]);
    const done = t.calls.find((c) => c.method === 'editMessageText');
    expect(done?.payload.text).toMatch(/отправлен на проверку/);
    const rows = await env.db.query.participants.findMany({ where: eq(schema.participants.ownerUserId, user.id), orderBy: (p, { asc }) => [asc(p.id)] });
    expect(rows.map((r) => [r.firstName, r.paymentStatus])).toEqual([
      ['Аня', 'pending'],
      ['Петя', 'unpaid'],
      ['Ваня', 'unpaid'],
    ]);
  });

  it('несколько чеков подряд - один чек: фото к черновику, «Отправить»; дальше чек за остальных - новый черновик; повтор файла - дубль', async () => {
    const tg = 8_800_031;
    const user = await registerFamily(tg);
    const t = makeTestBot(env);
    const replies = () => t.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text));

    await t.text(tg, '/pay');
    t.reset();
    await t.photo(tg, 'multi-1');
    const ask = t.calls.find((c) => c.method === 'sendMessage');
    expect(ask?.payload.text).toMatch(/За кого этот чек/);
    expect(ask?.payload.text).toMatch(/Нажмите на имя/);
    t.reset();
    await t.photo(tg, 'multi-2');
    expect(replies().join(' ')).toMatch(/Добавили к этому же чеку.*файлов: 2/);
    const drafts = await env.db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.userId, user.id));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('draft');

    // Отправляем: оба файла уходят одним чеком за отмеченных (перевод - Аня и Ваня).
    const send = buttonsOf(ask).find(([text]) => text.includes('Отправить'))!;
    t.reset();
    await t.tap(tg, 1, send[1]);
    expect(t.calls.find((c) => c.method === 'editMessageText')?.payload.text).toMatch(/отправлен на проверку/);

    // Петя ещё не оплачен: следующее фото - это чек за него (он остался один - сразу на проверку), а не к чеку Ани и Вани; тот же файл ещё раз - дубль.
    // Пауза: у бота защита от спама (не больше 4 действий за 1,5 с).
    await new Promise((r) => setTimeout(r, 1600));
    t.reset();
    await t.photo(tg, 'multi-3');
    expect(replies().join(' ')).toMatch(/Чек отправлен на проверку[\s\S]*Петя/);
    t.reset();
    await t.photo(tg, 'multi-2');
    expect(replies().join(' ')).toMatch(/уже получен/);

    const [view] = await listReceipts(env, 'pending', [drafts[0]!.id]);
    expect(view!.files.map((f) => f.url)).toEqual([`/api/admin/receipts/${drafts[0]!.id}/file`, `/api/admin/receipts/${drafts[0]!.id}/file?n=1`]);
    expect(view!.participants).toHaveLength(2);

    // Неотправленный черновик старше 15 минут - в списке «не нажали «Отправить»».
    const other = await registerFamily(8_800_032);
    const t2 = makeTestBot(env);
    await t2.text(8_800_032, '/pay');
    await t2.photo(8_800_032, 'multi-x');
    await env.db.update(schema.paymentReceipts).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.paymentReceipts.userId, other.id));
    expect((await unsentDrafts(env.db)).some((d) => d.userId === other.id && d.files === 1)).toBe(true);
  });

  it('пожертвование: кнопка в «Оплате» → чек уходит пожертвованием; фото без кнопки при оплаченном взносе - «за что этот чек?»', async () => {
    const tg = 8_800_021;
    const user = await registerFamily(tg);
    await env.db.update(schema.participants).set({ paymentStatus: 'paid', amountPaid: '35.00' }).where(eq(schema.participants.ownerUserId, user.id));
    const t = makeTestBot(env);

    await t.text(tg, '/pay');
    const screen = t.calls.filter((c) => c.method === 'sendMessage').at(-1);
    const donate = buttonsOf(screen).find(([text]) => text.includes('Пожертвование'));
    expect(donate?.[1]).toBe('v1:don');
    t.reset();
    await t.tap(tg, 1, 'v1:don');
    expect(JSON.stringify(t.calls)).toMatch(/Пожертвование/);
    t.reset();
    await t.photo(tg, 'don-1');
    expect(t.calls.find((c) => c.method === 'sendMessage')?.payload.text).toMatch(/пожертвования отправлен/);
    const [receipt] = await env.db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.fileUniqueId, 'don-1'));
    expect(receipt).toMatchObject({ kind: 'donation', status: 'pending', participantIds: [] });

    // Прошло больше 15 минут: следующее фото - уже не к этому пожертвованию, а вопрос; взноса среди вариантов нет (он оплачен).
    await env.db.update(schema.paymentReceipts).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.paymentReceipts.id, receipt!.id));
    await env.db.update(schema.users).set({ awaitingReceiptUntil: null }).where(eq(schema.users.id, user.id));
    t.reset();
    await t.photo(tg, 'don-2');
    const ask = t.calls.find((c) => c.method === 'sendMessage');
    expect(ask?.payload.text).toMatch(/За что он/);
    const options = buttonsOf(ask).map(([, data]) => data);
    expect(options).toEqual(expect.arrayContaining(['v1:rk:don', 'v1:rk:no']));
    expect(options).not.toContain('v1:rk:fee');
  });

  it('чек файлом: картинку и PDF принимаем, HEIC и посторонние файлы - просим прислать иначе', async () => {
    const tg = 8_800_010;
    await registerFamily(tg);
    const t = makeTestBot(env);
    const reply = () => String(t.calls.find((c) => c.method === 'sendMessage')?.payload.text ?? '');

    await t.text(tg, '/pay');
    t.reset();
    await t.document(tg, 'doc-heic', 'IMG_0001.HEIC', 'image/heic');
    expect(reply()).toMatch(/HEIC/);

    t.reset();
    await t.document(tg, 'doc-zip', 'check.zip', 'application/zip');
    expect(reply()).toMatch(/не подходит/);

    t.reset();
    await t.document(tg, 'doc-big', 'scan.pdf', 'application/pdf', 30 * 1024 * 1024);
    expect(reply()).toMatch(/20 МБ/);

    // Картинка файлом - от другого человека: у бота защита от спама (не больше 4 действий за 1,5 с).
    const tg2 = 8_800_011;
    await registerFamily(tg2);
    await t.text(tg2, '/pay');
    t.reset();
    await t.document(tg2, 'doc-jpg', 'check.jpg', undefined);
    expect(reply()).toMatch(/За кого этот чек/);
  });

  it('служебное сообщение о закреплении не роняет бота', async () => {
    const t = makeTestBot(env);
    await expect(t.pinnedService(8_800_002)).resolves.toBeUndefined();
    expect(t.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });
});

describe('bot: «Меня уже зарегистрировали»', () => {
  const sent = (t: ReturnType<typeof makeTestBot>) => t.calls.filter((c) => c.method === 'sendMessage');

  it('делится номером → находит регистрацию → «Да, это я» отдаёт её', async () => {
    const owner = await upsertTelegramUser(env.db, { id: 8_800_050, first_name: 'Саша', allows_write_to_pm: true });
    await submitRegistration(
      env,
      owner,
      registrationSubmitSchema.parse({
        idempotencyKey: randomUUID(),
        consent: { pd: true, documentVersion: 'x' },
        participants: [person('Контактов', { firstName: 'Петя', gender: 'm', relation: 'friend', phone: '+375 33 800-00-50', paymentMethod: 'cash' })],
      }),
    );
    const tg = 8_800_051;
    const t = makeTestBot(env);

    await t.text(tg, '/start');
    expect(buttonsOf(sent(t)[0]).map(([text]) => text)).toContain('🙋 Меня уже зарегистрировали');
    t.reset();
    await t.tap(tg, 1, 'v1:claim');
    const ask = sent(t)[0]!;
    expect((ask.payload.reply_markup as { keyboard: { request_contact?: boolean }[][] }).keyboard[0]![0]).toMatchObject({ request_contact: true });

    t.reset();
    await t.contact(tg, tg, '375338000050');
    const [number, question] = sent(t);
    expect(number?.payload.text).toBe('📱 Ваш номер: <b>+375 33 800-00-50</b>');
    expect(number?.payload.reply_markup).toEqual({ remove_keyboard: true });
    expect(question?.payload.text).toMatch(/Контактов Петя<\/b>, записал\(а\) Саша/);
    const yes = buttonsOf(question).find(([text]) => text === 'Да, это я')!;

    t.reset();
    await t.tap(tg, 1, yes[1]);
    expect(t.calls.find((c) => c.method === 'editMessageText')?.payload.text).toMatch(/^✅ <b>Готово!<\/b> Регистрация <b>Контактов Петя<\/b> теперь и у вас/);
    const petya = await env.db.query.users.findFirst({ where: eq(schema.users.tgId, tg) });
    const row = await env.db.query.participants.findFirst({ where: eq(schema.participants.lastName, 'Контактов') });
    expect(row!.holderUserId).toBe(petya!.id);
    expect(petya!.phone).toBe('+375338000050');
  });

  it('чужой контакт не принимает; на номер без регистраций - подсказка', async () => {
    const tg = 8_800_052;
    const t = makeTestBot(env);
    await t.text(tg, '/start');
    await t.tap(tg, 1, 'v1:claim');
    t.reset();
    await t.contact(tg, tg + 1, '375338000050');
    expect(sent(t)[0]?.payload.text).toMatch(/Это чужой номер/);
    const user = await env.db.query.users.findFirst({ where: eq(schema.users.tgId, tg) });
    expect(user!.phone).toBeNull();

    t.reset();
    await t.contact(tg, tg, '48601234567');
    const [, answer] = sent(t);
    expect(answer?.payload.text).toMatch(/^🔎 <b>На номер \+48601234567 регистраций нет/);
    expect(buttonsOf(answer).map(([text]) => text)).toContain('← Меню');
  });

  it('номер из Mini App («Взять номер из Telegram») бот сохраняет молча и убирает карточку из чата', async () => {
    const tg = 8_800_053;
    const t = makeTestBot(env);
    await t.text(tg, '/start');
    t.reset();
    await t.contact(tg, tg, '375338000053');
    expect(sent(t)).toHaveLength(0);
    expect(t.calls.some((c) => c.method === 'deleteMessage')).toBe(true);
    const user = await env.db.query.users.findFirst({ where: eq(schema.users.tgId, tg) });
    expect(user!.phone).toBe('+375338000053');
  });
});

describe('bot: друг записал по нику', () => {
  it('/start сразу после привязки не шлёт второе меню - QR-коды и меню придут одним блоком', async () => {
    const owner = await upsertTelegramUser(env.db, { id: 8_800_060, first_name: 'Саша', allows_write_to_pm: true });
    await submitRegistration(
      env,
      owner,
      registrationSubmitSchema.parse({
        idempotencyKey: randomUUID(),
        consent: { pd: true, documentVersion: 'x' },
        participants: [
          person('Ников', { firstName: 'Петя', gender: 'm', relation: 'friend', telegramUsername: 'petya_nick60', phone: '+375338000060', paymentMethod: 'cash' }),
        ],
      }),
    );
    const tg = 8_800_061;
    const t = makeTestBot(env);
    t.setUsername(tg, 'petya_nick60');
    await t.text(tg, '/start');
    expect(t.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    const petya = await env.db.query.users.findFirst({ where: eq(schema.users.tgId, tg) });
    const row = await env.db.query.participants.findFirst({ where: eq(schema.participants.lastName, 'Ников') });
    expect(row!.holderUserId).toBe(petya!.id);
    const jobs = await env.pool.query(`select data from pgboss.job where name = 'tickets.send'`);
    expect(jobs.rows.some((j) => j.data.userId === petya!.id && j.data.reason === 'linked')).toBe(true);

    // Следующий /start - обычное меню (в нём уже есть «Задать вопрос»).
    t.reset();
    await t.text(tg, '/start');
    const menu = t.calls.find((c) => c.method === 'sendMessage');
    expect(buttonsOf(menu).map(([text]) => text)).toContain('❓ Задать вопрос');
  });

  it('«Задать вопрос»: бот ждёт сообщения и кладёт их в переписку; второе - 👍 вместо текста', async () => {
    const tg = 8_800_062;
    const t = makeTestBot(env);
    await t.text(tg, '/menu');
    t.reset();
    await t.tap(tg, 1, 'v1:ask');
    expect(t.calls.find((c) => c.method === 'sendMessage')?.payload.text).toMatch(/Напишите организаторам/);
    t.reset();
    await t.text(tg, 'Где взять бейдж?');
    expect(t.calls.find((c) => c.method === 'sendMessage')?.payload.text).toMatch(/Передали организаторам/);
    t.reset();
    await t.text(tg, 'И ещё: есть ли парковка?');
    expect(t.calls.some((c) => c.method === 'setMessageReaction')).toBe(true);
    expect(t.calls.some((c) => c.method === 'sendMessage')).toBe(false);
    const user = await env.db.query.users.findFirst({ where: eq(schema.users.tgId, tg) });
    const msgs = await env.db.select().from(schema.supportMessages).where(eq(schema.supportMessages.userId, user!.id));
    expect(msgs.map((m) => m.text)).toEqual(['Где взять бейдж?', 'И ещё: есть ли парковка?']);
  });
});
