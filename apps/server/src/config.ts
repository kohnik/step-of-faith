import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  // По умолчанию - боевой режим: dev-маршруты (подписанный initData для любого id) включаются только явно.
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  BOT_TOKEN: z.string().min(10),
  /** Без @, например stepoffaith_bot */
  BOT_USERNAME: z.string().min(3),
  /** https://app.stepoffaith.online - Mini App, веб-билеты, браузерный сканер */
  APP_URL: z.url(),
  /** https://admin.stepoffaith.online */
  ADMIN_URL: z.url(),
  /** Соль для хешей кодов в локальной базе сканера */
  CODE_HASH_SALT: z.string().min(16),
  /** Telegram id первых суперадминов через запятую */
  SUPERADMIN_TG_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map(Number),
    ),
  /** Кому доступна кнопка «Очистить всю базу» (только на время разработки). Telegram id через запятую. */
  DEV_WIPE_TG_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map(Number),
    ),
  /** Фото и 3D-модели мерча - отдаёт Caddy по /media/* (в разработке - API). Локально - infra/data (не уходит на сервер при выкладке). */
  MEDIA_DIR: z.string().min(1).default('../../infra/data/media'),
  /** Закрытые файлы (чеки переводов за мерч) - только через API с правами. */
  PRIVATE_DIR: z.string().min(1).default('../../infra/data/private'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: bool.default(true),
  COOKIE_SECURE: bool.default(true),
  INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(86400),
  STAFF_INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(3600),
  STAFF_SESSION_HOURS: z.coerce.number().int().positive().default(16),
  /** Веб-админка: неделя, чтобы не входить каждый день. */
  ADMIN_SESSION_HOURS: z.coerce.number().int().positive().default(168),
  /**
   * Живые обновления Mini App (долгие соединения). Выключены по умолчанию: каждый поток держит память и в
   * прокси (на общем сервере - в чужом Caddy). Без них приложение обновляется опросом, как раньше.
   */
  REALTIME_ENABLED: bool.default(false),
  /** Потолок одновременных потоков на процесс API; сверх него - 503, приложение остаётся на опросе. */
  REALTIME_MAX_STREAMS: z.coerce.number().int().positive().default(1500),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
