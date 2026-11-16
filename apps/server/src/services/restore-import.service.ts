import {
  CATEGORY_LABELS,
  PAYMENT_STATUS_LABELS,
  REG_PAYMENT_METHOD_LABELS,
  type Category,
  type PaymentStatus,
  type RegPaymentMethod,
  type Tier,
} from '@sof/shared';
import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '../db/client.ts';
import { randomToken } from '../lib/crypto.ts';
import { personKey } from '../lib/person-key.ts';

/**
 * Восстановление после сбоя хостинга (ноябрь 2026): база поднимается из выгрузки участников
 * («Экспорт в Excel» в админке) и таблицы банкира по переводам.
 *  - аккаунт = код оплаты: у каждого аккаунта он свой; Telegram id неизвестен (`users.restored_at`);
 *  - номера участников, QR-коды и коды оплаты - как в выгрузке, чтобы выданные билеты остались в силе;
 *  - «Чек на проверке», которые банкир нашёл в выписке, - оплачено на всю сумму, время - «Время прихода» банкира.
 */

const RESTORE_NOTE = 'Восстановлено после сбоя хостинга: выгрузка от 29.10.2026';
/** Время в выгрузке и у банкира - по часам конференции (Минск, UTC+3), а Excel хранит его как UTC. */
const EVENT_OFFSET_MS = 3 * 3600_000;

type Cell = ExcelJS.CellValue;

function plain(v: Cell): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if ('text' in v) return v.text;
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
  }
  return v;
}

const str = (v: Cell): string | null => {
  const x = plain(v);
  if (x === null || x === undefined) return null;
  const s = (x instanceof Date ? x.toISOString() : String(x)).trim();
  return s === '' ? null : s;
};
const num = (v: Cell): number => Number(str(v) ?? 0) || 0;
const localTime = (v: Cell): Date | null => {
  const x = plain(v);
  return x instanceof Date ? new Date(x.getTime() - EVENT_OFFSET_MS) : null;
};
const dateOnly = (v: Cell): string | null => {
  const x = plain(v);
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const nick = (v: Cell) => str(v)?.replace(/^@/, '') || null;
const phoneOf = (v: Cell) => {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
};

function reverse<K extends string>(labels: Record<K, string>): Map<string, K> {
  return new Map(Object.entries(labels).map(([k, v]) => [v as string, k as K]));
}
const CATEGORY = reverse<Category>(CATEGORY_LABELS);
const PAYMENT = reverse<PaymentStatus>(PAYMENT_STATUS_LABELS);
const METHOD = reverse<RegPaymentMethod>(REG_PAYMENT_METHOD_LABELS);

function tierOf(label: string | null): Tier | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l.includes('без взноса')) return 'nofee';
  if (l.includes('обед') || l.includes('питани') || l.includes('35')) return 'fee35';
  if (l.includes('взнос')) return 'fee10';
  return null;
}

async function readSheet(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`${file}: нет листов`);
  const headers = (ws.getRow(1).values as Cell[]).slice(1).map((h) => str(h) ?? '');
  const rows: Record<string, Cell>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rec: Record<string, Cell> = {};
    headers.forEach((h, i) => (rec[h] = row.getCell(i + 1).value));
    if (str(rec['ID'] ?? null)) rows.push(rec);
  }
  return rows;
}

export interface RestoreReport {
  accounts: number;
  withUsername: number;
  participants: number;
  active: number;
  tickets: number;
  payments: number;
  paidSum: number;
  confirmedByBank: number;
  confirmedSum: number;
  notes: string[];
}

