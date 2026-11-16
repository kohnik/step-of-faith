import { useEffect, type ReactNode } from 'react';
import { IconChevronLeft } from '@tabler/icons-react';
import { useLocation } from 'wouter';
import { useBackHandler } from '../telegram/back.ts';
import { isTelegram } from '../telegram/sdk.ts';
import { cx } from './kit.tsx';

export interface PageProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Куда ведёт «Назад»: путь (относительно текущего роутера) или обработчик. null - корневой экран. */
  back?: string | (() => void) | null;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Запас снизу, если на странице закреплённая кнопка. */
  bottomInset?: boolean;
}

export function Page({ title, subtitle, back = null, headerRight, children, className, bottomInset }: PageProps) {
  const [, navigate] = useLocation();
  const handler = back === null ? null : typeof back === 'string' ? () => navigate(back) : back;
  useBackHandler(handler);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const showInlineBack = !isTelegram() && handler;
  return (
    <div
      className={cx(
        'mx-auto w-full max-w-xl px-4 pt-[calc(var(--safe-top)+14px)]',
        bottomInset ? 'pb-[calc(var(--safe-bottom)+96px)]' : 'pb-[calc(var(--safe-bottom)+28px)]',
        className,
      )}
    >
      {(title || showInlineBack || headerRight) && (
        <header className="mb-4 flex items-start gap-2">
          {showInlineBack && (
            <button
              type="button"
              onClick={handler}
              className="-ml-2 flex h-10 shrink-0 items-center gap-0.5 pl-1 pr-2 text-[17px] font-medium text-accent"
            >
              <IconChevronLeft size={22} />
              Назад
            </button>
          )}
          <div className="min-w-0 flex-1">
            {title && <h1 className="font-display text-[23px] font-semibold leading-tight">{title}</h1>}
            {subtitle && <div className="mt-1 text-[15px] text-subtle">{subtitle}</div>}
          </div>
          {headerRight}
        </header>
      )}
      {children}
    </div>
  );
}

/** Закреплённая снизу кнопка страницы (когда нет нативной MainButton Telegram). */
export function StickyFooter({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-page px-4 pb-[calc(var(--safe-bottom)+12px)] pt-3">
      <div className="mx-auto w-full max-w-xl">{children}</div>
    </div>
  );
}
