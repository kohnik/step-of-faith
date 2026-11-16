/**
 * Код билета: `SF-` + 10 символов Crockford base32 + контрольный символ (Luhn mod 32).
 * Только заглавные буквы и цифры, поэтому QR получается версии 1 с коррекцией Q (21×21)
 * и читается даже с тусклого или разбитого экрана.
 */
export const TICKET_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TICKET_PREFIX = 'SF-';
export const TICKET_BODY_LENGTH = 10;

function luhnSum(chars: string, startFactor: 1 | 2): number | null {
  let factor = startFactor;
  let sum = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const codePoint = TICKET_ALPHABET.indexOf(chars[i]!);
    if (codePoint < 0) return null;
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return sum;
}

export function ticketCheckChar(body: string): string {
  const sum = luhnSum(body, 2);
  if (sum === null) throw new Error(`Invalid ticket body: ${body}`);
  return TICKET_ALPHABET[(32 - (sum % 32)) % 32]!;
}

export function buildTicketCode(body: string): string {
  if (body.length !== TICKET_BODY_LENGTH) throw new Error('Ticket body must be 10 chars');
  return TICKET_PREFIX + body + ticketCheckChar(body);
}

/**
 * Приводит отсканированную или введённую руками строку к виду `SF-XXXXXXXXXXC`.
 * Прощает пробелы, дефисы, строчные буквы и путаницу O/0, I/L/1. Возвращает null,
 * если длина или контрольный символ не сходятся.
 */
export function parseTicketCode(raw: string): string | null {
  let s = raw.trim().toUpperCase().replace(/[\s\-_]/g, '');
  if (s.length === TICKET_BODY_LENGTH + 3 && s.startsWith('SF')) s = s.slice(2);
  if (s.length !== TICKET_BODY_LENGTH + 1) return null;
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  const sum = luhnSum(s, 1);
  if (sum === null || sum % 32 !== 0) return null;
  return TICKET_PREFIX + s;
}

/** `SF-7K3P9XQ2MN4` → `SF-7K3P 9XQ2 MN4` - для печати под QR и ручного ввода. */
export function formatTicketCode(code: string): string {
  const body = code.startsWith(TICKET_PREFIX) ? code.slice(TICKET_PREFIX.length) : code;
  return `${TICKET_PREFIX}${body.slice(0, 4)} ${body.slice(4, 8)} ${body.slice(8)}`;
}
