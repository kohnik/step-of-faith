import { buildSpin, SPIN_MAX_BYTES, SPIN_MAX_FRAMES, SPIN_MIN_FRAMES } from '@sof/shared';
import { unzipSync } from 'fflate';

/**
 * 360° для мерча: кадры оборота (архив .zip с картинками или сами картинки) → один файл .spin (см. shared/spin.ts).
 * Кадры идут по имени файла (frame_001, frame_002…). Пересжимает и выравнивает размер сервер - здесь только собираем.
 */

const IMAGE_RE = /\.(webp|jpe?g|png)$/i;
const MIME: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export interface SpinDraft {
  /** Файл для загрузки при «Сохранить». */
  file: File;
  /** Первый кадр - превью в редакторе. */
  poster: Blob;
  frames: number;
}

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const mimeOf = (name: string) => MIME[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

/** Больше кадров, чем нужно, - берём равномерно по обороту. */
function evenly<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  return Array.from({ length: max }, (_, i) => list[Math.floor((i * list.length) / max)]!);
}

export async function spinFromFiles(files: File[]): Promise<SpinDraft> {
  let frames: { name: string; data: Uint8Array }[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(new Uint8Array(await f.arrayBuffer()), {
          // Служебное (__MACOSX, ._файлы) и не картинки - не распаковываем.
          filter: (e) => IMAGE_RE.test(e.name) && !/(^|\/)(__MACOSX|\._)/.test(e.name),
        });
      } catch {
        throw new Error(`Не получилось открыть архив «${f.name}»`);
      }
      frames.push(...Object.entries(entries).map(([name, data]) => ({ name, data })));
    } else if (IMAGE_RE.test(f.name)) {
      frames.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  frames.sort((a, b) => naturalOrder.compare(a.name, b.name));
  if (frames.length < SPIN_MIN_FRAMES) {
    throw new Error(`Для 360° нужно хотя бы ${SPIN_MIN_FRAMES} кадров оборота, а нашлось ${frames.length}. Загрузите архив с кадрами (frame_001, frame_002…)`);
  }
  frames = evenly(frames, SPIN_MAX_FRAMES);
  const first = frames[0]!;
  const poster = new Blob([first.data as BlobPart], { type: mimeOf(first.name) });
  // Размер берём у первого кадра: остальные сервер подгонит под него.
  let size: { width: number; height: number };
  try {
    const bitmap = await createImageBitmap(poster);
    size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
  } catch {
    throw new Error(`Первый кадр «${first.name}» не открывается - проверьте архив`);
  }
  const bundle = buildSpin(
    frames.map((f) => f.data),
    size.width,
    size.height,
  );
  if (bundle.length > SPIN_MAX_BYTES) throw new Error(`360° получился ${(bundle.length / 1024 / 1024).toFixed(0)} МБ - больше 25 МБ. Уменьшите кадры`);
  return { file: new File([bundle as BlobPart], 'turn.spin', { type: 'application/octet-stream' }), poster, frames: frames.length };
}
