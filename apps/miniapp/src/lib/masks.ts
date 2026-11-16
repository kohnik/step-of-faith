/**
 * Маски полей ввода (без системных календарей и часов): дата рождения «ДД.ММ.ГГГГ», время «ЧЧ:ММ»,
 * день «ДД.ММ», «ДД.ММ ЧЧ:ММ» и телефон Беларуси (+375) или России (+7).
 */
import { ageOn } from '@sof/shared';
import { todayLocalDate } from './time.ts';

// ---------- дата рождения ----------

const pad2 = (s: string) => s.padStart(2, '0');

/**
 * Приводит ввод к «ДД.ММ.ГГГГ»: точки ставятся сами, лишнее отбрасывается.
 * Понимает вставку «17.05.1990», «17051990», «7.5.1990» и «1990-05-17».
 * `prev` - прошлое значение: по нему видно, печатают дальше или стирают (тогда точку не добавляем).
 */
export function maskBirthDate(raw: string, prev = ''): string {
  const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(raw);
  if (iso) return `${pad2(iso[3]!)}.${pad2(iso[2]!)}.${iso[1]}`;
  // Число дня или месяца, закрытое разделителем, дополняем нулём: «7.» → «07.».
  const segments = raw.split(/\D+/);
  let digits = '';
  segments.forEach((seg, i) => {
    const closed = i < segments.length - 1;
    digits += closed && seg.length === 1 && digits.length < 4 ? `0${seg}` : seg;
  });
  digits = digits.slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += `.${digits.slice(2, 4)}`;
  if (digits.length > 4) out += `.${digits.slice(4, 8)}`;
  const typingForward = raw.length > prev.length;
  if (typingForward && (digits.length === 2 || digits.length === 4)) out += '.';
  return out;
}

export type BirthDateCheck = { iso: string } | { error: string };

/** «ДД.ММ.ГГГГ» → `YYYY-MM-DD` с проверкой: такая дата есть, не в будущем, возраст 0–110. */
export function parseBirthDate(display: string): BirthDateCheck {
  const value = display.trim();
  if (!value) return { error: 'Укажите дату рождения' };
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!m) return { error: 'Введите дату так: 17.05.1990' };
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { error: 'Такой даты нет - проверьте число и месяц' };
  }
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const today = todayLocalDate();
  if (iso > today) return { error: 'Дата рождения не может быть в будущем' };
  const age = ageOn(iso, `${today}T12:00:00Z`);
  if (age > 110) return { error: 'Проверьте год рождения' };
  return { iso };
}

/** `YYYY-MM-DD` → «ДД.ММ.ГГГГ» (для формы правки). */
export function isoToDisplayDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

// ---------- время и короткие даты (форма активности) ----------

/**
 * Общая маска «группы цифр + разделители»: разделитель ставится сам, одиночная цифра перед
 * набранным вручную разделителем дополняется нулём («9:» → «09:»), при стирании не мешает.
 */
function maskGroups(raw: string, prev: string, groups: readonly number[], seps: readonly string[]): string {
  const starts = new Set<number>([0]);
  let acc = 0;
  for (const g of groups) starts.add((acc += g));
  const total = acc;
  const segments = raw.split(/\D+/);
  let digits = '';
  segments.forEach((seg, i) => {
    const closed = i < segments.length - 1;
    digits += closed && seg.length === 1 && starts.has(digits.length) ? `0${seg}` : seg;
  });
  digits = digits.slice(0, total);
  let out = '';
  let at = 0;
  groups.forEach((size, gi) => {
    if (at >= digits.length) return;
    if (gi > 0) out += seps[gi - 1];
    out += digits.slice(at, at + size);
    at += size;
  });
  if (raw.length > prev.length) {
    let boundary = 0;
    for (let gi = 0; gi < groups.length - 1; gi++) {
      boundary += groups[gi]!;
      if (digits.length === boundary) out += seps[gi];
    }
  }
  return out;
}

/** «ЧЧ:ММ»: двоеточие ставится само, «9:30» → «09:30»; корректность часов проверяет parseTime. */
export function maskTime(raw: string, prev = ''): string {
  return maskGroups(raw, prev, [2, 2], [':']);
}

/** Минуты от полуночи или ошибка. */
export function parseTime(value: string): { minutes: number } | { error: string } {
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return { error: 'Время так: 15:30' };
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return { error: 'Такого времени нет' };
  return { minutes: h * 60 + min };
}

