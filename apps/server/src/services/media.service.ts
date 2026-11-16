import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSpin, parseSpin, SPIN_MAX_BYTES } from '@sof/shared';
import sharp, { type OutputInfo } from 'sharp';
import { badRequest } from '../lib/errors.ts';

// Маленький сервер, общая память: по одной картинке за раз, без кэша (как у картинок QR).
sharp.cache(false);
sharp.concurrency(1);

export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const MODEL_MAX_BYTES = 25 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface SavedPhoto {
  file: string;
  thumb: string;
  width: number;
  height: number;
  bytes: number;
}

export interface SavedModel {
  file: string;
  bytes: number;
}

const hashOf = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Путь внутри папки; `..` и абсолютные пути не пускаем. */
function inside(root: string, rel: string): string {
  const full = normalize(join(root, rel));
  if (!full.startsWith(normalize(root) + sep)) throw badRequest('bad_path', 'Неверный путь к файлу');
  return full;
}

/** Запись через временный файл: читатель (Caddy) никогда не увидит половину файла. */
async function put(root: string, rel: string, data: Buffer): Promise<void> {
  const full = inside(root, rel);
  await mkdir(dirname(full), { recursive: true });
  const exists = await stat(full).catch(() => null);
  if (exists) return; // Имя - хеш содержимого: такой файл уже есть.
  const tmp = `${full}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, full);
}

/**
 * Фото товара: поворот по EXIF, EXIF и геометки убираем, WebP до 1600 px и превью до 600 px.
 * Имя файла - хеш картинки, поэтому Caddy отдаёт её с вечным кэшем.
 */
export async function savePhoto(root: string, folder: string, data: Buffer, mime: string): Promise<SavedPhoto> {
  if (!PHOTO_TYPES.includes(mime)) throw badRequest('bad_photo', 'Фото - только JPG, PNG или WebP');
  if (data.length > PHOTO_MAX_BYTES) throw badRequest('too_big', 'Фото больше 15 МБ');
  let full: { data: Buffer; info: OutputInfo };
  let thumb: Buffer;
  try {
    full = await sharp(data, { failOn: 'error' })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    thumb = await sharp(data, { failOn: 'error' })
      .rotate()
      .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer();
  } catch {
    throw badRequest('bad_photo', 'Не получилось открыть фото - попробуйте другой файл');
  }
  const hash = hashOf(full.data).slice(0, 20);
  const file = `${folder}/${hash}.webp`;
  const thumbFile = `${folder}/${hash}-s.webp`;
  await put(root, file, full.data);
  await put(root, thumbFile, thumb);
  return { file, thumb: thumbFile, width: full.info.width, height: full.info.height, bytes: full.data.length };
}

/** Фото профиля из Telegram: квадрат 128 px, WebP. */
export async function saveAvatar(root: string, data: Buffer): Promise<string> {
  const out = await sharp(data, { failOn: 'error' }).resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
  const file = `avatars/${hashOf(out).slice(0, 20)}.webp`;
  await put(root, file, out);
  return file;
}

/** 3D-модель: только бинарный glTF (.glb) - проверяем подпись файла, а не расширение. */
export async function saveModel(root: string, folder: string, data: Buffer): Promise<SavedModel> {
  if (data.length > MODEL_MAX_BYTES) throw badRequest('too_big', '3D-модель больше 25 МБ - сожмите её (Draco или meshopt)');
  if (data.length < 20 || data.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw badRequest('bad_model', '3D-модель - только файл .glb (бинарный glTF)');
  }
  const file = `${folder}/${hashOf(data).slice(0, 20)}.glb`;
  await put(root, file, data);
  return { file, bytes: data.length };
}

export interface SavedSpin {
  file: string;
  thumb: string;
  width: number;
  height: number;
  bytes: number;
  frames: number;
}

/** Кадр 360°: не больше 900×1200 - на телефоне больше не нужно, а памяти при вращении уходит меньше. */
const SPIN_FRAME_MAX = { width: 900, height: 1200 };
/** Исходный кадр - не больше 25 Мп: огромная картинка не съест память сервера. */
const SPIN_FRAME_PIXELS = 25_000_000;

/** Кадр - только WebP, JPEG или PNG (по содержимому, не по имени). */
function isFrameImage(b: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  return (b[0] === 0xff && b[1] === 0xd8) || ascii(1, 4) === 'PNG' || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP');
}

/**
 * 360°: файл .spin из редактора (кадры как есть, см. spin.ts). Каждый кадр пересжимаем в WebP одного размера -
 * чужие байты в витрину не попадут, а битый кадр отклонит весь файл. Превью - первый кадр, как у фото.
 */
export async function saveSpin(root: string, folder: string, data: Buffer): Promise<SavedSpin> {
  if (data.length > SPIN_MAX_BYTES) throw badRequest('too_big', '360° больше 25 МБ - уменьшите кадры');
  let parsed: ReturnType<typeof parseSpin>;
  try {
    parsed = parseSpin(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } catch {
    throw badRequest('bad_spin', 'Не получилось прочитать 360° - загрузите архив с кадрами ещё раз');
  }
  const frames: Uint8Array[] = [];
  let size: { width: number; height: number } | null = null;
  let thumb: Buffer;
  try {
    for (let i = 0; i < parsed.header.count; i++) {
      const raw = parsed.frame(i);
      if (!isFrameImage(raw)) throw new Error('not an image');
      const src = Buffer.from(raw);
      // Размер задаёт первый кадр; остальные подгоняем под него, чтобы оборот не прыгал.
      const pipeline = sharp(src, { failOn: 'error', limitInputPixels: SPIN_FRAME_PIXELS }).rotate();
      const out: { data: Buffer; info: OutputInfo } = size
        ? await pipeline.resize({ width: size.width, height: size.height, fit: 'cover' }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true })
        : await pipeline.resize({ ...SPIN_FRAME_MAX, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
      size ??= { width: out.info.width, height: out.info.height };
      frames.push(new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength));
    }
    thumb = await sharp(Buffer.from(parsed.frame(0)), { failOn: 'error', limitInputPixels: SPIN_FRAME_PIXELS })
      .rotate()
      .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer();
  } catch {
    throw badRequest('bad_spin', 'В 360° есть кадр, который не открывается - проверьте архив');
  }
  const bundle = Buffer.from(buildSpin(frames, size!.width, size!.height));
  const hash = hashOf(bundle).slice(0, 20);
  const file = `${folder}/${hash}.spin`;
  const thumbFile = `${folder}/${hash}-s.webp`;
  await put(root, file, bundle);
  await put(root, thumbFile, thumb);
  return { file, thumb: thumbFile, width: size!.width, height: size!.height, bytes: bundle.length, frames: frames.length };
}

/** Закрытый файл (чек перевода): тип по содержимому, а не по имени. */
export async function savePrivate(root: string, folder: string, data: Buffer): Promise<{ file: string; mime: string }> {
  if (data.length > PHOTO_MAX_BYTES) throw badRequest('too_big', 'Файл больше 15 МБ');
  const head = data.subarray(0, 12);
  const mime =
    head.subarray(0, 4).toString('ascii') === '%PDF'
      ? 'application/pdf'
      : head[0] === 0xff && head[1] === 0xd8
        ? 'image/jpeg'
        : head.subarray(1, 4).toString('ascii') === 'PNG'
          ? 'image/png'
          : head.subarray(8, 12).toString('ascii') === 'WEBP'
            ? 'image/webp'
            : null;
  if (!mime) throw badRequest('bad_file', 'Чек - фото (JPG, PNG, WebP) или PDF');
  const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1];
  const file = `${folder}/${hashOf(data).slice(0, 24)}.${ext}`;
  await put(root, file, data);
  return { file, mime };
}

export interface StoredMedia {
  kind: 'photo' | 'model' | 'spin';
  file: string;
  thumb: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

/**
 * Файл, загруженный раньше (редактор присылает его имя при «Сохранить»): в папку пишут только
 * savePhoto/saveModel, поэтому достаточно, что он на месте; размеры берём из самого файла.
 */
export async function storedMedia(root: string, file: string): Promise<StoredMedia> {
  const m = /^([a-z-]+\/[0-9a-f]{20})\.(webp|glb|spin)$/.exec(file);
  if (!m) throw badRequest('bad_file', 'Неверный файл');
  const missing = () => badRequest('file_missing', 'Файл не нашёлся на сервере - загрузите его ещё раз');
  const st = await stat(inside(root, file)).catch(() => null);
  if (!st) throw missing();
  if (m[2] === 'glb') return { kind: 'model', file, thumb: null, width: null, height: null, bytes: st.size };
  const thumb = `${m[1]}-s.webp`;
  if (!(await stat(inside(root, thumb)).catch(() => null))) throw missing();
  if (m[2] === 'spin') {
    const { header } = parseSpin(new Uint8Array(await readFile(inside(root, file))));
    return { kind: 'spin', file, thumb, width: header.width, height: header.height, bytes: st.size };
  }
  const meta = await sharp(inside(root, file)).metadata();
  return { kind: 'photo', file, thumb, width: meta.width ?? null, height: meta.height ?? null, bytes: st.size };
}

export async function readStored(root: string, rel: string): Promise<Buffer> {
  return readFile(inside(root, rel));
}

/** Удалить файл, если на него больше никто не ссылается (проверяет вызывающий). */
export async function removeStored(root: string, rel: string | null | undefined): Promise<void> {
  if (!rel) return;
  await rm(inside(root, rel), { force: true });
}

export const MEDIA_TYPES: Record<string, string> = {
  webp: 'image/webp',
  glb: 'model/gltf-binary',
  spin: 'application/octet-stream',
  jpg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
};
