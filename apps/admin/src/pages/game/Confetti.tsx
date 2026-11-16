import { useEffect, useRef } from 'react';

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  flip: number;
  vflip: number;
  w: number;
  h: number;
  color: string;
  round: boolean;
  life: number;
}

const COLORS = ['#d0352c', '#ff7a6e', '#ede8d0', '#f2c14e', '#4b5da5', '#9aa8e6', '#2ea86b'];

/**
 * Конфетти на итогах: две «пушки» снизу по краям и дождь сверху, потом стихает. Холст во весь экран,
 * частицы считаем сами - без библиотек и без нагрузки на страницу, когда всё упало.
 */
export function Confetti({ fire, colors = [] }: { fire: number; colors?: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!fire || !canvas || !ctx) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();
    window.addEventListener('resize', resize);
    const W = () => canvas.clientWidth;
    const H = () => canvas.clientHeight;
    const unit = Math.min(W(), H()) / 100;
    const palette = [...COLORS, ...colors];
    const pieces: Piece[] = [];
    const spawn = (x: number, y: number, angle: number, speed: number) => {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const v = speed * (0.55 + Math.random() * 0.6);
      pieces.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 12,
        flip: Math.random() * Math.PI * 2,
        vflip: 4 + Math.random() * 8,
        w: unit * (0.7 + Math.random() * 0.9),
        h: unit * (0.35 + Math.random() * 0.5),
        color: palette[Math.floor(Math.random() * palette.length)]!,
        round: Math.random() < 0.18,
        life: 0,
      });
    };
    // Залп: две пушки снизу, навстречу друг другу.
    for (let i = 0; i < 140; i++) {
      spawn(0, H(), -Math.PI / 3.2, unit * 175);
      spawn(W(), H(), -Math.PI + Math.PI / 3.2, unit * 175);
    }
    let rain = 0;
    let raf = 0;
    let last = performance.now();
    const started = last;
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      // Дождь сверху первые 4 секунды.
      if (now - started < 4000) {
        rain += dt * 90;
        while (rain >= 1) {
          rain -= 1;
          spawn(Math.random() * W(), -unit * 2, Math.PI / 2, unit * 18);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W(), H());
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i]!;
        p.life += dt;
        p.vy += unit * 55 * dt;
        const drag = Math.exp(-1.6 * dt);
        p.vx *= drag;
        p.vy *= drag;
        p.vx += Math.sin(p.flip) * unit * 6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vrot * dt;
        p.flip += p.vflip * dt;
        if (p.y > H() + unit * 5 || p.life > 12) {
          pieces.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.flip));
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.h, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (pieces.length > 0 || now - started < 4000) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W(), H());
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fire]);
  return <canvas ref={ref} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }} />;
}
