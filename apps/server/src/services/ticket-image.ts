import { CATEGORY_LABELS, formatTicketCode, textOn, type Category } from '@sof/shared';
import QRCode from 'qrcode';
import sharp from 'sharp';

// Сервер маленький (2 ГБ на несколько проектов): без внутреннего кэша libvips и по одному потоку.
sharp.cache(false);
sharp.concurrency(1);

export interface TicketImageInput {
  code: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  category: Category;
  eventName: string;
  /** Вариант участия: цвет шапки картинки. */
  tier: { short: string; color: string } | null;
}

/** Версия оформления: меняется - старые картинки (и file_id в Telegram) перерисовываются. */
export const TICKET_DESIGN = 3;

const W = 1080;
const H = 1440;
const FONT = "'DejaVu Sans', 'Noto Sans', Arial, sans-serif";
const MONO = "'DejaVu Sans Mono', 'Noto Sans Mono', Menlo, monospace";

/** Фирменные цвета «Шаг веры»: кремовая карточка, сливовый текст - как карточка в Mini App. */
const CARD = '#f7f4e8';
const INK = '#352937';
const MUTED = '#7a6e74';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Размер шрифта, чтобы строка влезла в ширину (грубая оценка: символ ≈ 0.6 кегля). */
function fit(text: string, max: number, width = 980): number {
  return Math.max(28, Math.min(max, Math.floor(width / (0.6 * Math.max(1, text.length)))));
}

/** Путь из тёмных модулей QR: каждый модуль - квадрат 1×1 в системе координат матрицы. */
function qrMatrixPath(code: string): { size: number; d: string } {
  const qr = QRCode.create(code, { errorCorrectionLevel: 'Q' });
  const size = qr.modules.size;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return { size, d };
}

/**
 * Картинка как карточка QR-кода в Mini App: сверху шапка цвета варианта (название, имя и вариант),
 * ниже на кремовом - QR-код на белой подложке (так сканеры читают надёжнее), код и подсказка.
 * Без варианта шапка сливовая.
 */
export function ticketSvg(t: TicketImageInput): string {
  const { size, d } = qrMatrixPath(t.code);
  const quiet = 4;
  const view = size + quiet * 2;
  const head = t.tier?.color ?? INK;
  const fg = textOn(head);
  const name = [t.lastName, t.firstName].filter(Boolean).join(' ');
  const sub = t.tier?.short ?? (t.category === 'participant' ? '' : CATEGORY_LABELS[t.category]);
  const HEAD_H = sub ? 330 : 270;
  const qrTop = HEAD_H + 70;
  const qrSize = 740;
  const pad = 30;
  const codeY = qrTop + qrSize + pad + 104;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${CARD}"/>
  <rect width="${W}" height="${HEAD_H}" fill="${esc(head)}"/>
  <text x="72" y="104" font-family="${FONT}" font-size="32" font-weight="700" letter-spacing="3" fill="${fg}" fill-opacity="0.85">${esc(t.eventName.toUpperCase())}</text>
  <text x="72" y="${sub ? 196 : 206}" font-family="${FONT}" font-size="${fit(name, 72, 936)}" font-weight="700" fill="${fg}">${esc(name)}</text>
  ${sub ? `<text x="72" y="268" font-family="${FONT}" font-size="${fit(sub, 44, 936)}" font-weight="600" fill="${fg}" fill-opacity="0.92">${esc(sub)}</text>` : ''}
  <rect x="${(W - qrSize) / 2 - pad}" y="${qrTop - pad}" width="${qrSize + pad * 2}" height="${qrSize + pad * 2}" rx="44" fill="#ffffff"/>
  <svg x="${(W - qrSize) / 2}" y="${qrTop}" width="${qrSize}" height="${qrSize}" viewBox="${-quiet} ${-quiet} ${view} ${view}" shape-rendering="crispEdges">
    <rect x="${-quiet}" y="${-quiet}" width="${view}" height="${view}" fill="#ffffff"/>
    <path d="${d}" fill="#000000"/>
  </svg>
  <text x="540" y="${codeY}" font-family="${MONO}" font-size="58" font-weight="700" letter-spacing="4" fill="${INK}" text-anchor="middle">${esc(formatTicketCode(t.code))}</text>
  <text x="540" y="${codeY + 64}" font-family="${FONT}" font-size="30" fill="${MUTED}" text-anchor="middle">Покажите на входе. Работает и без интернета.</text>
</svg>`;
}

export async function renderTicketPng(t: TicketImageInput): Promise<Buffer> {
  return sharp(Buffer.from(ticketSvg(t))).png({ compressionLevel: 9 }).toBuffer();
}
