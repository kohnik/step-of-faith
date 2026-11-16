/*
 * «Шаг веры 2026» - service worker для браузерных страниц: QR-кода для входа (/t/<token>) и браузерного сканера (/staff).
 * Регистрируется только вне Telegram и только с этими scope.
 *  - навигация: сеть (с таймаутом), при неудаче - сохранённая оболочка приложения;
 *  - /assets/* (файлы с хешем в имени): кэш, затем сеть;
 *  - /api/public/tickets/* (данные и картинка QR-кода): сеть, при неудаче - кэш.
 * Остальные запросы (в том числе весь API персонала) идут мимо service worker.
 */
const VERSION = 'sof-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const DATA_CACHE = `${VERSION}-data`;
const SHELL_KEY = '/index.html';
// С запасом на несколько выкладок: в одной сборке ~50 файлов. Вытесняем давно не нужные (LRU).
const MAX_ASSETS = 250;
const MAX_DATA = 60;
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/', { cache: 'reload' });
        if (res.ok) await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, res);
      } catch {
        /* без сети - оболочка закэшируется при первой навигации */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('sof-') && !k.startsWith(`${VERSION}-`)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function handleNavigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(event.request).then(async (res) => {
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.includes('text/html')) await cache.put(SHELL_KEY, res.clone());
    return res;
  });
  event.waitUntil(network.catch(() => undefined));
  try {
    const res = await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
    // Сервер лежит (502 от прокси, 500): сканер должен открыться из сохранённой оболочки, а не показать ошибку.
    if (res.status >= 500) return (await cache.match(SHELL_KEY)) ?? res;
    return res;
  } catch {
    const cached = await cache.match(SHELL_KEY);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Нет связи</title>' +
        '<p style="font:16px system-ui;padding:24px">Нет связи. Откройте страницу, когда появится интернет.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirst(event, cacheName, max) {
  const request = event.request;
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) {
    // Используемый файл переносим в конец очереди (ключи кэша - в порядке записи), чтобы обрезка его не тронула.
    event.waitUntil(cache.delete(request).then(() => cache.put(request, hit.clone())).catch(() => undefined));
    return hit;
  }
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    trim(cache, max);
  }
  return res;
}

async function networkFirst(event, cacheName, max) {
  const request = event.request;
  const cache = await caches.open(cacheName);
  const network = fetch(request).then(async (res) => {
    if (res.ok) {
      await cache.put(request, res.clone());
      trim(cache, max);
    } else if (res.status === 404) {
      // Регистрацию отменили или ссылка устарела - старую копию больше не показываем.
      await cache.delete(request);
    }
    return res;
  });
  event.waitUntil(network.catch(() => undefined));
  try {
    return await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'offline', message: 'Нет связи с сервером' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event, ASSET_CACHE, MAX_ASSETS));
    return;
  }
  if (url.pathname.startsWith('/api/public/tickets/')) {
    event.respondWith(networkFirst(event, DATA_CACHE, MAX_DATA));
    return;
  }
  if (/^\/(icon[\w-]*\.(png|svg)|manifest\.webmanifest)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(event, ASSET_CACHE, MAX_ASSETS));
  }
});
