import { queryClient } from '../../api/queries.ts';
import { loadModelViewer } from '../../ui/model-viewer-loader.ts';
import { participantApi } from '../api.ts';

export const MERCH_CATALOG_KEY = ['merch'] as const;

const warmed = new Set<string>();

/** Картинку - в кэш браузера: файлы мерча отдаются с вечным кэшем, второй раз их не качаем. */
function warmImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.onload = img.onerror = () => resolve();
    img.src = url;
  });
}

const warmFile = (url: string) =>
  fetch(url, { priority: 'low' }).then(
    (r) => r.blob().then(() => undefined),
    () => undefined,
  );

async function warm(urls: string[], load: (url: string) => Promise<void>) {
  for (const url of urls) {
    if (warmed.has(url)) continue;
    warmed.add(url);
    await load(url);
  }
}

/** Экономия трафика или совсем медленная сеть - тяжёлое не качаем заранее. */
function lowData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return c?.saveData === true || c?.effectiveType === 'slow-2g' || c?.effectiveType === '2g';
}

/**
 * Мерч - заранее, пока человек на главной: каталог, превью, все фото, 360°, 3D-движок и модели,
 * чтобы витрина и карточки открывались сразу. По одному файлу и с низким приоритетом -
 * остальному приложению не мешаем. При экономии трафика - только каталог и превью.
 */
export async function prefetchMerch(): Promise<void> {
  const data = await queryClient
    .fetchQuery({ queryKey: MERCH_CATALOG_KEY, queryFn: () => participantApi.merch(), staleTime: 15_000, gcTime: 60 * 60_000 })
    .catch(() => null);
  if (!data) return;
  const media = data.products.flatMap((p) => p.media);
  await warm(media.flatMap((m) => (m.kind === 'photo' && m.thumbUrl ? [m.thumbUrl] : [])), warmImage);
  if (lowData()) return;
  await warm(media.flatMap((m) => (m.kind === 'photo' ? [m.url] : [])), warmImage);
  // 360°: обложка и сам файл оборота - без движка, это просто кадры.
  await warm(media.flatMap((m) => (m.kind === 'spin' && m.thumbUrl ? [m.thumbUrl] : [])), warmImage);
  await warm(media.flatMap((m) => (m.kind === 'spin' ? [m.url] : [])), warmFile);
  const models = media.flatMap((m) => (m.kind === 'model' ? [m.url] : []));
  if (models.length === 0) return;
  await loadModelViewer().catch(() => undefined);
  await warm(models, warmFile);
}
