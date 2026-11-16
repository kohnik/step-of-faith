/**
 * Касса: приём взноса наличными (или отметка перевода) за конкретного человека - без отметки входа.
 * Нужна до конференции (каб. 504) и на месте. У каждого человека своя оплата: семью показываем списком,
 * но принимаем по одному - кто-то платит сам, кто-то позже.
 */
import { PAYMENT_STATUS_LABELS, formatRub, type ParticipantCard, type PaymentEntryView, type PaymentMethod } from '@sof/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { qrScanner } from '@tma.js/sdk-react';
import {
  IconArrowBackUp,
  IconCameraOff,
  IconCash,
  IconChevronRight,
  IconCircleCheckFilled,
  IconHeartHandshake,
  IconQrcode,
  IconScan,
  IconSearch,
} from '@tabler/icons-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/client.ts';
import { uuid } from '../lib/ids.ts';
import { haptic, unlockAudio } from '../lib/feedback.ts';
import { dayKey, formatTime, yearsLabel } from '../lib/time.ts';
import { confirmAction } from '../telegram/actions.ts';
import { Badge, Button, cx, EmptyState, Notice, paymentTone, Spinner, TextInput } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { TierBadge, tierStripe } from '../ui/TierBadge.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { nativeScannerAvailable, useEntranceCheckpoint, useEventTimezone, useTiers } from './common.ts';
import { SessionExpiredNotice } from './SessionExpired.tsx';

const CameraScanner = lazy(() => import('./CameraScanner.tsx'));

const UNDO_MS = 15 * 60_000;
const MY_PAYMENTS_KEY = ['cash-mine'] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

const isMoney = (v: string) => /^\d{1,8}(\.\d{1,2})?$/.test(v) && Number(v) > 0;

/** Сколько осталось внести. */
const leftOf = (c: ParticipantCard) => Math.max(0, Number(c.amountDue ?? 0) - Number(c.amountPaid ?? 0));
const isOpen = (c: ParticipantCard) =>
  c.status === 'active' && (c.paymentStatus === 'unpaid' || c.paymentStatus === 'partial' || c.paymentStatus === 'pending');

function statusText(c: ParticipantCard): string {
  if (c.paymentStatus === 'unpaid' || c.paymentStatus === 'partial') {
    const left = leftOf(c);
    return left > 0 ? `${PAYMENT_STATUS_LABELS[c.paymentStatus]} · ${formatRub(left)}` : PAYMENT_STATUS_LABELS[c.paymentStatus];
  }
  return PAYMENT_STATUS_LABELS[c.paymentStatus];
}

