import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.ts';

export type SaveState = 'idle' | 'pending' | 'saving' | 'error';

/**
 * Автосохранение голоса по ходу нажатий: шлём не каждое нажатие, а последнее значение - через `delay` после паузы,
 * но не реже раза в `maxWait`, пока человек жмёт без остановки. Одинаковое повторно не шлём, запросы - строго по одному
 * (ответы не приходят вразнобой), при «слишком часто» и обрыве сети - повтор. Ушёл со страницы - досохраняем.
 */
export function useAutoSave<T>({
  value,
  saved,
  equal,
  send,
  delay = 450,
  maxWait = 1400,
  enabled = true,
  onError,
}: {
  value: T;
  /** Что сейчас на сервере (последний подтверждённый голос). */
  saved: T;
  equal: (a: T, b: T) => boolean;
  send: (v: T) => Promise<void>;
  delay?: number;
  maxWait?: number;
  enabled?: boolean;
  onError?: (err: unknown) => void;
}): SaveState {
  const [state, setState] = useState<SaveState>('idle');
  const latest = useRef(value);
  latest.current = value;
  const confirmed = useRef(saved);
  const inflight = useRef(false);
  const timer = useRef<number | null>(null);
  const pendingSince = useRef<number | null>(null);
  const fns = useRef({ send, equal, onError });
  fns.current = { send, equal, onError };

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) return; // досохраним, когда вернётся текущий запрос
    const v = latest.current;
    if (fns.current.equal(v, confirmed.current)) {
      pendingSince.current = null;
      setState('idle');
      return;
    }
    inflight.current = true;
    pendingSince.current = null;
    setState('saving');
    let retry = false;
    try {
      await fns.current.send(v);
      confirmed.current = v;
    } catch (err) {
      // Перегрузка или сеть - пробуем ещё раз; остальное (раунд закрыт) - показываем.
      retry = !(err instanceof ApiError) || err.status === 0 || err.status === 429 || err.status >= 500;
      if (!retry) fns.current.onError?.(err);
      setState(retry ? 'pending' : 'error');
    } finally {
      inflight.current = false;
    }
    if (!fns.current.equal(latest.current, confirmed.current)) {
      setState('pending');
      timer.current = window.setTimeout(() => void flush(), retry ? 1500 : 0);
    } else setState('idle');
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (fns.current.equal(value, confirmed.current)) {
      if (!inflight.current) setState('idle');
      return;
    }
    const now = Date.now();
    pendingSince.current ??= now;
    setState(inflight.current ? 'saving' : 'pending');
    if (timer.current !== null) window.clearTimeout(timer.current);
    const wait = Math.max(0, Math.min(delay, maxWait - (now - pendingSince.current)));
    timer.current = window.setTimeout(() => void flush(), wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, enabled]);

  // Сервер прислал свежий голос (другое устройство, перезапрос) - принимаем, если сами ничего не ждём.
  useEffect(() => {
    if (!inflight.current && timer.current === null) confirmed.current = saved;
  }, [saved]);

  // Закрыли экран посреди нажатий - отправляем последнее, не дожидаясь паузы.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (!fns.current.equal(latest.current, confirmed.current)) void fns.current.send(latest.current).catch(() => undefined);
    },
    [],
  );

  return state;
}
