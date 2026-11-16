import type { Api } from 'grammy';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';

/** Всё, что нужно сервисам: конфиг, БД, очередь задач, клиент Telegram Bot API, логгер. */
export interface AppContext {
  config: Config;
  db: Db;
  pool: pg.Pool;
  boss: PgBoss;
  tg: Api;
  log: Logger;
}
