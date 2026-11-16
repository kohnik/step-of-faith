/**
 * Крошечный безопасный рендерер Markdown для инфо-страниц и объявлений.
 * Поддерживает: заголовки, абзацы, **жирный**, *курсив*, __подчёркнутый__, ~~зачёркнутый~~, `код`, ссылки [текст](url) и голые URL,
 * списки (маркированные и нумерованные), цитаты, линии и блоки ```кода```.
 * Никакого innerHTML: результат - React-элементы, текст экранируется React'ом, а ссылки
 * пропускаются только со схемами http(s)/mailto/tel/tg или внутренние (/schedule).
 */
import { useMemo, type MouseEvent, type ReactNode } from 'react';

type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; text: string }
  | { type: 'hr' };

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const UL = /^\s{0,3}[-*+•]\s+(.*)$/;
const OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;

function isBlockStart(line: string): boolean {
  return HEADING.test(line) || HR.test(line) || UL.test(line) || OL.test(line) || QUOTE.test(line) || FENCE.test(line);
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: Math.min(3, h[1]!.length) as 1 | 2 | 3, text: h[2]! });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const start = ol ? Number(ol[1]) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ordered ? OL.exec(l) : UL.exec(l);
        if (m) {
          items.push((ordered ? m[2] : m[1]) ?? '');
          i++;
          continue;
        }
        // Продолжение пункта с отступом.
        if (items.length && /^\s{2,}\S/.test(l)) {
          items[items.length - 1] += `\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!);
        if (!m) break;
        quote.push(m[1] ?? '');
        i++;
      }
      blocks.push({ type: 'quote', lines: quote });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length > 0 && isBlockStart(lines[i]!))) {
      para.push(lines[i]!.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', lines: para });
  }
  return blocks;
}

// ---------- строчная разметка ----------

// 1 - жирный (**), 2 - подчёркнутый (__, как в Telegram и рассылках), 3,4 - курсив (* / _), 5 - код, 6,7 - ссылка, 8 - голый URL, 9 - зачёркнутый (~~).
const INLINE =
  /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=\S)([\s\S]*?\S)\*|_(?=\S)([\s\S]*?\S)_|`([^`\n]+)`|\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)|((?:https?:\/\/|www\.|t\.me\/)[^\s<>"]+)|~~(?=\S)([\s\S]*?\S)~~/;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'tg:']);

export function safeHref(raw: string): string | null {
  let url = raw.trim();
  if (/^www\./i.test(url) || /^t\.me\//i.test(url)) url = `https://${url}`;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    return ALLOWED_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export type LinkHandler = (href: string) => void;

function link(href: string, children: ReactNode, key: string, onLink?: LinkHandler): ReactNode {
  const internal = href.startsWith('/');
  return (
    <a
      key={key}
      href={href}
      target={internal ? undefined : '_blank'}
      rel={internal ? undefined : 'noopener noreferrer'}
      className="break-words text-link underline decoration-1 underline-offset-2"
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (!onLink) return;
        e.preventDefault();
        onLink(href);
      }}
    >
      {children}
    </a>
  );
}

function renderInline(text: string, keyPrefix: string, onLink?: LinkHandler): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    const key = `${keyPrefix}.${k++}`;
    const before = m.index > 0 ? rest[m.index - 1]! : '';
    // snake_case_слова не превращаем в курсив.
    if ((m[2] !== undefined || m[4] !== undefined) && /[\p{L}\p{N}]/u.test(before)) {
      out.push(rest.slice(0, m.index + 1));
      rest = rest.slice(m.index + 1);
      continue;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    let consumed = m[0].length;
    if (m[1] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[1], key, onLink)}</strong>);
    } else if (m[2] !== undefined) {
      out.push(
        <u key={key} className="underline-offset-2">
          {renderInline(m[2], key, onLink)}
        </u>,
      );
    } else if (m[9] !== undefined) {
      out.push(<s key={key}>{renderInline(m[9], key, onLink)}</s>);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<em key={key}>{renderInline((m[3] ?? m[4])!, key, onLink)}</em>);
    } else if (m[5] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-fill px-1 font-mono text-[0.92em]">
          {m[5]}
        </code>,
      );
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const href = safeHref(m[7]);
      out.push(href ? link(href, renderInline(m[6], key, onLink), key, onLink) : m[6]);
    } else if (m[8] !== undefined) {
      // Хвостовую пунктуацию оставляем тексту: «см. https://site.ru.» → ссылка без точки.
      const trail = /[.,;:!?)»"'’]+$/.exec(m[8]);
      const urlText = trail ? m[8].slice(0, -trail[0].length) : m[8];
      consumed = m[0].length - (trail ? trail[0].length : 0);
      const href = safeHref(urlText);
      out.push(href ? link(href, urlText, key, onLink) : urlText);
    }
    rest = rest.slice(m.index + consumed);
  }
  return out;
}

function renderLines(lines: string[], key: string, onLink?: LinkHandler): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`${key}.br${idx}`} />);
    out.push(...renderInline(line, `${key}.l${idx}`, onLink));
  });
  return out;
}

function renderBlock(b: Block, key: string, onLink?: LinkHandler): ReactNode {
  switch (b.type) {
    case 'heading': {
      const content = renderInline(b.text, key, onLink);
      if (b.level === 1) return <h2 key={key} className="mb-2 mt-5 text-xl font-bold first:mt-0">{content}</h2>;
      if (b.level === 2) return <h3 key={key} className="mb-2 mt-4 text-lg font-bold first:mt-0">{content}</h3>;
      return <h4 key={key} className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{content}</h4>;
    }
    case 'paragraph':
      return (
        <p key={key} className="my-2 leading-relaxed first:mt-0 last:mb-0">
          {renderLines(b.lines, key, onLink)}
        </p>
      );
    case 'list': {
      const items = b.items.map((item, idx) => (
        <li key={`${key}.i${idx}`} className="pl-1">
          {renderLines(item.split('\n'), `${key}.i${idx}`, onLink)}
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start} className="my-2 list-decimal space-y-1 pl-6 leading-relaxed">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-2 list-disc space-y-1 pl-6 leading-relaxed">
          {items}
        </ul>
      );
    }
    case 'quote':
      return (
        <blockquote key={key} className="my-3 border-l-4 border-line pl-3 italic text-subtle">
          {renderLines(b.lines, key, onLink)}
        </blockquote>
      );
    case 'code':
      return (
        <pre key={key} className="my-3 overflow-x-auto rounded-xl bg-fill p-3 font-mono text-sm leading-snug">
          {b.text}
        </pre>
      );
    case 'hr':
      return <hr key={key} className="my-4 border-line" />;
  }
}

export function Markdown({ source, onLink, className }: { source: string; onLink?: LinkHandler; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={className}>{blocks.map((b, i) => renderBlock(b, `b${i}`, onLink))}</div>;
}
