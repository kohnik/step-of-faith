import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbLike = Db | Tx;

export function createDb(url: string, max = 10): { pool: pg.Pool; db: Db } {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    application_name: 'sof',
    // Запрос не ждёт блокировку бесконечно (при пике регистраций лучше ошибка и повтор клиента, чем зависший пул),
    // а забытая открытой транзакция не держит соединение.
    options: '-c lock_timeout=15000 -c idle_in_transaction_session_timeout=60000',
  });
  // Ошибка простаивающего соединения (перезапуск Postgres) без обработчика роняет весь процесс.
  pool.on('error', (err) => console.error('pg pool error', err));
  const db = drizzle({ client: pool, schema });
  return { pool, db };
}

export { schema };
