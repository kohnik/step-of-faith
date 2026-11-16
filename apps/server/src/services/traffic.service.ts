import { sql } from 'drizzle-orm';
import type { DbLike } from '../db/client.ts';

export type TrafficSource = 'bot' | 'app';

/**
 * Нагрузка: сколько запросов пришло в бота (сообщения и кнопки) и в Mini App - всего и от каждого человека.
 * Считаем в памяти - запрос ничего не ждёт - и раз в 30 секунд одной вставкой прибавляем к строкам часа в базе.
 */

/** `${час в ISO}|${источник}` → сколько запросов ещё не записано. */
const pending = new Map<string, number>();
/** `${час в ISO}|${id пользователя}|${источник}` → сколько. */
const pendingUsers = new Map<string, number>();
/** Последний раз чистили старое (раз в час хватает). */
let prunedAt = 0;
const KEEP_DAYS = 15;

const add = (m: Map<string, number>, key: string, n = 1) => m.set(key, (m.get(key) ?? 0) + n);

/** Запрос в бота или в приложение; `userId` - чей (если известно). */
export function countRequest(source: TrafficSource, userId?: number | null): void {
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  const h = hour.toISOString();
  add(pending, `${h}|${source}`);
  if (userId) add(pendingUsers, `${h}|${userId}|${source}`);
}

export async function flushTraffic(db: DbLike): Promise<void> {
  const totals = [...pending].map(([key, n]) => {
    const [hour, source] = key.split('|') as [string, TrafficSource];
    return { hour, source, n };
  });
  const users = [...pendingUsers].map(([key, n]) => {
    const [hour, userId, source] = key.split('|') as [string, string, TrafficSource];
    return { hour, userId: Number(userId), source, n };
  });
  pending.clear();
  pendingUsers.clear();
  try {
    if (totals.length) {
      await db.execute(sql`
        insert into traffic_hourly (hour, source, n)
        values ${sql.join(totals.map((r) => sql`(${r.hour}::timestamptz, ${r.source}, ${r.n})`), sql`, `)}
        on conflict (hour, source) do update set n = traffic_hourly.n + excluded.n`);
    }
    if (users.length) {
      // Пользователя могли удалить, пока копили, - такие строки просто пропускаем.
      await db.execute(sql`
        insert into traffic_users (hour, user_id, source, n)
        select v.hour, v.user_id, v.source, v.n
          from (values ${sql.join(users.map((r) => sql`(${r.hour}::timestamptz, ${r.userId}::bigint, ${r.source}, ${r.n}::int)`), sql`, `)}) as v(hour, user_id, source, n)
          join users u on u.id = v.user_id
        on conflict (hour, user_id, source) do update set n = traffic_users.n + excluded.n`);
    }
    if (Date.now() - prunedAt > 3600_000) {
      prunedAt = Date.now();
      await db.execute(sql`delete from traffic_users where hour < now() - make_interval(days => ${KEEP_DAYS})`);
    }
  } catch (err) {
    // Не записалось - вернём в очередь, допишем в следующий раз.
    for (const r of totals) add(pending, `${r.hour}|${r.source}`, r.n);
    for (const r of users) add(pendingUsers, `${r.hour}|${r.userId}|${r.source}`, r.n);
    throw err;
  }
}

/** Запустить запись раз в 30 секунд; вернёт «остановить и дописать остаток» - для выключения процесса. */
export function startTrafficFlush(db: DbLike, log: { warn: (o: object, m: string) => void }): () => Promise<void> {
  const timer = setInterval(() => void flushTraffic(db).catch((err: unknown) => log.warn({ err }, 'traffic not recorded')), 30_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await flushTraffic(db).catch((err: unknown) => log.warn({ err }, 'traffic not recorded'));
  };
}
