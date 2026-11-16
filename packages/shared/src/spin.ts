/**
 * 360° вещи - кадры оборота одним файлом `.spin`: так это обычный файл медиа (имя - хеш, вечный кэш),
 * а телефон качает его одним запросом и разворачивает кадры по одному, по мере вращения.
 *
 * Формат: `SPN1` · длина заголовка (uint32, little-endian) · заголовок JSON · кадры подряд (WebP/JPEG/PNG).
 * В заголовке у каждого кадра - [смещение, длина] от начала кадров.
 */

export const SPIN_MAGIC = 'SPN1';
/** Меньше - уже не оборот, больше - лишний вес без пользы. */
export const SPIN_MIN_FRAMES = 8;
export const SPIN_MAX_FRAMES = 180;
/** Готовый файл: кадры сжаты (WebP), обычно 1–3 МБ. */
export const SPIN_MAX_BYTES = 25 * 1024 * 1024;

export interface SpinHeader {
  count: number;
  width: number;
  height: number;
  frames: [offset: number, length: number][];
}

export function buildSpin(frames: Uint8Array[], width: number, height: number): Uint8Array {
  const index: [number, number][] = [];
  let offset = 0;
  for (const f of frames) {
    index.push([offset, f.length]);
    offset += f.length;
  }
  const header = new TextEncoder().encode(JSON.stringify({ count: frames.length, width, height, frames: index } satisfies SpinHeader));
  const out = new Uint8Array(8 + header.length + offset);
  out.set(new TextEncoder().encode(SPIN_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let at = 8 + header.length;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Разобрать файл; кривой - ошибка. `frame(i)` - байты кадра без копирования. */
export function parseSpin(data: Uint8Array): { header: SpinHeader; frame: (i: number) => Uint8Array } {
  const bad = () => new Error('bad_spin');
  if (data.length < 8 || new TextDecoder().decode(data.subarray(0, 4)) !== SPIN_MAGIC) throw bad();
  const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
  if (headerLength <= 0 || 8 + headerLength > data.length) throw bad();
  let header: SpinHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(data.subarray(8, 8 + headerLength))) as SpinHeader;
  } catch {
    throw bad();
  }
  const body = data.subarray(8 + headerLength);
  const ok =
    Number.isInteger(header.count) &&
    header.count >= SPIN_MIN_FRAMES &&
    header.count <= SPIN_MAX_FRAMES &&
    Number.isInteger(header.width) &&
    Number.isInteger(header.height) &&
    header.width > 0 &&
    header.height > 0 &&
    Array.isArray(header.frames) &&
    header.frames.length === header.count &&
    header.frames.every(
      (f) => Array.isArray(f) && Number.isInteger(f[0]) && Number.isInteger(f[1]) && f[0] >= 0 && f[1] > 0 && f[0] + f[1] <= body.length,
    );
  if (!ok) throw bad();
  return { header, frame: (i) => body.subarray(header.frames[i]![0], header.frames[i]![0] + header.frames[i]![1]) };
}
