/**
 * Даты и часовые пояса. Всё, что показываем про кемп, - во времени события (`me.event.timezone`),
 * а не в поясе телефона: волонтёр из другого города должен видеть те же 10:00, что и в программе.
 */
const LOCALE = 'ru-RU';
const formatters = new Map<string, Intl.DateTimeFormat>();
const validZones = new Map<string, boolean>();

function dtf(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    formatters.set(key, f);
  }
  return f;
}

/** Проверенный идентификатор пояса или undefined (тогда - пояс устройства). */
export function safeZone(tz: string | null | undefined): string | undefined {
  if (!tz) return undefined;
  let ok = validZones.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    validZones.set(tz, ok);
  }
  return ok ? tz : undefined;
}

const toDate = (v: string | Date | number) => (v instanceof Date ? v : new Date(v));

export function formatTime(value: string | Date, tz?: string | null): string {
  return dtf(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: safeZone(tz) }).format(toDate(value));
}

export function formatDate(
  value: string | Date,
  tz?: string | null,
  opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' },
): string {
  return dtf(LOCALE, { ...opts, timeZone: safeZone(tz) }).format(toDate(value));
}

/** «3 октября, 14:05» */
export function formatDateTime(value: string | Date, tz?: string | null): string {
  return dtf(LOCALE, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: safeZone(tz),
  }).format(toDate(value));
}

/** Сегодня ли это - по календарю пояса события. */
export function isToday(value: string | Date, tz?: string | null): boolean {
  return dayKey(value, tz) === dayKey(new Date(), tz);
}

/** Время, а если не сегодня - с датой: «14:05» / «7 нояб., 14:05». */
export function formatWhen(value: string | Date, tz?: string | null): string {
  if (isToday(value, tz)) return formatTime(value, tz);
  return `${formatDate(value, tz, { day: 'numeric', month: 'short' })}, ${formatTime(value, tz)}`;
}

/** Конференция уже началась (по дате начала из настроек; без даты - нет). */
export function eventStarted(startsAt: string | null | undefined, now = Date.now()): boolean {
  return Boolean(startsAt) && new Date(startsAt!).getTime() <= now;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(value: string | Date, tz?: string | null): ZonedParts {
  const parts = dtf('en-US', {
    timeZone: safeZone(tz),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(toDate(value));
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

const pad = (n: number, len = 2) => String(Math.abs(n)).padStart(len, '0');

/** Календарный день события в его поясе: `YYYY-MM-DD`. */
export function dayKey(value: string | Date, tz?: string | null): string {
  const p = zonedParts(value, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Подпись дня по ключу `YYYY-MM-DD`: «пт, 3 окт.» */
export function formatDayKey(
  key: string,
  opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' },
): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return dtf(LOCALE, { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Смещение пояса относительно UTC в минутах в указанный момент (Москва → +180). */
export function tzOffsetMinutes(tz: string | null | undefined, at: Date): number {
  const zone = safeZone(tz);
  if (!zone) return -at.getTimezoneOffset();
  const p = zonedParts(at, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const exact = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((asUtc - exact) / 60_000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/**
 * Значение `<input type="datetime-local">` («2026-10-03T10:00»), понятое как время в поясе события,
 * → ISO-строка со смещением этого пояса («2026-10-03T10:00:00+03:00»). null - если строка неверна.
 */
export function zonedLocalToIso(local: string, tz: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Смещение зависит от момента (переход на летнее время) - уточняем за два шага.
  let offset = tzOffsetMinutes(tz, new Date(wallAsUtc));
  let instant = wallAsUtc - offset * 60_000;
  const second = tzOffsetMinutes(tz, new Date(instant));
  if (second !== offset) {
    offset = second;
    instant = wallAsUtc - offset * 60_000;
  }
  if (!Number.isFinite(instant)) return null;
  const wall = new Date(instant + offset * 60_000).toISOString().slice(0, 19);
  return `${wall}${formatOffset(offset)}`;
}

/** ISO-момент → значение для `<input type="datetime-local">` во времени события. */
export function isoToZonedLocal(iso: string | null | undefined, tz: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** «3–5 октября 2026» / «30 сентября – 2 октября 2026» */
export function formatEventRange(start: string | null, end: string | null, tz?: string | null): string | null {
  if (!start) return null;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric', timeZone: safeZone(tz) };
  const f = dtf(LOCALE, opts);
  const s = new Date(start);
  if (!end) return f.format(s);
  const e = new Date(end);
  if (dayKey(s, tz) === dayKey(e, tz)) return f.format(s);
  const range = (f as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string }).formatRange;
  if (typeof range === 'function') {
    try {
      return range.call(f, s, e);
    } catch {
      /* старые движки */
    }
  }
  return `${f.format(s)} – ${f.format(e)}`;
}

/** Сегодня по часам телефона в формате `YYYY-MM-DD` (для ограничения поля даты рождения). */
export function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Полных лет - формат «34 года» / «7 лет» / «1 год». Без даты рождения (гость на месте) - «возраст не указан». */
export function yearsLabel(n: number | null): string {
  if (n === null) return 'возраст не указан';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} год`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} года`;
  return `${n} лет`;
}

/** Склонение: plural(5, ['место', 'места', 'мест']) → «мест». */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
