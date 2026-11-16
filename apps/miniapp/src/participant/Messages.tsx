import { formatRub, type ChatHistory, type ChatMessageView } from '@sof/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowUp, IconPlus, IconShirt, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { errorMessage, tmaAuthHeader } from '../api/client.ts';
import { usePollInterval } from '../api/realtime.ts';
import { haptic } from '../lib/feedback.ts';
import { dayKey, formatDayKey, formatTime } from '../lib/time.ts';
import { cx, ErrorState, Spinner } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { MESSAGES_KEY, participantApi, UNREAD_KEY, useMeData } from './api.ts';
import { clearRequest, removeFromRequest, useRequest, type RequestItem } from './merch/request.ts';

/** Заявка на бронь перед отправкой: какие вещи, убрать лишнее, добавить ещё. */
function RequestDraft({ items, onMore }: { items: RequestItem[]; onMore: () => void }) {
  const total = items.reduce((sum, it) => sum + Number(it.price) * it.qty, 0);
  return (
    <div className="mx-auto mb-2 max-w-xl rounded-2xl bg-section p-2.5">
      <p className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-wider text-subtle">Заявка на бронь</p>
      <div className="space-y-1.5">
        {items.map((it) => (
          <div key={it.variantId} className="flex items-center gap-2.5">
            <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-fill text-hint">
              {it.thumbUrl ? <img src={it.thumbUrl} alt="" className="size-full object-cover" /> : <IconShirt size={18} />}
            </div>
            <p className="min-w-0 flex-1 text-[14px] leading-snug">
              {it.title}
              {it.qty > 1 && <span className="text-subtle"> × {it.qty}</span>}
            </p>
            <span className="shrink-0 text-[14px] font-semibold">{formatRub(Number(it.price) * it.qty)}</span>
            <button type="button" aria-label={`Убрать: ${it.title}`} onClick={() => removeFromRequest(it.variantId)} className="p-1 text-hint">
              <IconX size={18} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between px-1">
        <button type="button" onClick={onMore} className="flex items-center gap-1 text-[14px] font-semibold text-accent">
          <IconPlus size={16} /> Ещё вещь
        </button>
        {items.length > 1 && <span className="text-[14px] font-bold">{formatRub(total.toFixed(2))}</span>}
      </div>
    </div>
  );
}

/** Картинка из переписки: отдаётся только с подписью Telegram, поэтому грузим сами и показываем из памяти. */
function useAuthImage(url: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    let objectUrl: string | null = null;
    const auth = tmaAuthHeader();
    void fetch(url, { headers: auth ? { Authorization: auth } : {} })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!alive || !b) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return src;
}

function Photo({ id, onOpen, onLoad }: { id: number; onOpen: () => void; onLoad: () => void }) {
  const src = useAuthImage(`/api/messages/${id}/photo?thumb=1`);
  return (
    <button type="button" onClick={onOpen} className="block">
      {src ? (
        <img src={src} alt="Картинка от организаторов" onLoad={onLoad} className="max-h-72 max-w-full rounded-xl object-cover" />
      ) : (
        <span className="flex h-40 w-56 items-center justify-center rounded-xl bg-fill">
          <Spinner className="text-hint" />
        </span>
      )}
    </button>
  );
}

/** Картинка во весь экран: нажатие - закрыть. */
function PhotoViewer({ id, onClose }: { id: number; onClose: () => void }) {
  const src = useAuthImage(`/api/messages/${id}/photo`);
  return (
    <button type="button" onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-3" aria-label="Закрыть">
      {src ? <img src={src} alt="Картинка от организаторов" className="max-h-full max-w-full object-contain" /> : <Spinner className="text-white" />}
    </button>
  );
}

/** Разделитель дней: «Сегодня», «Вчера», «27 октября». */
function dayTitle(day: string, tz: string): string {
  if (day === dayKey(new Date(), tz)) return 'Сегодня';
  if (day === dayKey(new Date(Date.now() - 86_400_000), tz)) return 'Вчера';
  return formatDayKey(day, { day: 'numeric', month: 'long' });
}

function Bubble({ m, tz, onPhoto, onMedia }: { m: ChatMessageView; tz: string; onPhoto: (id: number) => void; onMedia: () => void }) {
  const mine = !m.fromStaff;
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'max-w-[82%] rounded-2xl px-3.5 py-2',
          mine ? 'rounded-br-md bg-btn text-btn-fg' : 'rounded-bl-md bg-section',
          m.photo && !m.text && 'p-1',
        )}
      >
        {!mine && <p className="mb-0.5 text-[13px] font-semibold text-accent">Организаторы</p>}
        {m.photo && (
          <div className={m.text ? 'mb-1.5' : ''}>
            <Photo id={m.id} onOpen={() => onPhoto(m.id)} onLoad={onMedia} />
          </div>
        )}
        {m.text && <p className="whitespace-pre-wrap break-words text-[16px] leading-snug">{m.text}</p>}
        {m.merch?.order && m.merch.order.status !== 'cancelled' && m.merch.order.status !== 'expired' && (
          <p className="mt-1 text-[13px] font-semibold">✅ Забронировано · {m.merch.order.code}</p>
        )}
        <p className={cx('mt-0.5 text-right text-[12px]', mine ? 'text-btn-fg/70' : 'text-hint', m.photo && !m.text && 'px-2 pb-1')}>
          {formatTime(m.createdAt, tz)}
        </p>
      </div>
    </div>
  );
}

/**
 * Переписка с организаторами: как чат в Telegram. Ответы приходят сюда и в чат с ботом,
 * организаторы могут написать и первыми, в том числе с картинкой.
 */
