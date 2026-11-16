import { BRACELET_MEANING, DEFAULT_TIERS, braceletOf, textOn, tierShort, type Bracelet, type Tier, type TiersConfig } from '@sof/shared';
import type { CSSProperties } from 'react';
import { cx } from './kit.tsx';

/**
 * Вариант участия (взнос) - цветной бейдж. Цвет и подпись из настроек организаторов,
 * один и тот же везде: главная, QR-коды, сканер. С завтраком - «Обед и ужин + завтрак».
 */
export function TierBadge({
  tier,
  tiers,
  breakfast,
  className,
  size = 'md',
  bracelet = false,
}: {
  tier: Tier | null | undefined;
  tiers?: TiersConfig | null;
  breakfast?: boolean | null;
  className?: string;
  size?: 'sm' | 'md';
  /** Рядом - какой браслет (для команды: касса, сканер, поиск). */
  bracelet?: boolean;
}) {
  if (!tier) return null;
  // Вариант, которого больше нет (сохранённые на телефоне данные до обновления), - просто не показываем.
  const cfg = (tiers ?? DEFAULT_TIERS)[tier] as TiersConfig[Tier] | undefined;
  if (!cfg) return null;
  const badge = (
    <span
      className={cx(
        'inline-flex max-w-full items-center rounded-full font-semibold',
        size === 'sm' ? 'px-2 py-px text-[12px] leading-5' : 'px-2.5 py-0.5 text-[13px] leading-5',
        !bracelet && className,
      )}
      style={{ background: cfg.color, color: textOn(cfg.color) }}
    >
      <span className="truncate">{tierShort(cfg, breakfast)}</span>
    </span>
  );
  if (!bracelet) return badge;
  return (
    <span className={cx('inline-flex max-w-full flex-wrap items-center gap-1', className)}>
      {badge}
      <BraceletBadge bracelet={braceletOf(tiers, tier)} size={size} />
    </span>
  );
}

/** Браслет маленьким бейджем: чёрный - чёрный, белый - белый с рамкой. */
export function BraceletBadge({ bracelet, size = 'sm', className }: { bracelet: Bracelet | null; size?: 'sm' | 'md'; className?: string }) {
  if (!bracelet) return null;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border font-semibold',
        size === 'sm' ? 'px-2 py-px text-[12px] leading-5' : 'px-2.5 py-0.5 text-[13px] leading-5',
        bracelet === 'black' ? 'border-white/35 bg-black text-white' : 'border-black/30 bg-white text-black',
        className,
      )}
    >
      {bracelet === 'black' ? 'чёрный браслет' : 'белый браслет'}
    </span>
  );
}

/**
 * Браслет крупно - для сканера и экрана «Браслеты»: видно издалека, какой выдать или проверить.
 */
export function BraceletBig({ bracelet, className }: { bracelet: Bracelet; className?: string }) {
  return (
    <div
      className={cx(
        'flex items-center justify-center gap-3 rounded-2xl border-2 px-5 py-3',
        bracelet === 'black' ? 'border-white/40 bg-black text-white' : 'border-black/25 bg-white text-black',
        className,
      )}
    >
      <span className={cx('size-7 shrink-0 rounded-full border-[5px]', bracelet === 'black' ? 'border-white' : 'border-black')} aria-hidden />
      <span className="text-left leading-tight">
        <span className="block text-[24px] font-extrabold uppercase tracking-wide">{bracelet === 'black' ? 'Чёрный браслет' : 'Белый браслет'}</span>
        <span className="block text-[15px] font-semibold opacity-80">{BRACELET_MEANING[bracelet]}</span>
      </span>
    </div>
  );
}

/** Цвет варианта - для полосок и точек. */
export function tierColor(tier: Tier | null | undefined, tiers?: TiersConfig | null): string | null {
  return tier ? (((tiers ?? DEFAULT_TIERS)[tier] as TiersConfig[Tier] | undefined)?.color ?? null) : null;
}

/** Цветная полоса слева у карточки человека. */
export function tierStripe(tier: Tier | null | undefined, tiers?: TiersConfig | null): CSSProperties | undefined {
  const c = tierColor(tier, tiers);
  return c ? { boxShadow: `inset 5px 0 0 ${c}` } : undefined;
}
