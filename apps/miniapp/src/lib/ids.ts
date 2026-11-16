import { local } from './storage.ts';

/** UUID v4. `crypto.randomUUID` есть только в secure context - на всякий случай есть запасной путь. */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DEVICE_KEY = 'sof:device-id';

/** Постоянный идентификатор устройства сканера (для журнала отметок на сервере). */
export function deviceId(): string {
  let id = local.get(DEVICE_KEY);
  if (!id) {
    id = `d-${uuid()}`;
    local.set(DEVICE_KEY, id);
  }
  return id;
}

/** Короткий стабильный хеш строки (djb2) - для сравнения черновиков, не для безопасности. */
export function quickHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length.toString(36);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
