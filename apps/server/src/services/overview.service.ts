import { TIERS, type StaffOverview, type Tier } from '@sof/shared';
import { sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { duplicateGroups } from './admin.service.ts';
import { adminCounseling } from './counseling.service.ts';
import { dashboard } from './dashboard.service.ts';
import { unreadThreadsCount } from './chat.service.ts';
import { listBlocks } from './seminar.service.ts';
import { getSettings } from './settings.service.ts';
import { botToday } from './bot-log.service.ts';
import { ageRefDate } from './tiers.ts';

const DAYS = 14;
const QUARTER = 15 * 60_000;
const FLOW_BINS = 12;

/** Последние `n` дней `YYYY-MM-DD` по часам события, включая сегодня. */
function lastDays(n: number, tz: string, now = Date.now()): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Set<string>();
  for (let i = n - 1; i >= 0; i--) days.add(fmt.format(new Date(now - i * 86_400_000)));
  return [...days];
}

/** «Статистика» для админов в приложении команды: сводка админки плюс динамика, кто едет и программа. */
export async function staffOverview(ctx: Pick<AppContext, 'db' | 'boss' | 'config'>): Promise<StaffOverview> {
  const settings = await getSettings(ctx.db);
  const tz = settings.eventTimezone;
  const ref = ageRefDate(settings);
  const [dash, byDay, cities, churches, demo, blocks, counseling, openQuestions, duplicates, activities] = await Promise.all([
    dashboard(ctx),
    ctx.db.execute<{ day: string; n: number }>(sql`
      select to_char(created_at at time zone ${tz}, 'YYYY-MM-DD') as day, count(*)::int as n
        from participants
       where status = 'active' and created_at > now() - interval '15 days'
       group by 1`),
    ctx.db.execute<{ name: string; n: number }>(sql`
      select mode() within group (order by trim(city)) as name, count(*)::int as n
        from participants
       where status = 'active' and trim(city) <> ''
       group by lower(trim(city))
       order by n desc, name
       limit 5`),
    ctx.db.execute<{ name: string; n: number }>(sql`
      select mode() within group (order by trim(church)) as name, count(*)::int as n
        from participants
       where status = 'active' and trim(coalesce(church, '')) <> ''
       group by lower(trim(church))
       order by n desc, name
       limit 5`),
    ctx.db.execute<{
      cities: number;
      churches: number;
      m: number;
      f: number;
      under16: number;
      teen: number;
      young: number;
      older: number;
    }>(sql`
      select count(distinct lower(trim(city))) filter (where trim(city) <> '')::int as cities,
             count(distinct lower(trim(church))) filter (where trim(coalesce(church, '')) <> '')::int as churches,
             count(*) filter (where gender = 'm')::int as m,
             count(*) filter (where gender = 'f')::int as f,
             count(*) filter (where birth_date > ${ref}::date - interval '16 years')::int as under16,
             count(*) filter (where birth_date <= ${ref}::date - interval '16 years'
                                and birth_date > ${ref}::date - interval '18 years')::int as teen,
             count(*) filter (where birth_date <= ${ref}::date - interval '18 years'
                                and birth_date > ${ref}::date - interval '26 years')::int as young,
             count(*) filter (where birth_date <= ${ref}::date - interval '26 years')::int as older
        from participants
       where status = 'active'`),
    listBlocks(ctx.db),
    adminCounseling(ctx.db),
    unreadThreadsCount(ctx.db),
    duplicateGroups(ctx),
    ctx.db.execute<{ id: string; title: string; starts_at: Date; capacity: number | null; registered: number; waitlist: number }>(sql`
      select a.id, a.title, a.starts_at, a.capacity,
             count(*) filter (where r.status = 'registered')::int as registered,
             count(*) filter (where r.status = 'waitlist')::int as waitlist
        from activities a
        left join activity_registrations r on r.activity_id = a.id
       where a.status = 'published' and a.registration_mode = 'required' and a.block_id is null and a.ends_at > now()
       group by a.id
       order by a.starts_at, a.id
       limit 15`),
  ]);

  const perDay = new Map(byDay.rows.map((r) => [r.day, r.n]));
  const days = lastDays(DAYS, tz).map((day) => ({ day, n: perDay.get(day) ?? 0 }));

  // Поток на входе: последние 3 часа по 15 минут, пустые четверти - нулями.
  const flowMap = new Map(dash.arrivalsByQuarterHour.map((r) => [new Date(r.t).getTime(), r.n]));
  const lastBin = Math.floor(Date.now() / QUARTER) * QUARTER;
  const flow = Array.from({ length: FLOW_BINS }, (_, i) => {
    const t = lastBin - (FLOW_BINS - 1 - i) * QUARTER;
    return { t: new Date(t).toISOString(), n: flowMap.get(t) ?? 0 };
  });

  const d = demo.rows[0]!;
  const tierTotals = new Map<Tier | 'none', number>(dash.byTier.map((t) => [t.tier, t.total]));
  return {
    generatedAt: new Date().toISOString(),
    registrations: {
      participants: dash.participants.active,
      accounts: dash.accounts,
      cancelled: dash.participants.cancelled,
      today: days.at(-1)?.n ?? 0,
      week: days.slice(-7).reduce((sum, x) => sum + x.n, 0),
      byDay: days,
    },
    payments: {
      enabled: settings.paymentsEnabled,
      byStatus: dash.payments,
      expected: dash.money.expected,
      received: dash.money.received,
      byMethod: dash.money.byMethod,
      donations: dash.money.donations,
      pendingReceipts: dash.pendingReceipts,
    },
    // Варианты с лимитом - всегда (видно «0 / 150»), остальные - когда в них кто-то есть.
    tiers: ([...TIERS, 'none'] as (Tier | 'none')[])
      .filter((k) => (tierTotals.get(k) ?? 0) > 0 || (k !== 'none' && settings.tiers[k].limit))
      .map((k) => {
        const cfg = k === 'none' ? null : settings.tiers[k];
        return { tier: k, label: cfg?.label ?? 'Без варианта', color: cfg?.color ?? null, total: tierTotals.get(k) ?? 0, limit: cfg?.limit ?? null };
      }),
    meals: dash.meals,
    bot: await botToday(ctx.db),
    people: {
      cities: cities.rows,
      citiesTotal: d.cities,
      churches: churches.rows,
      churchesTotal: d.churches,
      gender: { m: d.m, f: d.f },
      ages: { under16: d.under16, from16to17: d.teen, from18to25: d.young, over25: d.older },
    },
    arrival: {
      arrived: dash.arrival.arrived,
      expected: dash.arrival.expected,
      today: dash.arrival.today,
      eventDay: dash.arrival.eventDay,
      flow,
      scanners: dash.scanners.slice(0, 5).map((s) => ({ name: s.name, count: s.count })),
    },
    seminars: blocks.map((b) => {
      const rooms = new Map(b.rooms.map((r) => [r.id, r.name]));
      // Сеансы, что идут (есть зал) или на которые уже поставили людей.
      const topics = b.topics.filter((t) => t.roomId !== null || t.registered > 0);
      return {
        id: b.id,
        title: b.title,
        startsAt: b.startsAt,
        registrationOpen: b.registrationOpen,
        roomsPublished: b.roomsPublishedAt !== null,
        registered: topics.reduce((sum, t) => sum + t.registered, 0),
        capacity: b.rooms.reduce((sum, r) => sum + r.capacity, 0),
        topics: topics
          .map((t) => ({
            id: t.id,
            title: t.title,
            registered: t.registered,
            overflow: t.overflow,
            room: t.roomId !== null ? (rooms.get(t.roomId) ?? null) : null,
          }))
          .sort((x, y) => y.registered - x.registered || x.id - y.id),
      };
    }),
    counseling: counseling.counselors.length
      ? {
          open: counseling.open,
          booked: counseling.counselors.reduce((sum, c) => sum + c.bookings.length, 0),
          slots: counseling.counselors.reduce((sum, c) => sum + c.slots.length, 0),
          counselors: counseling.counselors.map((c) => ({ name: c.name, booked: c.bookings.length, slots: c.slots.length })),
        }
      : null,
    activities: activities.rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      startsAt: new Date(r.starts_at).toISOString(),
      capacity: r.capacity,
      registered: r.registered,
      waitlist: r.waitlist,
    })),
    attention: {
      openQuestions,
      pendingReceipts: settings.paymentsEnabled ? dash.pendingReceipts : 0,
      duplicates: duplicates.length,
    },
  };
}
