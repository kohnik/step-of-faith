import type { GameScreenView } from '@sof/shared';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { bubbleRadii, BubbleWorld } from './bubbleWorld.ts';
import { ChurchArt, CREAM, Flag, luminance, PLUM, shade } from './ChurchArt.tsx';

type Team = GameScreenView['teams'][number];

export const DISPLAY = "'Unbounded Variable', system-ui, sans-serif";
/** Золото, серебро, бронза. */
export const PLACES = ['#f2c14e', '#dcd6c6', '#d99a6c'] as const;

export const peopleWord = (n: number) => (new Intl.PluralRules('ru').select(n) === 'few' ? 'человека' : 'человек');

interface Slot {
  R: number;
  anchor: { x: number; y: number } | null;
  /** Место на пьедестале (0…2) в итогах. */
  place: number | null;
}

interface NodeRef {
  el: HTMLDivElement;
  /** Радиус, под который свёрстан пузырь (его ширина - 2R); текущий размер - через scale. */
  R: number;
  pts: HTMLSpanElement | null;
  word: HTMLSpanElement | null;
  target: number;
  shown: number;
  text: number;
  x: number;
  y: number;
  r: number;
}

/**
 * Сцена с пузырями: размер - от отправленных людей, движение - физика (bubbleWorld), раз в кадр
 * меняем только transform - дёшево даже на огромном телевизоре. Голоса прилетают человечками и «+N».
 */
