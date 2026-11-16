import { parseSpin } from '@sof/shared';
import { IconRotate2, IconRotate360 } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { haptic } from '../lib/feedback.ts';
import { setVerticalSwipes } from '../telegram/sdk.ts';
import { cx, Spinner } from './kit.tsx';

/**
 * 360° вещи: кадры оборота из одного файла .spin (см. shared/spin.ts) на canvas.
 *  - палец влево-вправо - поворот, отпустил с разгоном - докрутится по инерции; полный оборот замкнут;
 *  - щипок или двойное касание - приблизить (до 3×), приближенное двигается пальцем, «Вернуть» - назад;
 *  - пока не трогали - медленно крутится сам.
 * Память: файл (1–3 МБ) держим целиком, а разжатыми - только последние кадры (несжатый кадр 600×800 - ~2 МБ,
 * все 120 сразу - 220 МБ, на этом телефоны и вылетают). Пока экран открыт, вертикальный свайп Telegram выключен.
 */

/** Сколько разжатых кадров держим: четверть оборота с запасом (кадр 600×800 - ~2 МБ). */
const CACHE = 40;
const MAX_ZOOM = 3;
const DOUBLE_TAP_ZOOM = 2.2;
/** Сколько ширин экрана - полный оборот (как в присланном просмотрщике: 1.5). */
const TURN_WIDTHS = 1.3;
/** Пока не тронули - показ ракурсов: стоит на переде, боку, заде, другом боку и поворачивается на четверть. */
const TOUR_PAUSE_MS = 2200;
const TOUR_TURN_MS = 700;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

type Pt = { x: number; y: number };

function readable(): boolean {
  return typeof window.createImageBitmap === 'function';
}

