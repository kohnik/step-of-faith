import {
  MIN_AGE,
  TIERS,
  ageOn,
  braceletOf,
  breakfastAllowed,
  formatRub,
  priceOf,
  type Meal,
  type Settings,
  type Tier,
  type TierConfig,
} from '@sof/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type DbLike } from '../db/client.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { conflict } from '../lib/errors.ts';

/**
 * Вариант выключен в настройках («Показывать при регистрации») - записаться или перейти на него нельзя.
 * Нужно, когда освободившиеся места (например, обеды после снятия неоплативших) больше не раздаём.
 */
export function assertTierOffered(settings: Settings, tier: Tier): void {
  const cfg = settings.tiers[tier];
  if (cfg.enabled === false) {
    throw conflict('tier_closed', `«${cfg.label}»: запись закрыта, выберите другой вариант`, { tier });
  }
}

/**
 * Условие на participants «у человека есть это питание»: завтрак - по галочке, обед и ужин - вариант
 * с чёрным браслетом (по нему кормят). null - ни у кого (нет вариантов с чёрным браслетом).
 */
export function mealEatersSql(settings: Settings, meal: Meal): SQL | null {
  if (meal === 'breakfast') return sql`breakfast`;
  const black = TIERS.filter((t) => braceletOf(settings.tiers, t) === 'black');
  return black.length ? sql`tier in ${black}` : null;
}

/** Завтрак выключен в настройках - добавить его нельзя (у кого уже есть, остаётся). */
export function assertBreakfastOffered(settings: Settings): void {
  if (settings.breakfast.enabled === false) throw conflict('breakfast_closed', 'Завтрак больше не добавить - снимите галочку');
}

export function asTier(v: string | null | undefined): Tier | null {
  return v && (TIERS as readonly string[]).includes(v) ? (v as Tier) : null;
}

export function tierConfig(settings: Settings, tier: string | null | undefined): TierConfig | null {
  const t = asTier(tier);
  return t ? settings.tiers[t] : null;
}

/** Сумма к оплате за вариант и завтрак: `45.00`. */
export function amountForTier(settings: Settings, tier: Tier, breakfast = false): string {
  return priceOf(settings, tier, breakfast).toFixed(2);
}

/** Без взноса (сумма 0) - на входе как оплаченный. */
export function initialPaymentStatus(settings: Settings, tier: Tier, breakfast = false): 'unpaid' | 'exempt' {
  return priceOf(settings, tier, breakfast) > 0 ? 'unpaid' : 'exempt';
}

/** Завтрак ставим только к платному варианту: у «Без взноса» галочку молча снимаем. */
export function withBreakfast(tier: string | null | undefined, breakfast: boolean | null | undefined): boolean {
  return !!breakfast && breakfastAllowed(tier);
}

async function breakfastCount(db: DbLike): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.participants)
    .where(and(eq(schema.participants.breakfast, true), eq(schema.participants.status, 'active')));
  return row?.n ?? 0;
}

/** Сколько завтраков осталось (считаем все активные регистрации, оплачены или нет); null - без лимита. */
export async function breakfastLeft(db: DbLike, settings: Settings): Promise<number | null> {
  const limit = settings.breakfast.limit;
  return limit ? Math.max(0, limit - (await breakfastCount(db))) : null;
}

/**
 * Хватит ли завтраков ещё на `adding` человек - под блокировкой до конца транзакции, как у вариантов.
 * Лимит проверяем только у тех, кто завтрак добавляет: уже записанных он не выгоняет.
 */
export async function assertBreakfastRoom(tx: DbLike, settings: Settings, adding: number): Promise<void> {
  const limit = settings.breakfast.limit;
  if (!limit || adding <= 0) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sof:breakfast'))`);
  const left = limit - (await breakfastCount(tx));
  if (adding > left) {
    throw conflict(
      'breakfast_full',
      left > 0 ? `Завтраков осталось: ${left}` : 'Завтраков больше нет - снимите галочку завтрака',
      { left: Math.max(0, left) },
    );
  }
}

/** Админ может добавить завтрак сверх лимита - сохраняем, но говорим ему об этом. */
export async function breakfastOverWarning(db: DbLike, settings: Settings): Promise<string | undefined> {
  const limit = settings.breakfast.limit;
  if (!limit) return undefined;
  const n = await breakfastCount(db);
  return n > limit ? `Завтраков: ${n} из ${limit} - лимит превышен` : undefined;
}

