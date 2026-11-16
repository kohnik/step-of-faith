import './lib/network.ts';
import { startTrafficFlush } from './services/traffic.service.ts';
import { Api } from 'grammy';
import { buildApp } from './api/app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { runMigrationsLocked } from './db/migrate.ts';
import { createBoss, ensureQueues } from './jobs/queues.ts';
import { trackOutgoingMessages } from './lib/message-tracking.ts';
import { createLogger } from './logger.ts';
import { initTelegramNet, telegramClient } from './lib/telegram-net.ts';
import { autoPlanSeminars } from './services/seminar.service.ts';

const config = loadConfig();
const log = createLogger(config, 'api');

await runMigrationsLocked(config.DATABASE_URL);
const { db, pool } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
const boss = createBoss(config.DATABASE_URL, { worker: false });
boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
await boss.start();
await ensureQueues(boss);

initTelegramNet(log);
const tg = new Api(config.BOT_TOKEN, telegramClient());
trackOutgoingMessages(tg, db);
const app = await buildApp({ config, db, pool, boss, tg, log });
await app.listen({ port: config.PORT, host: config.HOST });
const stopTraffic = startTrafficFlush(db, log);
// После выкладки семинары дораскладываются сразу (если включено автоматическое распределение), не дожидаясь нового выбора.
void autoPlanSeminars({ db, log }, null);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  await app.close().catch((err) => log.error({ err }, 'app close failed'));
  await stopTraffic();
  await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
