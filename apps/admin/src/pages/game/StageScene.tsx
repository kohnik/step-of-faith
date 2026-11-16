import { GAME_TEAM_COLORS, type GameScreenView } from '@sof/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { renderMarkdown } from '../../lib/markdown.tsx';
import { DISPLAY } from './BubbleStage.tsx';
import { BrandMark, ChurchArt, CREAM, Flag, PLUM, shade } from './ChurchArt.tsx';

type Stage = NonNullable<GameScreenView['stage']>;
type Team = GameScreenView['teams'][number];

const u = (n: number) => `calc(var(--u) * ${n})`;
const CORAL = '#ff7a6e';
const MUTED = 'rgba(237,232,208,.7)';
/** Фон заставки: сливовый чуть светлее страницы. */
const SPLASH_BG = '#4a2f45';
const SWAP_MS = 450;

/** Шары фона: одни и те же на всё время сцены - при смене команды меняется только цвет. */
const BALLS = Array.from({ length: 10 }, (_, i) => ({
  left: (i * 10.7 + Math.random() * 7) % 100,
  size: 6 + Math.random() * 14,
  dur: 22 + Math.random() * 18,
  delay: -Math.random() * 40,
  op: 0.16 + Math.random() * 0.18,
}));

/**
 * Сцена вне голосования: выступающая команда (флаг, название, контекст и задание) или заставка, если на сцене никого.
 * Фон и шары не перерисовываются при смене команды: плавно меняется цвет, а содержимое - перетекает.
 * Так между командами не проглядывают пузыри и не мелькает заставка.
 */
