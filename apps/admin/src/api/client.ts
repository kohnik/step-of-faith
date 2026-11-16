import type { ApiError as ApiErrorBody } from '@sof/shared';

/** Ошибка API: HTTP-статус + `{ error, message, details }` от сервера. */
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

  /** Ошибки валидации сервера (`details: [{ path, message }]`) по полям. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!Array.isArray(this.details)) return out;
    for (const item of this.details as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const { path, message } = item as { path?: unknown; message?: unknown };
      if (typeof path !== 'string' || !path) continue;
      if (!out[path]) out[path] = typeof message === 'string' && /[а-яё]/i.test(message) ? message : 'Проверьте значение';
    }
    return out;
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Проверьте, всё ли заполнено верно',
  401: 'Нужно войти заново',
  403: 'На это у вашей роли нет прав',
  404: 'Не найдено',
  409: 'Данные уже изменились - обновите страницу',
  410: 'Ссылка устарела',
  413: 'Слишком большой запрос',
  429: 'Слишком много запросов, подождите немного',
  500: 'Что-то пошло не так на сервере. Попробуйте ещё раз.',
  502: 'Сервер недоступен. Попробуйте через минуту.',
  503: 'Сервер недоступен. Попробуйте через минуту.',
  504: 'Сервер не ответил вовремя. Попробуйте ещё раз.',
};

type UnauthorizedHandler = (error: ApiError) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Вызывается при любом 401 (сессия истекла) - приложение уводит на /login. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Не уводить на /login при 401 (сам запрос сессии и вход). */
  skipAuthRedirect?: boolean;
}

async function toApiError(res: Response, opts: RequestOptions): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    body = null;
  }
  const message =
    typeof body?.message === 'string' && body.message
      ? body.message
      : (STATUS_MESSAGES[res.status] ?? `Ошибка ${res.status}`);
  const error = new ApiError(res.status, typeof body?.error === 'string' ? body.error : 'http_error', message, body?.details);
  if (res.status === 401 && !opts.skipAuthRedirect) unauthorizedHandler?.(error);
  return error;
}

async function request<T>(method: string, url: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Файл (фото, 3D-модель) - FormData: границу в заголовок поставит сам браузер.
  const form = body instanceof FormData;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
  }
  if (!res.ok) throw await toApiError(res, opts);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return (await res.text()) as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(url: string, opts?: RequestOptions) => request<T>('GET', url, undefined, opts),
  post: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', url, body, opts),
  put: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', url, body, opts),
  patch: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', url, body, opts),
  delete: <T>(url: string, opts?: RequestOptions) => request<T>('DELETE', url, undefined, opts),
};

/** Строка запроса без пустых параметров. */
export function withQuery(url: string, params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `${url}?${s}` : url;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* ниже - обычное имя */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

/**
 * Скачивание файла с cookie-сессией. Через fetch, а не простой ссылкой, чтобы
 * показать понятную ошибку вместо JSON-страницы, если сессия истекла или нет прав.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
  }
  if (!res.ok) throw await toApiError(res, {});
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Неизвестная ошибка';
}
