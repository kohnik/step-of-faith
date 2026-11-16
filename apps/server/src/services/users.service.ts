import { ROLES, type Role } from '@sof/shared';
import { eq, sql } from 'drizzle-orm';
import { schema, type DbLike } from '../db/client.ts';
import { generatePaymentRef } from '../lib/crypto.ts';
import { isUniqueViolation } from '../lib/errors.ts';

export type UserRow = typeof schema.users.$inferSelect;

export interface TelegramUserLike {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  allows_write_to_pm?: boolean;
}

/**
 * Создаёт или обновляет пользователя по Telegram id. `allowsWrite` только поднимается
 * (если пользователь хоть раз разрешил писать - помним это), сбрасывается при 403 от Telegram.
 */
export async function upsertTelegramUser(
  db: DbLike,
  tg: TelegramUserLike,
  opts: { allowsWrite?: boolean; superadminTgIds?: number[] } = {},
): Promise<UserRow> {
  const allowsWrite = opts.allowsWrite ?? tg.allows_write_to_pm ?? false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(schema.users)
        .values({
          tgId: tg.id,
          firstName: tg.first_name ?? null,
          lastName: tg.last_name ?? null,
          username: tg.username ?? null,
          languageCode: tg.language_code ?? null,
          paymentRef: generatePaymentRef(),
          allowsWrite,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.users.tgId,
          set: {
            firstName: sql`excluded.first_name`,
            lastName: sql`excluded.last_name`,
            username: sql`excluded.username`,
            languageCode: sql`coalesce(excluded.language_code, ${schema.users.languageCode})`,
            allowsWrite: sql`${schema.users.allowsWrite} or excluded.allows_write`,
            botBlocked: allowsWrite ? false : sql`${schema.users.botBlocked}`,
            lastSeenAt: sql`now()`,
          },
        })
        .returning();
      if (!row) throw new Error('upsert returned nothing');
      if (opts.superadminTgIds?.includes(tg.id)) {
        await db
          .insert(schema.staffRoles)
          .values({ userId: row.id, role: 'superadmin' })
          .onConflictDoNothing();
      }
      return row;
    } catch (err) {
      // Совпал случайный payment_ref - просто пробуем другой.
      if (isUniqueViolation(err, 'users_payment_ref_unique')) continue;
      throw err;
    }
  }
  throw new Error('Could not generate unique payment_ref');
}

/** Аккаунт без Telegram: волонтёр по карточке входа или участник, заведённый вручную. */
export async function createLocalUser(db: DbLike, displayName: string): Promise<UserRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(schema.users)
        .values({ displayName, paymentRef: generatePaymentRef() })
        .returning();
      if (row) return row;
    } catch (err) {
      if (isUniqueViolation(err, 'users_payment_ref_unique')) continue;
      throw err;
    }
  }
  throw new Error('Could not create local user');
}

export async function getUser(db: DbLike, userId: number): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(schema.users.id, userId) });
}

export async function getUserByTgId(db: DbLike, tgId: number): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(schema.users.tgId, tgId) });
}

export async function getRoles(db: DbLike, userId: number): Promise<Role[]> {
  const rows = await db
    .select({ role: schema.staffRoles.role })
    .from(schema.staffRoles)
    .where(eq(schema.staffRoles.userId, userId));
  const set = new Set(rows.map((r) => r.role));
  return ROLES.filter((r) => set.has(r));
}

export async function markBotBlocked(db: DbLike, userId: number): Promise<void> {
  await db.update(schema.users).set({ botBlocked: true, allowsWrite: false }).where(eq(schema.users.id, userId));
}
