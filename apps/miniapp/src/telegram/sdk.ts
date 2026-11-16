/**
 * Инициализация @tma.js/sdk v3 и безопасный доступ к возможностям Telegram.
 * Все вызовы идут через `.ifAvailable()` / `.isAvailable()` - вне Telegram или на старых
 * клиентах они просто ничего не делают.
 */
import {
  backButton,
  closingBehavior,
  init,
  initData,
  isTMA,
  mainButton,
  miniApp,
  retrieveLaunchParams,
  retrieveRawInitData,
  swipeBehavior,
  themeParams,
  viewport,
} from '@tma.js/sdk-react';

let active = false;
let platform = 'unknown';

/** true - приложение запущено как Telegram Mini App и SDK инициализирован. */
export function isTelegram(): boolean {
  return active;
}

export function telegramPlatform(): string {
  return platform;
}

/** Телефон/планшет (а не Telegram Desktop / Web). */
export function isMobileTelegram(): boolean {
  return platform === 'ios' || platform === 'android' || platform === 'android_x';
}

function attempt(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[telegram]', err);
  }
}

/** Есть ли параметры запуска Telegram (URL, performance entries или sessionStorage). */
export function detectTelegram(): boolean {
  try {
    return isTMA();
  } catch {
    return false;
  }
}

/** Фон приложения в фирменных темах - им же красим панели Telegram, чтобы не было «чужой» полосы сверху. */
const BRAND_BG = { light: '#ece7d2', dark: '#241b26' } as const;

function paintChrome(dark: boolean): void {
  const bg = dark ? BRAND_BG.dark : BRAND_BG.light;
  attempt(() => miniApp.setBgColor.ifAvailable(bg));
  attempt(() => {
    // Старые клиенты умеют красить шапку только цветом из темы Telegram.
    if (miniApp.setHeaderColor.isAvailable() && miniApp.setHeaderColor.supports('rgb')) miniApp.setHeaderColor(bg);
    else miniApp.setHeaderColor.ifAvailable('secondary_bg_color');
  });
  attempt(() => miniApp.setBottomBarColor.ifAvailable(bg));
}

function syncColorScheme(): void {
  const apply = () => {
    try {
      const dark = themeParams.isDark();
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      paintChrome(dark);
    } catch {
      /* ignore */
    }
  };
  apply();
  attempt(() => themeParams.isDark.sub(apply));
}

export function initTelegram(): boolean {
  try {
    init();
  } catch (err) {
    console.error('Telegram SDK init failed', err);
    return false;
  }
  active = true;
  attempt(() => {
    platform = retrieveLaunchParams().tgWebAppPlatform;
  });
  attempt(() => initData.restore());
  attempt(() => themeParams.mount.ifAvailable());
  attempt(() => themeParams.bindCssVars.ifAvailable());
  attempt(() => miniApp.mount.ifAvailable());
  attempt(() => miniApp.bindCssVars.ifAvailable());
  attempt(() => backButton.mount.ifAvailable());
  attempt(() => mainButton.mount.ifAvailable());
  attempt(() => closingBehavior.mount.ifAvailable());
  attempt(() => swipeBehavior.mount.ifAvailable());
  syncColorScheme();
  if (viewport.mount.isAvailable()) {
    viewport
      .mount()
      .then(() => {
        attempt(() => viewport.bindCssVars.ifAvailable());
        attempt(() => viewport.expand.ifAvailable());
      })
      .catch((err: unknown) => {
        if (import.meta.env.DEV) console.warn('[telegram] viewport mount failed', err);
      });
  }
  return true;
}

/** Скрыть заставку Telegram - вызываем после первого осмысленного рендера. */
export function telegramReady(): void {
  if (!active) return;
  attempt(() => miniApp.ready.ifAvailable());
}

/** Сырая initData для заголовка `Authorization: tma <initData>`. */
export function rawInitData(): string | undefined {
  if (!active) return undefined;
  try {
    return initData.raw() ?? retrieveRawInitData();
  } catch {
    return undefined;
  }
}

export interface TelegramUserInfo {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  allowsWriteToPm?: boolean;
}

export function telegramUser(): TelegramUserInfo | null {
  if (!active) return null;
  try {
    const u = initData.user();
    if (!u) return null;
    return {
      id: u.id,
      firstName: u.first_name,
      lastName: u.last_name,
      username: u.username,
      allowsWriteToPm: u.allows_write_to_pm,
    };
  } catch {
    return null;
  }
}

export function startParam(): string | undefined {
  if (!active) return undefined;
  try {
    return initData.startParam() ?? retrieveLaunchParams().tgWebAppStartParam;
  } catch {
    return undefined;
  }
}

/** Закрыть Mini App (вернуться в чат с ботом). */
export function closeMiniApp(): void {
  attempt(() => miniApp.close.ifAvailable());
}

/** Подтверждение при закрытии приложения (пока есть неотправленные отметки). */
export function setClosingConfirmation(enabled: boolean): void {
  if (!active) return;
  attempt(() =>
    enabled ? closingBehavior.enableConfirmation.ifAvailable() : closingBehavior.disableConfirmation.ifAvailable(),
  );
}

/** Вертикальный свайп закрывает/сворачивает приложение - на экране сканера его отключаем. */
export function setVerticalSwipes(enabled: boolean): void {
  if (!active) return;
  attempt(() => (enabled ? swipeBehavior.enableVertical.ifAvailable() : swipeBehavior.disableVertical.ifAvailable()));
}
