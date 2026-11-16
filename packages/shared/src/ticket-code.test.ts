import { describe, expect, it } from 'vitest';
import { TICKET_ALPHABET, buildTicketCode, formatTicketCode, parseTicketCode } from './ticket-code.ts';

function randomBody(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += TICKET_ALPHABET[Math.floor(Math.random() * 32)];
  return s;
}

describe('ticket code', () => {
  it('builds and parses back', () => {
    for (let i = 0; i < 1000; i++) {
      const code = buildTicketCode(randomBody());
      expect(code).toMatch(/^SF-[0-9A-Z]{11}$/);
      expect(parseTicketCode(code)).toBe(code);
    }
  });

  it('forgives formatting and O/I/L confusion', () => {
    const code = buildTicketCode('0123456789');
    const messy = ` ${formatTicketCode(code).toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')} `;
    expect(parseTicketCode(messy)).toBe(code);
    expect(parseTicketCode(code.slice(3))).toBe(code);
  });

  it('rejects any single-character typo', () => {
    const code = buildTicketCode('7K3P9XQ2MN');
    const body = code.slice(3);
    for (let pos = 0; pos < body.length; pos++) {
      for (const ch of TICKET_ALPHABET) {
        if (ch === body[pos]) continue;
        const typo = body.slice(0, pos) + ch + body.slice(pos + 1);
        expect(parseTicketCode(typo)).toBeNull();
      }
    }
  });

  it('rejects garbage', () => {
    expect(parseTicketCode('')).toBeNull();
    expect(parseTicketCode('https://t.me/bot?start=x')).toBeNull();
    expect(parseTicketCode('SF-123')).toBeNull();
  });
});
