import type { CSSProperties } from 'react';
import { cx } from '../../ui/kit.tsx';

/** Цвета пузырей - как у команд в игре и на постерах «Шага веры». */
const COLORS = ['#d0352c', '#4b5da5', '#2ea86b', '#f0a020', '#ff8a7e', '#9aa8e6'];

/** Псевдослучайное число по номеру: пузыри одинаковые при каждом показе, без «прыжков» при перерисовке. */
const rnd = (i: number, salt: number) => {
  const x = Math.sin(i * 97.13 + salt * 13.7) * 10000;
  return x - Math.floor(x);
};

/**
 * Пузыри, которые медленно всплывают снизу вверх (фон заставки, экрана благодарности, карточки).
 * `travel` - сколько проплывают (у карточки - её высота), `count` - сколько.
 */
export function Bubbles({ count = 14, travel = '115vh', className, small = false }: { count?: number; travel?: string; className?: string; small?: boolean }) {
  return (
    <div aria-hidden className={cx('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {Array.from({ length: count }, (_, i) => {
        const size = small ? 18 + rnd(i, 1) * 46 : 36 + rnd(i, 1) * 150;
        // Медленно и плавно: фон не должен отвлекать.
        const dur = (small ? 22 : 42) + rnd(i, 2) * (small ? 14 : 26);
        const style = {
          width: size,
          height: size,
          left: `${rnd(i, 3) * 100 - 8}%`,
          bottom: -size,
          background: `radial-gradient(circle at 32% 30%, rgb(255 255 255 / 0.55), ${COLORS[i % COLORS.length]} 58%)`,
          '--o': String(small ? 0.35 : 0.22 + rnd(i, 4) * 0.25),
          '--dur': `${dur}s`,
          // Отрицательная задержка - пузыри сразу по всей высоте, а не стартуют разом снизу.
          '--delay': `${-rnd(i, 5) * dur}s`,
          '--dx': `${(rnd(i, 6) - 0.5) * 40}px`,
          '--sway': `${dur / 3}s`,
          '--travel': travel,
        } as CSSProperties;
        return <span key={i} className="fb-rise absolute rounded-full opacity-0 blur-[0.5px]" style={style} />;
      })}
    </div>
  );
}

/** Плёночное зерно поверх градиента и пузырей (под текстом): слегка «живёт», как на плёнке. */
export function Grain() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="fb-grain-specks absolute -inset-[10%]" />
      <div className="fb-grain absolute -inset-[10%]" />
    </div>
  );
}

/** Фон карточки: тёплый градиент «Шага веры», цвета плавно перетекают (под пузырями и зерном). */
export function Flow() {
  return (
    <span
      aria-hidden
      className="fb-flow pointer-events-none absolute inset-0"
      style={{
        background: 'linear-gradient(125deg, #a82a2a 0%, #d0352c 28%, #e2603c 46%, #b8302a 64%, #7a3a8c 84%, #5b3a9a 100%)',
        backgroundSize: '240% 240%',
      }}
    />
  );
}

/** «Шаг веры» не разрываем между строк. */
export const nbsp = (text: string) => text.replace(/Шаг(а|у|ом|е)? вер(ы|е|у|ой)/g, (m) => m.replace(' ', '\u00a0'));

/** «ШАГ ВЕРЫ» по буквам: каждая слегка подпрыгивает волной. Год (если есть в названии) - отдельной строкой. */
export function Wordmark({ name, className }: { name: string; className?: string }) {
  const year = name.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
  const words = name.replace(/\b(19|20)\d{2}\b/, '').trim().toUpperCase().split(/\s+/);
  let n = 0;
  return (
    <div className={cx('font-display font-bold leading-[0.95] tracking-wide', className)} aria-label={name} role="img">
      {words.map((w, wi) => (
        <div key={wi} className="whitespace-nowrap">
          {[...w].map((ch, ci) => {
            const delay = `${(n++) * 0.09}s`;
            return (
              <span key={ci} className="fb-wave" style={{ '--delay': delay } as CSSProperties}>
                {ch}
              </span>
            );
          })}
        </div>
      ))}
      {year && <div className="mt-2 text-[0.32em] font-semibold tracking-[0.4em] opacity-80">{year}</div>}
    </div>
  );
}

/** Отпечаток стопы: подошва и пальцы. */
function Foot({ left }: { left?: boolean }) {
  return (
    <svg viewBox="0 0 24 40" width="100%" height="100%" style={left ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M12.5 15c5.2 0 8 4.4 7.6 10.6-.4 6.6-3.6 12.4-8.4 12.4-4.6 0-7-4.6-6.8-10.2.2-7.2 2.6-12.8 7.6-12.8z" fill="currentColor" />
      <circle cx="18.6" cy="9.6" r="2.7" fill="currentColor" />
      <circle cx="13.8" cy="7.2" r="2.4" fill="currentColor" />
      <circle cx="9.4" cy="7.6" r="2.1" fill="currentColor" />
      <circle cx="5.6" cy="9.6" r="1.9" fill="currentColor" />
      <circle cx="3.2" cy="13" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Шаги: следы появляются по очереди снизу вверх - кто-то идёт. Это и есть «шаг веры». */
export function Footsteps({ steps = 6, size = 22, className }: { steps?: number; size?: number; className?: string }) {
  const cycle = steps * 0.8 + 1.6;
  return (
    <div aria-hidden className={cx('relative', className)} style={{ width: size * 2.4, height: (steps - 1) * size * 1.05 + size * 1.7 }}>
      {Array.from({ length: steps }, (_, i) => {
        const left = i % 2 === 0;
        const style = {
          width: size,
          height: size * 1.66,
          left: left ? 0 : size * 1.25,
          bottom: i * size * 1.05,
          transform: `rotate(${left ? -8 : 8}deg)`,
          '--delay': `${i * 0.8}s`,
          '--cycle': `${cycle}s`,
        } as CSSProperties;
        return (
          <span key={i} className="fb-step absolute" style={style}>
            <Foot left={left} />
          </span>
        );
      })}
    </div>
  );
}
