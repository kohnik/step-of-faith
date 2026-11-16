import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** API и cookie-сессия живут на том же origin: в разработке — через прокси Vite. */
const apiProxy = {
  '/api': { target: 'http://localhost:3000', changeOrigin: false },
  // Фото и 3D мерча (в проде их отдаёт Caddy).
  '/media': { target: 'http://localhost:3000', changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  appType: 'spa',
  server: {
    port: 5174,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 5174,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Страницы грузятся лениво (React.lazy): AG Grid и графики попадают в отдельные чанки
    // и скачиваются только вместе со страницами, где нужны. Сам AG Grid весит ~1 МБ.
    chunkSizeWarningLimit: 1300,
  },
});
