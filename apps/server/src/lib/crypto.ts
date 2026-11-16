import { createHash, randomBytes, randomInt } from 'node:crypto';
import { TICKET_ALPHABET, buildTicketCode } from '@sof/shared';

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomCrockford(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += TICKET_ALPHABET[randomInt(32)];
  return s;
}

export function generateTicketCode(): string {
  return buildTicketCode(randomCrockford(10));
}

/** Код для комментария к переводу, один на аккаунт: P + 6 символов. */
export function generatePaymentRef(): string {
  return `P${randomCrockford(6)}`;
}

export function codeHash(salt: string, code: string): string {
  return sha256Hex(salt + code);
}
