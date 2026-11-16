import { DEFAULT_SETTINGS, TIERS, breakfastAllowed, priceOf, settingsSchema, type Settings, type Tier } from '@sof/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { schema, type DbLike, type Tx } from '../db/client.ts';
import { audit } from '../lib/audit.ts';

const KEY = 'app';
const TTL_MS = 5_000;
let cache: { value: Settings; at: number } | null = null;

export async function getSettings(db: DbLike, { fresh = false } = {}): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, KEY) });
  const merged = { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings> | undefined) ?? {}) };
  const parsed = settingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : salvage(merged, parsed.error.issues);
  cache = { value, at: Date.now() };
  return value;
}

/**
 * Сохранённые настройки не прошли схему (например, после обновления правил). Раньше молча брали всё
 * по умолчанию - сбрасывались цены, тексты и даты регистрации. Теперь по умолчанию - только сломанные поля.
 */
function salvage(merged: Record<string, unknown>, issues: { path: PropertyKey[] }[]): Settings {
  const shape = settingsSchema.shape;
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    const r = shape[key].safeParse(merged[key]);
    if (r.success) out[key] = r.data;
  }
  console.warn('settings: stored values failed validation, using defaults for:', [...new Set(issues.map((i) => String(i.path[0])))].join(', '));
  const again = settingsSchema.safeParse(out);
  return again.success ? again.data : DEFAULT_SETTINGS;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

/**
 * Сохранить только присланные поля поверх текущих. Так форма «Настроек», открытая давно, не откатывает
 * переключатели, которые тем временем поменяли на других страницах (душепопечение, запись на мероприятия).
 */
export async function patchSettings(db: DbLike, patch: Partial<Settings>, actorUserId: number): Promise<Settings> {
  const current = await getSettings(db, { fresh: true });
  const next = settingsSchema.parse({ ...current, ...patch });
  return updateSettings(db, next, actorUserId);
}

export async function updateSettings(db: DbLike, next: Settings, actorUserId: number): Promise<Settings> {
  try {
    await db.transaction(async (tx) => {
      const before = await getSettings(tx, { fresh: true });
      await tx
        .insert(schema.settings)
        .values({ key: KEY, value: next, updatedBy: actorUserId })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: next, updatedAt: new Date(), updatedBy: actorUserId },
        });
      await audit(tx, { actorUserId, action: 'settings.update', entity: 'settings', entityId: KEY, before, after: next });
      // Цена - вариант плюс завтрак: пересчитываем каждую пару отдельно (поменяли цену варианта или завтрака).
      for (const tier of TIERS) {
        for (const breakfast of breakfastAllowed(tier) ? [false, true] : [false]) {
          const from = priceOf(before, tier, breakfast);
          const to = priceOf(next, tier, breakfast);
          if (from !== to) await repriceTier(tx, tier, breakfast, from, to, actorUserId);
        }
      }
    });
  } finally {
    invalidateSettingsCache();
  }
  return next;
}

/**
 * Поменяли цену варианта или завтрака - пересчитываем «к оплате» только тем, у кого стоит старая цена
 * (вариант + завтрак, если он есть): ручную скидку и ручное «без взноса» (волонтёры, спикеры) не трогаем,
 * уже оплаченным не доначисляем. Частично оплаченным статус считаем от уже внесённого; «чек на проверке» остаётся.
 */
async function repriceTier(tx: Tx, tier: Tier, breakfast: boolean, from: number, to: number, actorUserId: number): Promise<void> {
  const fromDue = from.toFixed(2);
  const rows = await tx
    .select()
    .from(schema.participants)
    .where(
      and(
        eq(schema.participants.tier, tier),
        eq(schema.participants.breakfast, breakfast),
        eq(schema.participants.status, 'active'),
        or(
          and(inArray(schema.participants.paymentStatus, ['unpaid', 'partial', 'pending']), eq(schema.participants.amountDue, fromDue)),
          // «Без взноса» из-за бесплатного варианта (а не вручную) - платный вариант теперь тоже платный.
          from === 0
            ? and(eq(schema.participants.paymentStatus, 'exempt'), sql`coalesce(${schema.participants.amountDue}, 0) = 0`)
            : sql`false`,
        ),
      ),
    )
    .for('update');
  for (const p of rows) {
    const paid = Number(p.amountPaid ?? 0);
    const status =
      p.paymentStatus === 'pending'
        ? 'pending'
        : to === 0
          ? paid > 0
            ? 'paid'
            : 'exempt'
          : paid + 1e-9 >= to
            ? 'paid'
            : paid > 0
              ? 'partial'
              : 'unpaid';
    await tx
      .update(schema.participants)
      .set({ amountDue: to.toFixed(2), paymentStatus: status, updatedAt: new Date() })
      .where(eq(schema.participants.id, p.id));
    await audit(tx, {
      actorUserId,
      action: 'participant.reprice',
      entity: 'participant',
      entityId: p.id,
      before: { amountDue: p.amountDue, paymentStatus: p.paymentStatus },
      after: { amountDue: to.toFixed(2), paymentStatus: status },
    });
  }
}

/** Оплата выключена - на входе никого не останавливаем из-за статуса оплаты. */
export function effectiveAllowUnpaid(s: Settings): boolean {
  return !s.paymentsEnabled || s.allowUnpaidEntry;
}

/** Календарный день `YYYY-MM-DD` в поясе события. */
export function eventDayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Ещё не день начала конференции: сканер входа работает как касса, отметки входа не ставятся.
 * Считаем по дню, а не по минуте начала программы: двери открывают раньше (программа в 18:00, вход с 16:00).
 */
export function isBeforeEvent(s: Settings, now = new Date()): boolean {
  return s.eventStartsAt !== null && eventDayKey(now, s.eventTimezone) < eventDayKey(new Date(s.eventStartsAt), s.eventTimezone);
}

/** Конференция уже началась (дата начала задана и наступила) - тексты «до начала» больше не верны. */
export function hasEventStarted(s: Settings, now = new Date()): boolean {
  return s.eventStartsAt !== null && now >= new Date(s.eventStartsAt);
}

/** Перевод за мерч и пожертвование: тот же счёт, свой текст без «пакета регистрации»; не задан - текст для взноса. */
export function otherTransferText(s: Settings): string {
  return s.merchPaymentInstructions.trim() || s.paymentInstructions;
}

/** Когда вносить взнос: до начала - «до начала конференции», после - на кассе. */
export function feeDeadlineText(s: Settings): string {
  return hasEventStarted(s) ? 'Взнос можно внести на кассе у входа.' : 'Взнос вносится до начала конференции.';
}

export function isRegistrationOpen(s: Settings, now = new Date()): boolean {
  // Регистрация на месте открыта, пока включена, - даты не важны.
  if (s.onSiteRegistration) return true;
  if (s.registrationOpensAt && now < new Date(s.registrationOpensAt)) return false;
  if (s.registrationClosesAt && now >= new Date(s.registrationClosesAt)) return false;
  return true;
}
