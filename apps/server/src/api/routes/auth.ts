import { loginTokenSchema, passwordLoginSchema, type SessionInfo, type StaffSessionResponse } from '@sof/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.ts';
import { forbidden, unauthorized } from '../../lib/errors.ts';
import { getSettings } from '../../services/settings.service.ts';
import { createSession, resolveSession, revokeSession, type StaffPrincipal } from '../../services/sessions.service.ts';
import { consumeLoginToken, passwordLogin } from '../../services/staff.service.ts';
import { getRoles } from '../../services/users.service.ts';
import { readTmaHeader, requireStaff, SESSION_COOKIE, sessionToken, setSessionCookie, userFromInitData } from '../auth.ts';
import { parse, tooManyRequests, UserRateLimiter } from '../http.ts';

/** Пароль - строго (перебор). */
const loginLimiter = new UserRateLimiter(10, 0.2);
/**
 * Одноразовые ссылки и карточки перебрать нельзя, а утром волонтёры входят разом через общий Wi-Fi
 * площадки (один IP) - лимит щедрый.
 */
const tokenLoginLimiter = new UserRateLimiter(60, 2);
/** Карточка сканера входит в браузере и не продлевается сама - сессии хватает на все дни конференции. */
const SCANNER_CARD_SESSION_HOURS = 72;

async function sessionInfo(ctx: AppContext, p: StaffPrincipal): Promise<SessionInfo> {
  const settings = await getSettings(ctx.db);
  return {
    user: { id: p.user.id, name: p.name, username: p.user.username, tgId: p.user.tgId },
    roles: p.roles,
    permissions: p.permissions,
    event: { name: settings.eventName, timezone: settings.eventTimezone, startsAt: settings.eventStartsAt },
    features: {
      payments: settings.paymentsEnabled,
      devTools: p.user.tgId != null && ctx.config.DEV_WIPE_TG_IDS.includes(p.user.tgId),
    },
    tiers: settings.tiers,
    breakfast: settings.breakfast,
  };
}

function ua(req: FastifyRequest) {
  return (req.headers['user-agent'] as string | undefined) ?? null;
}

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const hours = ctx.config.STAFF_SESSION_HOURS;

  /** Mini App → сессия персонала. initData не старше часа, дальше работаем своим токеном. */
  app.post('/api/auth/staff-session', async (req): Promise<StaffSessionResponse> => {
    const raw = readTmaHeader(req);
    if (!raw) throw unauthorized('Откройте приложение из Telegram');
    const user = await userFromInitData(ctx, raw, ctx.config.STAFF_INIT_DATA_MAX_AGE_SEC);
    const roles = await getRoles(ctx.db, user.id);
    if (roles.length === 0) throw forbidden('У вас нет роли в команде');
    const { token, expiresAt } = await createSession(ctx.db, user.id, 'miniapp', hours, ua(req));
    const principal = await resolveSession(ctx.db, token);
    return { ...(await sessionInfo(ctx, principal!)), token, expiresAt: expiresAt.toISOString() };
  });

  /** Одноразовая ссылка из бота (админка) или карточка волонтёра (браузерный сканер). */
  app.post('/api/auth/login-token', async (req, reply) => {
    if (!tokenLoginLimiter.take(`ip:${req.ip}`)) throw tooManyRequests();
    const body = parse(loginTokenSchema, req.body);
    const { userId, purpose } = await consumeLoginToken(ctx, body.token);
    const kind = purpose === 'scanner_card' ? 'scanner' : 'web';
    const sessionHours = kind === 'web' ? ctx.config.ADMIN_SESSION_HOURS : Math.max(hours, SCANNER_CARD_SESSION_HOURS);
    const { token, expiresAt } = await createSession(ctx.db, userId, kind, sessionHours, ua(req));
    const principal = await resolveSession(ctx.db, token);
    if (!principal) throw forbidden('У этого аккаунта нет роли в команде');
    if (body.mode === 'cookie') {
      setSessionCookie(ctx, reply, token, expiresAt);
      return sessionInfo(ctx, principal);
    }
    return { ...(await sessionInfo(ctx, principal)), token, expiresAt: expiresAt.toISOString() };
  });

  /** Резервный вход в админку без Telegram: логин + пароль + код из приложения-аутентификатора. */
  app.post('/api/auth/password', async (req, reply) => {
    if (!loginLimiter.take(`ip:${req.ip}`)) throw tooManyRequests();
    const body = parse(passwordLoginSchema, req.body);
    const userId = await passwordLogin(ctx, body.login, body.password, body.totp);
    const { token, expiresAt } = await createSession(ctx.db, userId, 'web', ctx.config.ADMIN_SESSION_HOURS, ua(req));
    const principal = await resolveSession(ctx.db, token);
    if (!principal) throw forbidden('У этого аккаунта нет роли в команде');
    setSessionCookie(ctx, reply, token, expiresAt);
    return sessionInfo(ctx, principal);
  });

  app.get('/api/auth/session', { preHandler: requireStaff(ctx) }, async (req) => sessionInfo(ctx, req.staff!));

  app.post('/api/auth/logout', async (req, reply) => {
    const token = sessionToken(req);
    if (token) await revokeSession(ctx.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/api' });
    return { ok: true };
  });

}
