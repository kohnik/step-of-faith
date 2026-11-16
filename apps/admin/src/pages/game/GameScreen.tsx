import '@fontsource-variable/unbounded/wght.css';
import type { GameScreenView } from '@sof/shared';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useGameScreen } from '../../api/game.ts';
import { BubbleStage, DISPLAY, peopleWord } from './BubbleStage.tsx';
import { BrandMark, ChurchArt, CREAM, Flag, shade } from './ChurchArt.tsx';
import { mmss, useCountdown } from './common.tsx';
import { Confetti } from './Confetti.tsx';
import { GameScene } from './StageScene.tsx';

type Round = NonNullable<GameScreenView['round']>;

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const SECTION = '#352937';
const RED = '#d0352c';
const CORAL = '#ff7a6e';
const MUTED = 'rgba(237,232,208,.66)';

/**
 * Единица экрана: 1/100 ширины для 16:9 (на 1920×1080 - 19,2 px, на 4K - 38,4 px). На других пропорциях - по меньшей стороне,
 * так что шапка и полоса голосования одинаково смотрятся на ноутбуке, проекторе 4:3 и телевизоре 65″.
 */
const u = (n: number) => `calc(var(--u) * ${n})`;

/**
 * Большой экран для проектора и телевизора: пузыри команд растут от отправленных людей, голоса прилетают человечками,
 * во время раунда - за кого голосуем и таймер, в конце - пьедестал и конфетти.
 * Без входа: секретная ссылка от ведущего. Опрос сервера - раз в секунду.
 */
export default function GameScreen({ token }: { token: string }) {
  const screen = useGameScreen(token);
  const data = screen.data;
  // Поправка на часы компьютера у экрана: таймер - по часам сервера.
  const offset = data ? Date.parse(data.serverTime) - screen.dataUpdatedAt : 0;
  const left = useCountdown(data?.round?.closesAt ?? null, offset);
  useEffect(() => {
    document.title = 'Миссия: церкви · большой экран';
  }, []);

  // Итоги показали - залп конфетти (и ещё раз, если показали снова).
  const [fire, setFire] = useState(0);
  const shown = useRef<boolean | null>(null);
  useEffect(() => {
    if (!data) return;
    if (shown.current !== true && data.resultsShown) setFire((f) => f + 1);
    shown.current = data.resultsShown;
  }, [data]);

  const total = data?.teams.reduce((s, t) => s + t.points, 0) ?? 0;
  const voting = data?.round && !data.resultsShown ? data.round : null;
  // «Отправлено» и «голосовали» - только когда голосование началось: до него это пустые нули.
  const counting = total > 0 || !!data?.round || !!data?.resultsShown;
  const bar = usePresence(voting, 450);
  // Пузыри - на голосовании и итогах; закрыли голосование - ещё несколько секунд, пока долетают последние голоса.
  const bubbles = useHold(!!voting || !!data?.resultsShown, 4000);
  // В остальное время - сцена: выступающая команда или заставка. Смена команды - внутри сцены, без пузырей между ними.
  const sceneOn = !!data && !bubbles;
  const sceneStage = data?.stage ?? null;
  const sceneValue = useMemo(() => (sceneOn ? { stage: sceneStage } : null), [sceneOn, sceneStage]);
  const scene = usePresence(sceneValue, 450);
  // Экран открыли посреди сцены - показываем её сразу; потом (после голосования) - проявляем.
  const firstScene = useRef<boolean | null>(null);
  if (data && firstScene.current === null) firstScene.current = sceneOn;
  if (!scene.value && firstScene.current) firstScene.current = false;
  const winners = useMemo(() => (data ? [...data.teams].sort((a, b) => b.points - a.points).slice(0, 3).map((t) => t.color) : []), [data]);

  return (
    <div style={styles.page}>
      <style>{CSS}</style>
      <Backdrop />
      {!data ? (
        <div style={{ margin: 'auto', textAlign: 'center', position: 'relative', zIndex: 2 }}>
          <div style={{ width: u(5), height: u(5), margin: '0 auto' }}>
            <BrandMark size="100%" />
          </div>
          <div style={{ marginTop: u(1.2), fontFamily: DISPLAY, fontSize: u(1.5), color: MUTED }}>
            {screen.isError ? 'Ссылка на экран устарела - возьмите новую у ведущего' : 'Загружаем…'}
          </div>
        </div>
      ) : (
        <>
          <Header eventName={data.eventName} total={total} voters={data.totalVoters} stats={counting} />
          {bar.value && <VotingBar round={bar.value} hint={data.hint} left={bar.leaving ? 0 : left} leaving={bar.leaving} />}
          <div style={{ flex: 1, minHeight: 0, position: 'relative', zIndex: 2 }}>
            {data.teams.length === 0 ? (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: DISPLAY, fontSize: u(1.8), color: MUTED }}>Команды ещё не созданы</div>
            ) : (
              <BubbleStage teams={data.teams} current={voting?.teamId ?? null} results={data.resultsShown} />
            )}
            {data.resultsShown && <ResultsTitle empty={total === 0} />}
          </div>
          {/* Сцена - на весь экран, поверх шапки: крупнее текст задания. */}
          {scene.value && (
            <GameScene stage={scene.value.stage} teams={data.teams} phase={data.phase} eventName={data.eventName} leaving={scene.leaving} appear={!firstScene.current} />
          )}
          <Confetti fire={fire} colors={winners} />
        </>
      )}
    </div>
  );
}

