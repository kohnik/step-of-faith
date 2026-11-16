// Сборка сервера в dist/: один бандл на точку входа, общий пакет @sof/shared внутри бандла,
// остальные зависимости — из node_modules. Миграции копируются рядом (dist/migrations).
import { cp, readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => d !== '@sof/shared');

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: {
    'main-api': 'src/main-api.ts',
    'main-bot': 'src/main-bot.ts',
    cli: 'src/cli.ts',
    migrate: 'src/db/migrate-cli.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
await cp('src/db/migrations', 'dist/migrations', { recursive: true });
console.log('server build ok');
