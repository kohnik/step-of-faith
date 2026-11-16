import { IconChevronRight } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { TablerIcon } from './icons.tsx';
import { cx } from './kit.tsx';

/** Сгруппированный список, как в настройках Telegram: строки на одной подложке, разделители с отступом. */
export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('overflow-hidden rounded-2xl bg-section', className)}>{children}</div>;
}

export function ListRow({
  icon: Icon,
  title,
  subtitle,
  value,
  valueClassName,
  onClick,
}: {
  icon?: TablerIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Короткое значение справа (например, «35 руб.»). */
  value?: ReactNode;
  valueClassName?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-13 w-full items-center gap-3.5 pl-4 text-left active:bg-fill"
    >
      {Icon && <Icon size={22} className="shrink-0 text-accent" aria-hidden />}
      <span className="flex min-h-13 min-w-0 flex-1 items-center gap-2 border-b border-line py-3 pr-3 group-last:border-b-0">
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] leading-snug">{title}</span>
          {subtitle && <span className="mt-0.5 block text-[13px] leading-snug text-subtle">{subtitle}</span>}
        </span>
        {value !== undefined && <span className={cx('shrink-0 text-[15px]', valueClassName ?? 'text-subtle')}>{value}</span>}
        <IconChevronRight size={18} className="shrink-0 text-hint" aria-hidden />
      </span>
    </button>
  );
}