/** Сколько мест осталось у вариантов с лимитом (считаем все активные регистрации, оплачены или нет). */
export async function tierLeft(db: DbLike, settings: Settings): Promise<Partial<Record<Tier, number>>> {
  const limited = TIERS.filter((t) => settings.tiers[t].limit);
  if (limited.length === 0) return {};
  const rows = await db.execute<{ tier: string; n: number }>(sql`
    select tier, count(*)::int as n from ${schema.participants}
     where status = 'active' and tier is not null group by tier`);
  const used = new Map(rows.rows.map((r) => [r.tier, r.n]));
  return Object.fromEntries(limited.map((t) => [t, Math.max(0, settings.tiers[t].limit! - (used.get(t) ?? 0))]));
}

/**
 * Хватит ли мест в варианте ещё на `adding` человек. Под блокировкой варианта до конца транзакции -
 * две регистрации не займут одно последнее место. Мест нет - conflict('tier_full').
 */
export async function assertTierRoom(tx: DbLike, settings: Settings, tier: Tier, adding: number): Promise<void> {
  const cfg = settings.tiers[tier];
  if (!cfg.limit || adding <= 0) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sof:tier:${tier}`}))`);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.participants)
    .where(and(eq(schema.participants.tier, tier), eq(schema.participants.status, 'active')));
  const left = cfg.limit - (row?.n ?? 0);
  if (adding > left) {
    throw conflict(
      'tier_full',
      left > 0 ? `«${cfg.label}»: осталось мест - ${left}` : `«${cfg.label}»: мест больше нет, выберите другой вариант`,
      { tier, left: Math.max(0, left) },
    );
  }
}

/** Админ может поставить человека сверх лимита - сохраняем, но говорим ему об этом. */
export async function tierOverWarning(db: DbLike, settings: Settings, tier: Tier): Promise<string | undefined> {
  const cfg = settings.tiers[tier];
  if (!cfg.limit) return undefined;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.participants)
    .where(and(eq(schema.participants.tier, tier), eq(schema.participants.status, 'active')));
  const n = row?.n ?? 0;
  return n > cfg.limit ? `«${cfg.label}»: занято ${n} из ${cfg.limit} мест - лимит превышен` : undefined;
}

/** Короткий хеш цветов, подписей и завтрака - чтобы перерисовать QR-картинки после правки в настройках. */
export function tiersVersion(settings: Settings): string {
  return sha256Hex(JSON.stringify([settings.tiers, settings.breakfast])).slice(0, 8);
}

/** Дата, на которую считаем «до 16»: начало конференции, иначе сегодня. */
/** Дата, на которую считаем возраст: день начала конференции по часам события (не по UTC). */
export function ageRefDate(settings: Settings): string {
  const at = settings.eventStartsAt ? new Date(settings.eventStartsAt) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: settings.eventTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function isUnder16(settings: Settings, birthDate: string | null): boolean {
  return birthDate ? ageOn(birthDate, ageRefDate(settings)) < MIN_AGE : false;
}

/**
 * Строка оплаты для бота, коротко и без значков:
 * «35 руб., к оплате переводом» · «35 руб., оплачено» · «чек на проверке» · «внесено 20 из 35 руб.» · «без взноса».
 */
export function personPaymentText(
  settings: Settings,
  p: {
    tier: string | null;
    breakfast?: boolean;
    amountDue: string | null;
    amountPaid?: string | null;
    paymentStatus: string;
    paymentMethod: string | null;
  },
): string {
  const tier = asTier(p.tier);
  if (p.paymentStatus === 'exempt') return 'без взноса';
  const due = p.amountDue != null ? Number(p.amountDue) : tier ? priceOf(settings, tier, !!p.breakfast) : 0;
  const sum = formatRub(due);
  switch (p.paymentStatus) {
    case 'paid':
      return `${sum}, оплачено`;
    case 'pending':
      // Дни конференции: человеку не о чем волноваться - чек получили, проверим потом.
      return settings.softPaymentLabels ? `${sum}, чек получен ✓` : `${sum}, чек на проверке`;
    case 'partial':
      return `внесено ${formatRub(Number(p.amountPaid ?? 0))} из ${sum}`;
    default: {
      const how = !settings.transfersEnabled || p.paymentMethod === 'cash' ? ' наличными' : p.paymentMethod === 'transfer' ? ' переводом' : '';
      return settings.softPaymentLabels ? `${sum}, не забудьте оплатить${how}` : `${sum}, к оплате${how}`;
    }
  }
}
