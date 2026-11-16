import { hash, verify } from '@node-rs/argon2';
import {
  ROLE_LABELS,
  ROLES,
  type Role,
  type ScannerCardResponse,
  type MemberLinkView,
  type StaffInviteResponse,
  type StaffMember,
  type StaffPasswordResponse,
} from '@sof/shared';
import { and, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, forbidden, isUniqueViolation, notFound, unauthorized } from '../lib/errors.ts';
import { botLink, userDisplayName } from '../lib/format.ts';
import { revokeAllSessions, type StaffPrincipal } from './sessions.service.ts';
import { getSettings } from './settings.service.ts';
import { createLocalUser, getRoles, type UserRow } from './users.service.ts';

type Purpose = 'staff_invite' | 'ticket_claim' | 'admin_login' | 'scanner_card';

async function createToken(
  db: DbLike,
  purpose: Purpose,
  opts: { hours: number; payload?: object; userId?: number | null; createdBy?: number | null; maxUses?: number; keepToken?: boolean },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + opts.hours * 3600_000);
  await db.insert(schema.oneTimeTokens).values({
    tokenHash: sha256Hex(token),
    purpose,
    // Обычно храним только хэш. `keepToken` - для многоразовой ссылки, которую надо уметь показать снова.
    payload: opts.keepToken ? { ...opts.payload, token } : (opts.payload ?? {}),
    userId: opts.userId ?? null,
    createdBy: opts.createdBy ?? null,
    expiresAt,
    maxUses: opts.maxUses ?? 1,
  });
  return { token, expiresAt };
}

/** Атомарно «тратит» токен: одно использование, если он жив и не исчерпан. */
async function consumeToken(db: DbLike, token: string, purposes: Purpose[], usedBy: number | null) {
  const [row] = await db
    .update(schema.oneTimeTokens)
    .set({ uses: sql`${schema.oneTimeTokens.uses} + 1`, lastUsedBy: usedBy, lastUsedAt: new Date() })
    .where(
      and(
        eq(schema.oneTimeTokens.tokenHash, sha256Hex(token)),
        inArray(schema.oneTimeTokens.purpose, purposes),
        gt(schema.oneTimeTokens.expiresAt, sql`now()`),
        sql`${schema.oneTimeTokens.uses} < ${schema.oneTimeTokens.maxUses}`,
      ),
    )
    .returning();
  return row;
}

// ---------- инвайты ----------

export async function createInvite(
  ctx: Pick<AppContext, 'db' | 'config'>,
  role: Role,
  hours: number,
  actor: StaffPrincipal,
): Promise<StaffInviteResponse> {
  if (role === 'superadmin' && !actor.roles.includes('superadmin')) throw forbidden();
  // Банкир (без «Управления командой») приглашает только кассиров.
  if (!actor.permissions.includes('staff:manage') && role !== 'cashier') throw forbidden('Можно пригласить только кассира');
  const invite = await createInviteLink(ctx, role, hours, actor.user.id);
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'staff.invite', entity: 'staff', after: { role, expiresAt: invite.expiresAt } });
  return invite;
}

/** Без проверки прав - для CLI на сервере (первый суперадмин). */
export async function createInviteLink(
  ctx: Pick<AppContext, 'db' | 'config'>,
  role: Role,
  hours: number,
  createdBy: number | null,
): Promise<StaffInviteResponse> {
  const { token, expiresAt } = await createToken(ctx.db, 'staff_invite', { hours, payload: { role }, createdBy });
  return { link: botLink(ctx.config, `staff_${token}`), expiresAt: expiresAt.toISOString() };
}

