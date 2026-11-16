/** Экранирование для parse_mode HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fmtDateTime(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(d));
}

export function fmtTime(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}

export function dayKey(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

/** Минимальный markdown → HTML Telegram: **жирный**, _курсив_, [ссылка](url), всё остальное экранируется. */
export function mdToTelegramHtml(md: string): string {
  let s = esc(md);
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`);
  s = s.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>');
  return s;
}
