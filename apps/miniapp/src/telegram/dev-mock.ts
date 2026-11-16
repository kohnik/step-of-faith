/**
 * ТОЛЬКО ДЛЯ `vite dev`. Имитирует Telegram в обычном браузере:
 *  - берёт подписанную initData у API (`GET /api/dev/init-data`, есть только при NODE_ENV=development);
 *  - вызывает `mockTelegramEnv` из @tma.js/sdk, отвечает на запросы SDK (тема, viewport, попапы, QR…);
 *  - рисует поверх страницы имитацию MainButton и BackButton.
 * Параметры адреса: `?devTgId=123&devName=Анна` - другой пользователь, `?nomock=1` - режим браузера
 * (например, чтобы проверить браузерный сканер), `?nomock=0` - вернуть имитацию,
 * `?devPlatform=ios` - притвориться телефоном (нативный сканер QR), `?devPlatform=tdesktop` - обратно.
 * В production-сборку модуль не попадает: импорт стоит под `if (import.meta.env.DEV)`.
 */
import { emitEvent, mockTelegramEnv, type ThemeParamsType } from '@tma.js/sdk-react';

const NOMOCK_KEY = 'sof:dev-nomock';
const TG_ID_KEY = 'sof:dev-tg-id';
const NAME_KEY = 'sof:dev-name';

const LIGHT: ThemeParamsType = {
  bg_color: '#ffffff',
  text_color: '#000000',
  hint_color: '#707579',
  link_color: '#3390ec',
  button_color: '#3390ec',
  button_text_color: '#ffffff',
  secondary_bg_color: '#f1f1f4',
  header_bg_color: '#ffffff',
  accent_text_color: '#3390ec',
  section_bg_color: '#ffffff',
  section_header_text_color: '#3390ec',
  subtitle_text_color: '#707579',
  destructive_text_color: '#e53935',
  section_separator_color: '#e7e7e7',
  bottom_bar_bg_color: '#f1f1f4',
};

const DARK: ThemeParamsType = {
  bg_color: '#212121',
  text_color: '#ffffff',
  hint_color: '#aaaaaa',
  link_color: '#8774e1',
  button_color: '#8774e1',
  button_text_color: '#ffffff',
  secondary_bg_color: '#0f0f0f',
  header_bg_color: '#212121',
  accent_text_color: '#8774e1',
  section_bg_color: '#212121',
  section_header_text_color: '#8774e1',
  subtitle_text_color: '#aaaaaa',
  destructive_text_color: '#e53935',
  section_separator_color: '#303030',
  bottom_bar_bg_color: '#0f0f0f',
};

function isRealTelegramWebview(): boolean {
  const w = window as Window & { TelegramWebviewProxy?: unknown };
  if (w.TelegramWebviewProxy) return true;
  try {
    if (window.self !== window.top) return true;
  } catch {
    return true;
  }
  return /tgWebAppData=/.test(window.location.hash);
}

// ---------- имитация кнопок ----------

interface MainState {
  visible: boolean;
  active: boolean;
  progress: boolean;
  text: string;
  color?: string;
  textColor?: string;
}

