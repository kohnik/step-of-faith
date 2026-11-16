/**
 * Живые обновления участника. Сервер шлёт по потоку (`GET /api/events`, Server-Sent Events) только
 * подсказки «что устарело»: оплата, запись, выключатели, залы. Приложение само перезапрашивает нужное.
 * Поток читаем через fetch: EventSource не умеет заголовок авторизации, а initData в адрес класть нельзя.
 * Нет потока (старый прокси, плохая сеть) - всё работает, как раньше, на опросе.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { tmaAuthHeader } from './client.ts';
import { queryClient } from './queries.ts';

type Kind = 'hello' | 'me' | 'questions' | 'schedule' | 'seminars' | 'counseling' | 'settings' | 'info' | 'merch' | 'game' | 'resync';

const KEYS: Record<Exclude<Kind, 'hello' | 'resync'>, readonly (readonly string[])[]> = {
  me: [['me']],
  questions: [['questions']],
  schedule: [['schedule']],
  seminars: [['seminars'], ['schedule']],
  counseling: [['counseling']],
  // Флаги записи, расписания и оплаты приходят в «me».
  settings: [['me'], ['schedule'], ['seminars'], ['counseling'], ['merch']],
  info: [['info']],
  // Каталог, остатки и заказы мерча.
  merch: [['merch'], ['merch-orders']],
  // Игра: запись, команды, раунды голосования (сами голоса - нет).
  // Включение игры (пункт на главной) приходит как «settings».
  game: [['game']],
};
const ALL = [...new Set(Object.values(KEYS).flat().map((k) => k.join('|')))].map((k) => k.split('|'));

/** Пока поток жив, опрос остаётся только страховкой. */
const SAFETY_POLL_MS = 3 * 60_000;
/** Нет «hello» за это время - считаем, что поток не работает (прокси его держит), и переподключаемся. */
const HELLO_TIMEOUT_MS = 10_000;
/** Свёрнутое приложение держит поток ещё столько, потом отпускает (вернётся - подключимся снова). */
const HIDDEN_GRACE_MS = 30_000;
const BACKOFF_MS = [1000, 2000, 5000, 15_000];
/** Сервер сказал «выключено» или «мест нет» (503) - не ломимся, живём на опросе и пробуем редко. */
const OFF_RETRY_MS = 5 * 60_000;

let connected = false;
const listeners = new Set<() => void>();
function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  for (const l of listeners) l();
}

// Подсказки собираем и перезапрашиваем с небольшим разбросом: сотни приложений не бьют в сервер разом.
const dirty = new Set<string>();
let flushTimer: number | null = null;
function invalidate(keys: readonly (readonly string[])[]) {
  for (const k of keys) dirty.add(k.join('|'));
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const list = [...dirty];
    dirty.clear();
    for (const k of list) void queryClient.invalidateQueries({ queryKey: k.split('|') });
  }, 150 + Math.random() * 1350);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(t);
      resolve();
    });
  });

/** Одна попытка: читать поток, пока его не закроют. */
async function stream(signal: AbortSignal, onHello: () => void): Promise<'hello' | 'off' | 'failed'> {
  const auth = tmaAuthHeader();
  if (!auth) return 'failed';
  const attempt = new AbortController();
  const stop = () => attempt.abort();
  signal.addEventListener('abort', stop);
  let hello = false;
  const helloTimer = window.setTimeout(() => {
    if (!hello) attempt.abort();
  }, HELLO_TIMEOUT_MS);
  try {
    const res = await fetch('/api/events', {
      headers: { Authorization: auth, Accept: 'text/event-stream' },
      signal: attempt.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (res.status === 503) return 'off';
    if (!res.ok || !res.body) return 'failed';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('event: '));
        if (!line) continue;
        const kind = line.slice(7).trim() as Kind;
        if (kind === 'hello') {
          hello = true;
          onHello();
        } else if (kind === 'resync') invalidate(ALL);
        else if (kind in KEYS) invalidate(KEYS[kind as keyof typeof KEYS]);
      }
    }
  } catch {
    /* сеть, тайм-аут «hello» или свернули приложение */
  } finally {
    window.clearTimeout(helloTimer);
    signal.removeEventListener('abort', stop);
  }
  return hello ? 'hello' : 'failed';
}

async function run(signal: AbortSignal) {
  let failures = 0;
  let wasConnected = false;
  // Не из Telegram (веб-билет, предпросмотр) - потока нет, работает опрос.
  while (!signal.aborted && tmaAuthHeader()) {
    const result = await stream(signal, () => {
      setConnected(true);
      failures = 0;
      // Пока потока не было, подсказки терялись - догоняем.
      if (wasConnected) invalidate(ALL);
      wasConnected = true;
    });
    setConnected(false);
    if (signal.aborted) break;
    if (result === 'failed') failures += 1;
    const base = result === 'off' ? OFF_RETRY_MS : BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
    await sleep(base + Math.random() * base * 0.5, signal);
  }
}

/** Поток жив - интервалы опроса экранов можно сделать редкими. */
export function useRealtimeConnected(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => connected,
    () => false,
  );
}

/** Интервал опроса экрана: обычный без потока, редкий (страховка) - когда поток жив. */
export function usePollInterval(normalMs: number): number {
  return useRealtimeConnected() ? Math.max(normalMs, SAFETY_POLL_MS) : normalMs;
}

/** Держать поток, пока приложение участника открыто и не свёрнуто надолго. */
export function useRealtime(): void {
  useEffect(() => {
    let ctrl: AbortController | null = null;
    let hiddenTimer: number | null = null;
    const start = () => {
      if (ctrl) return;
      ctrl = new AbortController();
      void run(ctrl.signal);
    };
    const stop = () => {
      ctrl?.abort();
      ctrl = null;
      setConnected(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenTimer ??= window.setTimeout(() => {
          hiddenTimer = null;
          stop();
        }, HIDDEN_GRACE_MS);
      } else {
        if (hiddenTimer !== null) window.clearTimeout(hiddenTimer);
        hiddenTimer = null;
        if (!ctrl) {
          start();
          // Пока были свёрнуты, могли что-то пропустить.
          invalidate([['me']]);
        }
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (hiddenTimer !== null) window.clearTimeout(hiddenTimer);
      stop();
    };
  }, []);
}
