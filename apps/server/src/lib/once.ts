import { sql } from 'drizzle-orm';
import type { DbLike } from '../db/client.ts';

/**
 * Занять одноразовый ключ: true - впервые (действие можно делать), false - уже сделано.
 * Атомарно, поэтому две одновременные копии задачи не сделают одно и то же дважды.
 */
export async function firstTime(db: DbLike, key: string): Promise<boolean> {
  const res = await db.execute<{ key: string }>(sql`insert into once_keys (key) values (${key}) on conflict do nothing returning key`);
  return res.rows.length > 0;
}

/** Отпустить ключ: действие не удалось - пусть повтор задачи попробует снова. */
export async function forget(db: DbLike, key: string): Promise<void> {
  await db.execute(sql`delete from once_keys where key = ${key}`);
}
