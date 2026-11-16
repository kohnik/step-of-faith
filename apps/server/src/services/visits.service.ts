import { schema, type DbLike } from '../db/client.ts';
import { dayKey } from '../bot/format.ts';
import { getSettings } from './settings.service.ts';

export type VisitSource = 'bot' | 'app';

/** Кого уже отметили сегодня - чтобы не ходить в базу на каждое сообщение. Сбрасывается со сменой дня. */
let seen = { day: '', keys: new Set<string>() };

/**
 * Отметить, что человек сегодня заходил в бота или в Mini App: одна строка на человека, день и источник.
 * Ошибка здесь не должна мешать ответу человеку - только пишем в лог.
 */
export async function recordVisit(db: DbLike, userId: number, source: VisitSource, log?: { warn: (o: object, m: string) => void }): Promise<void> {
  try {
    const day = dayKey(new Date(), (await getSettings(db)).eventTimezone);
    if (seen.day !== day) seen = { day, keys: new Set() };
    const key = `${source}:${userId}`;
    if (seen.keys.has(key)) return;
    await db.insert(schema.userVisits).values({ userId, day, source }).onConflictDoNothing();
    if (seen.keys.size > 50_000) seen.keys.clear();
    seen.keys.add(key);
  } catch (err) {
    log?.warn({ err }, 'visit not recorded');
  }
}
