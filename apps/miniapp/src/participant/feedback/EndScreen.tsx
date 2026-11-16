import { IconHeartFilled, IconMessageCircle, IconTools } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { useLocation } from 'wouter';
import { haptic } from '../../lib/feedback.ts';
import { formatEventRange } from '../../lib/time.ts';
import { useBackHandler } from '../../telegram/back.ts';
import { feedbackOf, useMeData } from '../api.ts';
import { Bubbles, Footsteps, Grain, nbsp, Wordmark } from './fx.tsx';

/**
 * «Конец «Шага веры»» - отдельный экран вместо главной: живые пузыри, «пляшущее» название,
 * благодарность и две дороги - оставить отзыв или написать организаторам.
 * `preview` - тот же экран по ссылке /end (посмотреть до включения), с «Назад».
 */
export default function EndScreen({ preview = false }: { preview?: boolean }) {
  const me = useMeData();
  const [, navigate] = useLocation();
  useBackHandler(preview ? () => navigate('/') : null);
  const dates = formatEventRange(me.event.startsAt, me.event.endsAt, me.event.timezone)?.replace(/\s*\d{4}\s*г\.?$/, '');
  const staff = me.roles.length > 0;
  const feedback = feedbackOf(me);
  const go = (path: string) => {
    haptic('light');
    navigate(path);
  };
  const delay = (s: number) => ({ '--delay': `${s}s` }) as CSSProperties;

  return (
    <div
      className="relative flex min-h-[100dvh] flex-col overflow-hidden text-white"
      style={{
        background:
          'radial-gradient(90% 60% at 50% 0%, rgb(208 53 44 / 0.85) 0%, transparent 70%), radial-gradient(80% 50% at 50% 100%, rgb(75 93 165 / 0.7) 0%, transparent 75%), #2a1d2c',
      }}
    >
      <Bubbles count={8} />
      <Grain />
      <main className="relative mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 pt-[calc(var(--safe-top)+28px)] text-center">
        <p className="fb-pop text-[13px] font-bold uppercase tracking-[0.35em] text-white/70">Конференция завершилась</p>
        <Wordmark
          name={me.event.name}
          className="fb-pop mt-5 text-[clamp(44px,15vw,84px)] drop-shadow-[0_6px_24px_rgb(0_0_0/0.35)]"
        />
        {dates && (
          <p className="fb-pop mt-3 font-display text-[13px] font-medium uppercase tracking-[0.25em] text-[#ffd166]" style={delay(0.15)}>
            {dates}
          </p>
        )}
        <Footsteps steps={6} size={16} className="fb-pop mt-7 text-white/80" />
        {me.event.endTitle && (
          <h1 className="fb-pop mt-7 text-balance font-display text-[22px] font-semibold leading-tight" style={delay(0.3)}>
            {nbsp(me.event.endTitle)}
          </h1>
        )}
        {me.event.endText && (
          <p className="fb-pop mt-3 max-w-md whitespace-pre-line text-pretty text-[16px] leading-relaxed text-white/88" style={delay(0.4)}>
            {nbsp(me.event.endText)}
          </p>
        )}
      </main>

      <footer className="relative mx-auto w-full max-w-xl px-6 pb-[calc(var(--safe-bottom)+18px)] pt-6">
        {feedback.visible && (
          <button
            type="button"
            onClick={() => go('/feedback')}
            className="fb-pop fb-shine relative block min-h-14 w-full overflow-hidden rounded-2xl bg-white text-[17px] font-bold text-[#b8302a] shadow-[0_12px_30px_-10px_rgb(0_0_0/0.5)] transition active:scale-[0.98]"
            style={delay(0.55)}
          >
            <span className="inline-flex items-center justify-center gap-2">
              <IconHeartFilled size={20} className="fb-heart text-[#d0352c]" aria-hidden />
              {feedback.mine > 0 ? 'Написать ещё отзыв' : 'Оставить отзыв'}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => go('/questions')}
          className="fb-pop mt-2 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-white/12 text-[17px] font-semibold ring-1 ring-white/25 backdrop-blur-sm transition active:scale-[0.98]"
          style={delay(0.65)}
        >
          <IconMessageCircle size={22} />
          Написать организаторам
        </button>
        {staff && !preview && (
          <div className="fb-pop mt-4 flex justify-center gap-5 text-[14px] font-medium text-white/70" style={delay(0.75)}>
            <button type="button" onClick={() => go('/home')} className="active:opacity-60">
              Обычная главная
            </button>
            <button type="button" onClick={() => go('~/staff')} className="inline-flex items-center gap-1 active:opacity-60">
              <IconTools size={16} />
              Команда
            </button>
          </div>
        )}
        {preview && (
          <p className="mt-4 text-center text-[13px] leading-snug text-white/60">
            Так увидят все, когда в настройках включат «Конец «Шага веры»».
          </p>
        )}
      </footer>
    </div>
  );
}