const overlay = {
  main: null as HTMLButtonElement | null,
  back: null as HTMLButtonElement | null,
  state: { visible: false, active: true, progress: false, text: '' } as MainState,

  init(label: string) {
    const main = document.createElement('button');
    main.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;height:52px;border:0;border-radius:12px;' +
      'font:600 16px system-ui;display:none;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    main.addEventListener('click', () => {
      if (overlay.state.active && !overlay.state.progress) emitEvent('main_button_pressed');
    });
    const back = document.createElement('button');
    back.textContent = '‹ Назад (Telegram)';
    back.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:2147483000;height:34px;padding:0 12px;border:0;border-radius:17px;' +
      'font:600 14px system-ui;background:rgba(0,0,0,.65);color:#fff;display:none';
    back.addEventListener('click', () => emitEvent('back_button_pressed'));
    const badge = document.createElement('button');
    badge.textContent = `DEV · ${label}`;
    badge.title = 'Сменить тестового пользователя';
    badge.style.cssText =
      'position:fixed;right:8px;top:8px;z-index:2147483000;height:26px;padding:0 10px;border:0;border-radius:13px;' +
      'font:600 11px system-ui;background:#ff9800;color:#000;opacity:.85';
    badge.addEventListener('click', () => {
      const id = window.prompt('Telegram id тестового пользователя', sessionStorage.getItem(TG_ID_KEY) ?? '');
      if (!id) return;
      const name = window.prompt('Имя', sessionStorage.getItem(NAME_KEY) ?? 'Тестовый') ?? 'Тестовый';
      sessionStorage.setItem(TG_ID_KEY, id);
      sessionStorage.setItem(NAME_KEY, name);
      sessionStorage.removeItem('tapps/launchParams');
      window.location.reload();
    });
    document.body.append(main, back, badge);
    overlay.main = main;
    overlay.back = back;
  },

  setMain(p: Record<string, unknown> | undefined) {
    if (!p || !overlay.main) return;
    const s = overlay.state;
    if (typeof p.is_visible === 'boolean') s.visible = p.is_visible;
    if (typeof p.is_active === 'boolean') s.active = p.is_active;
    if (typeof p.is_progress_visible === 'boolean') s.progress = p.is_progress_visible;
    if (typeof p.text === 'string') s.text = p.text;
    if (typeof p.color === 'string') s.color = p.color;
    if (typeof p.text_color === 'string') s.textColor = p.text_color;
    const el = overlay.main;
    el.style.display = s.visible ? 'block' : 'none';
    el.style.background = s.color ?? '#3390ec';
    el.style.color = s.textColor ?? '#fff';
    el.style.opacity = s.active && !s.progress ? '1' : '.55';
    el.textContent = s.progress ? '⏳ …' : s.text;
    document.body.style.paddingBottom = s.visible ? '76px' : '';
  },

  setBack(visible: boolean) {
    if (overlay.back) overlay.back.style.display = visible ? 'block' : 'none';
  },
};

// ---------- ответы на методы Mini Apps ----------

let qrOpen = false;
let lastQr = '';

function promptQr(title: string): void {
  if (!qrOpen) return;
  const text = window.prompt(`DEV-сканер QR${title ? ` - ${title}` : ''}\nВставьте содержимое QR (например SF-XXXXXXXXXXX):`, lastQr);
  if (!text) {
    qrOpen = false;
    emitEvent('scan_qr_popup_closed');
    return;
  }
  lastQr = text;
  emitEvent('qr_text_received', { data: text });
  // Приложение не закрыло сканер (например, повторное чтение) - спрашиваем снова.
  window.setTimeout(() => promptQr(title), 600);
}

