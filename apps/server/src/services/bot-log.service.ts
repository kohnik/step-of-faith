import {
  BOT_JOB_LABELS,
  BOT_KINDS,
  botKindInfo,
  MEAL_LABELS,
  type BotLogOverview,
  type BotMessageRow,
  type BotOutcome,
  type BotRunDetail,
  type BotRunView,
  type BotScheduledItem,
  type BotTone,
  type BotUnreachableRow,
  type Meal,
  type Settings,
} from '@sof/shared';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { schema, type DbLike } from '../db/client.ts';
import { notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import { getSettings } from './settings.service.ts';
import { mealEatersSql } from './tiers.ts';
import { FEEDBACK_REMIND_TEXT, feedbackRemindAudience } from './feedback.service.ts';

/**
 * Журнал сообщений бота для админки: запуски (массовые - одной строкой, «по одному» - по часу),
 * кому что ушло и что ответили, что запланировано и до кого бот не достучится.
 */

const MASS = new Set(Object.entries(BOT_KINDS).flatMap(([k, v]) => (v.mass ? [k] : [])));
const FAILED: BotOutcome[] = ['blocked', 'unreachable', 'no_telegram', 'failed'];

type RunRow = {
  campaign: string | null;
  kind: string;
  hour: string;
  at: string;
  last_at: string;
  total: number;
  sent: number;
  failed: number;
};

/** Запуски за последние `days` дней, новые сверху; ручные рассылки - тоже здесь. */
export async function botRuns(db: DbLike, days = 3): Promise<BotRunView[]> {
  // Сбой, после которого повтор дошёл, - не «не дошло»: у человека в запуске считаем лучший итог.
  const rows = await db.execute<RunRow>(sql`
    with best as (
      select distinct on (kind, coalesce(campaign, date_trunc('hour', created_at)::text), user_id, coalesce(ref, ''))
             campaign, kind, user_id, outcome, created_at
        from bot_messages
       where created_at > now() - make_interval(days => ${days})
       order by kind, coalesce(campaign, date_trunc('hour', created_at)::text), user_id, coalesce(ref, ''), (outcome = 'sent') desc, created_at desc
    )
    select campaign, kind,
           date_trunc('hour', min(created_at))::text as hour,
           min(created_at)::text as at, max(created_at)::text as last_at,
           count(*)::int as total,
           count(*) filter (where outcome = 'sent')::int as sent,
           count(*) filter (where outcome <> 'sent')::int as failed
      from best
     group by campaign, kind, case when campaign is null then date_trunc('hour', created_at) end
     order by min(created_at) desc
     limit 300`);
  const runs: BotRunView[] = rows.rows.map((r) => {
    const info = botKindInfo(r.kind);
    return {
      key: r.campaign ? `c:${r.kind}:${r.campaign}` : `k:${r.kind}:${new Date(r.hour).toISOString()}`,
      kind: r.kind,
      label: info.label,
      topic: info.topic,
      at: new Date(r.at).toISOString(),
      lastAt: new Date(r.last_at).toISOString(),
      total: r.total,
      sent: r.sent,
      failed: r.failed,
      answers: null,
    };
  });
  // Ответы на вопрос - только у запусков «Точно заберёте?» и приглашений в игру.
  for (const run of runs) {
    if (run.kind === 'merch.confirm_ask' || run.kind === 'game.invite') run.answers = summarize((await runRows(db, run)).map((r) => r.answer));
  }
  const broadcasts = await db
    .select()
    .from(schema.broadcasts)
    .where(and(sql`${schema.broadcasts.startedAt} > now() - make_interval(days => ${days})`, eq(schema.broadcasts.isTest, false)))
    .orderBy(desc(schema.broadcasts.startedAt));
  for (const b of broadcasts) {
    runs.push({
      key: `b:${b.id}`,
      kind: 'broadcast',
      label: `Рассылка: ${b.text.replace(/\s+/g, ' ').slice(0, 60)}${b.text.length > 60 ? '…' : ''}`,
      topic: 'broadcast',
      at: (b.startedAt ?? b.createdAt).toISOString(),
      lastAt: (b.finishedAt ?? b.startedAt ?? b.createdAt).toISOString(),
      total: b.total,
      sent: b.sent,
      failed: b.failed + b.blocked,
      answers: null,
    });
  }
  return runs.sort((a, b) => b.at.localeCompare(a.at));
}

function summarize(answers: (BotMessageRow['answer'] | null)[]): BotRunView['answers'] {
  const counts = new Map<string, { label: string; count: number; tone: BotTone }>();
  for (const a of answers) {
    const x = a ?? { label: 'нет ответа', tone: 'gray' as BotTone };
    const cur = counts.get(x.label) ?? { ...x, count: 0 };
    cur.count++;
    counts.set(x.label, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** Строки запуска: кому, дошло ли, что ответили. */
async function runRows(db: DbLike, run: Pick<BotRunView, 'key' | 'kind'>): Promise<BotMessageRow[]> {
  if (run.key.startsWith('b:')) return broadcastRows(db, Number(run.key.slice(2)));
  let where;
  if (run.key.startsWith('c:')) {
    const [, kind, campaign] = run.key.match(/^c:([^:]+):(.+)$/) ?? [];
    if (!kind || !campaign) throw notFound('Запуск не найден');
    where = and(eq(schema.botMessages.kind, kind), eq(schema.botMessages.campaign, campaign));
  } else {
    const [, kind, hour] = run.key.match(/^k:(.+):([^:]+:[^:]+:[^:]+)$/) ?? [];
    if (!kind || !hour) throw notFound('Запуск не найден');
    where = and(
      eq(schema.botMessages.kind, kind),
      sql`${schema.botMessages.campaign} is null`,
      sql`date_trunc('hour', ${schema.botMessages.createdAt}) = ${hour}::timestamptz`,
    );
  }
  const rows = await db
    .select({ m: schema.botMessages, u: schema.users })
    .from(schema.botMessages)
    .leftJoin(schema.users, eq(schema.users.id, schema.botMessages.userId))
    .where(where)
    .orderBy(desc(schema.botMessages.createdAt))
    .limit(2000);
  // У человека в запуске - одна строка: дошедшая, иначе последняя попытка.
  const seen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.m.userId ?? 'x'}:${r.m.ref ?? ''}`;
    const prev = seen.get(k);
    if (!prev || (prev.m.outcome !== 'sent' && r.m.outcome === 'sent')) seen.set(k, r);
  }
  const list = [...seen.values()];
  const answers = await answersFor(
    db,
    run.kind,
    list.map((r) => ({ userId: r.m.userId, ref: r.m.ref })),
  );
  return list.map((r, i) => toRow(r.m, r.u, answers[i] ?? null));
}

function toRow(m: typeof schema.botMessages.$inferSelect, u: typeof schema.users.$inferSelect | null, answer: BotMessageRow['answer']): BotMessageRow {
  return {
    id: m.id,
    at: m.createdAt.toISOString(),
    userId: m.userId,
    userName: u ? userDisplayName(u) : 'нет аккаунта',
    username: u?.username ?? null,
    kind: m.kind,
    label: botKindInfo(m.kind).label,
    outcome: m.outcome as BotOutcome,
    error: m.error,
    preview: m.preview,
    answer,
  };
}

/** Ответы на вопрос в сообщении: «Точно заберёте?» - по брони, приглашение в игру - по людям аккаунта. */
async function answersFor(db: DbLike, kind: string, items: { userId: number | null; ref: string | null }[]): Promise<(BotMessageRow['answer'] | null)[]> {
  if (kind === 'merch.confirm_ask') {
    const ids = items.flatMap((i) => (i.ref?.startsWith('order:') ? [Number(i.ref.slice(6))] : []));
    const orders = ids.length ? await db.select().from(schema.merchOrders).where(inArray(schema.merchOrders.id, ids)) : [];
    return items.map((i) => {
      const o = i.ref?.startsWith('order:') ? orders.find((x) => x.id === Number(i.ref!.slice(6))) : undefined;
      if (!o) return null;
      if (o.confirmedAt && o.confirmAskedAt && o.confirmedAt >= o.confirmAskedAt) return { label: '«Да, заберу»', tone: 'green' };
      if (o.status === 'paid' || o.status === 'issued') return { label: 'оплатили или забрали', tone: 'green' };
      if (o.status === 'cancelled' && o.cancelReason?.startsWith('Бронь снята: не подтвердили')) return { label: 'бронь снята без ответа', tone: 'red' };
      if (o.status === 'cancelled' || o.status === 'expired') return { label: 'бронь отменили', tone: 'gray' };
      if (o.confirmBy && o.confirmBy.getTime() <= Date.now()) return { label: 'не ответили', tone: 'red' };
      return { label: 'ждём ответа', tone: 'yellow' };
    });
  }
  if (kind === 'game.invite') {
    const users = items.flatMap((i) => (i.userId ? [i.userId] : []));
    const rows = users.length
      ? await db
          .select({ owner: schema.participants.ownerUserId, holder: schema.participants.holderUserId, answer: schema.gamePlayers.answer })
          .from(schema.participants)
          .leftJoin(schema.gamePlayers, eq(schema.gamePlayers.participantId, schema.participants.id))
          .where(and(eq(schema.participants.status, 'active'), sql`coalesce(${schema.participants.holderUserId}, ${schema.participants.ownerUserId}) in ${users}`))
      : [];
    return items.map((i) => {
      const mine = rows.filter((r) => (r.holder ?? r.owner) === i.userId);
      if (mine.some((r) => r.answer === 'yes')) return { label: '«Участвую»', tone: 'green' };
      if (mine.length && mine.every((r) => r.answer === 'no')) return { label: '«Не участвую»', tone: 'gray' };
      return null;
    });
  }
  return items.map(() => null);
}

async function broadcastRows(db: DbLike, id: number): Promise<BotMessageRow[]> {
  const rows = await db
    .select({ d: schema.broadcastDeliveries, u: schema.users })
    .from(schema.broadcastDeliveries)
    .leftJoin(schema.users, eq(schema.users.id, schema.broadcastDeliveries.userId))
    .where(eq(schema.broadcastDeliveries.broadcastId, id))
    .limit(5000);
  const [b] = await db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id));
  if (!b) throw notFound('Рассылка не найдена');
  const outcome = (s: string): BotOutcome => (s === 'sent' ? 'sent' : s === 'blocked' ? 'blocked' : 'failed');
  return rows.map((r, i) => ({
    id: -(i + 1),
    at: (r.d.sentAt ?? b.startedAt ?? b.createdAt).toISOString(),
    userId: r.d.userId,
    userName: r.u ? userDisplayName(r.u) : 'нет аккаунта',
    username: r.u?.username ?? null,
    kind: 'broadcast',
    label: 'Рассылка',
    outcome: r.d.status === 'pending' || r.d.status === 'sending' ? 'failed' : outcome(r.d.status),
    error: r.d.status === 'pending' || r.d.status === 'sending' ? 'ещё отправляется' : r.d.error,
    preview: null,
    answer: null,
  }));
}

export async function botRun(db: DbLike, key: string): Promise<BotRunDetail> {
  const runs = await botRuns(db, 14);
  const run = runs.find((r) => r.key === key);
  if (!run) throw notFound('Запуск не найден');
  const rows = await runRows(db, run);
  return { run, rows: rows.sort((a, b) => Number(a.outcome === 'sent') - Number(b.outcome === 'sent') || a.userName.localeCompare(b.userName, 'ru')) };
}

/** Сколько аккаунтов получат личное напоминание о питании (как mealAudience в задаче). */
async function mealAccounts(db: DbLike, meal: Meal, s: Settings): Promise<number> {
  const eat = mealEatersSql(s, meal);
  if (!eat) return 0;
  const [r] = await db
    .execute<{ n: number }>(sql`select count(distinct coalesce(holder_user_id, owner_user_id))::int as n from participants where status = 'active' and ${eat}`)
    .then((x) => x.rows);
  return r?.n ?? 0;
}

/** Что запланировано: задачи бота со временем впереди (по виду и минуте) и вопрос мерча из настроек. */
export async function botScheduled(db: DbLike): Promise<BotScheduledItem[]> {
  const names = [...Object.keys(BOT_KINDS), ...Object.keys(BOT_JOB_LABELS)];
  const rows = await db.execute<{ name: string; at: string; data: Record<string, unknown> }>(sql`
    select name, date_trunc('minute', start_after)::text as at, data
      from pgboss.job
     where state in ('created', 'retry') and start_after > now() and name in ${names}
     order by start_after
     limit 1000`);
  const s = await getSettings(db);
  const tz = s.eventTimezone;
  const hhmm = (d: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  const groups = new Map<string, { name: string; at: string; data: Record<string, unknown>[] }>();
  for (const r of rows.rows) {
    const key = `${r.name}|${r.at}`;
    const g = groups.get(key) ?? { name: r.name, at: r.at, data: [] };
    g.data.push(r.data);
    groups.set(key, g);
  }
  const items: BotScheduledItem[] = [];
  for (const g of groups.values()) {
    const item: BotScheduledItem = {
      name: g.name,
      label: BOT_JOB_LABELS[g.name] ?? botKindInfo(g.name).label,
      at: new Date(g.at).toISOString(),
      count: g.data.length,
      recipients: null,
      lines: [],
      preview: null,
    };
    const ids = (k: string) => [...new Set(g.data.map((d) => Number(d[k])).filter((n) => Number.isFinite(n) && n > 0))];
    if (g.name === 'activity.reminder') {
      // Напоминание за 15 минут - тем, кто записан на мероприятие или нажал «Напомнить».
      const acts = await db.select().from(schema.activities).where(inArray(schema.activities.id, ids('activityId')));
      // Пункт программы без записи - всем участникам (см. activityReminder).
      const [all] = await db
        .execute<{ n: number }>(sql`select count(distinct coalesce(holder_user_id, owner_user_id))::int as n from participants where status = 'active'`)
        .then((r) => r.rows);
      let total = 0;
      for (const a of acts) {
        if (a.registrationMode === 'none') {
          total += all?.n ?? 0;
          const meal = a.meal as Meal | null;
          const eaters = meal ? await mealAccounts(db, meal, s) : 0;
          item.lines.push(
            `«${a.title}» ${hhmm(a.startsAt)}${a.location ? ` · ${a.location}` : ''} - всем участникам (${all?.n ?? 0})` +
              (meal ? `, из них ${eaters} - лично: «Вы в списке на ${MEAL_LABELS[meal].toLowerCase()}»` : ''),
          );
          continue;
        }
        const [n] = await db.execute<{ n: number }>(sql`
          select count(distinct coalesce(p.holder_user_id, p.owner_user_id))::int as n from (
            select r.participant_id from activity_registrations r where r.activity_id = ${a.id} and r.status = 'registered'
          ) x join participants p on p.id = x.participant_id and p.status = 'active'`).then((r) => r.rows);
        const [i] = await db.execute<{ n: number }>(sql`select count(*)::int as n from activity_interest where activity_id = ${a.id}`).then((r) => r.rows);
        const who = (n?.n ?? 0) + (i?.n ?? 0);
        total += who;
        item.lines.push(`«${a.title}» ${hhmm(a.startsAt)}${a.location ? ` · ${a.location}` : ''} - ${who ? `получат ${who}` : 'никто не записан, не получит никто'}`);
      }
      item.recipients = acts.some((a) => a.registrationMode === 'none') ? Math.min(total, all?.n ?? total) : total;
      const a = acts[0];
      if (a) item.preview = `⏰ Через 15 минут - «${a.title}»\n${hhmm(a.startsAt)}${a.location ? ` · ${a.location}` : ''}`;
      const m = a?.registrationMode === 'none' ? (a.meal as Meal | null) : null;
      if (a && m) {
        item.preview =
          `Тем, у кого есть ${MEAL_LABELS[m].toLowerCase()}:\n🍽 Через 15 минут - «${a.title}»\n${hhmm(a.startsAt)}${a.location ? ` · ${a.location}` : ''}\n` +
          `✅ Вы в списке на ${MEAL_LABELS[m].toLowerCase()}${m === 'breakfast' ? '' : ' - не забудьте браслет'}\n\nОстальным:\n${item.preview}`;
      }
    } else if (g.name === 'feedback.remind') {
      // Напоминание об отзыве: проверка - конкретным людям, иначе всем с регистрацией, кто ещё не оставил отзыв.
      const only = g.data.flatMap((d) => (Array.isArray(d.userIds) ? (d.userIds as number[]) : []));
      item.recipients = only.length ? new Set(only).size : (await feedbackRemindAudience(db)).length;
      item.lines.push(only.length ? 'Проверка - только отмеченным' : 'Всем с регистрацией, кто ещё не оставил отзыв (считаем в момент отправки)');
      item.lines.push('Картинка «Поделись своим шагом» + кнопка «💛 Оставить отзыв»');
      item.preview = FEEDBACK_REMIND_TEXT.replace(/<[^>]+>/g, '');
    } else if (g.name === 'counseling.reminder') {
      const bs = await db
        .select({ b: schema.counselingBookings, c: schema.counselors })
        .from(schema.counselingBookings)
        .innerJoin(schema.counselors, eq(schema.counselors.id, schema.counselingBookings.counselorId))
        .where(inArray(schema.counselingBookings.id, ids('bookingId')));
      item.recipients = bs.length;
      for (const r of bs) item.lines.push(`${hhmm(r.b.slotStart)} · ${r.c.name}${r.c.place ? ` · ${r.c.place}` : ''}`);
      const r = bs[0];
      if (r) item.preview = `⏰ Через 15 минут - ${s.counselingTitle}\n${hhmm(r.b.slotStart)} · ${r.c.name}${r.c.place ? ` · ${r.c.place}` : ''}`;
    } else if (g.name === 'broadcast.run') {
      const bs = await db.select().from(schema.broadcasts).where(inArray(schema.broadcasts.id, ids('broadcastId')));
      for (const b of bs) item.lines.push(b.text.replace(/\s+/g, ' ').slice(0, 120));
      item.preview = bs[0]?.text.slice(0, 600) ?? null;
    } else if (g.name === 'merch.confirm_drop' || g.name === 'merch.expire') {
      const os = await db.select({ code: schema.merchOrders.code, status: schema.merchOrders.status }).from(schema.merchOrders).where(inArray(schema.merchOrders.id, ids('orderId')));
      const open = os.filter((o) => o.status === 'reserved');
      item.recipients = open.length;
      item.lines = open.map((o) => o.code);
      if (open.length) item.preview = '⌛ Бронь мерча снята - не получили ответа, что вы её заберёте. Вещи вернулись в витрину, можно забронировать заново.';
    }
    items.push(item);
  }
  // «Точно заберёте?» ставит не задача, а время в настройках мерча.
  if (s.merchConfirmAt && Date.parse(s.merchConfirmAt) > Date.now() && s.merchVisible && s.merchSalesEnabled) {
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.merchOrders).where(eq(schema.merchOrders.status, 'reserved'));
    items.push({
      name: 'merch.confirm_ask',
      label: 'Мерч: «Точно заберёте?»',
      at: new Date(s.merchConfirmAt).toISOString(),
      count: n?.n ?? 0,
      recipients: n?.n ?? 0,
      lines: [],
      preview: '🛍 Ваша бронь мерча - код … Точно заберёте? Ответьте до …',
    });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 100);
}

/** До кого бот не достучится: аккаунты с активными участниками, у которых бот заблокирован, не открыт или нет Telegram. */
export async function botUnreachable(db: DbLike): Promise<BotUnreachableRow[]> {
  const rows = await db
    .select({ p: schema.participants, u: schema.users })
    .from(schema.participants)
    .innerJoin(schema.users, sql`${schema.users.id} = coalesce(${schema.participants.holderUserId}, ${schema.participants.ownerUserId})`)
    .where(and(eq(schema.participants.status, 'active'), sql`(${schema.users.tgId} is null or ${schema.users.botBlocked} or not ${schema.users.allowsWrite})`));
  const byUser = new Map<number, BotUnreachableRow>();
  for (const { p, u } of rows) {
    const cur =
      byUser.get(u.id) ??
      ({
        userId: u.id,
        name: userDisplayName(u),
        username: u.username,
        phone: p.phone,
        reason: !u.tgId ? 'no_telegram' : u.botBlocked ? 'blocked' : 'unreachable',
        people: [],
      } satisfies BotUnreachableRow);
    cur.people.push(`${p.lastName} ${p.firstName}`);
    byUser.set(u.id, cur);
  }
  return [...byUser.values()].sort((a, b) => a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name, 'ru'));
}

/** Сводка для страницы: сегодня, запуски, что дальше, сколько недостижимых. */
export async function botOverview(db: DbLike): Promise<BotLogOverview> {
  const tz = (await getSettings(db)).eventTimezone;
  const [today] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${schema.botMessages.outcome} = 'sent')::int`,
      failed: sql<number>`count(*) filter (where ${schema.botMessages.outcome} in ${FAILED})::int`,
    })
    .from(schema.botMessages)
    .where(sql`${schema.botMessages.createdAt} >= date_trunc('day', now() at time zone ${tz}) at time zone ${tz}`);
  const unreachable = await botUnreachable(db);
  return {
    today: { sent: today?.sent ?? 0, failed: today?.failed ?? 0 },
    runs: await botRuns(db),
    scheduled: await botScheduled(db),
    unreachable: {
      blocked: unreachable.filter((u) => u.reason === 'blocked').length,
      unreachable: unreachable.filter((u) => u.reason === 'unreachable').length,
      noTelegram: unreachable.filter((u) => u.reason === 'no_telegram').length,
    },
  };
}

/** Всё, что бот отправил аккаунту участника (тому, у кого его QR-код) и аккаунту, который его записал. */
export async function botMessagesForParticipant(db: DbLike, participantId: number): Promise<BotMessageRow[]> {
  const [p] = await db.select().from(schema.participants).where(eq(schema.participants.id, participantId));
  if (!p) throw notFound('Участник не найден');
  const accounts = [...new Set([p.holderUserId, p.ownerUserId].filter((x): x is number => x != null))];
  const rows = await db
    .select({ m: schema.botMessages, u: schema.users })
    .from(schema.botMessages)
    .leftJoin(schema.users, eq(schema.users.id, schema.botMessages.userId))
    .where(and(inArray(schema.botMessages.userId, accounts), gte(schema.botMessages.createdAt, sql`now() - interval '60 days'`)))
    .orderBy(desc(schema.botMessages.createdAt))
    .limit(200);
  return rows.map((r) => toRow(r.m, r.u, null));
}

/** Для статистики в приложении команды: сегодня и ближайшее по плану. */
export async function botToday(db: DbLike): Promise<{ sent: number; failed: number; next: BotScheduledItem[] }> {
  const o = await botOverview(db);
  return { ...o.today, next: o.scheduled.filter((s) => MASS.has(s.name) || s.name in BOT_JOB_LABELS || s.name === 'counseling.reminder').slice(0, 4) };
}
