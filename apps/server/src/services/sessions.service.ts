import { permissionsFor, type Permission, type Role } from '@sof/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, type DbLike } from '../db/client.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { userDisplayName } from '../lib/format.ts';
import { getRoles, type UserRow } from './users.service.ts';

export type SessionKind = 'miniapp' | 'web' | 'scanner';

export interface StaffPrincipal {
  user: UserRow;
  name: string;
  roles: Role[];
  permissions: Permission[];
  sessionId: number;
}

export async function createSession(
  db: DbLike,
  userId: number,
  kind: SessionKind,
  hours: number,
  userAgent?: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  await db.insert(schema.staffSessions).values({
    tokenHash: sha256Hex(token),
    userId,
    kind,
    expiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

/**
 * Находит живую сессию и заново читает роли - отзыв роли действует со следующего запроса.
 * Сессия без единой роли недействительна.
 */
export async function resolveSession(db: DbLike, token: string): Promise<StaffPrincipal | null> {
  const row = await db
    .select({ session: schema.staffSessions, user: schema.users })
    .from(schema.staffSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.staffSessions.userId))
    .where(
      and(
        eq(schema.staffSessions.tokenHash, sha256Hex(token)),
        isNull(schema.staffSessions.revokedAt),
        gt(schema.staffSessions.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const found = row[0];
  if (!found) return null;
  const roles = await getRoles(db, found.user.id);
  if (roles.length === 0) return null;
  const last = found.session.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - last > 5 * 60_000) {
    await db
      .update(schema.staffSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.staffSessions.id, found.session.id));
  }
  return {
    user: found.user,
    name: userDisplayName(found.user),
    roles,
    permissions: permissionsFor(roles),
    sessionId: found.session.id,
  };
}

export async function revokeSession(db: DbLike, token: string): Promise<void> {
  await db
    .update(schema.staffSessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.staffSessions.tokenHash, sha256Hex(token)));
}

export async function revokeAllSessions(db: DbLike, userId: number): Promise<void> {
  await db
    .update(schema.staffSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.staffSessions.userId, userId), isNull(schema.staffSessions.revokedAt)));
}
