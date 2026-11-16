import { IconAlertCircle, IconCircleCheck, IconInfoCircle, IconWifiOff } from '@tabler/icons-react';
import { useSyncExternalStore } from 'react';
import { useOffline } from '../api/client.ts';
import { cx } from './kit.tsx';

type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function show(kind: ToastKind, text: string, ms = 3500): void {
  const id = ++seq;
  // Не больше одного уведомления: новое заменяет предыдущее, чтобы не закрывать экран стопкой.
  items = [{ id, kind, text }];
  emit();
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, ms);
}

export const toast = {
  success: (text: string, ms?: number) => show('success', text, ms),
  error: (text: string, ms?: number) => show('error', text, ms ?? 5000),
  info: (text: string, ms?: number) => show('info', text, ms),
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getItems = () => items;

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getItems, getItems);
  if (list.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col items-center gap-2 px-3 pt-[calc(var(--safe-top)+10px)]">
      {list.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={cx(
            'pointer-events-auto flex w-full max-w-md animate-pop-in items-start gap-2.5 rounded-2xl px-4 py-3 text-[15px] font-medium leading-snug shadow-lg',
            t.kind === 'success' && 'bg-ok text-white',
            t.kind === 'error' && 'bg-bad text-white',
            t.kind === 'info' && 'bg-[#352937] text-[#fff8ec] ring-1 ring-white/10',
          )}
          onClick={() => {
            items = items.filter((x) => x.id !== t.id);
            emit();
          }}
        >
          <ToastIcon kind={t.kind} />
          <span className="min-w-0 flex-1">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

const TOAST_ICONS = { success: IconCircleCheck, error: IconAlertCircle, info: IconInfoCircle } as const;

function ToastIcon({ kind }: { kind: ToastKind }) {
  const Icon = TOAST_ICONS[kind];
  return <Icon size={20} className="mt-px opacity-90" />;
}

/** Небольшая плашка «нет связи» сверху: не перекрывает интерфейс, но заметна. */
export function OfflineBanner() {
  const offline = useOffline();
  if (!offline) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[65] flex justify-center pt-[calc(var(--safe-top)+4px)]">
      <div className="flex items-center gap-1.5 rounded-full bg-warn px-3 py-1 text-[13px] font-semibold text-black shadow">
        <IconWifiOff size={15} />
        Нет связи - показываем сохранённое
      </div>
    </div>
  );
}
