import { useEffect, type ReactNode } from 'react';
import { IconX } from '@tabler/icons-react';
import { createPortal } from 'react-dom';
import { useBackHandler } from '../telegram/back.ts';

/** Нижняя шторка. «Назад» в Telegram сначала закрывает её, а не уходит со страницы. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}) {
  useBackHandler(open ? onClose : null, 10);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 animate-fade-in bg-[rgba(0,0,0,0.45)]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative mx-auto max-h-[90vh] w-full max-w-xl animate-sheet-in overflow-y-auto overscroll-contain rounded-t-3xl bg-section px-4 pb-[calc(var(--safe-bottom)+20px)] pt-2"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-fill" />
        {title !== undefined && (
          <div className="mb-3 flex items-start gap-3">
            <h2 className="min-w-0 flex-1 text-xl font-bold leading-tight">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-fill text-subtle"
            >
              <IconX size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
