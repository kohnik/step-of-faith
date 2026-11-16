/**
 * Рисунки игры - те же, что на большом экране (админка, pages/game/ChurchArt.tsx): церковь в цвете команды и флаг.
 * Без эмодзи: в Telegram на Windows флаги-эмодзи показываются буквами («KE»).
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

/** Церковь: зал с двускатной крышей, башня со шпилем и крестом, окно-роза, арочная дверь. */
export function ChurchArt({ color, size, glow = false, flat = false, style }: { color: string; size: number; glow?: boolean; flat?: boolean; style?: CSSProperties }) {
  const wall = color;
  const tower = shade(color, 0.18);
  const roof = shade(color, -0.35);
  const id = `ch${color.slice(1)}`;
  return (
    <svg
      width={size}
      height={size * (148 / 120)}
      viewBox="0 -6 120 148"
      aria-hidden
      style={{ display: 'block', overflow: 'visible', filter: flat ? undefined : glow ? `drop-shadow(0 0 ${size / 6}px ${color})` : `drop-shadow(0 ${size / 20}px ${size / 12}px rgba(0,0,0,.35))`, ...style }}
    >
      <defs>
        <linearGradient id={`${id}w`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={shade(wall, 0.08)} />
          <stop offset="1" stopColor={shade(wall, -0.12)} />
        </linearGradient>
      </defs>
      <ellipse cx="60" cy="137" rx="54" ry="5" fill="#000" opacity=".28" />
      {/* зал */}
      <path d="M6 74 L60 42 L114 74 Z" fill={roof} />
      <rect x="14" y="72" width="92" height="64" rx="2" fill={`url(#${id}w)`} />
      <path d="M22 108 v-12 a7 7 0 0 1 14 0 v12 Z M84 108 v-12 a7 7 0 0 1 14 0 v12 Z" fill={CREAM} opacity=".92" />
      <path d="M22 118 h14 M84 118 h14" stroke={CREAM} strokeWidth="2" opacity=".5" />
      {/* башня */}
      <rect x="43" y="44" width="34" height="92" rx="2" fill={tower} />
      <path d="M38 47 L60 6 L82 47 Z" fill={roof} />
      <path d="M58.5 -6 h3 v16 h-3 Z M53 -1 h14 v3 h-14 Z" fill={CREAM} />
      <circle cx="60" cy="64" r="9" fill={CREAM} />
      <circle cx="60" cy="64" r="4" fill={roof} />
      <path d="M60 55 v18 M51 64 h18" stroke={roof} strokeWidth="1.5" opacity=".6" />
      <path d="M51 136 v-20 a9 9 0 0 1 18 0 v20 Z" fill={PLUM} />
      <path d="M60 107 v29" stroke={tower} strokeWidth="1.5" opacity=".5" />
    </svg>
  );
}

/** Флаг страны картинкой (`flag-icons`): одинаково на любом компьютере. */
export function Flag({ code, height, style }: { code: string | null | undefined; height: number; style?: CSSProperties }) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  return (
    <span
      className={`fi fi-${code.toLowerCase()}`}
      style={{ fontSize: height, width: height * (4 / 3), lineHeight: 1, borderRadius: Math.max(2, height / 7), boxShadow: '0 0 0 1px rgba(255,255,255,.15)', flexShrink: 0, ...style }}
    />
  );
}