function handleMethod(name: string, params: Record<string, unknown> | undefined, theme: ThemeParamsType): void {
  const later = (fn: () => void) => window.setTimeout(fn, 30);
  const reqId = typeof params?.req_id === 'string' ? params.req_id : '';
  switch (name) {
    case 'web_app_request_theme':
      later(() => emitEvent('theme_changed', { theme_params: theme }));
      break;
    case 'web_app_request_viewport':
      later(() =>
        emitEvent('viewport_changed', {
          height: window.innerHeight,
          width: window.innerWidth,
          is_expanded: true,
          is_state_stable: true,
        }),
      );
      break;
    case 'web_app_request_safe_area':
      later(() => emitEvent('safe_area_changed', { top: 0, bottom: 0, left: 0, right: 0 }));
      break;
    case 'web_app_request_content_safe_area':
      later(() => emitEvent('content_safe_area_changed', { top: 0, bottom: 0, left: 0, right: 0 }));
      break;
    case 'web_app_setup_main_button':
      overlay.setMain(params);
      break;
    case 'web_app_setup_back_button':
      overlay.setBack(Boolean(params?.is_visible));
      break;
    case 'web_app_open_popup':
      later(() => {
        const p = params as { title?: string; message?: string; buttons?: { id?: string; type?: string; text?: string }[] };
        const buttons = p.buttons ?? [];
        const action = buttons.find((b) => b.type !== 'cancel' && b.type !== 'close');
        const text = [p.title, p.message].filter(Boolean).join('\n\n');
        let id: string | undefined;
        if (action && buttons.length > 1) id = window.confirm(`${text}\n\n[OK] = «${action.text ?? action.type}»`) ? action.id : undefined;
        else {
          window.alert(text);
          id = buttons[0]?.id;
        }
        emitEvent('popup_closed', id !== undefined ? { button_id: id } : {});
      });
      break;
    case 'web_app_open_scan_qr_popup':
      qrOpen = true;
      later(() => promptQr(typeof params?.text === 'string' ? params.text : ''));
      break;
    case 'web_app_close_scan_qr_popup':
      qrOpen = false;
      break;
    case 'web_app_request_write_access':
      later(() => emitEvent('write_access_requested', { status: 'allowed' }));
      break;
    case 'web_app_request_phone':
      later(() => emitEvent('phone_requested', { status: 'cancelled' }));
      break;
    case 'web_app_request_file_download':
      later(() => {
        emitEvent('file_download_requested', { status: 'downloading' });
        if (typeof params?.url === 'string') window.open(params.url, '_blank');
      });
      break;
    case 'web_app_open_link':
      if (typeof params?.url === 'string') window.open(params.url, '_blank');
      break;
    case 'web_app_open_tg_link':
      if (typeof params?.path_full === 'string') window.open(`https://t.me${params.path_full}`, '_blank');
      break;
    case 'web_app_close':
      console.info('[dev] web_app_close - в Telegram приложение бы закрылось');
      break;
    case 'web_app_device_storage_get_key':
      later(() =>
        emitEvent('device_storage_key_received', {
          req_id: reqId,
          value: localStorage.getItem(`dev-device-storage:${String(params?.key)}`),
        }),
      );
      break;
    case 'web_app_device_storage_save_key':
      later(() => {
        const key = `dev-device-storage:${String(params?.key)}`;
        if (typeof params?.value === 'string') localStorage.setItem(key, params.value);
        else localStorage.removeItem(key);
        emitEvent('device_storage_key_saved', { req_id: reqId });
      });
      break;
    case 'web_app_device_storage_clear':
      later(() => emitEvent('device_storage_cleared', { req_id: reqId }));
      break;
    default:
      break;
  }
}

/** Возвращает true, если окружение Telegram теперь имитируется. */
export async function setupDevTelegramMock(): Promise<boolean> {
  const qs = new URLSearchParams(window.location.search);
  const nomock = qs.get('nomock');
  if (nomock === '1') sessionStorage.setItem(NOMOCK_KEY, '1');
  if (nomock === '0') sessionStorage.removeItem(NOMOCK_KEY);
  if (sessionStorage.getItem(NOMOCK_KEY) === '1') {
    sessionStorage.removeItem('tapps/launchParams');
    console.info('[dev] имитация Telegram выключена (?nomock=0 - включить)');
    return false;
  }
  if (isRealTelegramWebview()) return false;

  const tgId = qs.get('devTgId') ?? sessionStorage.getItem(TG_ID_KEY) ?? '777000001';
  const name = qs.get('devName') ?? sessionStorage.getItem(NAME_KEY) ?? 'Тестовый';
  sessionStorage.setItem(TG_ID_KEY, tgId);
  sessionStorage.setItem(NAME_KEY, name);
  const devPlatform = qs.get('devPlatform') ?? sessionStorage.getItem('sof:dev-platform') ?? 'tdesktop';
  sessionStorage.setItem('sof:dev-platform', devPlatform);

  let initData: string;
  try {
    const res = await fetch(`/api/dev/init-data?tgId=${encodeURIComponent(tgId)}&name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    initData = ((await res.json()) as { initData: string }).initData;
  } catch (err) {
    console.warn('[dev] /api/dev/init-data недоступен - запустите API с NODE_ENV=development', err);
    return false;
  }

  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const theme = dark ? DARK : LIGHT;
  mockTelegramEnv({
    launchParams: {
      tgWebAppData: initData,
      tgWebAppVersion: '9.1',
      tgWebAppPlatform: devPlatform,
      tgWebAppThemeParams: theme,
    },
    onEvent: (event) => handleMethod(event.name, event.params as Record<string, unknown> | undefined, theme),
    resetPostMessage: true,
  });
  overlay.init(`${name} #${tgId}`);
  console.info(`[dev] Telegram имитируется: tgId=${tgId}. ?devTgId=… - другой пользователь, ?nomock=1 - режим браузера.`);
  return true;
}
