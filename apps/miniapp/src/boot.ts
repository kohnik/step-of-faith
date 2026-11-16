import { setInitDataProvider } from './api/client.ts';
import type { AppEnv } from './app/env.ts';
import { detectTelegram, initTelegram, rawInitData } from './telegram/sdk.ts';

/** Путь, с которого открыли приложение (кнопка бота ведёт прямо на нужный экран). */
export const entryPath = window.location.pathname;

/** Страницы, которые всегда работают как обычный сайт (открываются по ссылке вне Telegram). */
export function isBrowserOnlyPath(path: string): boolean {
  return path.startsWith('/t/') || path === '/staff/login' || path.startsWith('/staff/login/');
}

export async function bootstrap(): Promise<AppEnv> {
  if (isBrowserOnlyPath(window.location.pathname)) return { mode: 'browser', mocked: false };

  let mocked = false;
  // Имитация Telegram - только в `vite dev`: в production-сборке этот блок и модуль dev-mock вырезаются.
  if (import.meta.env.DEV) {
    const { setupDevTelegramMock } = await import('./telegram/dev-mock.ts');
    mocked = await setupDevTelegramMock();
  }

  if (detectTelegram() && initTelegram()) {
    setInitDataProvider(rawInitData);
    return { mode: 'telegram', mocked };
  }
  return { mode: 'browser', mocked: false };
}