export async function redeemInvite(ctx: Pick<AppContext, 'db' | 'boss'>, token: string, user: UserRow): Promise<Role> {
  return ctx.db.transaction(async (tx) => {
    const row = await consumeToken(tx, token, ['staff_invite'], user.id);
    if (!row) throw new AppError(410, 'link_expired', 'Приглашение недействительно или уже использовано');
    const role = (row.payload as { role: Role }).role;
    await tx.insert(schema.staffRoles).values({ userId: user.id, role, grantedBy: row.createdBy }).onConflictDoNothing();
    await audit(tx, { actorUserId: user.id, action: 'staff.invite_redeem', entity: 'staff', entityId: user.id, after: { role } });
    await enqueue(ctx.boss, 'user.commands', { userId: user.id }, { tx });
    return role;
  });
}

// ---------- многоразовая ссылка «Участник команды» ----------

/** Живёт, пока не сменят или не отключат (срок - просто страховка). */
const MEMBER_LINK_HOURS = 24 * 365 * 3;
const MEMBER_LINK_MAX_USES = 100_000;

const activeMemberLink = () =>
  and(
    eq(schema.oneTimeTokens.purpose, 'staff_invite'),
    sql`${schema.oneTimeTokens.payload}->>'reusable' = 'true'`,
    gt(schema.oneTimeTokens.expiresAt, sql`now()`),
  );

/**
 * Одна ссылка на всех: скинуть в чат команды - каждый, кто откроет, станет «Участником команды».
 * Это самая безопасная роль (только посмотреть), поэтому ссылку можно делать многоразовой.
 */
export async function memberLink(ctx: Pick<AppContext, 'db' | 'config'>): Promise<MemberLinkView | null> {
  const [row] = await ctx.db
    .select()
    .from(schema.oneTimeTokens)
    .where(activeMemberLink())
    .orderBy(desc(schema.oneTimeTokens.createdAt))
    .limit(1);
  const token = (row?.payload as { token?: string } | undefined)?.token;
  if (!row || !token) return null;
  return { link: botLink(ctx.config, `staff_${token}`), uses: row.uses, createdAt: row.createdAt.toISOString() };
}

/** Создать ссылку (если её нет) или сменить: старая сразу перестаёт работать. */
export async function makeMemberLink(ctx: Pick<AppContext, 'db' | 'config'>, actor: StaffPrincipal, reset: boolean): Promise<MemberLinkView> {
  if (!reset) {
    const current = await memberLink(ctx);
    if (current) return current;
  }
  await ctx.db.transaction(async (tx) => {
    await tx.update(schema.oneTimeTokens).set({ expiresAt: new Date() }).where(activeMemberLink());
    await createToken(tx, 'staff_invite', {
      hours: MEMBER_LINK_HOURS,
      payload: { role: 'member', reusable: true },
      createdBy: actor.user.id,
      maxUses: MEMBER_LINK_MAX_USES,
      keepToken: true,
    });
    await audit(tx, { actorUserId: actor.user.id, action: reset ? 'staff.member_link_reset' : 'staff.member_link', entity: 'staff' });
  });
  return (await memberLink(ctx))!;
}

export async function disableMemberLink(db: DbLike, actor: StaffPrincipal): Promise<void> {
  const off = await db.update(schema.oneTimeTokens).set({ expiresAt: new Date() }).where(activeMemberLink()).returning({ h: schema.oneTimeTokens.tokenHash });
  if (off.length) await audit(db, { actorUserId: actor.user.id, action: 'staff.member_link_off', entity: 'staff' });
}

// ---------- роли ----------