export function formatMinutes(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(String(Math.floor(m / 60)))}:${pad2(String(m % 60))}`;
}

/** «ДД.ММ» */
export function maskDayMonth(raw: string, prev = ''): string {
  return maskGroups(raw, prev, [2, 2], ['.']);
}

function realDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad2(String(month))}-${pad2(String(day))}`;
}

/** «ДД.ММ» + год → `YYYY-MM-DD`. */
export function parseDayMonth(value: string, year: number): { date: string } | { error: string } {
  const m = /^(\d{2})\.(\d{2})$/.exec(value.trim());
  if (!m) return { error: 'Дата так: 03.10' };
  const date = realDate(year, Number(m[2]), Number(m[1]));
  return date ? { date } : { error: 'Такой даты нет' };
}

/** «ДД.ММ ЧЧ:ММ» */
export function maskDayMonthTime(raw: string, prev = ''): string {
  return maskGroups(raw, prev, [2, 2, 2, 2], ['.', ' ', ':']);
}

/** «ДД.ММ ЧЧ:ММ» + год → «YYYY-MM-DDTHH:mm» (время события, без пояса). */
export function parseDayMonthTime(value: string, year: number): { local: string } | { error: string } {
  const m = /^(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return { error: 'Так: 02.10 18:00' };
  const date = realDate(year, Number(m[2]), Number(m[1]));
  if (!date || Number(m[3]) > 23 || Number(m[4]) > 59) return { error: 'Такой даты или времени нет' };
  return { local: `${date}T${m[3]}:${m[4]}` };
}

// ---------- телефон ----------

export type PhoneCountry = 'by' | 'ru';

export const PHONE_COUNTRIES: Record<PhoneCountry, { code: string; length: number; label: string; placeholder: string }> = {
  by: { code: '375', length: 9, label: '+375', placeholder: '(29) 123-45-67' },
  ru: { code: '7', length: 10, label: '+7', placeholder: '(916) 123-45-67' },
};

/** Национальная часть: Беларусь «(29) 123-45-67», Россия «(916) 123-45-67» - по мере ввода. */
export function formatPhoneLocal(country: PhoneCountry, digits: string): string {
  const groups = country === 'by' ? [2, 3, 2, 2] : [3, 3, 2, 2];
  const d = digits.slice(0, PHONE_COUNTRIES[country].length);
  if (!d) return '';
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    if (at >= d.length) break;
    parts.push(d.slice(at, at + size));
    at += size;
  }
  const [area, a, b, c] = parts;
  let out = `(${area}`;
  if (a !== undefined) out += `) ${a}`;
  if (b !== undefined) out += `-${b}`;
  if (c !== undefined) out += `-${c}`;
  return out;
}

/** Полный номер для сохранения: «+375 (29) 123-45-67». */
export function formatPhoneFull(country: PhoneCountry, digits: string): string {
  return `${PHONE_COUNTRIES[country].label} ${formatPhoneLocal(country, digits)}`;
}

export function isPhoneComplete(country: PhoneCountry, digits: string): boolean {
  return digits.length === PHONE_COUNTRIES[country].length;
}

/**
 * Разбор номера из любого вида (вставка, контакт из Telegram, сохранённое значение):
 * «+375 29 123-45-67», «80291234567», «+7 916 …», «89161234567». null - не похоже на номер BY/RU.
 */
export function parsePhone(raw: string | null | undefined): { country: PhoneCountry; digits: string } | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('375') && d.length === 12) return { country: 'by', digits: d.slice(3) };
  if (d.startsWith('80') && d.length === 11) return { country: 'by', digits: d.slice(2) };
  if ((d.startsWith('7') || d.startsWith('8')) && d.length === 11) return { country: 'ru', digits: d.slice(1) };
  return null;
}

/**
 * Изменение поля ввода: если вставили номер с кодом страны - переключаем страну,
 * иначе берём цифры национальной части (с ограничением длины). Привычные «80…» и «375…»
 * в начале белорусского номера отбрасываем - так их можно набрать по привычке.
 */
