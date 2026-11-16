import './lib/network.ts';
import { startTrafficFlush } from './services/traffic.service.ts';
import { run } from '@grammyjs/runner';
import { createBot } from './bot/bot.ts';
import { participantCommands } from './bot/commands.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { runMigrationsLocked } from './db/migrate.ts';
import { createBoss, ensureQueues } from './jobs/queues.ts';
import { registerWorkers } from './jobs/workers.ts';
import { getSettings } from './services/settings.service.ts';
import { createLogger } from './logger.ts';
import { initTelegramNet } from './lib/telegram-net.ts';

const config = loadConfig();
const log = createLogger(config, 'bot');
initTelegramNet(log);

await runMigrationsLocked(config.DATABASE_URL);
const { db, pool } = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
const boss = createBoss(config.DATABASE_URL, { worker: true });
boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
await boss.start();
await ensureQueues(boss);

const bot = createBot({ config, db, pool, boss, log });
await bot.init();
log.info({ username: bot.botInfo.username }, 'bot identity');
if (bot.botInfo.username.toLowerCase() !== config.BOT_USERNAME.toLowerCase()) {
  log.warn({ expected: config.BOT_USERNAME, actual: bot.botInfo.username }, 'BOT_USERNAME differs from the token owner');
}

// Long polling: вебхук не нужен, публичный адрес для бота тоже.
await bot.api.deleteWebhook();
const settings = await getSettings(db);
await bot.api.setMyCommands(participantCommands(settings.paymentsEnabled));
// Текст в пустом чате до /start и в профиле бота. Ошибка здесь не должна валить бота.
await bot.api
  .setMyDescription(
    `Привет! 👋 Это бот конференции «${settings.eventName}». Здесь можно зарегистрироваться (сразу всей семьёй или с друзьями), получить QR-код для входа и смотреть расписание.`,
  )
  .catch((err) => log.warn({ err }, 'setMyDescription failed'));
await bot.api
  .setMyShortDescription(`Регистрация и QR-код для входа на «${settings.eventName}»`)
  .catch((err) => log.warn({ err }, 'setMyShortDescription failed'));
await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: config.APP_URL } } });

await registerWorkers({ config, db, pool, boss, log, tg: bot.api });
const stopTraffic = startTrafficFlush(db, log);

const runner = run(bot, {
  // Повтор getUpdates после сбоя сети - раз в 2 секунды, а не с растущей паузой: бот оживает сразу, как появилась связь.
  runner: { fetch: { allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, retryInterval: 2000 },
});
log.info('bot is running (long polling)');
// Runner остановился с ошибкой (409 - запущен второй бот с тем же токеном, 401 - неверный токен):
// пишем в лог и выходим, Docker перезапустит контейнер.
runner.task()?.catch((err: unknown) => {
  log.fatal({ err }, 'bot runner stopped');
  process.exit(1);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  if (runner.isRunning()) await runner.stop().catch(() => {});
  await stopTraffic();
  await boss.stop({ graceful: true, timeout: 15_000 }).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
