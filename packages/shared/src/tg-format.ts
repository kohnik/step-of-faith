/**
 * Разметка рассылок, как в Telegram: **жирный**, *курсив*, __подчёркнутый__, ~~зачёркнутый~~, [текст](https://…).
 * В бот уходит HTML: весь текст экранируем, теги - только эти, ссылки - только http(s) и tg.
 * Незакрытый маркер остаётся как есть; кривую вложенность Telegram отвергнет - тогда шлём `tgPlain`.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LINK = /\[([^\]\n]+)\]\(\s*((?:https?|tg):\/\/[^\s)]+)\s*\)/g;

const STYLES: [RegExp, string][] = [
  [/\*\*(?=\S)([^\n]*?\S)\*\*/g, 'b'],
  [/__(?=\S)([^\n]*?\S)__/g, 'u'],
  [/~~(?=\S)([^\n]*?\S)~~/g, 's'],
  // Одна звёздочка - курсив, но не «2*3*4» и не «* пункт списка».
  [/(?<![*\p{L}\p{N}])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\p{L}\p{N}])/gu, 'i'],
];

function styled(s: string): string {
  let out = esc(s);
  for (const [re, tag] of STYLES) out = out.replace(re, `<${tag}>$1</${tag}>`);
  return out;
}

/** Текст рассылки → HTML для Telegram (parse_mode: 'HTML') и для предпросмотра в админке. */
export function tgHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    out += styled(text.slice(last, m.index)) + `<a href="${esc(m[2]!)}">${styled(m[1]!)}</a>`;
    last = m.index + m[0].length;
  }
  return out + styled(text.slice(last));
}

/** Без разметки: заголовок объявления и запасной вариант, если Telegram не принял HTML. */
export function tgPlain(text: string): string {
  let out = text.replace(LINK, '$1 ($2)');
  for (const [re] of STYLES) out = out.replace(re, '$1');
  return out;
}