/** Команда. `onlyCashiers` - для банкира: он видит только кассиров (и приглашает только их). */
export async function listStaff(ctx: Pick<AppContext, 'db' | 'config'>, { onlyCashiers = false } = {}): Promise<StaffMember[]> {
  const rows = await ctx.db.execute<{
    id: string;
    tg_id: string | null;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    roles: string[];
    has_password: boolean;
    last_seen_at: Date | null;
  }>(sql`
    select u.id, u.tg_id, u.username, u.first_name, u.last_name, u.display_name, u.last_seen_at,
           coalesce(array_agg(sr.role) filter (where sr.role is not null), '{}') as roles,
           exists (select 1 from admin_credentials ac where ac.user_id = u.id) as has_password
      from users u
      left join staff_roles sr on sr.user_id = u.id
     group by u.id
    having ${onlyCashiers ? sql`bool_or(sr.role = 'cashier')` : sql`count(sr.role) > 0 or exists (select 1 from admin_credentials ac where ac.user_id = u.id)`}
     order by u.id`);
  return rows.rows.map((r) => ({
    userId: Number(r.id),
    name: userDisplayName({
      displayName: r.display_name,
      firstName: r.first_name,
      lastName: r.last_name,
      username: r.username,
    }),
    username: r.username,
    tgId: r.tg_id == null ? null : Number(r.tg_id),
    roles: ROLES.filter((role) => r.roles.includes(role)),
    hasPassword: r.has_password,
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    permanent: r.tg_id != null && ctx.config.SUPERADMIN_TG_IDS.includes(Number(r.tg_id)),
  }));
}

export async function setRoles(
  ctx: Pick<AppContext, 'db' | 'boss' | 'config'>,
  targetUserId: number,
  roles: Role[],
  actor: StaffPrincipal,
): Promise<StaffMember> {
  const target = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, targetUserId) });
  if (!target) throw notFound('Пользователь не найден');
  const before = await getRoles(ctx.db, targetUserId);
  const touchesSuperadmin = roles.includes('superadmin') !== before.includes('superadmin');
  if (touchesSuperadmin && !actor.roles.includes('superadmin')) throw forbidden('Роль суперадмина выдаёт только суперадмин');
  if (targetUserId === actor.user.id && before.includes('superadmin') && !roles.includes('superadmin')) {
    throw badRequest('self_lockout', 'Нельзя снять с себя роль суперадмина');
  }
  // Главные администраторы заданы в настройках сервера (SUPERADMIN_TG_IDS) - их не снять из админки.
  if (target.tgId != null && ctx.config.SUPERADMIN_TG_IDS.includes(target.tgId) && !roles.includes('superadmin')) {
    throw badRequest('permanent_superadmin', 'Это главный администратор - роль суперадмина у него не снимается');
  }
  await ctx.db.transaction(async (tx) => {
    if (roles.length) {
      await tx
        .delete(schema.staffRoles)
        .where(and(eq(schema.staffRoles.userId, targetUserId), notInArray(schema.staffRoles.role, roles)));
      await tx
        .insert(schema.staffRoles)
        .values(roles.map((role) => ({ userId: targetUserId, role, grantedBy: actor.user.id })))
        .onConflictDoNothing();
    } else {
      await tx.delete(schema.staffRoles).where(eq(schema.staffRoles.userId, targetUserId));
      await revokeAllSessions(tx, targetUserId);
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'staff.roles', entity: 'user', entityId: targetUserId, before, after: roles });
    if (target.tgId) await enqueue(ctx.boss, 'user.commands', { userId: targetUserId }, { tx });
  });
  const member = (await listStaff(ctx)).find((m) => m.userId === targetUserId);
  return (
    member ?? {
      userId: targetUserId,
      name: userDisplayName(target),
      username: target.username,
      tgId: target.tgId,
      roles: [],
      hasPassword: false,
      lastSeenAt: target.lastSeenAt?.toISOString() ?? null,
      permanent: false,
    }
  );
}

// ---------- вход без Telegram ----------

/** Карточка волонтёра: отдельный аккаунт без Telegram + многоразовая ссылка входа в браузерный сканер. */
export async function createScannerCard(
  ctx: Pick<AppContext, 'db' | 'config'>,
  name: string,
  role: 'scanner' | 'cashier',
  hours: number,
  actor: StaffPrincipal,
): Promise<ScannerCardResponse> {
  return ctx.db.transaction(async (tx) => {
    const user = await createLocalUser(tx, `${name} (${ROLE_LABELS[role]})`);
    await tx.insert(schema.staffRoles).values({ userId: user.id, role, grantedBy: actor.user.id });
    const { token, expiresAt } = await createToken(tx, 'scanner_card', {
      hours,
      userId: user.id,
      createdBy: actor.user.id,
      maxUses: 20,
    });
    await audit(tx, { actorUserId: actor.user.id, action: 'staff.scanner_card', entity: 'user', entityId: user.id, after: { role, hours } });
    return { userId: user.id, loginUrl: `${ctx.config.APP_URL}/staff/login#token=${token}`, expiresAt: expiresAt.toISOString() };
  });
}

