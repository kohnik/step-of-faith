import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_INFO, type FeedbackCategory, type MeResponse } from '@sof/shared';
import { IconCheck } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type CSSProperties } from 'react';
import { useLocation } from 'wouter';
import { errorMessage } from '../../api/client.ts';
import { meQuery, saveMe } from '../../api/queries.ts';
import { haptic } from '../../lib/feedback.ts';
import { toast } from '../../ui/toast.tsx';
import { Button, cx, EmptyState, Segmented, TextArea, TextInput } from '../../ui/kit.tsx';
import { Page, StickyFooter } from '../../ui/Page.tsx';
import { feedbackOf, participantApi, useMeData } from '../api.ts';
import { Bubbles, Flow, Footsteps, Grain, nbsp } from './fx.tsx';

const MAX = 4000;

/** Спасибо после отправки: сердце бьётся, пузыри всплывают. */
function Thanks({ onMore }: { onMore: () => void }) {
  const [, navigate] = useLocation();
  return (
    <Page back="/">
      <section
        className="relative mb-5 overflow-hidden rounded-3xl px-6 pb-8 pt-10 text-center text-white"
        style={{ background: 'radial-gradient(120% 90% at 50% 0%, #d0352c 0%, #8e2a3a 45%, #2a1d2c 100%)' }}
      >
        <Bubbles count={5} travel="420px" />
        <Grain />
        <div className="relative">
          <div className="fb-pop">
            <span className="fb-heart inline-block text-[72px] leading-none" aria-hidden>
              💛
            </span>
          </div>
          <h1 className="fb-pop mt-5 font-display text-[24px] font-semibold uppercase leading-tight tracking-wide" style={{ '--delay': '0.15s' } as CSSProperties}>
            Отзыв отправлен
          </h1>
          <p className="fb-pop mt-2 text-[17px] leading-snug text-white/90" style={{ '--delay': '0.25s' } as CSSProperties}>
            Спасибо за открытое сердце - твой отзыв очень ценен для нас.
          </p>
        </div>
      </section>
      <Button size="lg" block onClick={onMore}>
        Написать ещё
      </Button>
      <Button size="lg" block variant="secondary" className="mt-2" onClick={() => navigate('/')}>
        На главную
      </Button>
    </Page>
  );
}

export default function Feedback() {
  const me = useMeData();
  const fb = feedbackOf(me);
  const qc = useQueryClient();
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [text, setText] = useState('');
  const [signed, setSigned] = useState<'anon' | 'name'>('name');
  const [signature, setSignature] = useState(fb.name);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (!fb.visible) {
    return (
      <Page title="Отзыв" back="/">
        <EmptyState title="Отзывы пока не принимаются">Загляните позже - мы обязательно попросим вас поделиться.</EmptyState>
      </Page>
    );
  }
  if (sent) {
    return (
      <Thanks
        onMore={() => {
          setSent(false);
          setText('');
          setCategory(null);
          window.scrollTo(0, 0);
        }}
      />
    );
  }

  const ready = !!category && text.trim().length >= 3;
  const submit = async () => {
    if (!category) return;
    setBusy(true);
    try {
      const res = await participantApi.feedbackSend({
        category,
        text: text.trim(),
        anonymous: signed === 'anon',
        signature: signed === 'name' ? signature.trim() || null : null,
      });
      const next = qc.setQueryData<MeResponse>(meQuery.queryKey, (m) => (m ? { ...m, feedback: { ...feedbackOf(m), mine: res.mine, prompt: false } } : m));
      if (next) saveMe(next);
      haptic('success');
      setSent(true);
      window.scrollTo(0, 0);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const info = category ? FEEDBACK_CATEGORY_INFO[category] : null;
  return (
    <Page back="/" bottomInset>
      <section
        className="relative mb-6 overflow-hidden rounded-3xl p-5 text-white"
        style={{ background: '#b8302a' }}
      >
        <Flow />
        <Bubbles count={3} travel="260px" small />
        <Grain />
        <div className="relative flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[22px] font-semibold uppercase leading-[1.1] tracking-wide">{nbsp('Поделись своим «Шагом веры»')}</h1>
            <p className="mt-2 text-[15px] leading-snug text-white/90">
              Получил(а) обновление через слово, откровение, покаяние, освобождение, исцеление, крещение Святым Духом? Расскажи нам. Или подскажи, что сделать
              лучше в следующий раз.
            </p>
          </div>
          <Footsteps steps={5} size={13} className="mt-1 shrink-0 text-white/85" />
        </div>
      </section>

      <h2 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider text-head">О чём твой отзыв?</h2>
      <div className="mb-6 space-y-2" role="radiogroup" aria-label="Категория">
        {FEEDBACK_CATEGORIES.map((c) => {
          const it = FEEDBACK_CATEGORY_INFO[c];
          const on = c === category;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                haptic('selection');
                setCategory(c);
              }}
              className={cx(
                'flex w-full items-center gap-3 rounded-2xl bg-section p-3.5 text-left transition active:scale-[0.99]',
                on ? 'ring-2 ring-brand' : 'ring-1 ring-line',
              )}
            >
              <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-xl text-[24px] transition', on ? 'bg-brand/15' : 'bg-fill')} aria-hidden>
                {it.emoji}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[16px] font-semibold leading-snug">{it.label}</span>
                <span className="mt-0.5 block text-[14px] leading-snug text-subtle">{it.hint}</span>
              </span>
              <span
                className={cx('flex size-6 shrink-0 items-center justify-center rounded-full transition', on ? 'bg-brand text-white' : 'ring-[1.5px] ring-inset ring-hint')}
                aria-hidden
              >
                {on && <IconCheck size={16} stroke={3} />}
              </span>
            </button>
          );
        })}
      </div>

      <label htmlFor="fb-text" className="mb-2 block px-1 text-[13px] font-semibold uppercase tracking-wider text-head">
        «Шаг веры» твоими глазами
      </label>
      <TextArea
        id="fb-text"
        rows={7}
        maxLength={MAX}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={info?.placeholder ?? 'Сначала выбери, о чём отзыв, - и пиши всё, что на сердце…'}
        className="text-[16px] leading-relaxed"
      />
      <p className={cx('mt-1 px-1 text-right text-[13px]', text.length > MAX - 200 ? 'text-warn-fg' : 'text-hint')}>
        {text.length} / {MAX}
      </p>

      <h2 className="mb-2 mt-4 px-1 text-[13px] font-semibold uppercase tracking-wider text-head">Подпись</h2>
      <Segmented
        value={signed}
        onChange={setSigned}
        options={[
          { value: 'anon', label: 'Анонимно' },
          { value: 'name', label: 'С именем' },
        ]}
      />
      {signed === 'name' ? (
        <div className="mt-3">
          <TextInput value={signature} maxLength={120} onChange={(e) => setSignature(e.target.value)} placeholder="Как подписать" aria-label="Подпись" />
        </div>
      ) : (
        <p className="mt-2 px-1 text-[13px] leading-snug text-hint">Команда не увидит, кто написал.</p>
      )}

      <StickyFooter>
        <Button size="lg" block disabled={!ready} loading={busy} onClick={() => void submit()}>
          Отправить
        </Button>
      </StickyFooter>
    </Page>
  );
}