export function BubbleStage({ teams, current, results }: { teams: Team[]; current: number | null; results: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<BubbleWorld | null>(null);
  worldRef.current ??= new BubbleWorld();
  const world = worldRef.current;
  const nodes = useRef(new Map<number, NodeRef>()).current;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const fonts = useFontsVersion();

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      world.resize(r.width, r.height);
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [world]);

  const ranked = useMemo(() => [...teams].sort((a, b) => b.points - a.points || a.number - b.number), [teams]);
  const slots = useMemo(() => (results ? podiumSlots(ranked, size.w, size.h) : clusterSlots(ranked, size.w, size.h, current)), [ranked, size, results, current]);

  useEffect(() => {
    if (!size.w || !size.h) return;
    const lead = leaderOf(ranked);
    world.sync(
      ranked.map((t) => {
        const focus = !results && t.id === current;
        // Корона торчит сверху, у «голосуем» - кольцо и плашка снизу: соседям держаться подальше.
        const halo = results ? 1 : focus ? 1.14 : t.id === lead ? 1.1 : 1;
        return { id: t.id, R: slots.get(t.id)?.R ?? 0, anchor: slots.get(t.id)?.anchor ?? null, focus, halo };
      }),
    );
  }, [slots, ranked, world, results, current, size]);

  useEffect(() => {
    for (const t of teams) {
      const n = nodes.get(t.id);
      if (n) n.target = t.points;
    }
  }, [teams, nodes]);

  const register = useCallback(
    (id: number, ref: { el: HTMLDivElement; R: number; pts: HTMLSpanElement | null; word: HTMLSpanElement | null; points: number } | null) => {
      if (!ref) {
        nodes.delete(id);
        return;
      }
      const n = nodes.get(id);
      if (n) {
        Object.assign(n, { el: ref.el, R: ref.R, pts: ref.pts, word: ref.word });
        return;
      }
      // Первое появление: числа «докручиваются» с нуля, пока пузыри надуваются.
      nodes.set(id, { el: ref.el, R: ref.R, pts: ref.pts, word: ref.word, target: ref.points, shown: 0, text: -1, x: 0, y: 0, r: 0 });
    },
    [nodes],
  );

  // Кто сколько получил с прошлого опроса - туда летят человечки.
  const prev = useRef<Map<number, number> | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = new Map(teams.map((t) => [t.id, t.points]));
    if (!before || results) return;
    for (const t of teams) {
      const was = before.get(t.id);
      if (was !== undefined && t.points > was) burst(t, t.points - was);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams]);

  const burst = (team: Team, diff: number) => {
    const n = nodes.get(team.id);
    const fx = fxRef.current;
    if (!n || !fx || n.r <= 0 || reducedMotion()) return;
    const minDim = Math.min(world.w, world.h);
    const light = shade(team.color, 0.55);
    const plus = document.createElement('div');
    plus.className = 'sof-plus';
    plus.textContent = `+${diff}`;
    // Сбоку сверху - не под короной и не поверх названия.
    plus.style.cssText = `left:${n.x + n.r * 0.62}px;top:${n.y - n.r * 0.58}px;font-size:${Math.max(minDim * 0.055, n.r * 0.3)}px`;
    fx.appendChild(plus);
    plus.addEventListener('animationend', () => plus.remove());

    const people = Math.min(diff, 8);
    const s = Math.max(minDim * 0.036, 18);
    for (let i = 0; i < people; i++) {
      const delay = Math.random() * 500;
      const dur = 950 + Math.random() * 650;
      const sx = world.w * (0.05 + Math.random() * 0.9);
      const sy = world.h + s * 2;
      const outer = document.createElement('div');
      outer.className = 'sof-walk-x';
      outer.style.cssText = `left:${sx}px;top:${sy}px;--dx:${n.x - sx}px;animation-duration:${dur}ms;animation-delay:${delay}ms`;
      const inner = document.createElement('div');
      inner.className = 'sof-walk-y';
      inner.style.cssText = `--dy:${n.y - sy}px;width:${s}px;height:${s * 1.35}px;animation-duration:${dur}ms;animation-delay:${delay}ms`;
      inner.innerHTML = PERSON_SVG;
      outer.appendChild(inner);
      fx.appendChild(outer);
      window.setTimeout(() => {
        outer.remove();
        world.kick(team.id, 0.22);
      }, delay + dur);
    }

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
      const dist = n.r * (0.25 + Math.random() * 0.3);
      const dot = document.createElement('div');
      dot.className = 'sof-spark';
      dot.style.cssText = `left:${n.x + Math.cos(a) * n.r}px;top:${n.y + Math.sin(a) * n.r}px;--s:${Math.max(minDim * 0.007, 4)}px;--c:${i % 3 ? light : CREAM};--tx:${Math.cos(a) * dist}px;--ty:${Math.sin(a) * dist}px;animation-delay:${350 + Math.random() * 500}ms`;
      fx.appendChild(dot);
      dot.addEventListener('animationend', () => dot.remove());
    }
  };

  // Кадр: физика → transform. Числа «докручиваются» к новому значению.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      world.advance(dt);
      const amp = Math.min(world.w, world.h) * 0.0055;
      const t = world.time;
      for (const b of world.bodies.values()) {
        const n = nodes.get(b.id);
        if (!n) continue;
        const x = b.x + Math.cos(t * 0.37 + b.phase) * amp;
        const y = b.y + Math.sin(t * 0.53 + b.phase * 1.7) * amp;
        n.x = x;
        n.y = y;
        n.r = b.r;
        n.el.style.transform = `translate3d(${(x - n.R).toFixed(1)}px,${(y - n.R).toFixed(1)}px,0) scale(${(b.r / Math.max(n.R, 1)).toFixed(4)})`;
        if (n.shown !== n.target) {
          n.shown += (n.target - n.shown) * (1 - Math.exp(-Math.min(dt, 0.1) * 4.5));
          if (Math.abs(n.target - n.shown) < 0.45) n.shown = n.target;
        }
        const v = Math.round(n.shown);
        if (v !== n.text) {
          n.text = v;
          if (n.pts) n.pts.textContent = String(v);
          if (n.word) n.word.textContent = peopleWord(v);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [world, nodes]);

  const leader = leaderOf(ranked);
  const rankOf = (t: Team) => 1 + ranked.filter((x) => x.points > t.points).length;
  const minDim = Math.min(size.w, size.h);

  return (
    <div ref={stageRef} style={{ position: 'absolute', inset: 0 }}>
      {size.w > 0 &&
        ranked.map((t) => {
          const slot = slots.get(t.id);
          if (!slot || slot.R <= 0) return null;
          return (
            <Bubble
              key={t.id}
              team={t}
              R={Math.round(slot.R)}
              rank={t.points > 0 ? rankOf(t) : null}
              place={slot.place}
              current={!results && t.id === current}
              crown={results ? slot.place === 0 : t.id === leader}
              minDim={minDim}
              fonts={fonts}
              register={register}
            />
          );
        })}
      <div ref={fxRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10 }} />
    </div>
  );
}

/** Лидер - единственный с наибольшим числом людей (при ничьей короны нет). */
function leaderOf(ranked: Team[]): number | null {
  const [a, b] = ranked;
  return a && a.points > 0 && (!b || a.points > b.points) ? a.id : null;
}

