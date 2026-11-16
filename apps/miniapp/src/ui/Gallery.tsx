import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './kit.tsx';

/**
 * Фото листаются пальцем по одному (scroll-snap - плавно и без библиотек) и по кругу: за последним - снова первое.
 * Для круга по краям стоят копии последнего и первого фото: остановились на копии - незаметно
 * переносимся на настоящее. Новый набор фото (сменили цвет) - возвращаемся к первому.
 */
export function Gallery({ photos, alt, className }: { photos: { url: string; width: number | null; height: number | null }[]; alt: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const settle = useRef(0);
  const [index, setIndex] = useState(0);
  const n = photos.length;
  const loop = n > 1;
  const slides = loop ? [photos[n - 1]!, ...photos, photos[0]!] : photos;
  const key = photos.map((p) => p.url).join('|');

  const jump = (slide: number) => {
    const el = ref.current;
    if (el) el.scrollLeft = slide * el.clientWidth;
  };

  useLayoutEffect(() => {
    jump(loop ? 1 : 0);
    setIndex(0);
  }, [key]); // только при смене набора фото
  useEffect(() => () => clearTimeout(settle.current), []);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const w = Math.max(1, el.clientWidth);
    const slide = Math.round(el.scrollLeft / w);
    setIndex(loop ? (slide - 1 + n) % n : slide);
    if (!loop) return;
    clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const at = Math.round(el.scrollLeft / w);
      if (Math.abs(el.scrollLeft - at * w) > 1) return; // ещё доезжает до фото
      if (at === 0) jump(n);
      else if (at === n + 1) jump(1);
    }, 90);
  };

  return (
    <div className={cx('relative', className)}>
      <div ref={ref} onScroll={onScroll} className="no-scrollbar flex h-full snap-x snap-mandatory overflow-x-auto">
        {slides.map((p, i) => (
          <img
            key={i}
            src={p.url}
            alt={i === (loop ? 1 : 0) ? alt : ''}
            width={p.width ?? undefined}
            height={p.height ?? undefined}
            loading={i === (loop ? 1 : 0) ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
            className="h-full w-full shrink-0 snap-center object-cover"
          />
        ))}
      </div>
      {loop && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
          {photos.map((_, i) => (
            <span key={i} className={cx('h-1.5 rounded-full bg-white shadow transition-all', i === index ? 'w-5 opacity-100' : 'w-1.5 opacity-60')} />
          ))}
        </div>
      )}
    </div>
  );
}
