import { useSyncExternalStore } from 'react';

/** Вещь в заявке на бронь: размер уже выбран, остатки заявка не трогает - бронирует команда мерча. */
export interface RequestItem {
  variantId: number;
  qty: number;
  /** «Худи «Шаг веры» - белый, M». */
  title: string;
  price: string;
  thumbUrl: string | null;
}

const KEY = 'sof:merch-request';
let items: RequestItem[] = read();
const listeners = new Set<() => void>();

/** Заявка переживает переход «Ещё вещь» → витрина → обратно и перезагрузку экрана. */
function read(): RequestItem[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RequestItem[]) : [];
  } catch {
    return [];
  }
}

function write(next: RequestItem[]) {
  items = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Хранилище недоступно - заявка живёт, пока открыт экран.
  }
  for (const l of listeners) l();
}

/** Та же вещь того же размера - прибавляем количество (не больше 10). */
export function addToRequest(item: RequestItem) {
  const same = items.find((x) => x.variantId === item.variantId);
  write(same ? items.map((x) => (x === same ? { ...x, qty: Math.min(10, x.qty + item.qty) } : x)) : [...items, item]);
}

export const removeFromRequest = (variantId: number) => write(items.filter((x) => x.variantId !== variantId));
export const clearRequest = () => write([]);

export function useRequest(): RequestItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
}