/** Игра идёт: облако пузырей, площадь - от людей; за кого голосуем - чуть крупнее и в центре. */
function clusterSlots(ranked: Team[], w: number, h: number, current: number | null): Map<number, Slot> {
  const out = new Map<number, Slot>();
  if (!w || !h) return out;
  const radii = bubbleRadii(
    ranked.map((t) => t.points),
    w,
    h,
  );
  ranked.forEach((t, i) => out.set(t.id, { R: radii[i]! * (t.id === current ? 1.06 : 1), anchor: null, place: null }));
  return out;
}

/** Итоги: тройка лидеров - пьедестал (второй слева, первый в центре выше всех, третий справа), остальные - рядом внизу. */
function podiumSlots(ranked: Team[], w: number, h: number): Map<number, Slot> {
  const out = new Map<number, Slot>();
  if (!w || !h) return out;
  const minDim = Math.min(w, h);
  const top = ranked.filter((t) => t.points > 0).slice(0, 3);
  const rest = ranked.filter((t) => !top.includes(t));
  const pad = minDim * 0.03;
  const rr = rest.length ? Math.min(0.075 * h, (w - pad * 2) / (rest.length * 2.3)) : 0;
  const rowY = h - rr - pad;
  const areaTop = h * 0.14;
  // Под пузырями пьедестала - плашки «1 место»: оставляем им место, чтобы не налезали на нижний ряд.
  const areaBottom = (rest.length ? rowY - rr - minDim * 0.05 : h - pad) - minDim * 0.08;
  const areaH = Math.max(areaBottom - areaTop, h * 0.3);
  const gap = minDim * 0.05;
  const ratio = [1, 0.74, 0.64];
  // Первый - по высоте сцены, но три пузыря должны влезть по ширине.
  let R1 = Math.min(areaH * 0.5, (w - pad * 2 - gap * 2) / (2 * (ratio[0]! + ratio[1]! + ratio[2]!)) * 0.98);
  if (top.length === 1) R1 = Math.min(areaH * 0.5, w * 0.3);
  const xs = [w / 2, w / 2 - (R1 + R1 * ratio[1]! + gap), w / 2 + (R1 + R1 * ratio[2]! + gap)];
  const ys = [areaTop + R1, areaBottom - R1 * ratio[1]! - areaH * 0.04, areaBottom - R1 * ratio[2]!];
  top.forEach((t, i) => out.set(t.id, { R: R1 * ratio[i]!, anchor: { x: xs[i]!, y: ys[i]! }, place: i }));
  const step = rr * 2.3;
  rest.forEach((t, i) => out.set(t.id, { R: rr, anchor: { x: w / 2 + (i - (rest.length - 1) / 2) * step, y: rowY }, place: null }));
  return out;
}

interface BubbleProps {
  team: Team;
  R: number;
  rank: number | null;
  place: number | null;
  current: boolean;
  crown: boolean;
  minDim: number;
  fonts: number;
  register: (id: number, ref: { el: HTMLDivElement; R: number; pts: HTMLSpanElement | null; word: HTMLSpanElement | null; points: number } | null) => void;
}

