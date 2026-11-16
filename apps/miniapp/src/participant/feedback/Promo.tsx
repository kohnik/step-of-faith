import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_INFO, type MeResponse } from '@sof/shared';
import { IconChevronRight } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'wouter';
import { meQuery, saveMe } from '../../api/queries.ts';
import { haptic } from '../../lib/feedback.ts';
import { useBackHandler } from '../../telegram/back.ts';
import { feedbackOf, participantApi } from '../api.ts';
import { Bubbles, Flow, Footsteps, Grain, nbsp } from './fx.tsx';

/** Заставку больше не показываем: и на сервере (на это включение), и сразу в кэше. */
function useDismissPrompt() {
  const qc = useQueryClient();
  return () => {
    const next = qc.setQueryData<MeResponse>(meQuery.queryKey, (m) => (m ? { ...m, feedback: { ...feedbackOf(m), prompt: false } } : m));
    // И в копии на устройстве - иначе при следующем входе заставка мелькнёт до ответа сервера.
    if (next) saveMe(next);
    void participantApi.feedbackSeen().catch(() => undefined);
  };
}

/**
 * Карточка «Оставь отзыв» на главной: живая, слегка «дышит», шаги идут, пузыри всплывают.
 * Уже оставил - спокойная карточка «Спасибо! Можно написать ещё».
 */
export function FeedbackCard({ mine }: { mine: number }) {
  const [, navigate] = useLocation();
  if (mine > 0) {
    return (
      <button
        type="button"
        onClick={() => navigate('/feedback')}
        className="mb-6 flex w-full items-center gap-3 rounded-2xl bg-section p-3.5 text-left ring-1 ring-brand/30 transition active:scale-[0.99] active:opacity-80"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/12 text-[22px]" aria-hidden>
          💛
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold leading-snug">Спасибо за отзыв!</span>
          <span className="mt-0.5 block text-[14px] leading-snug text-subtle">Можно написать ещё - свидетельство, отзыв или пожелание</span>
        </span>
        <IconChevronRight size={20} className="shrink-0 text-hint" aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        haptic('light');
        navigate('/feedback');
      }}
      className="fb-breathe relative mb-6 block w-full overflow-hidden rounded-3xl p-5 text-left text-white transition active:scale-[0.99]"
      style={{ background: '#b8302a' }}
    >
      <Flow />
      <Bubbles count={4} travel="190px" small />
      <Grain />
      <span className="relative flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/18 px-2.5 py-1 text-[12px] font-bold uppercase tracking-wider">
            <span className="fb-bob inline-block size-2 rounded-full bg-[#ffd166]" />
            Нам очень важно
          </span>
          <span className="mt-3 block font-display text-[22px] font-semibold uppercase leading-[1.1] tracking-wide">Оставь отзыв</span>
          <span className="mt-1.5 block text-[15px] leading-snug text-white/90">{nbsp('Твой «Шаг веры» - свидетельство, отзыв или пожелание')}</span>
          <span className="fb-shine relative mt-4 inline-flex items-center gap-1 overflow-hidden rounded-full bg-white px-4 py-2 text-[15px] font-semibold text-[#b8302a]">
            Написать
            <IconChevronRight size={18} />
          </span>
        </span>
        <Footsteps steps={5} size={14} className="mr-1 mt-1 shrink-0 text-white/85" />
      </span>
    </button>
  );
}

/**
 * Заставка на весь экран: впервые после включения отзывов и пока человек их не оставлял.
 * Пузыри, идущие следы, крупная надпись; «Оставить отзыв» или «Позже» - и больше не появится.
 */
export function FeedbackPrompt() {
  const [, navigate] = useLocation();
  const dismiss = useDismissPrompt();
  const [leaving, setLeaving] = useState(false);
  const close = (go: boolean) => {
    if (leaving) return;
    haptic(go ? 'success' : 'light');
    setLeaving(true);
    window.setTimeout(() => {
      dismiss();
      if (go) navigate('/feedback');
    }, 220);
  };
  useBackHandler(() => close(false), 10);
  // Под заставкой страница не прокручивается.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Оставь отзыв о «Шаге веры»"
      className={`fixed inset-0 z-[70] flex flex-col overflow-hidden text-white transition-opacity duration-200 ${leaving ? 'opacity-0' : 'animate-fade-in'}`}
      style={{ background: 'radial-gradient(120% 80% at 50% 0%, #d0352c 0%, #8e2a3a 38%, #2a1d2c 100%)' }}
    >
      <Bubbles count={7} />
      <Grain />
      <div className="relative mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 pt-[calc(var(--safe-top)+24px)] text-center">
        <Footsteps steps={6} size={20} className="fb-pop text-white/90" />
        <p className="fb-pop mt-6 text-[13px] font-bold uppercase tracking-[0.3em] text-white/75" style={{ '--delay': '0.1s' } as CSSProperties}>
          Шаг веры · обратная связь
        </p>
        <h2
          className="fb-pop mt-3 font-display text-[clamp(30px,9vw,44px)] font-bold uppercase leading-[1.02] tracking-wide"
          style={{ '--delay': '0.2s' } as CSSProperties}
        >
          Оставь
          <br />
          отзыв
        </h2>
        <p className="fb-pop mt-4 max-w-sm text-[17px] leading-snug text-white/90" style={{ '--delay': '0.3s' } as CSSProperties}>
          {nbsp('Нам очень нужно услышать тебя. Расскажи, как прошёл твой «Шаг веры».')}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {FEEDBACK_CATEGORIES.map((c, i) => (
            <span
              key={c}
              className="fb-pop rounded-full bg-white/14 px-3.5 py-2 text-[15px] font-semibold ring-1 ring-white/25 backdrop-blur-sm"
              style={{ '--delay': `${0.45 + i * 0.12}s` } as CSSProperties}
            >
              {FEEDBACK_CATEGORY_INFO[c].emoji} {FEEDBACK_CATEGORY_INFO[c].label}
            </span>
          ))}
        </div>
      </div>
      <div className="relative mx-auto w-full max-w-xl px-6 pb-[calc(var(--safe-bottom)+20px)] pt-4">
        <button
          type="button"
          onClick={() => close(true)}
          className="fb-pop fb-shine relative block min-h-14 w-full overflow-hidden rounded-2xl bg-white text-[17px] font-bold text-[#b8302a] shadow-[0_12px_30px_-10px_rgb(0_0_0/0.5)] transition active:scale-[0.98]"
          style={{ '--delay': '0.8s' } as CSSProperties}
        >
          Оставить отзыв
        </button>
        <button
          type="button"
          onClick={() => close(false)}
          className="fb-pop mt-2 block min-h-12 w-full text-[16px] font-medium text-white/75 active:opacity-70"
          style={{ '--delay': '0.9s' } as CSSProperties}
        >
          Позже
        </button>
      </div>
    </div>,
    document.body,
  );
}
