/**
 * Нижняя кнопка Telegram (MainButton): текст, прогресс, блокировка.
 * Возвращает `true`, если используется нативная кнопка; иначе компонент рисует свою кнопку на странице.
 */
import { mainButton } from '@tma.js/sdk-react';
import { useEffect, useRef } from 'react';
import { isTelegram } from './sdk.ts';

export interface MainButtonOptions {
  text: string;
  visible?: boolean;
  enabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

function nativeAvailable(): boolean {
  if (!isTelegram()) return false;
  try {
    return mainButton.setParams.isAvailable();
  } catch {
    return false;
  }
}

export function useMainButton({ text, visible = true, enabled = true, loading = false, onClick }: MainButtonOptions): boolean {
  const native = nativeAvailable();
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const busyRef = useRef(false);
  busyRef.current = loading || !enabled;

  useEffect(() => {
    if (!native) return;
    let off: VoidFunction | undefined;
    try {
      off = mainButton.onClick(() => {
        if (!busyRef.current) clickRef.current();
      });
    } catch {
      /* ignore */
    }
    return () => {
      off?.();
      try {
        mainButton.setParams({ isVisible: false, isLoaderVisible: false, isEnabled: true });
      } catch {
        /* ignore */
      }
    };
  }, [native]);

  useEffect(() => {
    if (!native) return;
    try {
      mainButton.setParams({
        text,
        // Фирменный красный, а не цвет кнопок из темы Telegram.
        bgColor: '#d0352c',
        textColor: '#fff8ec',
        isVisible: visible,
        isEnabled: enabled && !loading,
        isLoaderVisible: loading,
      });
    } catch {
      /* ignore */
    }
  }, [native, text, visible, enabled, loading]);

  return native;
}