export async function importRestore(db: Db, participantsFile: string, bankFile: string | null, opts: { dryRun: boolean }): Promise<RestoreReport> {
  const rows = await readSheet(participantsFile);
  const bank = new Map<number, { arrived: Date | null }>();
  if (bankFile) {
    for (const r of await readSheet(bankFile)) {
      const id = num(r['ID'] ?? null);
      const arrived = localTime(r['Время прихода'] ?? null) ?? localTime(r['Время оплаты / операции'] ?? null);
      const prev = bank.get(id);
      // Повтор у банкира - второй чек (доплата): берём позднее время.
      if (!prev || (arrived && (!prev.arrived || arrived > prev.arrived))) bank.set(id, { arrived });
    }
  }
  const notes: string[] = [];

  // ---------- аккаунты: один на код оплаты ----------
  const accounts = new Map<string, { ref: string; username: string | null; name: string | null; created: Date | null }>();
  for (const r of rows) {
    const ref = str(r['Код оплаты'] ?? null);
    if (!ref) throw new Error(`Участник ${str(r['ID'] ?? null)}: нет кода оплаты`);
    const created = localTime(r['Зарегистрирован'] ?? null);
    const acc = accounts.get(ref) ?? { ref, username: nick(r['Username'] ?? null), name: str(r['Аккаунт'] ?? null), created };
    if (created && (!acc.created || created < acc.created)) acc.created = created;
    accounts.set(ref, acc);
  }
  const nickCount = new Map<string, number>();
  for (const a of accounts.values()) if (a.username) nickCount.set(a.username.toLowerCase(), (nickCount.get(a.username.toLowerCase()) ?? 0) + 1);
  for (const [n, c] of nickCount) if (c > 1) notes.push(`Ник @${n} у ${c} аккаунтов - по нику узнаем только первый`);

  // ---------- участники ----------
  // Номер участника - как в выгрузке (колонка «ID»), поэтому вставляем его сами (OVERRIDING SYSTEM VALUE).
  type P = typeof schema.participants.$inferInsert & { id: number };
  const people: P[] = [];
  const ticketsToMake: { participantId: number; code: string; active: boolean }[] = [];
  const paymentsToMake: { participantId: number; amount: number; method: 'cash' | 'transfer'; at: Date | null }[] = [];
  const keys = new Set<string>();
  let confirmedByBank = 0;
  let confirmedSum = 0;
  for (const r of [...rows].sort((a, b) => num(a['ID'] ?? null) - num(b['ID'] ?? null))) {
    const id = num(r['ID'] ?? null);
    const ref = str(r['Код оплаты'] ?? null)!;
    const status = str(r['Статус'] ?? null) === 'Отменён' ? 'cancelled' : 'active';
    const birthDate = dateOnly(r['Дата рождения'] ?? null);
    const phone = phoneOf(r['Телефон'] ?? null);
    const lastName = str(r['Фамилия'] ?? null) ?? '';
    const firstName = str(r['Имя'] ?? null) ?? '';
    const key = personKey({ lastName, firstName, birthDate, phone });
    const tier = tierOf(str(r['Вариант'] ?? null));
    const due = num(r['К оплате'] ?? null);
    let paid = num(r['Оплачено'] ?? null);
    let paymentStatus = PAYMENT.get(str(r['Оплата'] ?? null) ?? '') ?? 'unpaid';
    const method = METHOD.get(str(r['Способ оплаты'] ?? null) ?? '') ?? null;
    const b = bank.get(id);
    let paymentNote: string | null = null;
    if (paymentStatus === 'pending') {
      if (b) {
        confirmedByBank++;
        confirmedSum += due - paid;
        paid = due;
        paymentStatus = 'paid';
        paymentNote = 'Перевод найден банкиром в выписке (чек был на проверке)';
      } else {
        paymentStatus = paid > 0 ? 'partial' : 'unpaid';
        paymentNote = 'До сбоя чек был на проверке - попросить прислать чек ещё раз';
        notes.push(`№${id}: чек был на проверке, у банкира не найден`);
      }
    }
    if (status === 'active') {
      if (keys.has(`${ref}|${key}`)) notes.push(`№${id}: такой же человек уже есть в этом аккаунте`);
      keys.add(`${ref}|${key}`);
    }
    if (status === 'cancelled' && paid > 0) notes.push(`№${id}: отменён, но оплачено ${paid} руб.`);
    if (paymentStatus === 'paid' && method === 'transfer' && bankFile && !b) notes.push(`№${id}: оплачено переводом, но у банкира не записан`);
    people.push({
      id,
      ownerUserId: 0,
      lastName,
      firstName,
      middleName: str(r['Отчество'] ?? null),
      birthDate,
      gender: str(r['Пол'] ?? null) === 'М' ? 'm' : 'f',
      city: str(r['Населённый пункт'] ?? null),
      church: str(r['Церковь'] ?? null),
      phone,
      telegramUsername: nick(r['Ник Telegram'] ?? null),
      relation: 'other',
      category: CATEGORY.get(str(r['Категория'] ?? null) ?? '') ?? 'participant',
      status,
      personKey: key,
      tier,
      breakfast: str(r['Завтрак'] ?? null) === 'да',
      paymentMethod: method,
      paymentStatus,
      amountDue: tier ? String(due) : null,
      amountPaid: String(paid),
      paidAt: paymentStatus === 'paid' ? (b?.arrived ?? null) : null,
      paymentNote,
      sponsorOffer: str(r['Готов оплатить за другого'] ?? null) === 'да',
      extra: { restoredFrom: '2026-10-29', paymentRef: ref },
      createdAt: localTime(r['Зарегистрирован'] ?? null) ?? new Date(),
    });
    const code = str(r['QR-код'] ?? null);
    if (code) ticketsToMake.push({ participantId: id, code, active: status === 'active' });
    if (paid > 0) paymentsToMake.push({ participantId: id, amount: paid, method: method ?? 'cash', at: b?.arrived ?? null });
  }
  // «Я» - единственный в аккаунте или тот, чьё имя совпадает с именем аккаунта в Telegram; ребёнок - ребёнок.
  // Иначе «Я» не ставим: записавший мог быть не участником, и тогда он не смог бы записать себя.
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replaceAll('ё', 'е');
  const activeIn = new Map<string, number>();
  for (const p of people) if (p.status === 'active') activeIn.set((p.extra as { paymentRef: string }).paymentRef, (activeIn.get((p.extra as { paymentRef: string }).paymentRef) ?? 0) + 1);
  const named = new Set<string>();
  for (const p of people) {
    const ref = (p.extra as { paymentRef: string }).paymentRef;
    if (p.category === 'child') p.relation = 'child';
    else if (p.status === 'active' && !named.has(ref) && (activeIn.get(ref) === 1 || norm(p.firstName) === norm(accounts.get(ref)?.name?.split(' ')[0]))) {
      p.relation = 'self';
      named.add(ref);
    }
  }

  const report: RestoreReport = {
    accounts: accounts.size,
    withUsername: [...accounts.values()].filter((a) => a.username).length,
    participants: people.length,
    active: people.filter((p) => p.status === 'active').length,
    tickets: ticketsToMake.length,
    payments: paymentsToMake.length,
    paidSum: paymentsToMake.reduce((s, p) => s + p.amount, 0),
    confirmedByBank,
    confirmedSum,
    notes,
  };
  if (opts.dryRun) return report;

  await db.transaction(async (tx) => {
    const [existing] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from participants`)).rows;
    if (existing?.n) throw new Error(`В базе уже есть участники (${existing.n}) - восстановление только в пустую базу`);
    const restoredAt = new Date();
    const userIdOf = new Map<string, number>();
    const list = [...accounts.values()];
    for (let i = 0; i < list.length; i += 500) {
      const inserted = await tx
        .insert(schema.users)
        .values(
          list.slice(i, i + 500).map((a) => ({
            username: a.username,
            displayName: a.name,
            paymentRef: a.ref,
            restoredAt,
            createdAt: a.created ?? restoredAt,
          })),
        )
        .returning({ id: schema.users.id, paymentRef: schema.users.paymentRef });
      for (const u of inserted) userIdOf.set(u.paymentRef, u.id);
    }
    for (const p of people) p.ownerUserId = userIdOf.get((p.extra as { paymentRef: string }).paymentRef)!;
    for (let i = 0; i < people.length; i += 300) {
      await tx.insert(schema.participants).overridingSystemValue().values(people.slice(i, i + 300));
    }
    for (let i = 0; i < ticketsToMake.length; i += 500) {
      await tx.insert(schema.tickets).values(
        ticketsToMake.slice(i, i + 500).map((t) => ({
          participantId: t.participantId,
          code: t.code,
          webToken: randomToken(18),
          status: t.active ? 'active' : 'revoked',
          revokedReason: t.active ? null : 'cancelled',
          revokedAt: t.active ? null : restoredAt,
        })),
      );
    }
    for (let i = 0; i < paymentsToMake.length; i += 500) {
      await tx.insert(schema.payments).values(
        paymentsToMake.slice(i, i + 500).map((p) => ({
          participantId: p.participantId,
          kind: 'fee',
          amount: String(p.amount),
          method: p.method,
          source: 'manual',
          comment: RESTORE_NOTE,
          createdAt: p.at ?? restoredAt,
        })),
      );
    }
    await tx.execute(sql`select setval(pg_get_serial_sequence('participants', 'id'), (select max(id) from participants))`);
    // Точки отметки на входе - без них сканер не работает.
    const [cp] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from checkpoints`)).rows;
    if (!cp?.n) {
      await tx.insert(schema.checkpoints).values([
        { kind: 'entrance', name: 'Вход' },
        { kind: 'training', name: 'Тренировка волонтёров', countsInStats: false },
      ]);
    }
    await tx.insert(schema.auditLog).values({
      actorUserId: null,
      action: 'restore.import',
      entity: 'system',
      entityId: null,
      after: { ...report, notes: report.notes.length },
    });
  });
  return report;
}
