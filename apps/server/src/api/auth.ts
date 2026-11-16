import type { Permission } from '@sof/shared';
import { parse as parseInitData, validate } from '@tma.js/init-data-node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { autoLinkByUsername } from '../services/link.service.ts';
import { adoptRestoredByUsername } from '../services/restore.service.ts';
import { resolveSession, type StaffPrincipal } from '../services/sessions.service.ts';
import { upsertTelegramUser, type UserRow } from '../services/users.service.ts';
import { recordVisit } from '../services/visits.service.ts';
import { tooManyRequests, UserRateLimiter } from './http.ts';

declare module 'fastify' {
  interface FastifyRequest {
    tgUser?: UserRow;
    staff?: StaffPrincipal;
  }
}

export const SESSION_COOKIE = 'sof_session';

const participantLimiter = new UserRateLimiter(30, 3);
const staffLimiter = new UserRateLimiter(120, 20);

/** Проверенная initData → пользователь. Кэш на минуту, чтобы не писать в БД на каждый запрос. */
const initDataCache = new Map<string, { user: UserRow; at: number }>();

export function readTmaHeader(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('tma ')) return null;
  return h.slice(4).trim();
}

export async function userFromInitData(ctx: AppContext, raw: string, maxAgeSec: number): Promise<UserRow> {
  try {
    validate(raw, ctx.config.BOT_TOKEN, { expiresIn: maxAgeSec });
  } catch {
    throw unauthorized('Сессия Telegram устарела - закройте и откройте приложение заново');
  }
  const key = sha256Hex(raw);
  const cached = initDataCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.user;
  const data = parseInitData(raw);
  if (!data.user) throw unauthorized('Нет данных пользователя Telegram');
  // После сбоя хостинга: аккаунт из выгрузки с тем же @ником становится этим аккаунтом.
  await adoptRestoredByUsername(ctx, data.user).catch((err: unknown) => ctx.log.warn({ err }, 'restore adopt failed'));
  const user = await upsertTelegramUser(ctx.db, data.user, { superadminTgIds: ctx.config.SUPERADMIN_TG_IDS });
  await recordVisit(ctx.db, user.id, 'app', ctx.log);
  // Друг открыл сразу Mini App, минуя бота: если его записали по @нику - привязываем и здесь.
  await autoLinkByUsername(ctx, user).catch((err: unknown) => ctx.log.warn({ err }, 'auto-link failed'));
  if (initDataCache.size > 20_000) initDataCache.clear();
  initDataCache.set(key, { user, at: Date.now() });
  return user;
}

/** Участник из Mini App: заголовок `Authorization: tma <initData>`. */
export function requireParticipant(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const raw = readTmaHeader(req);
    if (!raw) throw unauthorized('Откройте приложение из Telegram');
    const user = await userFromInitData(ctx, raw, ctx.config.INIT_DATA_MAX_AGE_SEC);
    if (!participantLimiter.take(`u:${user.id}`)) throw tooManyRequests();
    req.tgUser = user;
  };
}

export function sessionToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const cookie = req.cookies?.[SESSION_COOKIE];
  return cookie || null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Защита от подделки запросов. Cookie админки браузер прикладывает и к запросам с других сайтов того же
 * «сайта» (*.sslip.io не в списке публичных суффиксов, SameSite=Strict там не спасает). Поэтому изменения
 * по cookie принимаем только со страницы самой админки. Браузер шлёт Origin с любым POST/PATCH/DELETE;
 * без Origin приходят только не-браузерные клиенты, а им cookie чужого человека не достать.
 */
function trustedCookieRequest(ctx: AppContext, req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin';
  return origin === new URL(ctx.config.ADMIN_URL).origin;
}

/** Персонал: Bearer-токен (Mini App, браузерный сканер) или cookie (веб-админка). Нужен хотя бы один из `anyOf`. */
export function requireStaff(ctx: AppContext, anyOf: Permission[] = []) {
  return async (req: FastifyRequest) => {
    const token = sessionToken(req);
    if (!token) throw unauthorized();
    const viaCookie = !req.headers.authorization?.startsWith('Bearer ');
    if (viaCookie && !trustedCookieRequest(ctx, req)) throw forbidden('Запрос пришёл не со страницы админки');
    const staff = await resolveSession(ctx.db, token);
    if (!staff) throw unauthorized('Сессия истекла, войдите заново');
    if (anyOf.length && !anyOf.some((p) => staff.permissions.includes(p))) throw forbidden();
    if (!staffLimiter.take(`s:${staff.user.id}`)) throw tooManyRequests();
    req.staff = staff;
  };
}

export function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/api',
    httpOnly: true,
    secure: ctx.config.COOKIE_SECURE,
    sameSite: 'strict',
    expires: expiresAt,
  });
}