export default function Messages() {
  const me = useMeData();
  // Открыли из раздела «Мерч» - вопрос уходит команде мерча (папка «Мерч» в админке).
  const merch = new URLSearchParams(useSearch()).get('topic') === 'merch';
  const [, navigate] = useLocation();
  // Заявка на бронь из «Мерча» - только в переписке про мерч.
  const draft = useRequest();
  const request = merch ? draft : [];
  const tz = me.event.timezone;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: MESSAGES_KEY, queryFn: () => participantApi.messages(), refetchInterval: usePollInterval(30_000) });
  const [older, setOlder] = useState<ChatMessageView[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [photoOf, setPhotoOf] = useState<number | null>(null);

  const latest = q.data?.messages ?? [];
  const messages = useMemo(() => {
    const seen = new Set(latest.map((m) => m.id));
    return [...older.filter((m) => !seen.has(m.id)), ...latest];
  }, [older, latest]);
  const lastId = latest.at(-1)?.id ?? 0;
  const firstLoad = useRef(true);
  // Картинка догрузилась, а человек внизу ленты - остаёмся внизу.
  const stickToBottom = () => {
    const el = document.documentElement;
    if (el.scrollHeight - window.scrollY - window.innerHeight < 400) window.scrollTo({ top: el.scrollHeight });
  };

  // Новое сообщение - вниз и отметить прочитанным (счётчик на главной обнулится).
  useEffect(() => {
    if (!lastId) return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: firstLoad.current ? 'auto' : 'smooth' });
    firstLoad.current = false;
    void participantApi
      .readMessages()
      .then(() => qc.setQueryData(UNREAD_KEY, { unread: 0 }))
      .catch(() => undefined);
  }, [lastId, qc]);

  const showEarlier = async () => {
    const first = messages[0];
    if (!first) return;
    setLoadingOlder(true);
    const height = document.documentElement.scrollHeight;
    try {
      const page = await participantApi.messages(first.id);
      setOlder((prev) => [...page.messages, ...prev]);
      setHasMoreOlder(page.hasMore);
      // Оставляем экран на том же сообщении.
      requestAnimationFrame(() => window.scrollBy(0, document.documentElement.scrollHeight - height));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async () => {
    const value = text.trim();
    if ((!value && request.length === 0) || sending) return;
    setSending(true);
    try {
      const items = request.length ? request.map((it) => ({ variantId: it.variantId, qty: it.qty })) : undefined;
      const created = await participantApi.sendMessage(value, merch ? 'merch' : undefined, items);
      qc.setQueryData<ChatHistory>(MESSAGES_KEY, (old) => ({ messages: [...(old?.messages ?? []), created], hasMore: old?.hasMore ?? false }));
      if (items) clearRequest();
      setText('');
      haptic('success');
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const hasMore = hasMoreOlder ?? q.data?.hasMore ?? false;
  return (
    <Page
      title={merch ? 'Вопрос по мерчу' : 'Сообщения'}
      subtitle={merch ? 'Ответит команда мерча - здесь и в чате с ботом' : 'Организаторы ответят здесь и в чате с ботом'}
      back={merch ? '/merch' : '/'}
      bottomInset
    >
      {q.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner className="text-btn" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="space-y-2">
          {hasMore && (
            <div className="flex justify-center">
              <button type="button" onClick={() => void showEarlier()} disabled={loadingOlder} className="py-2 text-[15px] font-medium text-accent">
                {loadingOlder ? 'Загружаем…' : 'Показать раньше'}
              </button>
            </div>
          )}
          {messages.length === 0 && (
            <p className="px-2 py-10 text-center text-[15px] text-subtle">
              {merch
                ? 'Спросите про размеры, бронь, оплату или выдачу мерча. Ответ придёт сюда и в чат с ботом.'
                : 'Напишите организаторам: вопрос, просьбу или что угодно. Ответ придёт сюда и в чат с ботом.'}
            </p>
          )}
          {messages.map((m, i) => {
            const day = dayKey(m.createdAt, tz);
            const newDay = i === 0 || dayKey(messages[i - 1]!.createdAt, tz) !== day;
            return (
              <div key={m.id}>
                {newDay && (
                  <p className="my-3 text-center">
                    <span className="rounded-full bg-fill px-3 py-1 text-[13px] text-subtle">{dayTitle(day, tz)}</span>
                  </p>
                )}
                <Bubble m={m} tz={tz} onPhoto={setPhotoOf} onMedia={stickToBottom} />
              </div>
            );
          })}
        </div>
      )}

      {/* Заявка над полем ввода выше обычного - чтобы не закрывала последние сообщения. */}
      {request.length > 0 && <div style={{ height: 72 + request.length * 48 }} />}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-page/95 px-3 pb-[calc(var(--safe-bottom)+10px)] pt-2.5 backdrop-blur">
        {request.length > 0 && <RequestDraft items={request} onMore={() => navigate('/merch')} />}
        <div className="mx-auto flex max-w-xl items-end gap-2">
          <textarea
            value={text}
            rows={1}
            maxLength={2000}
            placeholder={request.length ? 'Комментарий, если нужен' : 'Сообщение'}
            onChange={(e) => {
              setText(e.target.value);
              // Поле растёт с текстом, но не выше пяти строк.
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            className="max-h-[140px] min-h-11 flex-1 resize-none rounded-2xl bg-section px-4 py-2.5 text-[16px] leading-snug outline-none"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={(!text.trim() && request.length === 0) || sending}
            aria-label="Отправить"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-btn text-btn-fg transition disabled:opacity-40"
          >
            {sending ? <Spinner className="size-5" /> : <IconArrowUp size={22} />}
          </button>
        </div>
      </div>
      {photoOf !== null && <PhotoViewer id={photoOf} onClose={() => setPhotoOf(null)} />}
    </Page>
  );
}
