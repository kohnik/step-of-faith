/**
 * Сессия персонала.
 *  - Telegram: `POST /api/auth/staff-session` с `tma`-заголовком → Bearer-токен (память + localStorage,
 *    чтобы сканер открывался и без сети); на 401 сессия пересоздаётся автоматически, а если Telegram уже
 *    не даёт свежих данных входа - показываем «Сессия истекла, откройте приложение заново».
 *  - Браузер (карточка сканера): токен из `/staff/login` лежит в localStorage; на 401 - нужен новый вход.
 */
import type { Permission, SessionInfo, StaffSessionResponse } from '@sof/shared';
import { createContext, useContext, useSyncExternalStore } from 'react';
import { api, ApiError, setStaffAuthProvider } from '../api/client.ts';
import type { AppMode } from '../app/env.ts';
import { local, session as sessionStore } from '../lib/storage.ts';
import { telegramUser } from '../telegram/sdk.ts';

export interface StaffSession {
  token: string;
  expiresAt: string;
  roles: SessionInfo['roles'];
  permissions: Permission[];
  user: SessionInfo['user'];
  /** Название и часовой пояс события - сканеру без доступа к настройкам. */
  event: SessionInfo['event'];
  features: SessionInfo['features'];
  /** Варианты участия (цвета бейджей); нет в старых сохранённых сессиях. */
  tiers?: SessionInfo['tiers'];
}

/** Сессия персонала в Telegram привязана к аккаунту: другой пользователь не получит чужой токен. */
const tgKey = () => `sof:staff-session:${telegramUser()?.id ?? 'anon'}`;
const BROWSER_KEY = 'sof:staff-bearer';
/**
 * Данные входа Telegram годятся для сессии команды только первый час после открытия приложения.
 * Если сохранённой сессии осталось меньше этого - продлеваем её сразу при открытии, иначе она истечёт
 * посреди смены и продлить будет нечем.
 */
const RENEW_BELOW_MS = 12 * 3600_000;

let current: StaffSession | null = null;
let mode: AppMode = 'telegram';
let creating: Promise<StaffSession> | null = null;
/** Токен истёк, а продлить не вышло (данные входа Telegram устарели) - нужно переоткрыть приложение. */
let expired = false;
const listeners = new Set<() => void>();

function setExpired(v: boolean): void {
  if (expired === v) return;
  expired = v;
  for (const l of listeners) l();
}

function isValid(s: StaffSession | null | undefined): s is StaffSession {
  return Boolean(s?.token) && new Date(s!.expiresAt).getTime() > Date.now() + 60_000;
}

/** Сохранённая до обновления сессия без event/features/даты начала - в Telegram её просто пересоздаём. */
function isComplete(s: StaffSession): boolean {
  return Boolean(s.event && s.features && 'startsAt' in s.event);
}

function persist(s: StaffSession | null): void {
  current = s;
  const key = mode === 'telegram' ? tgKey() : BROWSER_KEY;
  if (s) local.setJSON(key, s);
  else local.remove(key);
  if (mode === 'telegram') sessionStore.remove(key);
  for (const l of listeners) l();
}

export function fromResponse(res: StaffSessionResponse): StaffSession {
  return {
    token: res.token,
    expiresAt: res.expiresAt,
    roles: res.roles,
    permissions: res.permissions,
    user: res.user,
    event: res.event,
    features: res.features,
    tiers: res.tiers,
  };
}

