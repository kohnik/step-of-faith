/**
 * Действия, которые внутри Telegram идут через нативные методы, а в браузере - через обычные API.
 */
import {
  copyTextToClipboard,
  downloadFile,
  openLink,
  openTelegramLink,
  popup,
  requestContact,
  requestContactComplete,
  requestWriteAccess,
} from '@tma.js/sdk-react';
import { isTelegram, telegramUser } from './sdk.ts';

/** Нативный диалог подтверждения (или window.confirm вне Telegram). */
export async function confirmAction(opts: {
  title?: string;
  message: string;
  ok: string;
  destructive?: boolean;
}): Promise<boolean> {
  if (isTelegram()) {
    try {
      if (popup.show.isAvailable()) {
        const id = await popup.show({
          title: opts.title?.slice(0, 64),
          message: opts.message.slice(0, 256),
          buttons: [
            { id: 'ok', type: opts.destructive ? 'destructive' : 'default', text: opts.ok.slice(0, 64) },
            { id: 'cancel', type: 'cancel' },
          ],
        });
        return id === 'ok';
      }
    } catch {
      /* попап уже открыт или не поддерживается - ниже запасной вариант */
    }
  }
  return window.confirm(opts.title ? `${opts.title}\n\n${opts.message}` : opts.message);
}

function isTelegramUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 't.me' || u.hostname === 'telegram.me';
  } catch {
    return false;
  }
}

/** Открыть внешнюю ссылку, не теряя приложение: в Telegram - во внешнем/встроенном браузере. */
export function openExternal(url: string): void {
  if (isTelegram()) {
    try {
      if (isTelegramUrl(url) && openTelegramLink.isAvailable()) {
        openTelegramLink(url);
        return;
      }
      if (openLink.isAvailable()) {
        openLink(url);
        return;
      }
    } catch {
      /* ниже запасной вариант */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Окно «Поделиться» Telegram со ссылкой (Mini App при этом закрывается). */
export function shareLink(url: string, text?: string): void {
  const share = `https://t.me/share/url?url=${encodeURIComponent(url)}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
  if (isTelegram()) {
    try {
      if (openTelegramLink.isAvailable()) {
        openTelegramLink(share);
        return;
      }
    } catch {
      /* ignore */
    }
  }
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    nav.share({ url, text }).catch(() => undefined);
    return;
  }
  window.open(share, '_blank', 'noopener,noreferrer');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await copyTextToClipboard(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Сохранить картинку: в Telegram 8.0+ - нативный диалог загрузки файла,
 * иначе - открыть картинку (долгое нажатие → «Сохранить»).
 */
export async function saveFile(url: string, fileName: string): Promise<'downloading' | 'opened' | 'denied'> {
  if (isTelegram()) {
    try {
      if (downloadFile.isAvailable()) {
        await downloadFile(url, fileName);
        return 'downloading';
      }
    } catch {
      return 'denied';
    }
    openExternal(url);
    return 'opened';
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return 'opened';
}

/**
 * Разрешение боту писать в личку - чтобы он смог прислать билеты. Спрашиваем один раз за сессию.
 * 'denied' - пользователь отказал (билеты всё равно будут в приложении).
 */
export async function ensureWriteAccess(): Promise<'allowed' | 'denied' | 'unknown'> {
  if (!isTelegram()) return 'unknown';
  const user = telegramUser();
  if (user?.allowsWriteToPm) return 'allowed';
  try {
    const asked = sessionStorage.getItem('sof:write-access');
    if (asked === 'allowed' || asked === 'denied') return asked;
  } catch {
    /* ignore */
  }
  let result: 'allowed' | 'denied' | 'unknown' = 'unknown';
  try {
    if (requestWriteAccess.isAvailable()) {
      // Клиент Telegram иногда не отвечает на запрос - регистрация не должна висеть на этом бесконечно.
      const status = await Promise.race([
        requestWriteAccess(),
        new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), 15_000)),
      ]);
      result = status === 'timeout' ? 'unknown' : status === 'allowed' ? 'allowed' : 'denied';
    }
  } catch {
    result = 'unknown';
  }
  try {
    if (result !== 'unknown') sessionStorage.setItem('sof:write-access', result);
  } catch {
    /* ignore */
  }
  return result;
}

export function canRequestContact(): boolean {
  if (!isTelegram()) return false;
  try {
    return requestContact.isAvailable();
  } catch {
    return false;
  }
}

export interface TelegramContact {
  phone: string;
  /** Ответ Telegram как есть, с подписью: по нему сервер проверяет, что номер принадлежит этому аккаунту. */
  signed: string;
}

/** Номер телефона из Telegram (с согласия пользователя) вместе с подписью Telegram. */
export async function requestContactFromTelegram(): Promise<TelegramContact | null> {
  if (!canRequestContact()) return null;
  try {
    const res = await requestContactComplete({ timeout: 60_000 });
    const raw = res.parsed.contact.phone_number?.trim();
    if (!raw) return null;
    return { phone: raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`, signed: res.raw };
  } catch {
    return null;
  }
}