function Header({ eventName, total, voters, stats }: { eventName: string; total: number; voters: number; stats: boolean }) {
  const t = useCountUp(total);
  const v = useCountUp(voters);
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: u(1.2), position: 'relative', zIndex: 3, flexWrap: 'wrap' }}>
      <div style={{ width: u(3.9), height: u(3.9), flexShrink: 0 }}>
        <BrandMark size="100%" />
      </div>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ fontFamily: DISPLAY, fontSize: u(0.88), fontWeight: 600, letterSpacing: '.22em', textTransform: 'uppercase', color: CORAL, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {eventName} · миссионерская игра
        </div>
        <div style={{ fontFamily: DISPLAY, fontSize: u(2.75), fontWeight: 800, lineHeight: 1.05, textTransform: 'uppercase', letterSpacing: '-.01em' }}>Миссия: церкви</div>
      </div>
      {stats && (
        <>
          <HeaderStat value={t} label={`${peopleWord(total)} отправлено`} accent />
          <HeaderStat value={v} label="голосовали" />
        </>
      )}
    </header>
  );
}

function HeaderStat({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return (
    <div
      style={{
        textAlign: 'right',
        padding: `${u(0.55)} ${u(1.35)}`,
        borderRadius: u(1.15),
        background: accent ? RED : SECTION,
        color: accent ? '#fff8ec' : CREAM,
        minWidth: u(9.5),
      }}
    >
      <div style={{ fontFamily: DISPLAY, fontSize: u(2.7), fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: u(0.88), fontWeight: 600, opacity: 0.9, marginTop: u(0.2), whiteSpace: 'nowrap' }}>{label}</div>
    </div>
  );
}

/** Полоса «Сейчас голосуем»: команда, кольцевой таймер, сколько проголосовало. Въезжает сверху, уезжает плавно. */
function VotingBar({ round, hint, left, leaving }: { round: Round; hint: string; left: number | null; leaving: boolean }) {
  const team = round.team;
  const voters = useCountUp(round.voters);
  return (
    <div
      className={leaving ? 'sof-bar-out' : 'sof-bar-in'}
      style={{
        position: 'relative',
        zIndex: 3,
        display: 'flex',
        alignItems: 'center',
        gap: u(1.6),
        padding: `${u(0.85)} ${u(1.7)} ${u(0.85)} ${u(1.1)}`,
        borderRadius: u(1.8),
        // Плотная карточка, как в мини-апке: без прозрачности и свечения; цвет команды - в шаре слева.
        background: SECTION,
        boxShadow: `0 ${u(0.25)} ${u(0.9)} rgba(0,0,0,.28)`,
      }}
    >
      {team ? <MiniBall color={team.color} size={u(5.4)} /> : <BudgetBalls />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: DISPLAY, fontSize: u(0.85), fontWeight: 700, letterSpacing: '.2em', textTransform: 'uppercase', color: CORAL }}>
          {team ? 'Сейчас голосуем за церковь' : 'Голосование открыто'}
        </div>
        <div style={{ fontFamily: DISPLAY, fontSize: u(2.75), fontWeight: 800, lineHeight: 1.1, marginTop: u(0.2), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {team ? team.title : 'Раздайте людей между церквями'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(0.7), marginTop: u(0.35), fontSize: u(1.08), color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {team?.countryCode && (
            <>
              <Flag code={team.countryCode} height={u(1.15)} />
              <span style={{ color: CREAM, fontWeight: 600 }}>{team.countryName}</span>
              {hint && <span>·</span>}
            </>
          )}
          {/* Подсказка - из настроек игры («Тексты»). */}
          {hint && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</span>}
        </div>
      </div>
      {left !== null && <TimerRing left={left} closesAt={round.closesAt} />}
      <div style={{ textAlign: 'center', minWidth: u(7.5) }}>
        <div style={{ fontFamily: DISPLAY, fontSize: u(3.4), fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{voters}</div>
        <div style={{ fontSize: u(0.85), fontWeight: 700, color: MUTED, marginTop: u(0.35), letterSpacing: '.1em', textTransform: 'uppercase' }}>проголосовали</div>
      </div>
    </div>
  );
}

/** Кольцо таймера: полный круг - сколько было, когда открыли (или продлили) раунд. */
function TimerRing({ left, closesAt }: { left: number; closesAt: string | null }) {
  const full = useRef<{ key: string | null; total: number }>({ key: null, total: 1 });
  if (full.current.key !== closesAt) full.current = { key: closesAt, total: Math.max(left, 1) };
  const frac = Math.max(0, Math.min(1, left / full.current.total));
  const hurry = left <= 10;
  const C = 2 * Math.PI * 44;
  return (
    <div style={{ position: 'relative', width: u(6.4), height: u(6.4), flexShrink: 0 }} className={hurry && left > 0 ? 'sof-tick' : undefined}>
      <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ transform: 'rotate(-90deg)', overflow: 'visible' }}>
        <circle cx="50" cy="50" r="44" fill="#241b26" stroke="rgba(237,232,208,.14)" strokeWidth="7" />
        <circle
          cx="50"
          cy="50"
          r="44"
          fill="none"
          stroke={hurry ? CORAL : CREAM}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke .3s' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: DISPLAY, fontWeight: 800, fontSize: u(1.55), fontVariantNumeric: 'tabular-nums', color: hurry ? CORAL : CREAM }}>
        {mmss(left)}
      </div>
    </div>
  );
}

/** Маленький пузырь с церковью - в полосе голосования. */
function MiniBall({ color, size }: { color: string; size: string }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        background: `radial-gradient(circle at 33% 27%, ${shade(color, 0.42)}, ${color} 55%, ${shade(color, -0.38)})`,
        boxShadow: `inset 0 ${u(-0.3)} ${u(0.8)} rgba(0,0,0,.22), inset 0 0 0 ${u(0.06)} rgba(255,248,236,.16)`,
      }}
    >
      <div style={{ width: '46%' }}>
        <ChurchArt color={color} size={100} tone="light" flat style={{ width: '100%', height: 'auto' }} />
      </div>
    </div>
  );
}

