import { formatTicketCode } from '@sof/shared';
import type { Config } from '../config.ts';

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function userDisplayName(u: {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
}): string {
  if (u.displayName) return u.displayName;
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  if (name) return name;
  return u.username ? `@${u.username}` : 'Без имени';
}

export function ticketUrls(config: Config, webToken: string) {
  return {
    webUrl: `${config.APP_URL}/t/${webToken}`,
    imageUrl: `${config.APP_URL}/api/public/tickets/${webToken}/image.png`,
  };
}

export function ticketView(config: Config, t: { code: string; webToken: string }) {
  return { code: t.code, displayCode: formatTicketCode(t.code), ...ticketUrls(config, t.webToken) };
}

export function botLink(config: Config, payload?: string): string {
  return payload ? `https://t.me/${config.BOT_USERNAME}?start=${payload}` : `https://t.me/${config.BOT_USERNAME}`;
}
