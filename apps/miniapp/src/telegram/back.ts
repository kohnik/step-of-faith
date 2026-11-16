/**
 * Кнопка «Назад». Внутри Telegram - нативная BackButton, вне Telegram - стрелка в шапке страницы.
 * Обработчики складываются в стек: открытая шторка перехватывает «Назад» раньше страницы
 * (приоритет выше), поэтому первое нажатие закрывает шторку, а не уводит со страницы.
 */
import { backButton } from '@tma.js/sdk-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isTelegram } from './sdk.ts';

interface Entry {
  id: number;
  priority: number;
  handler: () => void;
}

let entries: Entry[] = [];
let seq = 0;
let wired = false;
const listeners = new Set<() => void>();

function top(): Entry | undefined {
  let best: Entry | undefined;
  for (const e of entries) {
    if (!best || e.priority > best.priority || (e.priority === best.priority && e.id > best.id)) best = e;
  }
  return best;
}

function sync(): void {
  if (isTelegram()) {
    try {
      if (entries.length) backButton.show.ifAvailable();
      else backButton.hide.ifAvailable();
    } catch {
      /* ignore */
    }
  }
  for (const l of listeners) l();
}

function wire(): void {
  if (wired || !isTelegram()) return;
  wired = true;
  try {
    backButton.onClick.ifAvailable(() => {
      triggerBack();
    });
  } catch {
    /* ignore */
  }
}

export function triggerBack(): boolean {
  const t = top();
  if (!t) return false;
  t.handler();
  return true;
}

export function pushBackHandler(handler: () => void, priority = 0): () => void {
  wire();
  const entry: Entry = { id: ++seq, priority, handler };
  entries = [...entries, entry];
  sync();
  return () => {
    entries = entries.filter((e) => e !== entry);
    sync();
  };
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const hasBack = () => entries.length > 0;

/** Есть ли сейчас куда вернуться (для стрелки в шапке вне Telegram). */
export function useHasBack(): boolean {
  return useSyncExternalStore(subscribe, hasBack, hasBack);
}

/** Регистрирует обработчик «Назад», пока компонент смонтирован и handler не null. */
export function useBackHandler(handler: (() => void) | null | undefined, priority = 0): void {
  const ref = useRef(handler);
  ref.current = handler;
  const enabled = Boolean(handler);
  useEffect(() => {
    if (!enabled) return;
    return pushBackHandler(() => ref.current?.(), priority);
  }, [enabled, priority]);
}