export function phoneInputChange(
  country: PhoneCountry,
  raw: string,
  prevDigits = '',
): { country: PhoneCountry; digits: string } {
  const all = raw.replace(/\D/g, '');
  const max = PHONE_COUNTRIES[country].length;
  const parsed = parsePhone(raw);
  if (parsed && (raw.trim().startsWith('+') || all.length > max)) return parsed;
  // Вставили (не набрали!) 10 цифр в белорусский режим - это российский номер без кода страны.
  const pasted = all.length - prevDigits.length > 1;
  if (pasted && country === 'by' && all.length === 10 && !all.startsWith('80')) return { country: 'ru', digits: all };
  let digits = all;
  if (country === 'by') {
    if (digits.startsWith('375')) digits = digits.slice(3);
    else if (digits.startsWith('80')) digits = digits.slice(2);
  }
  return { country, digits: digits.slice(0, max) };
}

/**
 * Ввод белорусского номера (конференция минская - только +375): цифры национальной части, 9 штук.
 * Вставка «+375 29 …», «375…», «80 29 …» нормализуется. Номер другой страны (+7 …, 8 916 …) не принимается:
 * `foreign: true`, поле остаётся прежним.
 */
export function byPhoneInputChange(raw: string, prevDigits = ''): { digits: string; foreign: boolean } {
  const parsed = parsePhone(raw);
  if (parsed?.country === 'by') return { digits: parsed.digits, foreign: false };
  const all = raw.replace(/\D/g, '');
  if (parsed?.country === 'ru' || (raw.trim().startsWith('+') && !all.startsWith('375') && all.length > 3)) {
    return { digits: prevDigits, foreign: true };
  }
  let digits = all;
  if (digits.startsWith('375')) digits = digits.slice(3);
  else if (digits.startsWith('80')) digits = digits.slice(2);
  return { digits: digits.slice(0, PHONE_COUNTRIES.by.length), foreign: false };
}

// ---------- телефон: Беларусь по умолчанию, но можно любой страны ----------

/** 'by' - маска +375 (XX) XXX-XX-XX; 'intl' - свободный ввод «+код и номер». */
export type PhoneMode = 'by' | 'intl';

const INTL_MAX = 15;

/**
 * Изменение поля телефона. В белорусском режиме вставка «+48 …», «+7 …» или «8 916 …» переключает
 * на номер другой страны; в режиме другой страны «+375 …» возвращает белорусскую маску.
 */
export function phoneFieldChange(mode: PhoneMode, raw: string, prevDigits = ''): { mode: PhoneMode; digits: string } {
  const all = raw.replace(/\D/g, '');
  const parsed = parsePhone(raw);
  if (parsed?.country === 'by') return { mode: 'by', digits: parsed.digits };
  if (mode === 'by') {
    if (parsed?.country === 'ru') return { mode: 'intl', digits: `7${parsed.digits}` };
    if (raw.trim().startsWith('+') && all.length > 3 && !all.startsWith('375')) return { mode: 'intl', digits: all.slice(0, INTL_MAX) };
    const next = byPhoneInputChange(raw, prevDigits);
    return { mode: 'by', digits: next.digits };
  }
  return { mode: 'intl', digits: all.slice(0, INTL_MAX) };
}

/** «+48 601 234 567» - по мере ввода, группами по три после кода страны (код угадываем грубо). */
export function formatIntlPhone(digits: string): string {
  if (!digits) return '';
  const codeLen = digits.startsWith('7') || digits.startsWith('1') ? 1 : digits.length > 11 ? 3 : 2;
  const code = digits.slice(0, codeLen);
  const rest = digits.slice(codeLen).replace(/(\d{3})(?=\d)/g, '$1 ');
  return `+${code}${rest ? ` ${rest}` : ''}`;
}

export function phoneForSubmit(mode: PhoneMode, digits: string): string | null {
  if (!digits) return null;
  return mode === 'by' ? formatPhoneFull('by', digits) : `+${digits}`;
}

export function isPhoneFieldComplete(mode: PhoneMode, digits: string): boolean {
  return mode === 'by' ? digits.length === PHONE_COUNTRIES.by.length : digits.length >= 8 && digits.length <= INTL_MAX;
}

/** Сохранённый номер → поле формы. */
export function phoneFieldFromStored(stored: string | null | undefined): { phoneMode: PhoneMode; phone: string } {
  const parsed = parsePhone(stored);
  if (parsed?.country === 'by') return { phoneMode: 'by', phone: parsed.digits };
  const d = (stored ?? '').replace(/\D/g, '');
  return d ? { phoneMode: 'intl', phone: d.slice(0, INTL_MAX) } : { phoneMode: 'by', phone: '' };
}