/** Пузырь команды: глянцевый шар в её цвете, церковь, название, флаг и сколько людей отправили. */
const Bubble = memo(function Bubble({ team, R, rank, place, current, crown, minDim, fonts, register }: BubbleProps) {
  const el = useRef<HTMLDivElement>(null);
  const pts = useRef<HTMLSpanElement>(null);
  const word = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (el.current) register(team.id, { el: el.current, R, pts: pts.current, word: word.current, points: team.points });
  });
  useEffect(() => () => register(team.id, null), [register, team.id]);

  const c = team.color;
  // На светлых цветах (жёлтый, салатовый) светлый текст не читается - пишем сливовым.
  const lightBall = luminance(c) > 0.3;
  const ink = lightBall ? PLUM : CREAM;
  const name = useMemo(() => fitName(team.title, R), [team.title, R, fonts]);
  // Мелкое на телевизоре не читается - в маленьких пузырях оставляем главное: название и число.
  // Порог читаемости: ~1,8% высоты сцены (на 1080p - около 15 px, на 4K - 30 px).
  const legible = Math.max(minDim * 0.018, 12);
  const showChurch = R >= minDim * 0.06;
  const countryFont = Math.max(R * 0.08, legible);
  const showCountry = !!team.countryCode && countryFont <= R * 0.13;
  const showWord = R * 0.085 >= legible;
  const badge = Math.max(R * 0.26, minDim * 0.028, 18);
  const d = R * 2;

  return (
    <div
      ref={el}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: d,
        height: d,
        transform: 'translate3d(-200vw,-200vh,0)',
        zIndex: current ? 4 : crown ? 3 : place !== null ? 2 : 1,
      }}
    >
      {current && (
        <>
          <div className="sof-ring" style={{ borderWidth: Math.max(R * 0.022, 3) }} />
          <div className="sof-ring" style={{ borderWidth: Math.max(R * 0.022, 3), animationDelay: '1.1s' }} />
        </>
      )}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          // Чуть прозрачный шар: сквозь него видно «зерно» фона, объём - от затемнения к краю и блика. Без неонового свечения.
          // Как у стеклянного шарика: в центре прозрачнее, к краю плотнее.
          background: `radial-gradient(circle at 33% 27%, ${shade(c, 0.42)}d0 0%, ${shade(c, 0.12)}c4 24%, ${c}c8 52%, ${shade(c, -0.26)}e0 84%, ${shade(c, -0.46)}f0 100%)`,
          boxShadow: `inset 0 ${-R * 0.07}px ${R * 0.2}px rgba(0,0,0,.2), inset 0 0 0 ${Math.max(R * 0.012, 1.5)}px rgba(255,248,236,.16), 0 ${R * 0.05}px ${R * 0.18}px rgba(0,0,0,.3)`,
        }}
      />
      {/* блик - как на мыльном пузыре */}
      <div
        style={{
          position: 'absolute',
          left: '15%',
          top: '8%',
          width: '42%',
          height: '27%',
          borderRadius: '50%',
          background: 'radial-gradient(ellipse at 50% 55%, rgba(255,255,255,.55), rgba(255,255,255,.12) 55%, rgba(255,255,255,0) 72%)',
          transform: 'rotate(-24deg)',
        }}
      />
      <div style={{ position: 'absolute', right: '17%', bottom: '11%', width: '16%', height: '9%', borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(255,255,255,.28), rgba(255,255,255,0) 70%)', transform: 'rotate(-30deg)' }} />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          color: ink,
          gap: R * 0.02,
          paddingTop: R * 0.04,
          textShadow: lightBall ? '0 1px 0 rgba(255,255,255,.25)' : `0 ${R * 0.01}px ${R * 0.035}px rgba(36,27,38,.45)`,
        }}
      >
        {showChurch && <ChurchArt color={c} size={R * (R >= minDim * 0.16 ? 0.34 : 0.3)} tone={lightBall ? 'dark' : 'light'} flat style={{ marginBottom: R * 0.02 }} />}
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: name.size, lineHeight: 1.08, opacity: team.placeholder ? 0.82 : 1 }}>
          {name.lines.map((l, i) => (
            <div key={i} style={{ whiteSpace: 'nowrap' }}>
              {l}
            </div>
          ))}
        </div>
        {showCountry && (
          <div style={{ display: 'flex', alignItems: 'center', gap: countryFont * 0.45, fontSize: countryFont, fontWeight: 600, maxWidth: R * 1.4, opacity: 0.92 }}>
            <Flag code={team.countryCode} height={countryFont} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team.countryName}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: R * 0.04, marginTop: R * 0.015 }}>
          <span ref={pts} style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: R * 0.3, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }} />
          {showWord && <span ref={word} style={{ fontSize: R * 0.085, fontWeight: 700, opacity: 0.85 }} />}
        </div>
      </div>

      {rank !== null && (
        <div
          style={{
            position: 'absolute',
            left: R * 0.293 - badge / 2,
            top: R * 0.293 - badge / 2,
            width: badge,
            height: badge,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            fontFamily: DISPLAY,
            fontWeight: 800,
            fontSize: badge * 0.46,
            // Плоские значки, как бейджи в мини-апке: золото, серебро, бронза - для тройки.
            ...(rank <= 3
              ? { background: PLACES[rank - 1], color: PLUM, boxShadow: `0 ${badge * 0.06}px ${badge * 0.18}px rgba(0,0,0,.3)` }
              : { background: PLUM, color: CREAM, boxShadow: `inset 0 0 0 ${Math.max(badge * 0.05, 1.5)}px rgba(237,232,208,.3)` }),
          }}
        >
          {rank}
        </div>
      )}
      {crown && <Crown R={R} minDim={minDim} />}
      {current && <Pill R={R} bg={CREAM} fg={shade(c, -0.45)} text="голосуем" />}
      {place !== null && <Pill R={R} bg={PLACES[place]!} fg={PLUM} text={`${place + 1} место`} below />}
    </div>
  );
});

