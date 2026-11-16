import type { PaymentStatus } from '@sof/shared';
import { IconAlertCircleFilled, IconAlertTriangle, IconCheck, IconWifiOff } from '@tabler/icons-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError, errorMessage } from '../api/client.ts';
import { IconChip, type Hue, type TablerIcon } from './icons.tsx';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------- кнопки ----------

type Variant = 'primary' | 'secondary' | 'plain' | 'danger' | 'success' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-btn text-btn-fg',
  secondary: 'bg-fill text-accent',
  plain: 'bg-transparent text-accent',
  danger: 'bg-fill text-danger',
  success: 'bg-ok text-white',
  outline: 'border border-line bg-section text-fg',
};

const SIZES: Record<Size, string> = {
  sm: 'min-h-9 px-3 text-sm rounded-lg',
  md: 'min-h-12 px-4 text-base rounded-xl',
  lg: 'min-h-14 px-5 text-[17px] rounded-2xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 py-2 text-center font-semibold leading-tight transition active:scale-[0.98] active:opacity-80 disabled:opacity-50 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="size-5" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Загрузка"
      className={cx('inline-block shrink-0 animate-spin rounded-full border-[3px] border-current border-r-transparent opacity-80', className ?? 'size-6')}
    />
  );
}

// ---------- карточки и разделы ----------

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
        className={cx('block w-full cursor-pointer rounded-2xl bg-section p-4 text-left transition active:opacity-80', className)}
      >
        {children}
      </div>
    );
  }
  return <div className={cx('rounded-2xl bg-section p-4', className)}>{children}</div>;
}

