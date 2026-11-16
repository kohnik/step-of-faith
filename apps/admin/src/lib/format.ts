import { formatTicketCode } from '@sof/shared';

const formatters = new Map<string, Intl.DateTimeFormat>();

function dtf(key: string, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${key}|${tz}`;
  let f = formatters.get(cacheKey);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, ...options });
    formatters.set(cacheKey, f);
  }
  return f;
}

function toDate(iso: string | Date | null | undefined): Date | null {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `02.10.2026 14:05` по часам события. */
export function formatDateTime(iso: string | Date | null | undefined, tz: string, empty = '-'): string {
  const d = toDate(iso);
  if (!d) return empty;
  return dtf('dt', tz, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(d)
    .replace(',', '');
}

/** `2 окт, 14:05` - компактно для таблиц. */
export function formatDateTimeShort(iso: string | Date | null | undefined, tz: string, empty = '-'): string {
  const d = toDate(iso);
  if (!d) return empty;
  return dtf('dts', tz, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d).replace('.,', ',');
}

/** `14:05`. */
export function formatTime(iso: string | Date | null | undefined, tz: string, empty = '-'): string {
  const d = toDate(iso);
  if (!d) return empty;
  return dtf('t', tz, { hour: '2-digit', minute: '2-digit' }).format(d);
}

/** `14:05:09`. */
export function formatTimeSeconds(iso: string | Date | null | undefined, tz: string, empty = '-'): string {
  const d = toDate(iso);
  if (!d) return empty;
  return dtf('ts', tz, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
}

/** `02.10.2026` из `YYYY-MM-DD` (дата без времени, например день рождения). */
export function formatDate(ymd: string | null | undefined, empty = '-'): string {
  if (!ymd) return empty;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** `пятница, 2 октября` из `YYYY-MM-DD`. */
export function formatDayLong(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return dtf('dayLong', 'UTC', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

/** Первая буква заглавная: «пятница, 2 октября» → «Пятница, 2 октября». */
export function capitalizeFirst(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** `2 окт` из `YYYY-MM-DD`. */
export function formatDayShort(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return dtf('dayShort', 'UTC', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });

/** «5 минут назад», «через 2 часа». */
export function formatRelative(iso: string | Date | null | undefined, now: number = Date.now(), empty = '-'): string {
  const d = toDate(iso);
  if (!d) return empty;
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'только что';
  if (abs < 45 * 60) return relative.format(Math.round(diffSec / 60), 'minute');
  if (abs < 22 * 3600) return relative.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 26 * 86400) return relative.format(Math.round(diffSec / 86400), 'day');
  if (abs < 320 * 86400) return relative.format(Math.round(diffSec / (30 * 86400)), 'month');
  return relative.format(Math.round(diffSec / (365 * 86400)), 'year');
}

const money = { format: (n: number) => `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n)} руб.` };
const integer = new Intl.NumberFormat('ru-RU');

/** `1 234,5 руб.` (белорусские рубли). */
export function formatMoney(value: string | number | null | undefined, empty = '-'): string {
  if (value === null || value === undefined || value === '') return empty;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? money.format(n) : String(value);
}

export function formatNumber(value: number | null | undefined, empty = '-'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return empty;
  return integer.format(value);
}

export function formatPercent(part: number, total: number): string {
  if (!total) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

const pluralRules = new Intl.PluralRules('ru-RU');

/** `plural(5, ['участник', 'участника', 'участников'])` → `участников`. */
export function plural(n: number, forms: readonly [one: string, few: string, many: string]): string {
  const rule = pluralRules.select(n);
  if (rule === 'one') return forms[0];
  if (rule === 'few') return forms[1];
  return forms[2];
}

/** `5 участников`. */
export function countLabel(n: number, forms: readonly [string, string, string]): string {
  return `${formatNumber(n)} ${plural(n, forms)}`;
}

export function formatTicket(code: string | null | undefined, empty = '-'): string {
  if (!code) return empty;
  return formatTicketCode(code);
}

export function telegramUrl(username: string | null | undefined): string | null {
  return username ? `https://t.me/${encodeURIComponent(username)}` : null;
}

/** Деньги из поля ввода → строка API `1234.50` (или null для пустого). */
export function normalizeMoneyInput(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/\s/g, '').replace(',', '.');
  return s === '' ? null : s;
}

export function initials(name: string): string {
  const words = name.replace(/^@/, '').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  const letters = words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