function createTelegramSession(): Promise<StaffSession> {
  creating ??= api<StaffSessionResponse>('/api/auth/staff-session', { method: 'POST', auth: 'tma', timeoutMs: 15_000 })
    .then((res) => {
      const s = fromResponse(res);
      persist(s);
      setExpired(false);
      return s;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

/** Вход по карточке сканера (страница /staff/login). */
export function saveBrowserSession(res: StaffSessionResponse): void {
  local.setJSON(BROWSER_KEY, fromResponse(res));
}

export function hasBrowserSession(): boolean {
  return isValid(local.getJSON<StaffSession>(BROWSER_KEY));
}

function installProvider(): void {
  setStaffAuthProvider({
    getToken: () => current?.token ?? null,
    refresh: async () => {
      if (mode === 'telegram') {
        // Старый токен не обнуляем ни в памяти, ни на устройстве: параллельные запросы дождутся той же новой
        // сессии, а без связи сканер и после перезапуска откроется по сохранённой (отметки уйдут позже).
        try {
          await createTelegramSession();
          return true;
        } catch (err) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setExpired(true);
          throw err;
        }
      }
      persist(null);
      return false;
    },
  });
}

/** Свежие роли и настройки события для сохранённой сессии (без связи - остаёмся на сохранённых). */
async function refreshInfo(saved: StaffSession): Promise<void> {
  try {
    const info = await api<SessionInfo>('/api/auth/session', { auth: 'staff', timeoutMs: 6000, retries: 0 });
    if (current?.token === saved.token) {
      persist({ ...saved, roles: info.roles, permissions: info.permissions, user: info.user, event: info.event, features: info.features });
    }
  } catch {
    /* без связи работаем с сохранённой */
  }
}

export async function startStaffSession(m: AppMode): Promise<StaffSession> {
  mode = m;
  installProvider();
  if (m === 'telegram') {
    if (isValid(current)) return current;
    const saved = local.getJSON<StaffSession>(tgKey()) ?? sessionStore.getJSON<StaffSession>(tgKey());
    if (isValid(saved) && isComplete(saved)) {
      current = saved;
      if (new Date(saved.expiresAt).getTime() - Date.now() < RENEW_BELOW_MS) void createTelegramSession().catch(() => undefined);
      // Роли, дата начала и включённые возможности могли поменяться - сверяемся в фоне.
      else void refreshInfo(saved);
      return saved;
    }
    try {
      return await createTelegramSession();
    } catch (err) {
      // Нет связи, а сохранённая сессия истекла: всё равно открываем сканер по ней - база QR-кодов на телефоне,
      // отметки копятся в очереди и уйдут, когда приложение откроют заново со связью.
      const offline = !(err instanceof ApiError) || err.isTransient;
      if (offline && saved?.token && isComplete(saved)) {
        current = saved;
        setExpired(true);
        return saved;
      }
      throw err;
    }
  }

  const saved = local.getJSON<StaffSession>(BROWSER_KEY);
  if (!isValid(saved)) {
    local.remove(BROWSER_KEY);
    throw new ApiError(401, 'no_session', 'Войдите по ссылке с карточки сканера');
  }
  current = saved;
  // Роли могли поменяться - сверяемся с сервером; без связи работаем с сохранённой сессией.
  try {
    const info = await api<SessionInfo>('/api/auth/session', { auth: 'staff', timeoutMs: 6000, retries: 0 });
    persist({ ...saved, roles: info.roles, permissions: info.permissions, user: info.user, event: info.event, features: info.features });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      persist(null);
      throw err;
    }
  }
  return current ?? saved;
}

export async function logoutBrowser(): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST', auth: 'staff', timeoutMs: 5000 });
  } catch {
    /* всё равно выходим локально */
  }
  persist(null);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getCurrent = () => current;
const getExpired = () => expired;

/** Сессия истекла и сама не продлилась - сканер просит переоткрыть приложение. */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, getExpired, getExpired);
}

/** Текущая сессия (null - вышли или токен отозван). */
export function useStaffSessionState(): StaffSession | null {
  return useSyncExternalStore(subscribe, getCurrent, getCurrent);
}

export const StaffContext = createContext<StaffSession | null>(null);

export function useStaff(): StaffSession {
  const s = useContext(StaffContext);
  if (!s) throw new Error('useStaff outside StaffApp');
  return s;
}

export function can(s: StaffSession, permission: Permission): boolean {
  return s.permissions.includes(permission);
}

/** Оплата включена? Пока нет (или сессия старая, без признака) - никаких «не оплачено» и кассы. */
export function paymentsEnabledFor(s: StaffSession): boolean {
  return s.features?.payments === true;
}
