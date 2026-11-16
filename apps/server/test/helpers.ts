import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { permissionsFor, type Role } from '@sof/shared';
import { Api } from 'grammy';
import pino from 'pino';
import { loadConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { createDb, schema } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createBoss, ensureQueues } from '../src/jobs/queues.ts';
import { issueTicket } from '../src/services/tickets.service.ts';
import type { StaffPrincipal } from '../src/services/sessions.service.ts';
import { upsertTelegramUser, type UserRow } from '../src/services/users.service.ts';
import { personKey } from '../src/lib/person-key.ts';

export interface TestEnv extends AppContext {
  container: StartedPostgreSqlContainer;
  teardown(): Promise<void>;
}

export async function setupTestEnv(): Promise<TestEnv> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    BOT_TOKEN: '123456:TEST-TOKEN-NOT-REAL',
    BOT_USERNAME: 'test_bot',
    APP_URL: 'https://app.example.test',
    ADMIN_URL: 'https://admin.example.test',
    CODE_HASH_SALT: 'test-salt-0123456789',
    COOKIE_SECURE: 'false',
    REALTIME_ENABLED: 'true',
    // Медиа и закрытые файлы каждого набора тестов - во временной папке.
    MEDIA_DIR: mkdtempSync(join(tmpdir(), 'sof-media-')),
    PRIVATE_DIR: mkdtempSync(join(tmpdir(), 'sof-private-')),
  });
  const { db, pool } = createDb(url, 40);
  await runMigrations(db);
  const boss = createBoss(url, { worker: false });
  await boss.start();
  await ensureQueues(boss);
  const log = pino({ level: 'silent' });
  return {
    container,
    config,
    db,
    pool,
    boss,
    tg: new Api(config.BOT_TOKEN),
    log,
    async teardown() {
      await boss.stop({ graceful: false });
      await pool.end();
      await container.stop();
    },
  };
}

let tgSeq = 1_000_000;

export async function makeUser(env: TestEnv, name = 'Test'): Promise<UserRow> {
  tgSeq += 1;
  return upsertTelegramUser(env.db, { id: tgSeq, first_name: name, allows_write_to_pm: true });
}

export async function makeStaff(env: TestEnv, roles: Role[], name = 'Staff'): Promise<StaffPrincipal> {
  const user = await makeUser(env, name);
  for (const role of roles) await env.db.insert(schema.staffRoles).values({ userId: user.id, role });
  return { user, name, roles, permissions: permissionsFor(roles), sessionId: 0 };
}

export async function makeParticipant(
  env: TestEnv,
  owner: UserRow,
  over: Partial<typeof schema.participants.$inferInsert> = {},
) {
  tgSeq += 1;
  const base = {
    lastName: `Иванов${tgSeq}`,
    firstName: 'Иван',
    birthDate: '2000-01-01',
    gender: 'm',
    city: 'Москва',
    ...over,
  };
  const [p] = await env.db
    .insert(schema.participants)
    .values({ ownerUserId: owner.id, personKey: personKey(base), paymentStatus: 'paid', ...base })
    .returning();
  const ticket = await issueTicket(env.db, p!.id);
  return { participant: p!, ticket };
}
