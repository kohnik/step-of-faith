import type { ReactNode } from 'react';

/**
 * Крошечный безопасный рендер Markdown для предпросмотра инфо-страниц и объявлений.
 * Строит React-элементы напрямую (никакого innerHTML), поэтому любой HTML в тексте
 * показывается как текст. Поддерживает: заголовки, абзацы, переносы строк, списки,
 * цитаты, блоки кода, разделитель, **жирный**, *курсив*, ~~зачёркнутый~~, `код`,
 * [ссылки](https://…) и голые https-ссылки.
 */

const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/)/i;

export function safeUrl(url: string): string | null {
  const u = url.trim();
  return SAFE_URL.test(u) ? u : null;
}

// Порядок важен: код и ссылки раньше выделений.
const INLINE_RE = new RegExp(
  [
    '`([^`\\n]+)`', // 1 - код
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)', // 2, 3 - ссылка
    '\\*\\*([^\\n]+?)\\*\\*', // 4 - жирный
    '__([^\\n]+?)__', // 5 - жирный
    '~~([^\\n]+?)~~', // 6 - зачёркнутый
    '\\*([^*\\s](?:[^*\\n]*[^*\\s])?)\\*', // 7 - курсив
    '(?<![\\p{L}\\p{N}])_([^_\\s](?:[^_\\n]*[^_\\s])?)_(?![\\p{L}\\p{N}])', // 8 - курсив
    '(https?:\\/\\/[^\\s<>]+[^\\s<>.,;:!?)\\]\'"»])', // 9 - голая ссылка
  ].join('|'),
  'gu',
);

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) {
      out.push(<code key={key}>{m[1]}</code>);
    } else if (m[2] !== undefined && m[3] !== undefined) {
      const href = safeUrl(m[3]);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(m[2], key)}
          </a>
        ) : (
          <span key={key}>{m[0]}</span>
        ),
      );
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[4] ?? m[5] ?? '', key)}</strong>);
    } else if (m[6] !== undefined) {
      out.push(<s key={key}>{renderInline(m[6], key)}</s>);
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push(<em key={key}>{renderInline(m[7] ?? m[8] ?? '', key)}</em>);
    } else if (m[9] !== undefined) {
      out.push(
        <a key={key} href={m[9]} target="_blank" rel="noopener noreferrer nofollow">
          {m[9]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Строки абзаца: одиночный перенос строки - `<br>`. */
function renderLines(lines: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}-br${i}`} />);
    out.push(...renderInline(line, `${keyPrefix}-l${i}`));
  });
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```/;

function isBlockStart(line: string): boolean {
  return HEADING_RE.test(line) || HR_RE.test(line) || UL_RE.test(line) || OL_RE.test(line) || QUOTE_RE.test(line) || FENCE_RE.test(line);
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const key = `b${b++}`;
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (FENCE_RE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) code.push(lines[i++] ?? '');
      i++; // закрывающие ```
      blocks.push(
        <pre key={key}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1] ?? '#').length + 1); // # → h2: h1 оставляем заголовку страницы
      const content = renderInline(heading[2] ?? '', key);
      const Tag = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={key}>{content}</Tag>);
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i] ?? '')) quote.push(QUOTE_RE.exec(lines[i++] ?? '')?.[1] ?? '');
      blocks.push(
        <blockquote key={key}>
          <p>{renderLines(quote, key)}</p>
        </blockquote>,
      );
      continue;
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line) && !UL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items: string[][] = [];
      const start = ordered ? Number(OL_RE.exec(line)?.[1] ?? 1) : 1;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const m = re.exec(current);
        if (m) {
          items.push([(ordered ? m[2] : m[1]) ?? '']);
          i++;
        } else if (current.trim() !== '' && /^\s{2,}\S/.test(current) && items.length) {
          items[items.length - 1]!.push(current.trim()); // продолжение пункта с отступом
          i++;
        } else break;
      }
      const children = items.map((item, idx) => <li key={`${key}-${idx}`}>{renderLines(item, `${key}-${idx}`)}</li>);
      blocks.push(
        ordered ? (
          <ol key={key} start={start === 1 ? undefined : start}>
            {children}
          </ol>
        ) : (
          <ul key={key}>{children}</ul>
        ),
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && (para.length === 0 || !isBlockStart(lines[i] ?? ''))) {
      para.push(lines[i++] ?? '');
    }
    blocks.push(<p key={key}>{renderLines(para, key)}</p>);
  }
  return blocks;
}
