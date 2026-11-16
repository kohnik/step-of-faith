/**
 * HTTP-клиент API: относительные `/api/...` URL, таймауты, типизированные ошибки, повторы GET,
 * авторизация участника (`tma <initData>`) и персонала (`Bearer <token>` с пересозданием сессии на 401),
 * учёт связи для баннера «нет сети».
 */
import type { ApiError as ApiErrorBody } from '@sof/shared';
import { useSyncExternalStore } from 'react';
import { sleep } from '../lib/ids.ts';

export type AuthKind = 'tma' | 'staff' | 'none';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Нет связи или сервер не ответил вовремя. */
  get isNetwork(): boolean {
    return this.status === 0;
  }

  /** Имеет смысл повторить: сеть, таймаут, 5xx, 429. */
  get isTransient(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export function errorMessage(err: unknown, fallback = 'Что-то пошло не так. Попробуйте ещё раз.'): string {
  if (err instanceof ApiError && err.message) return err.message;
  return fallback;
}

function defaultMessage(status: number): string {
  if (status === 400) return 'Проверьте введённые данные';
  if (status === 401) return 'Откройте приложение заново, пожалуйста';
  if (status === 403) return 'Нет доступа';
  if (status === 404) return 'Не нашли';
  if (status === 409) return 'Данные изменились - обновите страницу';
  if (status === 410) return 'Ссылка устарела';
  if (status === 429) return 'Слишком часто 🙂 Подождите пару секунд';
  if (status >= 500) return 'Сервер недоступен - попробуйте чуть позже';
  return `Ошибка ${status}`;
}

// ---------- авторизация ----------

export interface StaffAuthProvider {
  getToken(): string | null;
  /** Пересоздать сессию после 401. true - запрос можно повторить. */
  refresh(): Promise<boolean>;
}

let initDataProvider: () => string | undefined = () => undefined;
let staffProvider: StaffAuthProvider | null = null;

/** Заголовок авторизации участника для своих запросов (поток живых обновлений). null - не из Telegram. */
export function tmaAuthHeader(): string | null {
  const raw = initDataProvider();
  return raw ? `tma ${raw}` : null;
}

/** Файл с сервера как адрес для <img> (чек за мерч): с токеном команды, которого у <img src> нет. */
export async function staffBlobUrl(path: string): Promise<string> {
  const token = staffProvider?.getToken();
  if (!token) throw new ApiError(401, 'no_session', 'Сессия команды истекла - войдите заново');
  const res = await fetch(buildUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, 'file_failed', 'Не удалось загрузить файл чека');
  return URL.createObjectURL(await res.blob());
}

export function setInitDataProvider(fn: () => string | undefined): void {
  initDataProvider = fn;
}

export function setStaffAuthProvider(provider: StaffAuthProvider | null): void {
  staffProvider = provider;
}

// ---------- связь ----------

let browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
let networkFailing = false;
const connListeners = new Set<() => void>();

function emitConnectivity(): void {
  for (const l of connListeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    browserOnline = true;
    emitConnectivity();
  });
  window.addEventListener('offline', () => {
    browserOnline = false;
    emitConnectivity();
  });
}

function markNetwork(ok: boolean): void {
  if (networkFailing === !ok) return;
  networkFailing = !ok;
  emitConnectivity();
}

export const connectivity = {
  subscribe(listener: () => void): () => void {
    connListeners.add(listener);
    return () => connListeners.delete(listener);
  },
  isOffline(): boolean {
    return !browserOnline || networkFailing;
  },
};

export function useOffline(): boolean {
  return useSyncExternalStore(connectivity.subscribe, connectivity.isOffline, () => false);
}

// ---------- запросы ----------

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** По умолчанию - `tma` (участник из Telegram). */
  auth?: AuthKind;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** По умолчанию 15 секунд. */
  timeoutMs?: number;
  /** Повторы при сетевых ошибках, 5xx и 429. По умолчанию: GET - 2, остальные - 0. */
  retries?: number;
  signal?: AbortSignal;
  cache?: RequestCache;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

async function once<T>(path: string, opts: RequestOptions, method: string): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let body: string | FormData | undefined;
  // Файл (чек) - FormData: заголовок с границей поставит сам браузер.
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const auth = opts.auth ?? 'tma';
  if (auth === 'tma') {
    const raw = initDataProvider();
    if (!raw) throw new ApiError(401, 'no_init_data', 'Откройте приложение из Telegram');
    headers.Authorization = `tma ${raw}`;
  } else if (auth === 'staff') {
    const token = staffProvider?.getToken();
    if (!token) throw new ApiError(401, 'no_session', 'Сессия команды истекла - войдите заново');
    headers.Authorization = `Bearer ${token}`;
  }

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? 15_000);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort);
  }

  try {
    const res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      signal: ctrl.signal,
      cache: opts.cache,
      credentials: 'same-origin',
    });
    const text = res.status === 204 || res.status === 304 ? '' : await res.text();
    // 502/503/504 отдаёт прокси, когда API лежит - для баннера это тоже «нет связи».
    markNetwork(!(res.status === 502 || res.status === 503 || res.status === 504));
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok && res.status !== 304) {
      const b = (data && typeof data === 'object' ? data : {}) as Partial<ApiErrorBody>;
      throw new ApiError(
        res.status,
        typeof b.error === 'string' ? b.error : `http_${res.status}`,
        typeof b.message === 'string' && b.message ? b.message : defaultMessage(res.status),
        b.details,
      );
    }
    return { status: res.status, headers: res.headers, data: data as T };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (opts.signal?.aborted && !timedOut) throw err;
    markNetwork(false);
    throw timedOut
      ? new ApiError(0, 'timeout', 'Сервер не ответил вовремя - проверьте связь')
      : new ApiError(0, 'network', 'Нет связи с сервером');
  } finally {
    window.clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const method = opts.method ?? 'GET';
  const retries = opts.retries ?? (method === 'GET' ? 2 : 0);
  let attempt = 0;
  let refreshed = false;
  for (;;) {
    try {
      return await once<T>(path, opts, method);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 401 && opts.auth === 'staff' && staffProvider && !refreshed) {
        refreshed = true;
        let ok = false;
        try {
          ok = await staffProvider.refresh();
        } catch {
          ok = false;
        }
        if (ok) continue;
      }
      if (attempt < retries && err.isTransient && !opts.signal?.aborted) {
        attempt += 1;
        await sleep(400 * 3 ** (attempt - 1) + Math.random() * 250);
        continue;
      }
      throw err;
    }
  }
}

export async function api<T>(path: string, opts?: RequestOptions): Promise<T> {
  return (await apiFetch<T>(path, opts)).data;
}
