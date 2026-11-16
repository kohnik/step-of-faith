import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // SPA: любой неизвестный путь (/tickets, /staff/scan, /t/<token>) отдаёт index.html.
  appType: 'spa',
  server: {
    port: 5173,
    strictPort: true,
    // /media — фото и 3D мерча (в проде их отдаёт Caddy).
    proxy: { '/api': API_TARGET, '/media': API_TARGET },
  },
  preview: {
    port: 4173,
    proxy: { '/api': API_TARGET, '/media': API_TARGET },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    // Большой .wasm (zxing) никогда не инлайнится — всегда отдельный файл в dist/assets.
    assetsInlineLimit: (file) => (file.endsWith('.wasm') ? false : undefined),
    chunkSizeWarningLimit: 700,
  },
});
