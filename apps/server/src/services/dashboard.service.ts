import { CATEGORIES, MIN_AGE, PAYMENT_STATUSES, TIERS, braceletOf, type Bracelet, type Category, type DashboardResponse, type MoneyBreakdown, type PaymentMethod, type PaymentStatus } from '@sof/shared';
import { sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { DbLike } from '../db/client.ts';
import { eventDays, scanLogRows } from './admin.service.ts';
import { userDisplayName } from '../lib/format.ts';
import { namesOf } from './chat.service.ts';
import { getSettings } from './settings.service.ts';
import { ageRefDate } from './tiers.ts';

const ALERT_OUTCOMES = sql`('duplicate', 'invalid_code', 'unknown_code', 'revoked_ticket', 'event_id_reused')`;

const dayKeyIn = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Сколько людей отмечено на входе сегодня (по часам события). */
export async function arrivedToday(db: DbLike, tz: string): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    select count(distinct ci.participant_id)::int as n
      from check_ins ci join checkpoints c on c.id = ci.checkpoint_id
     where c.kind = 'entrance' and c.counts_in_stats and ci.revoked_at is null
       and (ci.created_at at time zone ${tz})::date = (now() at time zone ${tz})::date`);
  return res.rows[0]?.n ?? 0;
}

const VISIT_DAYS = 14;

/**
 * Сколько разных людей заходило в бота и в Mini App по дням (последние две недели, пустые дни - нулями)
 * и сколько из них новых - впервые открыли бота или приложение в этот день.
 */
export async function visitsByDay(db: DbLike, tz: string): Promise<DashboardResponse['visits']> {
  const today = dayKeyIn(new Date(), tz);
  const [visits, fresh] = await Promise.all([
    db.execute<{ day: string; total: number; bot: number; app: number }>(sql`
      select day::text as day, count(distinct user_id)::int as total,
             count(*) filter (where source = 'bot')::int as bot,
             count(*) filter (where source = 'app')::int as app
        from user_visits where day > ${today}::date - ${VISIT_DAYS}::int group by day`),
    db.execute<{ day: string; n: number }>(sql`
      select (created_at at time zone ${tz})::date::text as day, count(*)::int as n
        from users where tg_id is not null and created_at > now() - interval '15 days' group by 1`),
  ]);
  const byDay = new Map(visits.rows.map((r) => [r.day, r]));
  const newByDay = new Map(fresh.rows.map((r) => [r.day, r.n]));
  return Array.from({ length: VISIT_DAYS }, (_, i) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (VISIT_DAYS - 1 - i));
    const day = d.toISOString().slice(0, 10);
    const v = byDay.get(day);
    return { day, total: v?.total ?? 0, bot: v?.bot ?? 0, app: v?.app ?? 0, new: newByDay.get(day) ?? 0 };
  });
}

const TRAFFIC_HOURS = 48;
const TRAFFIC_DAYS = 14;

/** Нагрузка: сколько запросов пришло в бота и в Mini App - по часам (48 ч) и по дням (14 дней, по часам события). */
export async function trafficStats(db: DbLike, tz: string): Promise<DashboardResponse['traffic']> {
  const res = await db.execute<{ hour: Date; source: 'bot' | 'app'; n: number }>(sql`
    select hour, source, n from traffic_hourly where hour > now() - interval '15 days'`);
  const byHour = new Map<string, { bot: number; app: number }>();
  const byDay = new Map<string, { bot: number; app: number }>();
  for (const r of res.rows) {
    const at = new Date(r.hour);
    const h = byHour.get(at.toISOString()) ?? { bot: 0, app: 0 };
    h[r.source] += r.n;
    byHour.set(at.toISOString(), h);
    const day = dayKeyIn(at, tz);
    const d = byDay.get(day) ?? { bot: 0, app: 0 };
    d[r.source] += r.n;
    byDay.set(day, d);
  }
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const hours = Array.from({ length: TRAFFIC_HOURS }, (_, i) => {
    const at = new Date(now.getTime() - (TRAFFIC_HOURS - 1 - i) * 3600_000).toISOString();
    return { at, ...(byHour.get(at) ?? { bot: 0, app: 0 }) };
  });
  const today = dayKeyIn(new Date(), tz);
  const days = Array.from({ length: TRAFFIC_DAYS }, (_, i) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (TRAFFIC_DAYS - 1 - i));
    const day = d.toISOString().slice(0, 10);
    return { day, ...(byDay.get(day) ?? { bot: 0, app: 0 }) };
  });
  const topRows = await db.execute<{ user_id: string; bot: number; app: number }>(sql`
    select user_id, coalesce(sum(n) filter (where source = 'bot'), 0)::int as bot, coalesce(sum(n) filter (where source = 'app'), 0)::int as app
      from traffic_users where hour > now() - interval '24 hours'
     group by user_id order by sum(n) desc limit 10`);
  const names = await namesOf(db, topRows.rows.map((r) => Number(r.user_id)));
  const top = topRows.rows.map((r) => {
    const n = names.get(Number(r.user_id));
    return { userId: Number(r.user_id), name: n?.name ?? 'Без имени', username: n?.username ?? null, bot: r.bot, app: r.app };
  });
  return { hours, days, top };
}

/** Из чего сложились деньги - по журналу оплат: способами и по кассирам (только активные участники, без отменённых приёмов). */
export async function moneyBreakdown(db: DbLike): Promise<Pick<MoneyBreakdown, 'byMethod' | 'byCashier' | 'donations'>> {
  const [methods, cashiers, donations] = await Promise.all([
    db.execute<{ method: PaymentMethod; amount: string; people: number }>(sql`
      select pm.method, sum(pm.amount)::text as amount, count(distinct pm.participant_id)::int as people
        from payments pm join participants p on p.id = pm.participant_id
       where pm.undone_at is null and p.status = 'active' and pm.kind = 'fee'
       group by pm.method`),
    db.execute<{
      user_id: string | null;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
      username: string | null;
      cash: string;
      other: string;
      donations: string;
      people: number;
    }>(sql`
      select pm.accepted_by as user_id, u.display_name, u.first_name, u.last_name, u.username,
             coalesce(sum(pm.amount) filter (where pm.kind = 'fee' and pm.method = 'cash'), 0)::text as cash,
             coalesce(sum(pm.amount) filter (where pm.kind = 'fee' and pm.method <> 'cash'), 0)::text as other,
             coalesce(sum(pm.amount) filter (where pm.kind = 'donation'), 0)::text as donations,
             count(distinct pm.participant_id) filter (where pm.kind = 'fee')::int as people
        from payments pm
        left join participants p on p.id = pm.participant_id
        left join users u on u.id = pm.accepted_by
       where pm.undone_at is null and (pm.participant_id is null or p.status = 'active' or pm.kind = 'donation') and pm.source = 'desk'
       group by pm.accepted_by, u.display_name, u.first_name, u.last_name, u.username
       order by sum(pm.amount) desc`),
    db.execute<{ amount: string; cash: string; count: number }>(sql`
      select coalesce(sum(pm.amount), 0)::text as amount,
             coalesce(sum(pm.amount) filter (where pm.method = 'cash'), 0)::text as cash,
             count(*)::int as count
        from payments pm left join participants p on p.id = pm.participant_id
       where pm.kind = 'donation' and pm.undone_at is null`),
  ]);
  const d = donations.rows[0]!;
  const order: PaymentMethod[] = ['cash', 'transfer', 'card'];
  return {
    byMethod: order.flatMap((m) => {
      const r = methods.rows.find((x) => x.method === m);
      return r ? [{ method: m, amount: Number(r.amount).toFixed(2), people: r.people }] : [];
    }),
    byCashier: cashiers.rows.map((r) => ({
      userId: r.user_id == null ? null : Number(r.user_id),
      name: r.user_id == null ? 'Удалённый аккаунт' : userDisplayName({ displayName: r.display_name, firstName: r.first_name, lastName: r.last_name, username: r.username }),
      cash: Number(r.cash).toFixed(2),
      other: Number(r.other).toFixed(2),
      donations: Number(r.donations).toFixed(2),
      people: r.people,
    })),
    donations: { amount: Number(d.amount).toFixed(2), cash: Number(d.cash).toFixed(2), count: d.count },
  };
}

export async function dashboard(ctx: Pick<AppContext, 'db'>): Promise<DashboardResponse> {
  const settings = await getSettings(ctx.db);
  const ref = ageRefDate(settings);
  const tz = settings.eventTimezone;
  const [totals, payments, arrivals, categories, acts, scanners, alerts, receipts, recent, tiers, today] = await Promise.all([
    ctx.db.execute<{ accounts: number; active: number; cancelled: number; arrived: number }>(sql`
      select count(distinct owner_user_id) filter (where status = 'active')::int as accounts,
             count(*) filter (where status = 'active')::int as active,
             count(*) filter (where status = 'cancelled')::int as cancelled,
             count(*) filter (where status = 'active' and arrived_at is not null)::int as arrived
        from participants`),
    ctx.db.execute<{ payment_status: PaymentStatus; n: number }>(sql`
      select payment_status, count(*)::int as n from participants where status = 'active' group by payment_status`),
    ctx.db.execute<{ t: Date; n: number }>(sql`
      select date_bin('15 minutes', ci.created_at, timestamptz '2000-01-01 00:00:00+00') as t, count(*)::int as n
        from check_ins ci join checkpoints c on c.id = ci.checkpoint_id
       where c.kind = 'entrance' and c.counts_in_stats and ci.revoked_at is null
         and ci.created_at > now() - interval '72 hours'
       group by 1 order by 1`),
    ctx.db.execute<{ category: Category; total: number; arrived: number }>(sql`
      select category, count(*)::int as total, count(*) filter (where arrived_at is not null)::int as arrived
        from participants where status = 'active' group by category`),
    ctx.db.execute<{ id: string; title: string; starts_at: Date; capacity: number | null; registered: number; waitlist: number }>(sql`
      select a.id, a.title, a.starts_at, a.capacity,
             count(*) filter (where r.status = 'registered')::int as registered,
             count(*) filter (where r.status = 'waitlist')::int as waitlist
        from activities a left join activity_registrations r on r.activity_id = a.id
       where a.status = 'published' and a.registration_mode = 'required' and a.ends_at > now() - interval '2 hours'
       group by a.id order by a.starts_at limit 20`),
    ctx.db.execute<{ name: string; username: string | null; count: number; last_at: Date }>(sql`
      select coalesce(u.display_name, nullif(concat_ws(' ', u.first_name, u.last_name), ''), '@' || u.username, 'Без имени') as name,
             u.username, count(*)::int as count, max(ci.created_at) as last_at
        from check_ins ci join users u on u.id = ci.scanned_by
       where ci.revoked_at is null and ci.created_at > now() - interval '24 hours'
       group by u.id order by count desc limit 30`),
    ctx.db.execute<{ duplicates: number; invalid: number }>(sql`
      select count(*) filter (where outcome = 'duplicate')::int as duplicates,
             count(*) filter (where outcome in ('invalid_code', 'unknown_code', 'revoked_ticket'))::int as invalid
        from scan_log where created_at > now() - interval '24 hours'`),
    ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from payment_receipts where status = 'pending'`),
    scanLogRows(ctx.db, sql`sl.outcome in ${ALERT_OUTCOMES}`, 10),
    ctx.db.execute<{
      tier: string | null;
      total: number;
      paid: number;
      arrived: number;
      due: string;
      received: string;
      under16: number;
      breakfast: number;
    }>(sql`
      select tier, count(*)::int as total,
             count(*) filter (where breakfast)::int as breakfast,
             count(*) filter (where payment_status in ('paid', 'exempt'))::int as paid,
             count(*) filter (where arrived_at is not null)::int as arrived,
             coalesce(sum(amount_due), 0)::text as due,
             coalesce(sum(amount_paid), 0)::text as received,
             count(*) filter (where birth_date > ${ref}::date - make_interval(years => ${MIN_AGE}))::int as under16
        from participants where status = 'active' group by tier`),
    // На 2-й и 3-й день важно «сколько пришло сегодня», а не «пришли хоть раз».
    arrivedToday(ctx.db, tz),
  ]);
  const [visits, traffic] = await Promise.all([visitsByDay(ctx.db, tz), trafficStats(ctx.db, tz)]);
  const tierMap = new Map(tiers.rows.map((r) => [r.tier ?? 'none', r]));
  // Браслет - по варианту: чёрный (с питанием) или белый; люди без варианта браслета не получают.
  const braceletsOf = (b: Bracelet) =>
    TIERS.filter((t) => braceletOf(settings.tiers, t) === b).reduce(
      (acc, t) => ({ total: acc.total + (tierMap.get(t)?.total ?? 0), arrived: acc.arrived + (tierMap.get(t)?.arrived ?? 0) }),
      { total: 0, arrived: 0 },
    );
  const t = totals.rows[0]!;
  const paymentMap = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, 0])) as Record<PaymentStatus, number>;
  for (const r of payments.rows) paymentMap[r.payment_status] = r.n;
  const catMap = new Map(categories.rows.map((r) => [r.category, r]));
  return {
    traffic,
    accounts: t.accounts,
    participants: { active: t.active, cancelled: t.cancelled },
    payments: paymentMap,
    arrival: {
      arrived: t.arrived,
      expected: t.active,
      today,
      eventDay: eventDays(settings).includes(dayKeyIn(new Date(), tz)),
    },
    arrivalsByQuarterHour: arrivals.rows.map((r) => ({ t: new Date(r.t).toISOString(), n: r.n })),
    byCategory: CATEGORIES.filter((c) => catMap.has(c)).map((c) => ({
      category: c,
      total: catMap.get(c)!.total,
      arrived: catMap.get(c)!.arrived,
    })),
    activities: acts.rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      startsAt: new Date(r.starts_at).toISOString(),
      capacity: r.capacity,
      registered: r.registered,
      waitlist: r.waitlist,
    })),
    scanners: scanners.rows.map((r) => ({ name: r.name, username: r.username, count: r.count, lastAt: new Date(r.last_at).toISOString() })),
    alerts: { duplicates: alerts.rows[0]!.duplicates, invalid: alerts.rows[0]!.invalid, recent },
    pendingReceipts: receipts.rows[0]!.n,
    byTier: [...TIERS, 'none' as const]
      .filter((k) => tierMap.has(k))
      .map((k) => ({ tier: k, total: tierMap.get(k)!.total, paid: tierMap.get(k)!.paid, arrived: tierMap.get(k)!.arrived })),
    meals: {
      lunchDinner: braceletsOf('black').total,
      bracelets: { black: braceletsOf('black'), white: braceletsOf('white') },
      breakfast: tiers.rows.reduce((s, r) => s + r.breakfast, 0),
      breakfastLimit: settings.breakfast.limit,
    },
    money: {
      expected: tiers.rows.reduce((s, r) => s + Number(r.due), 0).toFixed(2),
      received: tiers.rows.reduce((s, r) => s + Number(r.received), 0).toFixed(2),
      ...(await moneyBreakdown(ctx.db)),
    },
    under16: tiers.rows.reduce((s, r) => s + r.under16, 0),
    visits,
    generatedAt: new Date().toISOString(),
  };
}
