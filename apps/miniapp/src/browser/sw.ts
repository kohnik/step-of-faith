/**
 * Service worker регистрируем только в браузерном режиме и только для своих страниц
 * (/t/<token> - веб-билет, /staff - браузерный сканер). Внутри Telegram он не нужен.
 */
export function registerServiceWorker(scope: '/t/' | '/staff'): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope }).catch(() => undefined);
}

/** Ссылка на манифест PWA - только для браузерного сканера («Добавить на главный экран»). */
export function injectStaffManifest(): void {
  if (document.querySelector('link[rel="manifest"]')) return;
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = '/manifest.webmanifest';
  document.head.appendChild(link);
}
