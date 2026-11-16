import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Db } from './client.ts';

/** В исходниках это src/db/migrations, в сборке - dist/migrations (build.mjs копирует папку). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(db: Db, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/** Миграции под advisory-блокировкой: если стартуют два процесса разом, второй подождёт. */
export async function runMigrationsLocked(url: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'sof-migrate' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(727274001)');
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.query('select pg_advisory_unlock(727274001)').catch(() => {});
    await client.end();
  }
}
