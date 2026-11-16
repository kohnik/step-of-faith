/**
 * Иконки: набор Tabler (`@tabler/icons-react`, импорт по одной - лишнее вырезается при сборке).
 * Толщина линий задана глобально в styles.css (`.tabler-icon`), размер - пропом `size`.
 * IconChip - иконка на мягкой цветной подложке (плитки меню, пустые состояния).
 */
import type { TablerIcon } from '@tabler/icons-react';
import type { CSSProperties } from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export type { TablerIcon };

export type Hue = 'blue' | 'violet' | 'green' | 'orange' | 'pink' | 'teal' | 'gray';

const CHIP_SIZES = {
  sm: { box: 'size-8 rounded-[10px]', icon: 18 },
  md: { box: 'size-11 rounded-[14px]', icon: 24 },
  lg: { box: 'size-14 rounded-[18px]', icon: 30 },
  xl: { box: 'size-20 rounded-[26px]', icon: 42 },
} as const;

export function IconChip({
  icon: Icon,
  hue = 'blue',
  size = 'md',
  onAccent = false,
  className,
}: {
  icon: TablerIcon;
  hue?: Hue;
  size?: keyof typeof CHIP_SIZES;
  /** Подложка на цветной (акцентной) кнопке: полупрозрачно-белая. */
  onAccent?: boolean;
  className?: string;
}) {
  const s = CHIP_SIZES[size];
  const style: CSSProperties | undefined = onAccent
    ? undefined
    : { background: `var(--hue-${hue}-bg)`, color: `var(--hue-${hue}-fg)` };
  return (
    <span
      aria-hidden
      className={cx('inline-flex shrink-0 items-center justify-center', s.box, onAccent && 'bg-white/20 text-current', className)}
      style={style}
    >
      <Icon size={s.icon} />
    </span>
  );
}