export function GameScene({
  stage,
  teams,
  phase,
  eventName,
  leaving,
  appear,
}: {
  stage: Stage | null;
  teams: Team[];
  phase: GameScreenView['phase'];
  eventName: string;
  leaving: boolean;
  /** Проявиться плавно; без этого - сразу (экран только открыли - пузыри под сценой не мелькают). */
  appear: boolean;
}) {
  const color = stage?.team.color ?? null;
  const palette = teams.length ? teams.map((t) => t.color) : GAME_TEAM_COLORS;
  const items = useCrossfade(stage ? `team:${stage.team.id}` : 'splash', stage, SWAP_MS);
  return (
    <div
      className={leaving ? 'sof-stage-out' : appear ? 'sof-stage-in' : 'sof-stage-on'}
      style={
        {
          position: 'absolute',
          inset: 0,
          zIndex: 20,
          overflow: 'hidden',
          // Поля - как у страницы: телевизоры обрезают края (overscan).
          padding: `${u(1.2)} ${u(1.6)}`,
          boxSizing: 'border-box',
          '--sof-bg': color ? shade(color, -0.35) : SPLASH_BG,
          background: `radial-gradient(ellipse at 50% 30%, var(--sof-bg) 0%, ${PLUM} 72%)`,
        } as CSSProperties
      }
    >
      <style>{CSS}</style>
      <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {BALLS.map((b, i) => {
          const c = color ?? palette[i % palette.length]!;
          return (
            <span
              key={i}
              className="sof-stage-ball"
              style={
                {
                  left: `${b.left}%`,
                  width: u(b.size),
                  height: u(b.size),
                  opacity: b.op,
                  animationDuration: `${b.dur}s`,
                  animationDelay: `${b.delay}s`,
                  '--sof-a': shade(c, 0.45),
                  '--sof-b': c,
                  '--sof-c': shade(c, -0.4),
                } as CSSProperties
              }
            />
          );
        })}
      </div>
      <div style={{ position: 'relative', height: '100%', display: 'grid' }}>
        {items.map((it) => (
          <div key={it.key} className={it.leaving ? 'sof-swap-out' : 'sof-swap-in'} style={{ gridArea: '1 / 1', minWidth: 0, minHeight: 0 }}>
            {it.value ? <TeamOnStage stage={it.value} /> : <Splash teams={teams} phase={phase} eventName={eventName} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Длинное задание (контекст и задание вместе) - команда полосой сверху, текст на всю ширину в две колонки. */
const WIDE_FROM = 450;

/** Выступает команда: флаг, название, контекст и задание; шрифт - самый крупный, какой влезает. */
function TeamOnStage({ stage }: { stage: Stage }) {
  const { team, task } = stage;
  const context = useMemo(() => (task?.context ? renderMarkdown(task.context) : []), [task?.context]);
  const body = useMemo(() => (task?.text ? renderMarkdown(task.text) : []), [task?.text]);
  // Под названием - страна и номер; у команды без названия номер уже в заголовке («Команда 3»).
  const sub = [team.countryName, team.placeholder ? null : `команда ${team.number}`].filter(Boolean).join(' · ');
  const wide = !!task && task.context.length + task.text.length >= WIDE_FROM;
  const flag = (height: number) =>
    team.countryCode ? (
      <Flag
        code={team.countryCode}
        height={u(height)}
        style={{ borderRadius: u(height / 10), boxShadow: `0 ${u(0.6)} ${u(2.4)} rgba(0,0,0,.45), 0 0 0 ${u(0.15)} rgba(255,248,236,.25)` }}
      />
    ) : (
      <ChurchArt color={team.color} size={100} style={{ display: 'block', width: u(height * 0.9), height: 'auto' }} />
    );
  const card = (
    <div
      className="sof-task-in"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        alignSelf: 'stretch',
        display: 'flex',
        flexDirection: 'column',
        padding: `${u(1.8)} ${u(2.2)}`,
        borderRadius: u(1.8),
        background: 'rgba(36,27,38,.8)',
        boxShadow: `0 ${u(0.4)} ${u(1.6)} rgba(0,0,0,.35), inset 0 0 0 ${u(0.08)} rgba(237,232,208,.12)`,
      }}
    >
      {task ? (
        <FitText fitKey={`${wide}\n${task.title}\n${task.context}\n${task.text}`} min={0.8} max={wide ? 1.9 : 2.3}>
          <div style={{ fontFamily: DISPLAY, fontSize: '1.3em', fontWeight: 800, lineHeight: 1.12 }}>{task.title}</div>
          {/* В две колонки - только когда есть и контекст, и задание. */}
          <div style={wide && context.length > 0 && body.length > 0 ? { display: 'flex', gap: '1.6em', alignItems: 'flex-start' } : undefined}>
            {context.length > 0 && (
              <div style={{ flex: '1 1 0', minWidth: 0 }}>
                <Label>Контекст</Label>
                <div className="sof-stage-text" style={{ lineHeight: 1.38, color: 'rgba(237,232,208,.86)' }}>
                  {context}
                </div>
              </div>
            )}
            {body.length > 0 && (
              <div style={{ flex: '1 1 0', minWidth: 0 }}>
                <Label>Задание</Label>
                <div
                  className="sof-stage-text"
                  style={{ lineHeight: 1.38, fontWeight: 600, color: CREAM, borderLeft: `max(.14em, ${u(0.2)}) solid ${CORAL}`, paddingLeft: '.6em' }}
                >
                  {body}
                </div>
              </div>
            )}
          </div>
        </FitText>
      ) : (
        <div style={{ margin: 'auto 0', fontSize: u(1.8), color: MUTED }}>Задание не выбрано</div>
      )}
    </div>
  );

  if (wide) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: u(1.2), padding: `${u(1.4)} ${u(1.8)} ${u(1.6)}`, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(1.4), minWidth: 0 }}>
          <div className="sof-flag-pop" style={{ lineHeight: 0, flexShrink: 0 }}>
            {flag(4.6)}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: DISPLAY, fontSize: u(0.85), fontWeight: 700, letterSpacing: '.3em', textTransform: 'uppercase', color: CORAL }}>Выступает</div>
            <div
              style={{
                fontFamily: DISPLAY,
                fontSize: u(2.4),
                fontWeight: 800,
                lineHeight: 1.1,
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {team.title}
            </div>
          </div>
          {sub && <div style={{ flexShrink: 0, fontSize: u(1.35), fontWeight: 700, color: MUTED }}>{sub}</div>}
        </div>
        {card}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', gap: u(2.6), padding: `${u(2)} ${u(2.6)}`, boxSizing: 'border-box' }}>
      {/* Слева - кто выступает: флаг (или церковь), крупно название, под ним страна и номер. */}
      <div style={{ flex: '0 0 29%', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', minWidth: 0 }}>
        <div style={{ fontFamily: DISPLAY, fontSize: u(1.05), fontWeight: 700, letterSpacing: '.3em', textTransform: 'uppercase', color: CORAL }}>Выступает</div>
        <div className="sof-flag-pop" style={{ marginTop: u(1.4), lineHeight: 0 }}>
          {flag(11)}
        </div>
        <div
          style={{
            marginTop: u(1.4),
            maxWidth: '100%',
            fontFamily: DISPLAY,
            fontSize: u(team.title.length > 18 ? 2.1 : 2.7),
            fontWeight: 800,
            lineHeight: 1.05,
            textTransform: 'uppercase',
            overflowWrap: 'anywhere',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {team.title}
        </div>
        {sub && <div style={{ marginTop: u(0.7), fontSize: u(1.35), fontWeight: 700, color: MUTED }}>{sub}</div>}
      </div>
      {card}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        margin: '.95em 0 .3em',
        fontFamily: DISPLAY,
        fontSize: `max(.46em, ${u(0.75)})`,
        fontWeight: 700,
        letterSpacing: '.24em',
        textTransform: 'uppercase',
        color: CORAL,
      }}
    >
      {children}
    </div>
  );
}

/** Заставка, пока на сцене никого: знак и название игры, команды (флаги - когда их открыли). */
function Splash({ teams, phase, eventName }: { teams: Team[]; phase: GameScreenView['phase']; eventName: string }) {
  const note = phase === 'revealed' ? 'Выступления церквей' : phase === 'started' ? 'Игра начинается' : 'Скоро начнём';
  const ordered = [...teams].sort((a, b) => a.number - b.number);
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: `${u(2)} ${u(3)}`, boxSizing: 'border-box', textAlign: 'center' }}>
      <div className="sof-float" style={{ width: u(8), height: u(8) }}>
        <BrandMark size="100%" />
      </div>
      <div style={{ marginTop: u(1.8), fontFamily: DISPLAY, fontSize: u(1.05), fontWeight: 600, letterSpacing: '.22em', textTransform: 'uppercase', color: CORAL }}>
        {eventName} · миссионерская игра
      </div>
      <div style={{ marginTop: u(0.5), fontFamily: DISPLAY, fontSize: u(4.6), fontWeight: 800, lineHeight: 1.05, textTransform: 'uppercase', letterSpacing: '-.01em' }}>Миссия: церкви</div>
      <div style={{ marginTop: u(0.9), fontSize: u(1.8), fontWeight: 700, color: MUTED }}>{note}</div>
      {ordered.length > 0 && (
        <div style={{ marginTop: u(2.6), display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: u(0.8), maxWidth: '88%' }}>
          {ordered.map((t) => (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: u(0.6),
                padding: `${u(0.5)} ${u(1)} ${u(0.5)} ${u(0.6)}`,
                borderRadius: 999,
                background: 'rgba(36,27,38,.72)',
                boxShadow: `inset 0 0 0 ${u(0.08)} ${t.color}`,
                fontSize: u(1.15),
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              {t.countryCode ? (
                <Flag code={t.countryCode} height={u(1.3)} />
              ) : (
                <span style={{ width: u(1.3), height: u(1.3), borderRadius: '50%', background: t.color, flexShrink: 0 }} />
              )}
              {t.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Самый крупный шрифт (в единицах экрана, от `min` до `max`), при котором текст влезает в рамку.
 * Внутри размеры - в em: заголовок, подписи и абзацы растут вместе.
 */
function FitText({ fitKey, min, max, children }: { fitKey: string; min: number; max: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const b = box.current;
    const el = inner.current;
    if (!b || !el) return;
    const fit = () => {
      const unit = Math.min(window.innerWidth / 100, (window.innerHeight * 1.7778) / 100);
      const fits = (px: number) => {
        el.style.fontSize = `${px}px`;
        return el.offsetHeight <= b.clientHeight;
      };
      let lo = min * unit;
      let hi = max * unit;
      if (fits(hi)) return;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      fits(lo);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    // Шрифт заголовка догружается - пересчитать.
    void document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [fitKey, min, max]);
  return (
    <div ref={box} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div ref={inner} style={{ flexShrink: 0 }}>
        {children}
      </div>
    </div>
  );
}

/** Смена содержимого с перетеканием: прежнее ещё `ms` уходит поверх нового, новое проявляется. */
function useCrossfade<T>(key: string, value: T, ms: number): { key: string; value: T; leaving: boolean }[] {
  const [gone, setGone] = useState<{ key: string; value: T }[]>([]);
  const last = useRef({ key, value });
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { key, value };
    if (prev.key === key) return;
    setGone((list) => [...list.filter((x) => x.key !== key && x.key !== prev.key), prev]);
    timers.current.push(window.setTimeout(() => setGone((list) => list.filter((x) => x !== prev)), ms));
  }, [key, value, ms]);
  return [...gone.filter((x) => x.key !== key).map((x) => ({ ...x, leaving: true })), { key, value, leaving: false }];
}

// Цвета фона и шаров - зарегистрированные свойства: тогда их можно плавно менять (transition), а не прыжком.
const CSS = `
@property --sof-bg { syntax: '<color>'; inherits: false; initial-value: #4a2f45; }
@property --sof-a { syntax: '<color>'; inherits: false; initial-value: #ede8d0; }
@property --sof-b { syntax: '<color>'; inherits: false; initial-value: #d0352c; }
@property --sof-c { syntax: '<color>'; inherits: false; initial-value: #241b26; }
.sof-stage-in, .sof-stage-on { transition: --sof-bg 1.1s ease; }
.sof-stage-in { animation: sofStageIn .7s cubic-bezier(.2,.9,.25,1.05) both; }
.sof-stage-out { animation: sofStageOut .45s cubic-bezier(.5,0,.75,0) both; }
@keyframes sofStageIn { from { opacity:0; transform: scale(.96) } to { opacity:1; transform:none } }
@keyframes sofStageOut { from { opacity:1; transform:none } to { opacity:0; transform: scale(.97) } }
.sof-swap-in { animation: sofSwapIn .55s ease-out .12s both; }
.sof-swap-out { animation: sofSwapOut ${SWAP_MS}ms ease-in both; pointer-events: none; }
@keyframes sofSwapIn { from { opacity:0; transform: translateY(1.5%) } to { opacity:1; transform:none } }
@keyframes sofSwapOut { from { opacity:1 } to { opacity:0 } }
.sof-flag-pop { animation: sofFlagPop .9s cubic-bezier(.2,.9,.25,1.3) .2s both; }
@keyframes sofFlagPop { from { opacity:0; transform: translateY(12%) scale(.7) rotate(-4deg) } to { opacity:1; transform:none } }
.sof-task-in { animation: sofTaskIn .8s cubic-bezier(.2,.9,.25,1) .3s both; }
@keyframes sofTaskIn { from { opacity:0; transform: translateX(4%) } to { opacity:1; transform:none } }
.sof-float { animation: sofFloat 5s ease-in-out infinite; filter: drop-shadow(0 .6vw 1.4vw rgba(0,0,0,.35)); }
@keyframes sofFloat { 0%,100% { transform: translateY(0) rotate(-2deg) } 50% { transform: translateY(-7%) rotate(2deg) } }
.sof-stage-ball { position:absolute; bottom:-25%; border-radius:50%; filter: blur(1px); background: radial-gradient(circle at 33% 27%, var(--sof-a), var(--sof-b) 55%, var(--sof-c)); transition: --sof-a 1.1s ease, --sof-b 1.1s ease, --sof-c 1.1s ease; animation-name: sofStageRise; animation-timing-function: linear; animation-iteration-count: infinite; }
@keyframes sofStageRise { from { transform: translate3d(0,0,0) } to { transform: translate3d(0, calc(-100vh - 140%), 0) } }
.sof-stage-text p { margin: 0 0 .5em; }
.sof-stage-text p:last-child { margin-bottom: 0; }
.sof-stage-text ul, .sof-stage-text ol { margin: 0 0 .5em; padding-left: 1.2em; }
@media (prefers-reduced-motion: reduce) { .sof-stage-ball, .sof-flag-pop, .sof-task-in, .sof-float, .sof-swap-in { animation: none !important; } }
`;