export function Section({ title, children, className, aside }: { title?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={cx('mb-5', className)}>
      {(title || aside) && (
        <div className="mb-2 flex items-end justify-between gap-2 px-1">
          {title && <h2 className="text-[13px] font-semibold uppercase tracking-wide text-head">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = 'green' | 'yellow' | 'red' | 'blue' | 'gray';

const TONES: Record<Tone, string> = {
  green: 'bg-ok-soft text-ok-fg',
  yellow: 'bg-warn-soft text-warn-fg',
  red: 'bg-bad-soft text-bad-fg',
  blue: 'bg-info-soft text-info-fg',
  gray: 'bg-fill text-subtle',
};

export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[13px] font-semibold leading-5', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function paymentTone(status: PaymentStatus): Tone {
  if (status === 'paid' || status === 'exempt') return 'green';
  if (status === 'pending' || status === 'partial') return 'yellow';
  return 'red';
}

export function Notice({ tone = 'blue', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <div className={cx('rounded-2xl px-4 py-3 text-[15px] leading-snug', TONES[tone], className)}>{children}</div>;
}

// ---------- поля форм ----------

/**
 * Ошибка поля: тонкая обводка внутри (без «рамки с отступом»), лёгкая подложка.
 * Для полей, кнопок-переключателей и выпадающих списков - одна и та же.
 */
export const invalidRing =
  'shadow-[inset_0_0_0_1.5px_var(--color-danger)] focus:shadow-[inset_0_0_0_1.5px_var(--color-danger)] bg-bad-soft/60';

/** Текст ошибки под полем: иконка + коротко, плавно появляется. */
export function FieldError({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="mt-1.5 flex animate-error-in items-start gap-1.5 px-1 text-[13px] font-medium leading-snug text-danger">
      <IconAlertCircleFilled size={16} className="mt-px shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
  htmlFor,
  optional,
  anchor,
}: {
  label: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  optional?: boolean;
  /** id обёртки - чтобы прокрутить к полю из сводки ошибок. */
  anchor?: string;
}) {
  return (
    <div id={anchor} className="mb-4 scroll-mt-24">
      <label htmlFor={htmlFor} className="mb-1.5 block px-1 text-sm font-medium text-subtle">
        {label}
        {optional && <span className="font-normal text-hint"> - по желанию</span>}
      </label>
      {children}
      {error ? <FieldError>{error}</FieldError> : hint ? <p className="mt-1.5 px-1 text-[13px] leading-snug text-hint">{hint}</p> : null}
    </div>
  );
}

const inputBase =
  'w-full rounded-xl bg-fill px-3 text-fg outline-none transition-[box-shadow,background-color] placeholder:text-hint focus:shadow-[inset_0_0_0_1.5px_var(--color-btn)] disabled:opacity-60';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function TextInput({ className, invalid, ...rest }, ref) {
    return <input ref={ref} aria-invalid={invalid || undefined} className={cx(inputBase, 'h-12', invalid && invalidRing, className)} {...rest} />;
  },
);

export function TextArea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea aria-invalid={invalid || undefined} className={cx(inputBase, 'min-h-24 py-3', invalid && invalidRing, className)} {...rest} />;
}

export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <div className="relative">
      <select aria-invalid={invalid || undefined} className={cx(inputBase, 'h-12 appearance-none pr-9', invalid && invalidRing, className)} {...rest}>
        {children}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-hint">▾</span>
    </div>
  );
}

/** Галочка: своя (системная выглядит по-разному везде), крупная зона нажатия. */
export function Checkbox({
  checked,
  onChange,
  children,
  invalid,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-xl py-2', disabled && 'opacity-60')}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cx(
          'mt-px flex size-6 shrink-0 items-center justify-center rounded-[7px] transition-[background-color,box-shadow] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-btn',
          checked
            ? 'bg-btn text-btn-fg'
            : invalid
              ? 'bg-bad-soft shadow-[inset_0_0_0_2px_var(--color-danger)]'
              : 'bg-fill shadow-[inset_0_0_0_2px_var(--color-hint)]',
        )}
      >
        {checked && <IconCheck size={17} stroke={3} />}
      </span>
      <span className="text-[15px] leading-snug">{children}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex gap-1 rounded-xl bg-fill p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'min-h-10 flex-1 rounded-lg px-2 text-[15px] font-semibold transition',
            o.value === value ? 'bg-section text-fg shadow-sm' : 'text-subtle',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Тумблер: подпись слева, переключатель справа. */
export function Switch({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={cx('flex cursor-pointer items-center justify-between gap-3', disabled && 'opacity-60')}>
      <span className="min-w-0 flex-1">{children}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden
        className={cx(
          'relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-btn',
          checked ? 'bg-ok' : 'bg-fill shadow-[inset_0_0_0_1.5px_var(--color-hint)]',
        )}
      >
        <span className={cx('absolute top-[2px] size-[27px] rounded-full bg-white shadow transition-[left]', checked ? 'left-[22px]' : 'left-[2px]')} />
      </span>
    </label>
  );
}

export function Chip({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'min-h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[15px] font-semibold transition',
        active ? 'bg-btn text-btn-fg' : 'bg-section text-fg',
      )}
    >
      {children}
    </button>
  );
}

// ---------- состояния ----------

export function FullScreenLoader({ label }: { label?: string }) {
  return (
    <div className="flex min-h-app flex-col items-center justify-center gap-3 text-hint">
      <Spinner className="size-9 text-btn" />
      {label && <p className="text-sm">{label}</p>}
    </div>
  );
}

export function EmptyState({
  icon,
  hue = 'blue',
  title,
  children,
}: {
  icon?: TablerIcon;
  hue?: Hue;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon && <IconChip icon={icon} hue={hue} size="xl" className="mb-4" />}
      <p className="text-lg font-semibold">{title}</p>
      {children && <div className="mt-2 text-[15px] text-subtle">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const offline = error instanceof ApiError && error.isNetwork;
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <IconChip icon={offline ? IconWifiOff : IconAlertTriangle} hue={offline ? 'gray' : 'orange'} size="xl" className="mb-4" />
      <p className="text-lg font-semibold">{title ?? (offline ? 'Нет связи' : 'Не получилось загрузить')}</p>
      <p className="mt-2 text-[15px] text-subtle">{errorMessage(error)}</p>
      {onRetry && (
        <Button className="mt-5" variant="secondary" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

export function Divider() {
  return <div className="my-3 h-px bg-line" />;
}