function BudgetBalls() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: u(0.2) }}>
      <MiniBall color="#4b5da5" size={u(3.4)} />
      <MiniBall color={RED} size={u(5)} />
      <MiniBall color="#2ea86b" size={u(3.4)} />
    </div>
  );
}

function ResultsTitle({ empty }: { empty: boolean }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: u(0.4), display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
      <div className="sof-title" style={{ fontFamily: DISPLAY, fontWeight: 900, fontSize: u(1.9), letterSpacing: '.24em', textTransform: 'uppercase' }}>
        {empty ? 'Голосов пока нет' : 'Итоги игры'}
      </div>
    </div>
  );
}

/** Фон: сливовый с «зерном», как мини-апка, и редкие поднимающиеся пузырьки. */
function Backdrop() {
  const dots = useMemo(
    () =>
      Array.from({ length: 16 }, () => ({
        left: Math.random() * 100,
        size: 0.35 + Math.random() * 1.6,
        dur: 26 + Math.random() * 30,
        delay: -Math.random() * 50,
        drift: (Math.random() - 0.5) * 10,
        op: 0.04 + Math.random() * 0.06,
      })),
    [],
  );
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      {dots.map((d, i) => (
        <span
          key={i}
          className="sof-rise"
          style={
            {
              left: `${d.left}%`,
              width: u(d.size),
              height: u(d.size),
              opacity: d.op,
              animationDuration: `${d.dur}s`,
              animationDelay: `${d.delay}s`,
              '--drift': `${d.drift}vw`,
            } as CSSProperties
          }
        />
      ))}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 60%, rgba(0,0,0,.22) 100%)' }} />
    </div>
  );
}