function Pill({ R, bg, fg, text, below = false }: { R: number; bg: string; fg: string; text: string; below?: boolean }) {
  const fs = Math.max(R * 0.075, 11);
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: below ? `calc(100% + ${R * 0.06}px)` : undefined,
        bottom: below ? undefined : -fs * 0.9,
        transform: 'translateX(-50%)',
        padding: `${fs * 0.45}px ${fs * 1.1}px`,
        borderRadius: 999,
        background: bg,
        color: fg,
        fontFamily: DISPLAY,
        fontWeight: 800,
        fontSize: fs,
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        boxShadow: `0 ${fs * 0.2}px ${fs * 0.8}px rgba(0,0,0,.35)`,
      }}
    >
      {text}
    </div>
  );
}

/** Корона лидера: покачивается над пузырём. */
function Crown({ R, minDim }: { R: number; minDim: number }) {
  // У огромного лидера корона не должна закрывать соседей.
  const w = Math.min(R * 0.5, minDim * 0.13);
  return (
    <svg className="sof-crown" width={w} height={w * 0.72} viewBox="0 0 100 72" style={{ position: 'absolute', left: '50%', top: -w * 0.46, overflow: 'visible' } as CSSProperties} aria-hidden>
      <defs>
        <linearGradient id="sofGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff1b8" />
          <stop offset=".45" stopColor="#f2c14e" />
          <stop offset="1" stopColor="#c98a1e" />
        </linearGradient>
      </defs>
      <path d="M8 62 L4 18 L28 38 L50 4 L72 38 L96 18 L92 62 Z" fill="url(#sofGold)" stroke="#8a5a10" strokeWidth="2.5" strokeLinejoin="round" />
      <rect x="8" y="58" width="84" height="12" rx="4" fill="url(#sofGold)" stroke="#8a5a10" strokeWidth="2.5" />
      <circle cx="50" cy="4" r="5" fill="#fff8e1" />
      <circle cx="4" cy="18" r="4.5" fill="#fff8e1" />
      <circle cx="96" cy="18" r="4.5" fill="#fff8e1" />
      <circle cx="50" cy="44" r="6" fill="#d0352c" />
      <circle cx="27" cy="50" r="4" fill="#4b5da5" />
      <circle cx="73" cy="50" r="4" fill="#2ea86b" />
    </svg>
  );
}

/** Человечек, которого «отправили» в церковь: кремовый, с тёмным контуром - виден на любом фоне. */
const PERSON_SVG =
  '<svg viewBox="-2 -2 24 31" width="100%" height="100%" aria-hidden><circle cx="10" cy="6" r="5.4" fill="#fff8ec" stroke="#241b26" stroke-width="1.6"/><path d="M1.2 27.5 v-6.6 a8.8 8.8 0 0 1 17.6 0 V27.5 Z" fill="#fff8ec" stroke="#241b26" stroke-width="1.6" stroke-linejoin="round"/></svg>';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Шрифт Unbounded догрузился - пересчитываем переносы названий. */
function useFontsVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let alive = true;
    void document.fonts?.load(`700 64px "Unbounded Variable"`).then(() => alive && setV((x) => x + 1));
    void document.fonts?.ready.then(() => alive && setV((x) => x + 1));
    return () => {
      alive = false;
    };
  }, []);
  return v;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.66;
  measureCtx.font = `700 ${size}px "Unbounded Variable", system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

function wrap(words: string[], size: number, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next, size) > maxW) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Название в пузыре: крупно, не больше двух строк; длинное - мельче. */
export function fitName(title: string, R: number): { size: number; lines: string[] } {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const maxW = R * 1.36;
  const min = Math.max(R * 0.08, 9);
  let size = R * 0.19;
  for (let i = 0; i < 24; i++) {
    const lines = wrap(words, size, maxW);
    if (lines.length <= 2 && lines.every((l) => measure(l, size) <= maxW)) return { size, lines };
    if (size * 0.92 < min) break;
    size *= 0.92;
  }
  const lines = wrap(words, min, maxW);
  return { size: min, lines: lines.length > 3 ? [...lines.slice(0, 2), `${lines.slice(2).join(' ').slice(0, 14)}…`] : lines };
}