export async function createAdminLoginLink(ctx: Pick<AppContext, 'db' | 'config'>, user: UserRow): Promise<string> {
  const { token } = await createToken(ctx.db, 'admin_login', { hours: 0.25, userId: user.id, createdBy: user.id });
  return `${ctx.config.ADMIN_URL}/login#token=${token}`;
}

export async function consumeLoginToken(
  ctx: Pick<AppContext, 'db'>,
  token: string,
): Promise<{ userId: number; purpose: 'admin_login' | 'scanner_card' }> {
  const row = await consumeToken(ctx.db, token, ['admin_login', 'scanner_card'], null);
  if (!row || !row.userId) throw new AppError(410, 'link_expired', 'Ссылка входа недействительна или устарела');
  return { userId: row.userId, purpose: row.purpose as 'admin_login' | 'scanner_card' };
}

export async function setPassword(
  ctx: Pick<AppContext, 'db'>,
  targetUserId: number,
  login: string,
  password: string,
  actor: StaffPrincipal,
): Promise<StaffPasswordResponse> {
  const target = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, targetUserId) });
  if (!target) throw notFound('Пользователь не найден');
  const secret = new OTPAuth.Secret({ size: 20 });
  const { eventName } = await getSettings(ctx.db);
  const totp = new OTPAuth.TOTP({ issuer: eventName, label: login, secret });
  const passwordHash = await hash(password);
  try {
    await ctx.db
      .insert(schema.adminCredentials)
      .values({ userId: targetUserId, login, passwordHash, totpSecret: secret.base32 })
      .onConflictDoUpdate({
        target: schema.adminCredentials.userId,
        set: { login, passwordHash, totpSecret: secret.base32, failedAttempts: 0, lockedUntil: null, updatedAt: new Date() },
      });
  } catch (err) {
    // Логин уникален: занят другим человеком из команды.
    if (isUniqueViolation(err)) throw conflict('login_taken', 'Этот логин уже занят - придумайте другой', [{ path: 'login', message: 'Этот логин уже занят' }]);
    throw err;
  }
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'staff.password', entity: 'user', entityId: targetUserId, after: { login } });
  return { login, totpUri: totp.toString() };
}

export async function passwordLogin(
  ctx: Pick<AppContext, 'db'>,
  login: string,
  password: string,
  code: string,
): Promise<number> {
  const creds = await ctx.db.query.adminCredentials.findFirst({ where: eq(schema.adminCredentials.login, login) });
  if (!creds) throw unauthorized('Неверный логин, пароль или код');
  if (creds.lockedUntil && creds.lockedUntil > new Date()) {
    throw new AppError(429, 'locked', 'Слишком много попыток, попробуйте через 15 минут');
  }
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(creds.totpSecret) });
  const ok = (await verify(creds.passwordHash, password)) && totp.validate({ token: code, window: 1 }) !== null;
  if (!ok) {
    const attempts = creds.failedAttempts + 1;
    await ctx.db
      .update(schema.adminCredentials)
      .set(
        attempts >= 5
          ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + 15 * 60_000) }
          : { failedAttempts: attempts },
      )
      .where(eq(schema.adminCredentials.userId, creds.userId));
    throw unauthorized('Неверный логин, пароль или код');
  }
  await ctx.db
    .update(schema.adminCredentials)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(schema.adminCredentials.userId, creds.userId));
  return creds.userId;
}