/** Значение «докручивается» к новому за ~0,9 с. */
function useCountUp(value: number, ms = 900): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const a = from.current;
    if (a === value) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const v = a + (value - a) * (1 - (1 - k) ** 3);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return Math.round(shown);
}

/** `true`, пока `on`, и ещё `ms` после того, как стало `false`. */
function useHold(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  useEffect(() => {
    if (on) {
      setHeld(true);
      return;
    }
    const t = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return on || held;
}

/** Держим последнее значение ещё `ms` после исчезновения - чтобы проиграть анимацию ухода. */
function usePresence<T>(value: T | null, ms: number): { value: T | null; leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (value) {
      setKept(value);
      setLeaving(false);
      return;
    }
    if (!kept) return;
    setLeaving(true);
    const t = window.setTimeout(() => {
      setKept(null);
      setLeaving(false);
    }, ms);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return { value: value ?? kept, leaving: !value && leaving };
}

/** «Зерно» тёмной темы мини-апки: кремовые крапинки на сливовом. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .88 0 0 0 0 .86 0 0 0 0 .75 0.6 0 0 0 -.29'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const styles: Record<string, CSSProperties> = {
  page: {
    // 1/100 ширины для 16:9, на «вытянутых» экранах - по высоте.
    ['--u' as string]: 'min(1vw, 1.7778vh)',
    position: 'relative',
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    gap: u(1.2),
    // Поля с запасом: телевизоры часто обрезают края картинки (overscan).
    padding: `${u(1.6)} ${u(2.2)} ${u(1.4)}`,
    color: CREAM,
    backgroundColor: '#241b26',
    backgroundImage: GRAIN,
    // Крупность зерна - как в мини-апке на телефоне, на любом экране.
    backgroundSize: `${u(9.4)} ${u(9.4)}`,
    fontFamily: SANS,
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
};

const CSS = `
@keyframes sofRise { from { transform: translate3d(0,0,0) } to { transform: translate3d(var(--drift), calc(-100vh - 120%), 0) } }
.sof-rise { position:absolute; bottom:-6%; border-radius:50%; background: radial-gradient(circle at 35% 30%, rgba(255,255,255,.9), rgba(237,232,208,.35) 45%, rgba(237,232,208,.05) 70%); box-shadow: inset 0 0 0 1px rgba(237,232,208,.35); animation-name: sofRise; animation-timing-function: linear; animation-iteration-count: infinite; }
.sof-ring { position:absolute; inset:-5%; border-radius:50%; border-style:solid; border-color: rgba(237,232,208,.6); animation: sofPulse 2.4s cubic-bezier(.2,.6,.3,1) infinite; pointer-events:none; }
@keyframes sofPulse { 0% { transform: scale(.97); opacity:.95 } 100% { transform: scale(1.32); opacity:0 } }
.sof-crown { transform-origin: 50% 100%; animation: sofCrown 3.2s ease-in-out infinite; filter: drop-shadow(0 3px 6px rgba(0,0,0,.3)); }
@keyframes sofCrown { 0%,100% { transform: translateX(-50%) translateY(0) rotate(-7deg) } 50% { transform: translateX(-50%) translateY(-7%) rotate(-2deg) } }
.sof-plus { position:absolute; font-family: ${DISPLAY}; font-weight: 900; color: #fff8ec; white-space: nowrap; pointer-events:none; text-shadow: 0 .05em 0 #241b26, 0 .08em .2em rgba(36,27,38,.6); animation: sofPlus 1.9s cubic-bezier(.2,.8,.2,1) .25s both; }
@keyframes sofPlus { 0% { transform: translate(-50%,-50%) scale(.3); opacity:0 } 16% { transform: translate(-50%,-70%) scale(1.18); opacity:1 } 30% { transform: translate(-50%,-80%) scale(1) } 72% { opacity:1 } 100% { transform: translate(-50%,-190%) scale(.95); opacity:0 } }
.sof-walk-x { position:absolute; animation-name: sofWalkX; animation-timing-function: cubic-bezier(.4,0,.6,1); animation-fill-mode: both; pointer-events:none; }
@keyframes sofWalkX { from { transform: translateX(0) } to { transform: translateX(var(--dx)) } }
.sof-walk-y { animation-name: sofWalkY; animation-timing-function: cubic-bezier(.15,.75,.35,1); animation-fill-mode: both; filter: drop-shadow(0 .12em .2em rgba(0,0,0,.4)); }
@keyframes sofWalkY { 0% { transform: translate(-50%,0) scale(.5); opacity:0 } 10% { opacity:1 } 82% { opacity:1; transform: translate(-50%, calc(var(--dy) * .97)) scale(1) } 100% { transform: translate(-50%, var(--dy)) scale(.15); opacity:0 } }
.sof-spark { position:absolute; width: var(--s); height: var(--s); border-radius:50%; background: var(--c); pointer-events:none; animation: sofSpark .9s ease-out both; }
@keyframes sofSpark { 0% { transform: translate(-50%,-50%) scale(1.2); opacity:0 } 15% { opacity:1 } 100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(.2); opacity:0 } }
.sof-bar-in { animation: sofBarIn .55s cubic-bezier(.2,.9,.25,1.15) both; }
.sof-bar-out { animation: sofBarOut .45s cubic-bezier(.5,0,.75,0) both; }
@keyframes sofBarIn { from { opacity:0; transform: translateY(-40%) scale(.97) } to { opacity:1; transform: none } }
@keyframes sofBarOut { from { opacity:1; transform:none } to { opacity:0; transform: translateY(-30%) scale(.97) } }
.sof-tick { animation: sofTick 1s ease-in-out infinite; }
@keyframes sofTick { 0%,100% { transform: scale(1) } 50% { transform: scale(1.07) } }
.sof-title { color: #ff7a6e; animation: sofTitleIn .9s cubic-bezier(.2,.9,.25,1.2) both; }
@keyframes sofTitleIn { from { opacity:0; transform: translateY(-40%) scale(.9) } to { opacity:1; transform:none } }
@media (prefers-reduced-motion: reduce) { .sof-rise, .sof-ring, .sof-crown, .sof-tick, .sof-title { animation: none !important; } }
`;
