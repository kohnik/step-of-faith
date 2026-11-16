/**
 * Время события. Сервер отдаёт ISO в UTC; показываем и вводим - по часовому поясу
 * события (`settings.eventTimezone`), а не по поясу браузера админа.
 * Поля ввода Mantine работают со строками `YYYY-MM-DD HH:mm:ss` («настенное» время).
 */

/** Запасной пояс, если настройки ещё не пришли (совпадает с DEFAULT_SETTINGS.eventTimezone). */
export const DEFAULT_TIMEZONE = 'Europe/Minsk';

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

const validity = new Map<string, boolean>();

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  const cached = validity.get(tz);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    ok = false;
  }
  validity.set(tz, ok);
  return ok;
}

export function safeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** Все часовые пояса IANA, которые знает браузер. */
export function timeZoneList(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [DEFAULT_TIMEZONE, 'Europe/Moscow', 'Europe/Kaliningrad', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'UTC'];
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Календарные части момента времени в часовом поясе `tz`. */
export function wallParts(date: Date, tz: string): WallParts {
  const parts = partsFormatter(tz).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Смещение пояса `tz` от UTC в минутах в момент `date` (Москва: +180). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = wallParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

function parseIso(iso: string | Date | null | undefined): Date | null {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO → `YYYY-MM-DD HH:mm:ss` по часам события (значение для DateTimePicker). */
export function isoToWall(iso: string | null | undefined, tz: string): string | null {
  const d = parseIso(iso);
  if (!d) return null;
  const p = wallParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * `YYYY-MM-DD HH:mm[:ss]` по часам события → ISO со смещением пояса,
 * например `2026-10-02T10:00:00+03:00`. Учитывает переход на летнее время.
 */
export function wallToIso(wall: string | null | undefined, tz: string): string | null {
  if (!wall) return null;
  const m = WALL_RE.exec(wall.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const s = Number(m[6] ?? 0);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = tzOffsetMinutes(new Date(asUtc), tz);
  const second = tzOffsetMinutes(new Date(asUtc - offset * 60_000), tz);
  if (second !== offset) offset = second;
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Сдвиг «настенного» времени на N минут (без учёта поясов - просто арифметика календаря). */
export function addMinutesToWall(wall: string, minutes: number): string | null {
  const m = WALL_RE.exec(wall.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  const d = new Date(t + minutes * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Два ISO - один и тот же момент (форматы `Z` и `+03:00` считаем равными). */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return new Date(a).getTime() === new Date(b).getTime();
}

/** День события `YYYY-MM-DD`, к которому относится момент. */
export function dayKey(iso: string | Date, tz: string): string {
  const d = parseIso(iso);
  if (!d) return '';
  const p = wallParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Минуты от полуночи по часам события. */
export function minutesOfDay(iso: string | Date, tz: string): number {
  const d = parseIso(iso);
  if (!d) return 0;
  const p = wallParts(d, tz);
  return p.hour * 60 + p.minute;
}

/** Сегодня по часам события. */
export function todayKey(tz: string): string {
  return dayKey(new Date(), tz);
}

/** Локальная (браузерная) дата → `YYYY-MM-DD` - для фильтров AG Grid. */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Короткое имя пояса: «UTC+3». */
export function offsetLabel(tz: string, at: Date = new Date()): string {
  const offset = tzOffsetMinutes(at, tz);
  const sign = offset >= 0 ? '+' : '−';
  const abs = Math.abs(offset);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${pad(m)}` : ''}`;
}
