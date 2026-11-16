/**
 * Рисунки для большого экрана игры: церковь в цвете команды, флаг страны и фирменный знак «Шаг веры».
 * Всё векторное, без эмодзи: на ноутбуке с Windows флаги-эмодзи показываются буквами («KE»).
 */
import 'flag-icons/css/flag-icons.min.css';
import type { CSSProperties } from 'react';

export const CREAM = '#ede8d0';
export const PLUM = '#241b26';

/** Светлее (k > 0) или темнее (k < 0) цвет в формате #rrggbb. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  const [r, g, b] = [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Яркость цвета (0…1, по WCAG): на светлых пузырях пишем тёмным. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

type Tone = 'color' | 'light' | 'dark';

/**
 * Церковь: зал с двускатной крышей, башня со шпилем и крестом, окно-роза, арочная дверь.
 * `tone`: `color` - стены в цвете команды; `light` - кремовая церковь (для тёмного пузыря); `dark` - сливовая с тёплыми окнами (для светлого).
 */
export function ChurchArt({
  color,
  size,
  glow = false,
  tone = 'color',
  flat = false,
  style,
}: {
  color: string;
  size: number;
  glow?: boolean;
  tone?: Tone;
  flat?: boolean;
  style?: CSSProperties;
}) {
  const wall = tone === 'light' ? '#fff8ec' : tone === 'dark' ? '#3b2d3e' : color;
  const tower = tone === 'light' ? '#f1e7cf' : tone === 'dark' ? '#2f2432' : shade(color, 0.18);
  const roof = tone === 'light' ? shade(color, -0.5) : tone === 'dark' ? PLUM : shade(color, -0.35);
  const glass = tone === 'light' ? shade(color, -0.2) : tone === 'dark' ? '#ffd98a' : CREAM;
  const id = `ch${tone}${color.slice(1)}`;
  return (
    <svg
      width={size}
      height={size * (148 / 120)}
      viewBox="0 -6 120 148"
      aria-hidden
      style={{
        display: 'block',
        overflow: 'visible',
        filter: flat ? undefined : glow ? `drop-shadow(0 0 ${size / 6}px ${color})` : `drop-shadow(0 ${size / 20}px ${size / 12}px rgba(0,0,0,.35))`,
        ...style,
      }}
    >
      <defs>
        <linearGradient id={`${id}w`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(wall, 0.08)} />
          <stop offset="1" stopColor={shade(wall, tone === 'color' ? -0.12 : -0.06)} />
        </linearGradient>
      </defs>
      <ellipse cx="60" cy="137" rx="54" ry="5" fill="#000" opacity=".28" />
      {/* зал */}
      <path d="M6 74 L60 42 L114 74 Z" fill={roof} />
      <rect x="14" y="72" width="92" height="64" rx="2" fill={`url(#${id}w)`} />
      <path d="M22 108 v-12 a7 7 0 0 1 14 0 v12 Z M84 108 v-12 a7 7 0 0 1 14 0 v12 Z" fill={glass} opacity=".92" />
      <path d="M22 118 h14 M84 118 h14" stroke={glass} strokeWidth="2" opacity=".5" />
      {/* башня */}
      <rect x="43" y="44" width="34" height="92" rx="2" fill={tower} />
      <path d="M38 47 L60 6 L82 47 Z" fill={roof} />
      <path d="M58.5 -6 h3 v16 h-3 Z M53 -1 h14 v3 h-14 Z" fill={tone === 'dark' ? PLUM : tone === 'light' ? '#fff8ec' : CREAM} />
      <circle cx="60" cy="64" r="9" fill={glass} />
      <circle cx="60" cy="64" r="4" fill={roof} />
      <path d="M60 55 v18 M51 64 h18" stroke={roof} strokeWidth="1.5" opacity=".6" />
      <path d="M51 136 v-20 a9 9 0 0 1 18 0 v20 Z" fill={tone === 'dark' ? '#ffd98a' : PLUM} opacity={tone === 'dark' ? 0.85 : 1} />
      <path d="M60 107 v29" stroke={tower} strokeWidth="1.5" opacity=".5" />
    </svg>
  );
}

/** Флаг страны картинкой (`flag-icons`): одинаково на любом компьютере. */
export function Flag({ code, height, style }: { code: string | null | undefined; height: number | string; style?: CSSProperties }) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  const h = typeof height === 'number' ? `${height}px` : height;
  return (
    <span
      className={`fi fi-${code.toLowerCase()}`}
      style={{
        fontSize: h,
        width: `calc(${h} * 4 / 3)`,
        height: h,
        lineHeight: 1,
        borderRadius: `calc(${h} / 7)`,
        boxShadow: '0 0 0 1px rgba(255,255,255,.18), 0 1px 3px rgba(0,0,0,.3)',
        flexShrink: 0,
        backgroundSize: 'cover',
        ...style,
      }}
    />
  );
}

/** Фирменный знак «Шаг веры»: ступени и солнце - как иконка мини-апки. */
export function BrandMark({ size }: { size: number | string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-label="Шаг веры 2026">
      <rect width="512" height="512" rx="128" fill="#d0352c" />
      <path fill={CREAM} d="M136 360h80v-60h80v-60h80v120H136z" />
      <circle cx="356" cy="160" r="30" fill={CREAM} />
    </svg>
  );
}