/** Один человек в шторке: сумма, способ, «Принять». После приёма - «Отменить» на 15 минут. */
function PersonPay({
  card,
  canAccept,
  acceptedAt,
  onAccepted,
  onUndone,
}: {
  card: ParticipantCard;
  canAccept: boolean;
  acceptedAt: number | undefined;
  onAccepted: () => void;
  onUndone: () => void;
}) {
  const tiers = useTiers();
  const left = leftOf(card);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  // toFixed: 35 − 26.12 даёт 8.879999999999999, а такая строка не проходит проверку суммы.
  const [amount, setAmount] = useState(left > 0 ? String(Number(left.toFixed(2))) : '');
  const [busy, setBusy] = useState(false);
  /** «Без сдачи»: сколько дали; всё сверх взноса - пожертвование. */
  const [noChange, setNoChange] = useState(false);
  const [given, setGiven] = useState('');
  /** Ключ приёма: не дождались ответа и нажали снова - сервер не зачтёт дважды. */
  const requestRef = useRef<string | null>(null);
  const value = amount.trim().replace(',', '.');
  const givenValue = given.trim().replace(',', '.');
  const extra = noChange && isMoney(givenValue) ? Math.round((Number(givenValue) - Number(value)) * 100) / 100 : 0;
  const valid = isMoney(value) && (!noChange || (isMoney(givenValue) && extra >= 0));
  const canUndo = acceptedAt !== undefined && Date.now() - acceptedAt < UNDO_MS;

  const accept = async () => {
    if (!valid || busy) return;
    const how = method === 'cash' ? 'наличными' : method === 'transfer' ? 'переводом' : 'картой';
    const ok = await confirmAction({
      title: extra > 0 ? `Принять ${formatRub(givenValue)}?` : `Принять ${formatRub(value)}?`,
      message:
        extra > 0
          ? `${card.fullName}: взнос ${formatRub(value)} + пожертвование ${formatRub(extra.toFixed(2))}, ${how}. Сдачу не даём.`
          : `${card.fullName} - ${how}.`,
      ok: 'Принять',
    });
    if (!ok) return;
    setBusy(true);
    requestRef.current ??= uuid();
    try {
      const res = await staffApi.markPaid({
        participantIds: [card.id],
        method,
        amount: value,
        donation: extra > 0 ? extra.toFixed(2) : null,
        note: null,
        requestId: requestRef.current,
      });
      requestRef.current = null;
      const p = res.people[0];
      haptic('success');
      if (res.duplicate) toast.info(`${card.fullName}: этот приём уже записан - второй раз не зачли`);
      else if (res.updated === 0) toast.info(`${card.fullName}: оплата уже была`);
      else if (extra > 0) toast.success(`${card.fullName}: взнос и пожертвование ${formatRub(extra.toFixed(2))} приняты`);
      else toast.success(p?.paymentStatus === 'partial' ? `${card.fullName}: внесено частично` : `${card.fullName}: взнос принят`);
      onAccepted();
    } catch (err) {
      // Нет связи - ключ оставляем: повтор того же приёма не зачтётся дважды.
      if (!(err instanceof ApiError && err.isTransient)) requestRef.current = null;
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    setBusy(true);
    try {
      await staffApi.undoPayment(card.id);
      toast.success('Приём отменён');
      onUndone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-fill py-3 pl-5 pr-4" style={tierStripe(card.tier, tiers)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold leading-snug">{card.fullName}</p>
          <p className="text-[13px] text-subtle">{yearsLabel(card.age)}</p>
          <TierBadge bracelet tier={card.tier} tiers={tiers} breakfast={card.breakfast} size="sm" className="mt-1" />
        </div>
        <Badge tone={paymentTone(card.paymentStatus)} className="shrink-0 text-right">
          {statusText(card)}
        </Badge>
      </div>

      {card.status !== 'active' ? (
        <p className="mt-2 text-[13px] text-bad-fg">Регистрация отменена - взнос не принимаем.</p>
      ) : card.paymentStatus === 'pending' ? (
        <p className="mt-2 text-[13px] text-warn-fg">
          Прислали чек перевода - он на проверке у админов. Если платят наличными, можно принять и так: тогда админ отклонит чек.
        </p>
      ) : null}

      {canAccept && card.status === 'active' && (card.paymentStatus === 'unpaid' || card.paymentStatus === 'partial' || card.paymentStatus === 'pending') && (
        <div className="mt-3 grid gap-2">
          <div className="flex gap-1 rounded-xl bg-section p-1">
            {(['cash', 'transfer'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={cx('min-h-10 flex-1 rounded-lg text-[15px] font-semibold', method === m ? 'bg-btn text-btn-fg' : 'text-subtle')}
              >
                {m === 'cash' ? 'Наличные' : 'Перевод'}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <TextInput
              className="bg-section"
              inputMode="decimal"
              value={amount}
              invalid={amount !== '' && !isMoney(value)}
              aria-label="Сумма, руб."
              onChange={(e) => setAmount(e.target.value)}
            />
            <Button variant="success" loading={busy} disabled={!valid} onClick={() => void accept()} className="shrink-0">
              <IconCash size={20} />
              Принять
            </Button>
          </div>
          {noChange ? (
            <div className="rounded-xl bg-section p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[14px] font-semibold">Без сдачи: сколько дали?</p>
                <button type="button" onClick={() => (setNoChange(false), setGiven(''))} className="text-[14px] text-accent">
                  Со сдачей
                </button>
              </div>
              <TextInput
                className="mt-2 bg-fill"
                inputMode="decimal"
                placeholder="Например, 50"
                value={given}
                invalid={given !== '' && (!isMoney(givenValue) || extra < 0)}
                aria-label="Сколько дали, руб."
                onChange={(e) => setGiven(e.target.value)}
              />
              <p className="mt-2 text-[14px] text-subtle">
                {isMoney(givenValue) && extra === 0 ? (
                  'Ровно взнос - без пожертвования'
                ) : isMoney(givenValue) && extra > 0 ? (
                  <>
                    Взнос <b className="text-fg">{formatRub(value)}</b> + пожертвование <b className="text-ok-fg">{formatRub(extra.toFixed(2))}</b>
                  </>
                ) : isMoney(givenValue) ? (
                  'Дали меньше взноса - уменьшите сумму взноса выше'
                ) : (
                  'Всё сверх взноса запишем пожертвованием'
                )}
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNoChange(true)}
              className="inline-flex items-center gap-1.5 self-start py-1 text-[14px] font-medium text-accent"
            >
              <IconHeartHandshake size={17} />
              Без сдачи - остальное в пожертвование
            </button>
          )}
        </div>
      )}

      {canAccept && card.status === 'active' && (card.paymentStatus === 'paid' || card.paymentStatus === 'exempt') && (
        <DonationForm participantId={card.id} name={card.fullName} compact />
      )}

      {canUndo && (
        <button type="button" disabled={busy} onClick={() => void undo()} className="mt-2 inline-flex items-center gap-1.5 py-1 text-[14px] font-medium text-accent">
          <IconArrowBackUp size={17} />
          Отменить приём (ошиблись человеком)
        </button>
      )}
    </div>
  );
}

/** Кого открыли: по QR-коду (скан) или по id (поиск). */
export type CashSubject = { code: string; via: 'qr' } | { participantId: number; via: 'search' };

export function PersonSheet({
  subject,
  onClose,
  onScanNext,
  canAccept = true,
}: {
  subject: CashSubject | null;
  onClose: () => void;
  /** Закрыть и сразу сканировать следующего. */
  onScanNext: () => void;
  /** Может принимать деньги (payments:write). Нет - только смотрит статус. */
  canAccept?: boolean;
}) {
  const qc = useQueryClient();
  const [accepted, setAccepted] = useState<Record<number, number>>({});
  const q = useQuery({
    queryKey: ['cash-person', subject],
    queryFn: () => {
      const sub = subject!;
      return staffApi.findForPayment(sub.via === 'qr' ? { code: sub.code } : { participantId: sub.participantId });
    },
    enabled: subject !== null,
    staleTime: 0,
  });
  const refresh = () => {
    void q.refetch();
    void qc.invalidateQueries({ queryKey: ['cash-search'] });
    void qc.invalidateQueries({ queryKey: MY_PAYMENTS_KEY });
  };
  // Свой приём за последние 15 минут (открыли из «Моих приёмов» или снова по QR-коду) - тоже можно отменить.
  const mine = useQuery({ queryKey: MY_PAYMENTS_KEY, queryFn: () => staffApi.myPayments(), enabled: subject !== null && canAccept, staleTime: 10_000 });
  const myRecent = (id: number) => {
    const last = mine.data?.find((r) => r.participantId === id && !r.undoneAt && r.source === 'desk' && r.kind === 'fee');
    const at = last ? Date.parse(last.createdAt) : NaN;
    return Number.isFinite(at) && Date.now() - at < UNDO_MS ? at : undefined;
  };
  const data = q.data?.found ? q.data : null;
  const people = data ? [data.card, ...data.family] : [];
  const openCount = people.filter(isOpen).length;
  const byQr = subject?.via === 'qr';

  return (
    <Sheet open={subject !== null} onClose={onClose} title="Оплата">
      {q.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner className="text-btn" />
        </div>
      ) : q.isError ? (
        <Notice tone="red" className="mb-3">
          {errorMessage(q.error)} Без связи оплату принять нельзя - попробуйте ещё раз.
        </Notice>
      ) : !data ? (
        <Notice tone="yellow" className="mb-3">
          {q.data?.found === false && q.data.reason === 'invalid_code'
            ? 'Это не QR-код конференции.'
            : 'QR-код не найден.'}{' '}
          Найдите человека по фамилии или отсканируйте ещё раз.
        </Notice>
      ) : (
        <div className="grid gap-2 pb-1">
          {byQr && (
            <p className="flex items-center gap-1.5 rounded-xl bg-info-soft px-3 py-2 text-[13px] font-medium text-info-fg">
              <IconQrcode size={16} className="shrink-0" />
              Найден по QR-коду · только оплата, вход не отмечается
            </p>
          )}
          {data.codeStatus === 'revoked' && (
            <p className="rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn-fg">
              Этот QR-код устарел - у человека есть новый (в боте). Оплату принять можно.
            </p>
          )}
          {people.length > 1 && (
            <p className="px-1 text-[13px] text-hint">
              Записаны вместе с одного Telegram. У каждого своя оплата - принимайте только за тех, за кого платят сейчас.
            </p>
          )}
          {people.map((c) => (
            <PersonPay
              key={`${c.id}:${c.paymentStatus}:${c.amountPaid}`}
              card={c}
              canAccept={canAccept}
              acceptedAt={accepted[c.id] ?? myRecent(c.id)}
              onAccepted={() => {
                setAccepted((a) => ({ ...a, [c.id]: Date.now() }));
                refresh();
              }}
              onUndone={() => {
                setAccepted((a) => {
                  const next = { ...a };
                  delete next[c.id];
                  return next;
                });
                refresh();
              }}
            />
          ))}
          {openCount === 0 && (
            <p className="flex items-center justify-center gap-1.5 py-2 text-[15px] font-medium text-ok-fg">
              <IconCircleCheckFilled size={18} />
              {people.length > 1 ? 'Все внесли взнос' : 'Взнос уже внесён'}
            </p>
          )}
        </div>
      )}
      <Button variant="secondary" block className="mt-2" onClick={onScanNext}>
        <IconScan size={20} />
        {data ? 'Сканировать следующий' : 'Сканировать ещё раз'}
      </Button>
    </Sheet>
  );
}

export default function Cash() {
  const { checkpoint } = useEntranceCheckpoint();
  const tiers = useTiers();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [subject, setSubject] = useState<CashSubject | null>(null);
  const [donating, setDonating] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [nativeFailed, setNativeFailed] = useState(false);
  const native = nativeScannerAvailable();
  const search = useQuery({
    queryKey: ['cash-search', checkpoint?.id, term],
    queryFn: ({ signal }) => staffApi.search(term, checkpoint!.id, signal),
    enabled: term.length >= 2 && checkpoint !== null,
    placeholderData: keepPreviousData,
  });
  const items = term.length >= 2 ? (search.data?.items ?? []) : [];

  const onRead = (raw: string) => {
    haptic('light');
    setCameraOn(false);
    setSubject({ code: raw, via: 'qr' });
  };

  const openNative = () => {
    try {
      if (!qrScanner.open.isAvailable() || qrScanner.isOpened()) return;
      let handled = false;
      qrScanner
        .open({
          text: 'Касса: наведите на QR-код - вход НЕ отмечается',
          onCaptured: (qr) => {
            if (handled) return;
            handled = true;
            try {
              qrScanner.close();
            } catch {
              /* ignore */
            }
            onRead(qr);
          },
        })
        .catch(() => setNativeFailed(true));
    } catch {
      setNativeFailed(true);
      toast.error('Сканер Telegram не открылся - попробуйте камеру в приложении');
    }
  };

  const scan = () => {
    unlockAudio();
    if (native && !nativeFailed) openNative();
    else setCameraOn((on) => !on);
  };

  const scanNext = () => {
    setSubject(null);
    // Шторка закрывается - сканер открываем чуть позже, чтобы не мешали друг другу.
    window.setTimeout(scan, 200);
  };

  return (
    <Page title="Касса" subtitle="Приём взноса - вход не отмечается" back="/">
      <SessionExpiredNotice />
      <Button size="lg" variant="success" block className="mb-3 min-h-16 text-[18px]" onClick={scan}>
        {cameraOn ? (
          <>
            <IconCameraOff size={22} />
            Закрыть камеру
          </>
        ) : (
          <>
            <IconCash size={24} />
            Сканировать QR-код для оплаты
          </>
        )}
      </Button>
      {cameraOn && (
        <Suspense
          fallback={
            <div className="mb-3 flex aspect-[4/5] items-center justify-center rounded-3xl bg-black">
              <Spinner className="size-8 text-white" />
            </div>
          }
        >
          <div className="mb-3">
            <CameraScanner paused={subject !== null} onRead={onRead} onClose={() => setCameraOn(false)} />
          </div>
        </Suspense>
      )}
      {native && nativeFailed && !cameraOn && (
        <button type="button" onClick={() => setCameraOn(true)} className="mb-2 w-full py-2 text-center text-[15px] text-accent">
          Камера не открывается? Камера в приложении
        </button>
      )}

      <button
        type="button"
        onClick={() => setDonating(true)}
        className="mb-1 inline-flex w-full items-center justify-center gap-1.5 py-2 text-[15px] font-semibold text-accent"
      >
        <IconHeartHandshake size={18} />
        Пожертвование без QR-кода
      </button>

      <p className="mb-2 mt-2 px-1 text-[15px] font-semibold">Или найдите по фамилии</p>
      <div className="relative mb-3">
        <IconSearch size={20} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-hint" />
        <TextInput
          type="search"
          enterKeyHint="search"
          placeholder="Фамилия, имя или телефон"
          className="pl-11"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {term.length < 2 ? (
        <MyPayments onOpen={(id) => setSubject({ participantId: id, via: 'search' })} />
      ) : !checkpoint ? (
        <Notice tone="yellow">Поиск по фамилии сейчас недоступен - отсканируйте QR-код.</Notice>
      ) : search.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner className="text-btn" />
        </div>
      ) : search.isError ? (
        <Notice tone="red">{errorMessage(search.error)}</Notice>
      ) : items.length === 0 ? (
        <p className="px-1 py-2 text-[15px] text-subtle">Никого не нашли</p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-section">
          {items.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSubject({ participantId: c.id, via: 'search' })}
              className="flex min-h-16 w-full items-center gap-3 border-b border-line py-2.5 pl-5 pr-3 text-left last:border-b-0 active:bg-fill"
              style={tierStripe(c.tier, tiers)}
            >
              <span className="min-w-0 flex-1">
                <span className={cx('block font-semibold leading-snug', c.status === 'cancelled' && 'text-hint line-through')}>{c.fullName}</span>
                <TierBadge bracelet tier={c.tier} tiers={tiers} breakfast={c.breakfast} size="sm" className="mt-0.5" />
              </span>
              <Badge tone={paymentTone(c.paymentStatus)} className="shrink-0 text-right">
                {statusText(c)}
              </Badge>
              <IconChevronRight size={20} className="shrink-0 text-hint" />
            </button>
          ))}
        </div>
      )}

      <PersonSheet subject={subject} onClose={() => setSubject(null)} onScanNext={scanNext} />
      <Sheet open={donating} onClose={() => setDonating(false)} title="Пожертвование без QR-кода">
        <DonationForm onDone={() => setDonating(false)} />
      </Sheet>
    </Page>
  );
}