export function SpinViewer({ src, poster, alt, className }: { src: string; poster?: string | null; alt: string; className?: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [progress, setProgress] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [touched, setTouched] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  /** Всё изменяемое - в одном объекте: обработчики жестов живут вне React. */
  const s = useRef({
    frames: [] as Blob[],
    count: 0,
    width: 0,
    height: 0,
    pos: 0, // текущий кадр (дробный: между кадрами - плавный переход)
    /** Что сейчас нарисовано: кадр, доля перехода, есть ли следующий. */
    shownKey: '',
    zoom: 1,
    pan: { x: 0, y: 0 },
    cache: new Map<number, ImageBitmap>(),
    decoding: new Map<number, Promise<ImageBitmap | null>>(),
    /** Кадры, которые телефон не смог разжать, - больше не пробуем (иначе повтор на каждом кадре анимации). */
    failed: new Set<number>(),
    /** Куда крутят: +1 / -1 - туда и готовим кадры заранее. */
    dir: 1,
    /** Блок на экране - показ ракурсов идёт только тогда. */
    visible: true,
    raf: 0,
    /** Время прошлого шага анимации; 0 - анимация стояла. */
    lastT: 0,
    /** Надо перерисовать, даже если кадр тот же (зум, сдвиг, размер, дождались кадра). */
    dirty: true,
    auto: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    /** Идёт поворот показа: откуда, куда, когда начался. */
    tour: null as { from: number; to: number; start: number } | null,
    tourTimer: 0,
    inertia: 0,
    dead: false,
  });

  useEffect(() => {
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);

  // ---------- загрузка ----------
  useEffect(() => {
    const st = s.current;
    st.dead = false;
    setState('loading');
    setProgress(0);
    const abort = new AbortController();
    (async () => {
      if (!readable()) throw new Error('no createImageBitmap');
      const res = await fetch(src, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`spin ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (total) setProgress(got / total);
      }
      const data = new Uint8Array(got);
      let at = 0;
      for (const p of parts) {
        data.set(p, at);
        at += p.length;
      }
      const { header, frame } = parseSpin(data);
      st.frames = Array.from({ length: header.count }, (_, i) => new Blob([frame(i) as BlobPart], { type: 'image/webp' }));
      st.count = header.count;
      st.width = header.width;
      st.height = header.height;
      st.pos = 0;
      st.shownKey = '';
      st.dirty = true;
      st.failed.clear();
      const first = await decode(0);
      if (st.dead) return;
      if (!first) throw new Error('spin frame decode failed');
      setState('ready');
      request();
      scheduleTour();
    })().catch((err: unknown) => {
      if (st.dead || (err instanceof DOMException && err.name === 'AbortError')) return;
      setState('failed');
    });
    return () => {
      st.dead = true;
      clearTimeout(st.tourTimer);
      abort.abort();
      cancelAnimationFrame(st.raf);
      st.raf = 0;
      for (const b of st.cache.values()) b.close();
      st.cache.clear();
      st.decoding.clear();
      st.frames = [];
    };
    // decode/request - функции этого компонента без своего состояния.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  /** Разжать кадр (один раз; лишние - из памяти). */
  function decode(i: number): Promise<ImageBitmap | null> {
    const st = s.current;
    const have = st.cache.get(i);
    if (have) {
      st.cache.delete(i);
      st.cache.set(i, have); // свежий - в конец очереди
      return Promise.resolve(have);
    }
    const pending = st.decoding.get(i);
    if (pending) return pending;
    const blob = st.frames[i];
    if (!blob || st.failed.has(i)) return Promise.resolve(null);
    const p = createImageBitmap(blob)
      .then((bmp) => {
        st.decoding.delete(i);
        if (st.dead) {
          bmp.close();
          return null;
        }
        st.cache.set(i, bmp);
        while (st.cache.size > CACHE) {
          const [oldest, old] = st.cache.entries().next().value as [number, ImageBitmap];
          st.cache.delete(oldest);
          old.close();
        }
        return bmp;
      })
      .catch(() => {
        st.decoding.delete(i);
        st.failed.add(i);
        return null;
      });
    st.decoding.set(i, p);
    return p;
  }

  const frameIndex = (pos: number) => {
    const n = s.current.count;
    return n ? ((Math.round(pos) % n) + n) % n : 0;
  };

  /** Кадр ещё не разжат - рисуем ближайший готовый, а нужный дорисуем, когда будет. */
  function nearestReady(i: number): ImageBitmap | null {
    const st = s.current;
    for (let d = 0; d < st.count; d++) {
      const a = st.cache.get((i + d) % st.count) ?? st.cache.get((i - d + st.count) % st.count);
      if (a) return a;
    }
    return null;
  }

  function draw() {
    const st = s.current;
    const c = canvas.current;
    const box = wrap.current;
    if (!c || !box || !st.count) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(box.clientWidth * dpr);
    const h = Math.round(box.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    // Между соседними кадрами - плавный переход: кадры идут через 3°, и без него медленное вращение «шагает».
    const base = Math.floor(st.pos);
    const frac = st.pos - base;
    const i = frameIndex(base);
    const j = frameIndex(base + 1);
    const a = st.cache.get(i);
    const b = st.cache.get(j);
    const later = (k: number) =>
      void decode(k).then(() => {
        st.dirty = true;
        request();
      });
    if (!a) later(i);
    if (!b && frac > 0.02) later(j);
    // Соседей - заранее, в сторону вращения: вперёд это base+2…, назад - base-1….
    for (let k = 1; k <= 6; k++) void decode(frameIndex(st.dir > 0 ? base + 1 + k : base + 1 - k));
    const key = `${i}:${Math.round(frac * 32)}:${b ? 1 : 0}`;
    const under = a ?? nearestReady(i);
    if (!under || (a && key === st.shownKey && !st.dirty)) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const fit = Math.min(w / st.width, h / st.height);
    const dw = st.width * fit * st.zoom;
    const dh = st.height * fit * st.zoom;
    const x = (w - dw) / 2 + st.pan.x * dpr;
    const y = (h - dh) / 2 + st.pan.y * dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.drawImage(under, x, y, dw, dh);
    if (a && b && frac > 0.02) {
      ctx.globalAlpha = frac;
      ctx.drawImage(b, x, y, dw, dh);
      ctx.globalAlpha = 1;
    }
    st.shownKey = a ? key : '';
    st.dirty = false;
  }

  /**
   * Показ ракурсов: через паузу - поворот на четверть. Кадры поворота разжимаем заранее, до старта:
   * если разжимать на ходу, быстрый поворот подтормаживает.
   */
  function scheduleTour() {
    const st = s.current;
    clearTimeout(st.tourTimer);
    if (!st.auto || st.dead) return;
    st.tourTimer = window.setTimeout(async () => {
      if (!st.auto || st.dead || st.zoom !== 1) return;
      // Не видно (прокрутили, свернули приложение) - не крутим и не разжимаем зря, ждём следующего раза.
      if (document.hidden || !st.visible) return scheduleTour();
      const from = Math.round(st.pos);
      const to = from + Math.max(1, Math.round(st.count / 4));
      st.dir = 1;
      const path = Array.from({ length: to - from + 1 }, (_, k) => frameIndex(from + k));
      await Promise.all(path.map((i) => decode(i)));
      if (!st.auto || st.dead) return;
      st.tour = { from, to, start: performance.now() };
      request();
    }, TOUR_PAUSE_MS);
  }

  /** Один кадр перерисовки за раз; показ ракурсов и инерция идут отсюда же. */
  function request() {
    const st = s.current;
    if (st.raf || st.dead) return;
    st.raf = requestAnimationFrame(tick);
  }
  function tick(t: number) {
    const st = s.current;
    st.raf = 0;
    const dt = st.lastT ? Math.min(t - st.lastT, 64) : 16;
    st.lastT = t;
    let moving = false;
    if (st.auto && st.tour) {
      const p = Math.min(1, (t - st.tour.start) / TOUR_TURN_MS);
      st.pos = st.tour.from + (st.tour.to - st.tour.from) * easeInOut(p);
      if (p >= 1) {
        st.tour = null;
        scheduleTour();
      } else moving = true;
    } else if (Math.abs(st.inertia) > 0.002) {
      st.pos += st.inertia * dt;
      st.inertia *= Math.pow(0.94, dt / 16);
      moving = true;
    } else if (st.inertia !== 0) {
      // Докрутилось - встаём ровно на кадр, а не на смесь двух (иначе края двоятся).
      st.inertia = 0;
      st.pos = Math.round(st.pos);
      st.dirty = true;
    }
    draw();
    if (moving) request();
    else st.lastT = 0;
  }

  // ---------- жесты ----------
  useEffect(() => {
    const el = wrap.current;
    if (!el || state !== 'ready') return;
    const st = s.current;
    const points = new Map<number, Pt>();
    let drag: { x: number; y: number; pos: number; pan: Pt; t: number; moved: boolean } | null = null;
    let pinch: { dist: number; zoom: number; mid: Pt; pan: Pt } | null = null;
    let samples: { t: number; pos: number }[] = [];
    let lastTap = 0;

    const rect = () => el.getBoundingClientRect();
    /** Приближенное не уезжает за край. */
    const clampPan = () => {
      const r = rect();
      const fit = Math.min(r.width / st.width, r.height / st.height);
      const mx = Math.max(0, (st.width * fit * st.zoom - r.width) / 2);
      const my = Math.max(0, (st.height * fit * st.zoom - r.height) / 2);
      st.pan = { x: Math.max(-mx, Math.min(mx, st.pan.x)), y: Math.max(-my, Math.min(my, st.pan.y)) };
    };
    /** Зум вокруг точки (координаты внутри блока). */
    const zoomAt = (zoom: number, at: Pt, from: { zoom: number; pan: Pt }) => {
      const r = rect();
      const z = Math.max(1, Math.min(MAX_ZOOM, zoom));
      const cx0 = at.x - r.width / 2;
      const cy0 = at.y - r.height / 2;
      st.pan = { x: cx0 - ((cx0 - from.pan.x) * z) / from.zoom, y: cy0 - ((cy0 - from.pan.y) * z) / from.zoom };
      st.zoom = z;
      if (z <= 1.01) {
        st.zoom = 1;
        st.pan = { x: 0, y: 0 };
      }
      clampPan();
      el.style.touchAction = st.zoom > 1 ? 'none' : 'pan-y';
      setZoomed(st.zoom > 1);
      st.dirty = true;
      request();
    };
    const local = (e: PointerEvent): Pt => {
      const r = rect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    /** Человек сам крутит или приближает - показ ракурсов больше не мешает. */
    const stopAuto = () => {
      if (st.auto) {
        st.auto = false;
        st.tour = null;
        clearTimeout(st.tourTimer);
        setTouched(true);
      }
    };
    /** Палец на картинке - показ ждёт; убрали, ничего не покрутив (например, листали страницу), - продолжаем. */
    const pauseTour = () => {
      clearTimeout(st.tourTimer);
      st.tour = null;
    };
    const resumeTour = () => {
      if (st.auto && points.size === 0) scheduleTour();
    };
    /** Отпустили - встаём ровно на кадр, если не докручиваемся по инерции. */
    const settle = () => {
      if (st.inertia === 0 && st.pos !== Math.round(st.pos)) {
        st.pos = Math.round(st.pos);
        st.dirty = true;
        request();
      }
    };
    const startPinch = () => {
      const [a, b] = [...points.values()] as [Pt, Pt];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: st.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pan: { ...st.pan } };
      drag = null;
      samples = [];
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Касание кнопки («Вернуть») - её нажатие, а не жест: иначе захват указателя съест click.
      if ((e.target as Element | null)?.closest('button')) return;
      pauseTour();
      st.inertia = 0;
      points.set(e.pointerId, local(e));
      el.setPointerCapture(e.pointerId);
      if (points.size >= 2) {
        stopAuto();
        startPinch();
      } else {
        const p = local(e);
        drag = { x: p.x, y: p.y, pos: st.pos, pan: { ...st.pan }, t: e.timeStamp, moved: false };
        samples = [{ t: e.timeStamp, pos: st.pos }];
      }
    };
    const move = (e: PointerEvent) => {
      if (!points.has(e.pointerId)) return;
      // Палец пошёл вверх-вниз - это прокрутка страницы, не поворот.
      if (lock === 'v' && st.zoom === 1 && points.size === 1) return;
      points.set(e.pointerId, local(e));
      if (pinch && points.size >= 2) {
        const [a, b] = [...points.values()] as [Pt, Pt];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        zoomAt((pinch.zoom * dist) / pinch.dist, pinch.mid, { zoom: pinch.zoom, pan: pinch.pan });
        return;
      }
      if (!drag) return;
      const p = local(e);
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      if (Math.hypot(dx, dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      stopAuto();
      if (st.zoom > 1) {
        st.pan = { x: drag.pan.x + dx, y: drag.pan.y + dy };
        clampPan();
        // Упёрлись в край - отсчёт от края, чтобы обратное движение сразу двигало картинку.
        drag.pan = { x: st.pan.x - dx, y: st.pan.y - dy };
        st.dirty = true;
      } else {
        const pos = drag.pos + (dx * st.count) / (rect().width * TURN_WIDTHS);
        if (pos !== st.pos) st.dir = pos > st.pos ? 1 : -1;
        st.pos = pos;
        samples.push({ t: e.timeStamp, pos: st.pos });
        if (samples.length > 8) samples.shift();
      }
      request();
    };
    const up = (e: PointerEvent) => {
      if (!points.has(e.pointerId)) return;
      points.delete(e.pointerId);
      if (pinch) {
        if (points.size >= 2) {
          startPinch(); // третий палец убрали - продолжаем щипок оставшимися двумя
          return;
        }
        pinch = null;
        // Один палец ещё на экране - дальше он двигает, а не поворачивает.
        const rest = [...points.values()][0];
        drag = rest ? { x: rest.x, y: rest.y, pos: st.pos, pan: { ...st.pan }, t: e.timeStamp, moved: true } : null;
        samples = rest ? [{ t: e.timeStamp, pos: st.pos }] : [];
        if (!rest) settle();
        return;
      }
      if (drag && !drag.moved) {
        // Двойное касание - приблизить или вернуть.
        if (e.timeStamp - lastTap < 300) {
          haptic('selection');
          stopAuto();
          zoomAt(st.zoom > 1 ? 1 : DOUBLE_TAP_ZOOM, local(e), { zoom: st.zoom, pan: { ...st.pan } });
          lastTap = 0;
        } else lastTap = e.timeStamp;
      } else if (drag && st.zoom === 1) {
        // Скорость - только по движению за последние ~100 мс; палец задержали перед отпусканием - без докрутки.
        samples.push({ t: e.timeStamp, pos: st.pos });
        const recent = samples.filter((x) => e.timeStamp - x.t <= 100);
        const a = recent[0];
        const b = recent[recent.length - 1];
        const v = a && b && b.t - a.t >= 16 ? (b.pos - a.pos) / (b.t - a.t) : 0;
        st.inertia = Math.abs(v) > 0.01 ? Math.max(-0.5, Math.min(0.5, v)) : 0;
        if (st.inertia) {
          st.dir = st.inertia > 0 ? 1 : -1;
          request();
        }
      }
      drag = null;
      samples = [];
      settle();
      resumeTour();
    };
    /** Браузер забрал касание себе (прокрутка страницы, системный жест) - это не касание и не бросок. */
    const cancel = (e: PointerEvent) => {
      if (!points.has(e.pointerId)) return;
      points.delete(e.pointerId);
      if (points.size < 2) pinch = null;
      if (drag && lock === 'v') st.pos = drag.pos;
      drag = null;
      samples = [];
      lastTap = 0;
      settle();
      resumeTour();
    };

    /*
     * Направление - по первым миллиметрам: больше вбок - крутим и не даём странице уехать (preventDefault
     * на touchmove, пока прокрутка не началась), явно вверх-вниз - отдаём прокрутке. Иначе чуть косое
     * движение пальца браузер забирал под прокрутку, и поворот срывался.
     */
    let lock: 'h' | 'v' | null = null;
    let start: Pt | null = null;
    const touchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      lock = e.touches.length > 1 ? 'h' : null;
      start = t ? { x: t.clientX, y: t.clientY } : null;
    };
    const touchMove = (e: TouchEvent) => {
      if (st.zoom > 1 || e.touches.length > 1) {
        lock = 'h';
        if (e.cancelable) e.preventDefault();
        return;
      }
      const t = e.touches[0];
      if (!lock && start && t) {
        const dx = Math.abs(t.clientX - start.x);
        const dy = Math.abs(t.clientY - start.y);
        if (Math.max(dx, dy) > 6) lock = dx >= dy * 0.75 ? 'h' : 'v';
      }
      if (lock === 'h' && e.cancelable) e.preventDefault();
    };

    el.style.touchAction = st.zoom > 1 ? 'none' : 'pan-y';
    el.addEventListener('touchstart', touchStart, { passive: true });
    el.addEventListener('touchmove', touchMove, { passive: false });
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    const io = new IntersectionObserver(([entry]) => {
      st.visible = !!entry?.isIntersecting;
    });
    io.observe(el);
    const ro = new ResizeObserver(() => {
      st.dirty = true;
      request();
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('touchstart', touchStart);
      el.removeEventListener('touchmove', touchMove);
      ro.disconnect();
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const reset = () => {
    const st = s.current;
    haptic('selection');
    st.zoom = 1;
    st.pan = { x: 0, y: 0 };
    st.dirty = true;
    if (wrap.current) wrap.current.style.touchAction = 'pan-y';
    setZoomed(false);
    request();
  };

  if (state === 'failed') {
    return (
      <div className={cx('flex flex-col items-center justify-center gap-2 bg-fill text-center text-[14px] text-subtle', className)}>
        <IconRotate360 size={32} stroke={1.5} />
        Не получилось открыть 360°
      </div>
    );
  }
  return (
    <div ref={wrap} className={cx('relative select-none overflow-hidden bg-fill', className)} role="img" aria-label={`${alt}, 360°`}>
      {poster && state !== 'ready' && <img src={poster} alt="" className="absolute inset-0 size-full object-contain" />}
      <canvas ref={canvas} className={cx('absolute inset-0 size-full', state !== 'ready' && 'opacity-0')} />
      {state === 'ready' && !touched && !zoomed && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span className="flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1 text-[13px] font-semibold text-white backdrop-blur">
            <IconRotate360 size={15} />
            Проведите, чтобы повернуть
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={reset}
        tabIndex={zoomed ? 0 : -1}
        aria-hidden={!zoomed}
        className={cx(
          'absolute bottom-4 right-3 flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-[13px] font-semibold text-white backdrop-blur transition duration-300',
          zoomed ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        )}
      >
        <IconRotate2 size={15} />
        Вернуть
      </button>
      {state === 'loading' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1 text-[13px] font-semibold text-white">
            <Spinner className="size-4" />
            {progress > 0 ? `${Math.round(progress * 100)}%` : '360°'}
          </span>
        </div>
      )}
    </div>
  );
}