/**
 * «Мои приёмы»: кого принял(а) этот кассир, сумма наличными и переводом - за сегодня или за всё время.
 * Нажали на человека - открывается его оплата (там же «Отменить» в первые 15 минут).
 */
function MyPayments({ onOpen }: { onOpen: (participantId: number) => void }) {
  const tz = useEventTimezone();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<'today' | 'all'>('today');
  const q = useQuery({ queryKey: MY_PAYMENTS_KEY, queryFn: () => staffApi.myPayments(), refetchInterval: 30_000 });
  const today = dayKey(new Date(), tz);
  const rows = (q.data ?? []).filter((r) => period === 'all' || dayKey(r.createdAt, tz) === today);
  const counted = rows.filter((r) => !r.undoneAt);
  const sum = (pick: (r: PaymentEntryView) => boolean) => counted.filter(pick).reduce((s, r) => s + Number(r.amount), 0);
  const cashInBox = sum((r) => r.method === 'cash');
  const fees = sum((r) => r.kind === 'fee');
  const donations = sum((r) => r.kind === 'donation');
  const people = new Set(counted.filter((r) => r.kind === 'fee').map((r) => r.participantId)).size;

  // Своё пожертвование в первые 15 минут - по нажатию предлагаем отменить; позже - открываем человека (если он есть).
  const fresh = (r: PaymentEntryView) => !r.undoneAt && Date.now() - Date.parse(r.createdAt) < UNDO_MS;
  const undoDonation = async (r: PaymentEntryView) => {
    const ok = await confirmAction({ title: 'Отменить пожертвование?', message: `${r.fullName}, ${formatRub(r.amount)}`, ok: 'Отменить', destructive: true });
    if (!ok) return;
    try {
      await staffApi.undoDonation(r.id);
      toast.success('Пожертвование отменено');
      void qc.invalidateQueries({ queryKey: MY_PAYMENTS_KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (q.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="text-btn" />
      </div>
    );
  }
  if (q.isError) return <Notice tone="red">{errorMessage(q.error)}</Notice>;
  if ((q.data ?? []).length === 0) {
    return (
      <EmptyState icon={IconCash} title="Кто вносит взнос?">
        Отсканируйте QR-код человека или найдите по фамилии. Платить можно за себя или за кого-то из записанных вместе - каждого отмечаем отдельно.
        Здесь появятся все, у кого вы приняли оплату.
      </EmptyState>
    );
  }
  return (
    <section className="mt-2">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <p className="text-[15px] font-semibold">Мои приёмы</p>
        <div className="flex rounded-full bg-fill p-0.5 text-[13px] font-semibold">
          {(['today', 'all'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cx('rounded-full px-3 py-1', period === p ? 'bg-section shadow-sm' : 'text-subtle')}
            >
              {p === 'today' ? 'Сегодня' : 'Всё время'}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-2 rounded-2xl bg-ok-soft px-4 py-3 text-ok-fg">
        <div className="text-[12px] font-semibold uppercase tracking-wide">В кассе наличными</div>
        <div className="text-[26px] font-bold tabular-nums">{formatRub(cashInBox.toFixed(2))}</div>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Tile label="Взносы" value={formatRub(fees.toFixed(2))} />
        <Tile label="Пожертв." value={formatRub(donations.toFixed(2))} />
        <Tile label="Людей" value={String(people)} />
      </div>
      {rows.length === 0 ? (
        <p className="px-1 py-2 text-[15px] text-subtle">Сегодня вы ещё никого не принимали.</p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-section">
          {rows.map((r) => {
            const pid = r.participantId;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => (r.kind === 'donation' && fresh(r) ? void undoDonation(r) : pid != null ? onOpen(pid) : undefined)}
                className="flex min-h-14 w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-b-0 active:bg-fill"
              >
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate font-semibold leading-snug', r.undoneAt && 'text-hint line-through')}>{r.fullName}</span>
                  <span className="block text-[13px] text-subtle">
                    {formatTime(r.createdAt, tz)} · {r.kind === 'donation' ? 'пожертвование, ' : ''}
                    {r.method === 'cash' ? 'наличные' : r.method === 'transfer' ? 'перевод' : 'карта'}
                    {r.undoneAt ? ' · отменено' : ''}
                  </span>
                </span>
                {r.kind === 'donation' && <IconHeartHandshake size={18} className="shrink-0 text-ok-fg" />}
                <span className={cx('shrink-0 font-semibold tabular-nums', r.undoneAt && 'text-hint line-through')}>{formatRub(r.amount)}</span>
                {r.kind === 'donation' && fresh(r) ? (
                  <IconArrowBackUp size={18} className="shrink-0 text-hint" />
                ) : (
                  pid != null && <IconChevronRight size={18} className="shrink-0 text-hint" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cx('rounded-2xl px-3 py-2.5', accent ? 'bg-ok-soft text-ok-fg' : 'bg-section')}>
      <div className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-0.5 truncate text-[17px] font-bold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Пожертвование: у того, кто уже оплатил взнос (в его окне, по QR-коду), или без QR-кода - тогда можно имя.
 * compact - сначала только кнопка «＋ Пожертвование», форма раскрывается по нажатию.
 */
function DonationForm({ participantId, name, compact, onDone }: { participantId?: number; name?: string; compact?: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(!compact);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [donor, setDonor] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<string | null>(null);
  const value = amount.trim().replace(',', '.');
  const valid = isMoney(value);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-1.5 py-1 text-[15px] font-semibold text-accent">
        <IconHeartHandshake size={18} />
        Добавить пожертвование
      </button>
    );
  }

  const submit = async () => {
    if (!valid || busy) return;
    const who = name ?? (donor.trim() || 'без имени');
    const ok = await confirmAction({
      title: `Пожертвование ${formatRub(value)}?`,
      message: `${who} - ${method === 'cash' ? 'наличными' : 'переводом'}.`,
      ok: 'Принять',
    });
    if (!ok) return;
    setBusy(true);
    requestRef.current ??= uuid();
    try {
      const res = await staffApi.donate({
        participantId: participantId ?? null,
        donorName: participantId ? null : donor.trim() || null,
        amount: value,
        method,
        comment: comment.trim() || null,
        requestId: requestRef.current,
      });
      requestRef.current = null;
      haptic('success');
      toast.success(res.duplicate ? 'Это пожертвование уже записано' : `Пожертвование ${formatRub(value)} принято - спасибо!`);
      setAmount('');
      setDonor('');
      setComment('');
      if (compact) setOpen(false);
      void qc.invalidateQueries({ queryKey: MY_PAYMENTS_KEY });
      onDone?.();
    } catch (err) {
      if (!(err instanceof ApiError && err.isTransient)) requestRef.current = null;
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx('grid gap-2', compact && 'mt-3 rounded-xl bg-section p-3')}>
      {compact && <p className="text-[14px] font-semibold">Пожертвование</p>}
      {participantId === undefined && (
        <TextInput className="bg-section" placeholder="Имя (необязательно)" value={donor} maxLength={120} onChange={(e) => setDonor(e.target.value)} />
      )}
      <div className={cx('flex gap-1 rounded-xl p-1', compact ? 'bg-fill' : 'bg-section')}>
        {(['cash', 'transfer'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMethod(m)}
            className={cx('min-h-10 flex-1 rounded-lg text-[15px] font-semibold', method === m ? 'bg-btn text-btn-fg' : 'text-subtle')}
          >
            {m === 'cash' ? 'Наличные' : 'Перевод'}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <TextInput
          className={compact ? 'bg-fill' : 'bg-section'}
          inputMode="decimal"
          placeholder="Сумма, руб."
          value={amount}
          invalid={amount !== '' && !valid}
          aria-label="Сумма пожертвования, руб."
          onChange={(e) => setAmount(e.target.value)}
        />
        <Button variant="success" loading={busy} disabled={!valid} onClick={() => void submit()} className="shrink-0">
          <IconHeartHandshake size={20} />
          Принять
        </Button>
      </div>
      {participantId === undefined && (
        <TextInput className="bg-section" placeholder="Комментарий (необязательно)" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
      )}
      {compact && (
        <button type="button" onClick={() => setOpen(false)} className="justify-self-start py-1 text-[14px] text-subtle">
          Отмена
        </button>
      )}
    </div>
  );
}
