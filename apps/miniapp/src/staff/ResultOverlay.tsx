/**
 * Полноэкранный результат сканирования.
 * Сразу показывает данные из локальной базы, параллельно спрашивает сервер (3 с) - его ответ главнее.
 *
 * Зелёный - вспышка на весь экран ~1 с: галочка, имя, возраст и большая «Отменить» (без отсчёта).
 * Отметка уходит на сервер сразу и не держит экран: ответ (или офлайн-очередь) обрабатывается в фоне.
 * Касание вспышки ставит её на паузу. Жёлтый и красный ждут кнопку «Дальше».
 * Ручной поиск - одна кнопка «Отметить». У каждого члена семьи свой QR-код - сканируются по очереди.
 */
import {
  CATEGORY_LABELS,
  MIN_AGE,
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABELS,
  braceletOf,
  formatRub,
  textOn,
  tierShort,
  type CheckpointView,
  type PaymentMethod,
  type PaymentStatus,
  type Tier,
  type TiersConfig,
} from '@sof/shared';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowRight,
  IconBan,
  IconCash,
  IconCircleCheck,
  IconCloudCheck,
  IconRefresh,
  IconScan,
  IconSearch,
  IconWifiOff,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/client.ts';
import { signal, type Signal } from '../lib/feedback.ts';
import { deviceId, uuid } from '../lib/ids.ts';
import { formatTime, yearsLabel } from '../lib/time.ts';
import { confirmAction } from '../telegram/actions.ts';
import { useBackHandler } from '../telegram/back.ts';
import type { TablerIcon } from '../ui/icons.tsx';
import { Button, cx, Spinner, TextInput } from '../ui/kit.tsx';
import { BraceletBig } from '../ui/TierBadge.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import {
  lookupVerdict,
  needsPayment,
  outcomeView,
  submitCheckIns,
  undoCheckIns,
  type Color,
  type OutcomeView,
  type PaymentRules,
  type UndoItem,
} from './checkin.ts';
import { fromServerCard, localLookup, markLocalPaid, useManifestState, type CardInfo, type LookupState } from './manifest.ts';
import { can, useStaff } from './session.ts';
import { useTiers } from './common.ts';

export interface ScanSubject {
  id: number;
  source: 'scan' | 'manual';
  via: 'native' | 'camera' | 'search';
  raw: string | null;
  canonical: string | null;
  participantId: number | null;
  checkpoint: CheckpointView;
}

export interface RecentItem {
  key: string;
  name: string;
  color: Color;
  text: string;
  at: number;
  /** Вариант участия - цветной бейдж в истории. */
  tier?: Tier | null;
  breakfast?: boolean;
  /** Отметка на сервере (для отмены из истории). */
  checkInId?: number | null;
  canUndo?: boolean;
}

export interface OverlayResult {
  reopen: boolean;
  popupText?: string;
  focusSearch?: boolean;
}

/** Состояние отметки после нажатия (или авто-отметки): ответ сервера приходит в фоне. */
type MarkState = 'pending' | 'ok' | 'offline' | 'rejected' | 'undoing' | 'undone';

type Phase =
  | { kind: 'review' }
  | {
      kind: 'flash';
      name: string;
      sub: string;
      state: MarkState;
      view: OutcomeView | null;
      tier: Tier | null;
      breakfast: boolean;
      under16: boolean;
    };

/** Сколько горит зелёная вспышка. */
const FLASH_MS = 1000;

const PAY_LABELS: Record<PaymentMethod, string> = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };

const COLOR_BG: Record<Color, string> = {
  green: 'bg-scan-green text-white',
  yellow: 'bg-scan-yellow text-black',
  red: 'bg-scan-red text-white',
};

const COLOR_SIGNAL: Record<Color, Signal> = { green: 'success', yellow: 'warning', red: 'error' };
const COLOR_ICON: Record<Color, TablerIcon> = { green: IconCircleCheck, yellow: IconAlertTriangle, red: IconBan };

/** Крупная иконка результата над заголовком. */
function ResultIcon({ color, offline, size = 52 }: { color: Color; offline?: boolean; size?: number }) {
  const Icon = offline ? IconCloudCheck : COLOR_ICON[color];
  return <Icon size={size} className="mb-2" style={{ strokeWidth: 2 }} />;
}

/**
 * Полоса варианта участия внизу экрана: у каждого варианта свой цвет - волонтёр сразу видит,
 * кому положены обед и ужин, а надпись «+ завтрак» - кому завтрак. Младше 16 - отдельная метка.
 */
function TierBand({
  tier,
  tiers,
  breakfast,
  under16,
  className,
}: {
  tier: Tier | null;
  tiers: TiersConfig;
  breakfast: boolean;
  under16: boolean;
  className?: string;
}) {
  if (!tier && !under16) return null;
  const cfg = (tier ? tiers[tier] : null) ?? null;
  const bg = cfg?.color ?? '#374151';
  const bracelet = braceletOf(tiers, tier);
  return (
    <div
      className={cx('flex flex-col items-center justify-center gap-2 px-5 text-center', className)}
      style={{ background: bg, color: textOn(bg) }}
    >
      {/* Какой браслет выдать - крупно: по нему кормят. */}
      {bracelet && <BraceletBig bracelet={bracelet} className="w-full max-w-sm" />}
      {cfg && <p className="text-[22px] font-extrabold leading-tight">{tierShort(cfg, breakfast)}</p>}
      {under16 && (
        <p className="rounded-full bg-black/25 px-3 py-0.5 text-[15px] font-bold text-white">до {MIN_AGE} лет</p>
      )}
    </div>
  );
}

const shortName = (full: string) => {
  const [last, first] = full.split(' ');
  return first ? `${last} ${first[0]}.` : full;
};

/** Сколько ещё внести: к оплате минус уже внесённое (внесённое знает только сервер). */
const remainingOf = (card: CardInfo) => Math.max(0, Number(card.amountDue ?? 0) - Number(card.amountPaid ?? 0));

function withFixes(l: LookupState, paid: { status: PaymentStatus; amountPaid: string } | null, local: LookupState | null): LookupState {
  if (!l.found) return l;
  let card: CardInfo = l.card;
  // Касса только что приняла оплату - статус и внесённое берём из ответа сервера («частично» остаётся «частично»).
  if (paid) card = { ...card, paymentStatus: paid.status, amountPaid: paid.amountPaid };
  // Сервер ещё не знает про офлайн-отметку с этого устройства - показываем её.
  if (!card.checkIn && local?.found && local.card.id === card.id && local.card.checkIn?.local) card = { ...card, checkIn: local.card.checkIn };
  return card === l.card ? l : { ...l, card };
}

export function ResultOverlay({
  subject,
  tz,
  sound,
  onClose,
  onRecord,
}: {
  subject: ScanSubject;
  tz: string;
  sound: boolean;
  onClose: (r: OverlayResult) => void;
  /** Строка для «Последних отметок»; может прийти и после закрытия экрана (ответ сервера в фоне). */
  onRecord: (r: RecentItem) => void;
}) {
  const staff = useStaff();
  const manifest = useManifestState();
  const fallbackTiers = useTiers();
  const cp = subject.checkpoint;
  const canWrite = can(staff, 'checkin:write');
  const fromScan = subject.source === 'scan';

  const [local, setLocal] = useState<LookupState | null>(null);
  const [server, setServer] = useState<LookupState | null>(null);
  const [serverState, setServerState] = useState<'pending' | 'ok' | 'failed'>('pending');
  const [serverError, setServerError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [paid, setPaid] = useState<{ status: PaymentStatus; amountPaid: string } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'review' });
  /** Человек коснулся вспышки - не закрываем сами, ждём его решения. */
  const [hold, setHold] = useState(false);
  const closedRef = useRef(false);

  // Касса (только если оплата включена)
  const [payMethod, setPayMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [paying, setPaying] = useState(false);
  /** Ключ приёма: при повторной отправке того же приёма (не дождались ответа) сервер не зачтёт дважды. */
  const payRequestRef = useRef<string | null>(null);

  // ---------- поиск: локально + сервер ----------
  useEffect(() => {
    let cancelled = false;
    setServerState('pending');
    setServerError(null);
    if (fromScan && !subject.canonical) {
      setLocal({ found: false, origin: 'local', reason: 'invalid_code' });
    } else if (canWrite) {
      void localLookup(subject.canonical, subject.participantId, cp.id).then((r) => {
        if (!cancelled) setLocal(r);
      });
    }
    const code = subject.canonical ?? (subject.raw ? subject.raw.slice(0, 200) : null);
    staffApi
      .lookup({ checkpointId: cp.id, code, participantId: subject.participantId })
      .then((r) => {
        if (cancelled) return;
        setServer(
          r.found
            ? {
                found: true,
                origin: 'server',
                codeStatus: r.codeStatus,
                card: fromServerCard(r.card),
                family: [],
                paymentsEnabled: r.paymentsEnabled === true,
                allowUnpaidEntry: r.allowUnpaidEntry,
                tiers: r.tiers ?? null,
              }
            : { found: false, origin: 'server', reason: r.reason },
        );
        setServerState('ok');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setServerState('failed');
        setServerError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [subject, fromScan, cp.id, canWrite, attempt]);

  const base = server ?? local;
  const effective = useMemo(() => (base ? withFixes(base, paid, local) : null), [base, paid, local]);
  const verdict = effective ? lookupVerdict(effective, cp, tz) : null;
  const card = effective?.found ? effective.card : null;
  // Оплата выключена → ни статусов, ни «не оплачено», ни кассы.
  const rules: PaymentRules = effective?.found
    ? { paymentsEnabled: effective.paymentsEnabled, allowUnpaidEntry: effective.allowUnpaidEntry }
    : { paymentsEnabled: false, allowUnpaidEntry: true };
  const payments = rules.paymentsEnabled;
  const tiers = (effective?.found ? effective.tiers : null) ?? fallbackTiers;
  // Касса: подставляем остаток (а не всю сумму варианта) - кассиру остаётся нажать.
  const remaining = card ? remainingOf(card) : 0;
  useEffect(() => {
    if (remaining > 0) setAmount((a) => a || String(Number(remaining.toFixed(2))));
  }, [remaining]);
  const canCash = payments && can(staff, 'payments:write');
  const unpaid = Boolean(card && verdict?.unpaid && needsPayment(card, cp, rules));

  // ---------- закрытие ----------
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const recordRef = useRef(onRecord);
  recordRef.current = onRecord;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const finish = (reopen: boolean, extra: Partial<OverlayResult> = {}) => {
    if (closedRef.current) return;
    closedRef.current = true;
    const p = phaseRef.current;
    // «Отмечен» в попапе - только когда сервер принял (или отметка сохранена без связи), не пока ждём ответа.
    const marked = p.kind === 'flash' && (p.state === 'ok' || p.state === 'offline');
    closeRef.current({
      reopen,
      popupText: marked && p.kind === 'flash' ? `✅ ${shortName(p.name)} - отмечен(а). Следующий!` : undefined,
      ...extra,
    });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // ---------- отметка: сразу вспышка, ответ сервера - в фоне ----------
  const submittedRef = useRef(false);
  const markRef = useRef<Promise<{ accepted: boolean; undo: UndoItem[]; record: RecentItem } | null> | null>(null);

  const mark = (override = false) => {
    if (!card || submittedRef.current) return;
    submittedRef.current = true;
    const clientEventId = uuid();
    const name = card.fullName;
    setHold(false);
    const sub = card.category === 'participant' ? yearsLabel(card.age) : `${yearsLabel(card.age)} · ${CATEGORY_LABELS[card.category]}`;
    // Зелёный и звук - только после ответа сервера: иначе второй сканер с тем же скриншотом билета тоже
    // показал бы «Отмечен», а отказ пришёл бы потом мелким уведомлением.
    setPhase({ kind: 'flash', name, sub, state: 'pending', view: null, tier: card.tier, breakfast: card.breakfast, under16: card.under16 });

    markRef.current = submitCheckIns(
      [
        {
          name,
          event: {
            clientEventId,
            checkpointId: cp.id,
            participantId: card.id,
            code: fromScan ? subject.canonical : null,
            clientTs: new Date().toISOString(),
            deviceId: deviceId(),
            method: fromScan ? 'scan' : 'manual',
            offline: false,
            overrideUnpaid: override && canCash,
          },
        },
      ],
      staff.user.name,
    ).then(
      (res) => {
        const offline = res.mode === 'offline';
        const r = res.mode === 'online' ? res.results.get(clientEventId) : undefined;
        const view = offline ? null : outcomeView(r, tz);
        const accepted = offline || r?.outcome === 'new' || r?.outcome === 'retry';
        const undo: UndoItem[] =
          accepted && canWrite ? [{ clientEventId, checkInId: r?.checkInId ?? null, checkpointId: cp.id, participantId: card.id }] : [];
        const record: RecentItem = {
          key: clientEventId,
          name,
          tier: card.tier,
          breakfast: card.breakfast,
          color: accepted ? 'green' : (view?.color ?? 'red'),
          text: offline ? 'сохранено без связи' : accepted ? '' : (view?.text ?? ''),
          at: Date.now(),
        };
        recordRef.current(record);
        if (accepted) signal('success', sound);
        if (!accepted) {
          // Сервер не принял (например, уже отмечен на другом устройстве) - пропустить это нельзя.
          signal(COLOR_SIGNAL[view?.color ?? 'red'], sound);
          if (closedRef.current) toast.error(`${shortName(name)}: ${view?.text ?? 'не отмечен'}`, 7000);
        }
        setPhase((p) =>
          p.kind === 'flash' && p.state === 'pending' ? { ...p, state: accepted ? (offline ? 'offline' : 'ok') : 'rejected', view } : p,
        );
        return { accepted, undo, record };
      },
      (err: unknown) => {
        const view: OutcomeView = { color: 'red', text: errorMessage(err) };
        signal('error', sound);
        if (closedRef.current) toast.error(`${shortName(name)}: ${view.text}`, 7000);
        setPhase((p) => (p.kind === 'flash' ? { ...p, state: 'rejected', view } : p));
        return null;
      },
    );
  };
  const markFnRef = useRef(mark);
  markFnRef.current = mark;

  // Скан + зелёный = отмечаем сразу, без нажатия. Один раз: после отказа - только кнопкой.
  const autoTried = useRef(false);
  const autoReady = fromScan && phase.kind === 'review' && verdict?.color === 'green' && verdict.canCheckIn;
  useEffect(() => {
    if (!autoReady || autoTried.current) return;
    autoTried.current = true;
    markFnRef.current();
  }, [autoReady]);

  // Цвет + вибрация + звук, когда появился вердикт (для отметки сигнал дала вспышка).
  const signaled = useRef<Color | null>(null);
  useEffect(() => {
    if (!verdict || phase.kind !== 'review' || autoReady) return;
    if (signaled.current === verdict.color) return;
    signaled.current = verdict.color;
    signal(COLOR_SIGNAL[verdict.color], sound);
  }, [verdict, phase.kind, autoReady, sound]);

  // Вспышка гаснет сама через ~1 с (пока отметка не отклонена и экран не трогали); после скана - сразу следующий.
  const flashLive = phase.kind === 'flash' && (phase.state === 'ok' || phase.state === 'offline');
  useEffect(() => {
    if (!flashLive || hold) return;
    const t = window.setTimeout(() => finishRef.current(fromScan), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flashLive, hold, fromScan]);

  const undo = async () => {
    if (phase.kind !== 'flash' || !markRef.current) return;
    setHold(true);
    setPhase((p) => (p.kind === 'flash' ? { ...p, state: 'undoing' } : p));
    const done = await markRef.current;
    if (!done?.accepted || done.undo.length === 0) {
      setPhase((p) => (p.kind === 'flash' ? { ...p, state: 'rejected' } : p));
      return;
    }
    const res = await undoCheckIns(done.undo);
    if (res.failed === 0) {
      recordRef.current({ ...done.record, color: 'yellow', text: 'отменено' });
      setPhase((p) => (p.kind === 'flash' ? { ...p, state: 'undone' } : p));
    } else {
      toast.error('Не удалось отменить - проверьте связь');
      setPhase((p) => (p.kind === 'flash' ? { ...p, state: 'ok' } : p));
    }
  };

  useBackHandler(() => finishRef.current(false), 20);

  // ---------- касса ----------
  const amountValue = amount.trim().replace(',', '.');
  const amountValid = amountValue === '' || (/^\d{1,8}(\.\d{1,2})?$/.test(amountValue) && Number(amountValue) > 0);

  const acceptPayment = async (thenCheckIn: boolean) => {
    if (paying || !card || !amountValid) return;
    setPaying(true);
    // «Принять оплату» без пропуска: человек станет зелёным, но отмечать вход сами не будем.
    if (!thenCheckIn) autoTried.current = true;
    payRequestRef.current ??= uuid();
    try {
      const res = await staffApi.markPaid({
        participantIds: [card.id],
        method: payMethod,
        amount: amountValue || null,
        note: null,
        requestId: payRequestRef.current,
      });
      payRequestRef.current = null;
      const person = res.people.find((p) => p.id === card.id);
      if (person) setPaid({ status: person.paymentStatus, amountPaid: person.amountPaid });
      if (person?.paymentStatus === 'paid') await markLocalPaid([card.id]);
      if (res.duplicate) toast.info('Этот приём уже записан - второй раз не зачли');
      else if (res.updated === 0) toast.info('Оплата уже была - ничего не изменилось');
      else toast.success(person?.paymentStatus === 'partial' ? `Принято частично, осталось ${formatRub(remainingOf({ ...card, amountPaid: person.amountPaid }))}` : 'Оплата принята');
      if (thenCheckIn) {
        setPaying(false);
        mark(true);
        return;
      }
    } catch (err) {
      // Ошибка данных - ключ больше не нужен; нет связи - оставляем, чтобы повтор не зачёл дважды.
      if (!(err instanceof ApiError && err.isTransient)) payRequestRef.current = null;
      signal('error', sound);
      toast.error(`Оплату отметить не удалось: ${errorMessage(err)}`);
    }
    setPaying(false);
  };

  /** Заплатит переводом позже: пропускаем, в бот - реквизиты и «пришлите чек». Статус остаётся «не оплачено». */
  const letInTransfer = async () => {
    if (paying || !card) return;
    setPaying(true);
    try {
      await staffApi.promiseTransfer([card.id]);
      setPaying(false);
      mark(true);
    } catch (err) {
      setPaying(false);
      signal('error', sound);
      toast.error(`Не получилось: ${errorMessage(err)}`);
    }
  };

  /** Чек о переводе на проверке - кассир пропускает без оплаты (проверят позже), это пишется в журнал. */
  const letInUnpaid = async () => {
    if (!card) return;
    const ok = await confirmAction({
      title: 'Пропустить без оплаты?',
      message: `${card.fullName}: чек ещё на проверке. Отметим вход, оплату проверят позже.`,
      ok: 'Пропустить',
    });
    if (ok) mark(true);
  };

  const nextButton = (
    <Button size="lg" block className="min-h-16 text-[19px]" onClick={() => finish(fromScan)}>
      {fromScan ? (
        <>
          <IconScan size={22} />
          Дальше
        </>
      ) : (
        <>
          Готово
          <IconArrowRight size={20} />
        </>
      )}
    </Button>
  );

  // ---------- вспышка ----------
  if (phase.kind === 'flash') {
    const s = phase.state;
    const green = s === 'ok' || s === 'offline' || s === 'undoing';
    const color: Color | null = green ? 'green' : s === 'rejected' ? (phase.view?.color ?? 'red') : null;
    return (
      <div
        className={cx('fixed inset-0 z-50 flex flex-col pt-[calc(var(--safe-top)+16px)]', color ? COLOR_BG[color] : 'bg-page text-fg')}
        onPointerDown={() => setHold(true)}
      >
        <div className="flex justify-end px-6">
          <button
            type="button"
            aria-label="Закрыть"
            onClick={() => finish(false)}
            className="-mr-2 flex size-11 items-center justify-center rounded-full opacity-80 active:opacity-50"
          >
            <IconX size={28} />
          </button>
        </div>
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 text-center">
          {s === 'undone' ? (
            <IconArrowBackUp size={88} className="mb-3 text-hint" />
          ) : s === 'pending' ? (
            <Spinner className="mb-3 size-20 text-hint" />
          ) : (
            <ResultIcon color={color ?? 'green'} offline={s === 'offline'} size={96} />
          )}
          <p className="text-[34px] font-extrabold uppercase leading-[1.1]">
            {s === 'undone'
              ? 'Отменено'
              : s === 'pending'
                ? 'Отмечаем…'
                : s === 'rejected'
                ? 'Не отмечен'
                : s === 'offline'
                  ? 'Сохранено'
                  : 'Отмечен'}
          </p>
          <p className="mt-4 text-[30px] font-bold leading-tight">{phase.name}</p>
          <p className="mt-1 text-[18px] font-medium opacity-90">{phase.sub}</p>
          {s === 'rejected' && phase.view && <p className="mt-3 text-[17px] font-semibold">{phase.view.text}</p>}
          {s === 'offline' && <p className="mt-3 text-[15px] opacity-90">Нет связи - отметка отправится сама</p>}
          {s === 'undone' && <p className="mt-3 text-[15px] text-subtle">Отметку сняли. Можно сканировать дальше.</p>}
        </div>
        <div className={cx('mx-auto grid w-full max-w-xl gap-2 px-6', phase.tier || phase.under16 ? 'pb-4' : 'pb-[calc(var(--safe-bottom)+20px)]')}>
          {green && canWrite && (
            <button
              type="button"
              onClick={() => void undo()}
              disabled={s === 'undoing'}
              className="flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl border-2 border-white/80 text-[19px] font-bold active:bg-white/15 disabled:opacity-70"
            >
              {s === 'undoing' ? <Spinner className="size-6" /> : <IconArrowBackUp size={24} />}
              Отменить
            </button>
          )}
          {(!green || hold) && s !== 'undoing' && nextButton}
        </div>
        <TierBand
          tier={phase.tier}
          tiers={tiers}
          breakfast={phase.breakfast}
          under16={phase.under16}
          className="min-h-[22vh] shrink-0 pb-[calc(var(--safe-bottom)+12px)] pt-3"
        />
      </div>
    );
  }

  // ---------- проверка / жёлтый / красный ----------
  const noData = !effective && serverState === 'failed';
  const loading = !effective && serverState === 'pending';
  const headColor: Color | null = verdict?.color ?? null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page">
      {/* Цветная шапка */}
      <div className={cx('shrink-0 px-5 pb-6 pt-[calc(var(--safe-top)+16px)] transition-colors', headColor ? COLOR_BG[headColor] : 'bg-section text-fg')}>
        <div className="mx-auto w-full max-w-xl">
          <div className="flex justify-end">
            <button
              type="button"
              aria-label="Закрыть"
              onClick={() => finish(false)}
              className="-mr-2 -mt-1 flex size-10 items-center justify-center rounded-full opacity-80 active:opacity-50"
            >
              <IconX size={26} />
            </button>
          </div>

          {loading ? (
            <div className="mt-2 flex items-center gap-3">
              <Spinner className="size-7" />
              <p className="text-xl font-bold">Проверяем QR-код…</p>
            </div>
          ) : noData ? (
            <>
              <IconWifiOff size={52} className="mb-2" />
              <p className="text-[26px] font-extrabold leading-tight">Нет связи</p>
              <p className="mt-1 text-[15px] opacity-90">
                {canWrite ? 'QR-коды ещё не загружены на устройство.' : 'Сервер недоступен.'} {serverError}
              </p>
            </>
          ) : (
            verdict && (
              <>
                <ResultIcon color={verdict.color} />
                <p className="text-[30px] font-extrabold uppercase leading-[1.1]">{verdict.title}</p>
                {verdict.detail && <p className="mt-1 text-[16px] font-medium opacity-90">{verdict.detail}</p>}
              </>
            )
          )}

          {card && (
            <div className="mt-3">
              <p className="text-[28px] font-bold leading-tight">{card.fullName}</p>
              <p className="mt-1 text-[17px] font-medium opacity-90">
                {yearsLabel(card.age)}
                {card.category !== 'participant' ? ` · ${CATEGORY_LABELS[card.category]}` : ''}
                {payments && card.paymentStatus !== 'exempt' ? ` · ${PAYMENT_STATUS_LABELS[card.paymentStatus]}` : ''}
                {payments && (card.paymentStatus === 'unpaid' || card.paymentStatus === 'partial') && remaining > 0
                  ? ` · осталось ${formatRub(remaining)}`
                  : ''}
              </p>
            </div>
          )}

          {effective?.origin === 'local' && (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] opacity-80">
              {serverState === 'pending' ? <IconRefresh size={15} /> : <IconWifiOff size={15} />}
              {serverState === 'pending'
                ? 'По базе на устройстве, сверяем с сервером…'
                : `Нет связи - по базе на устройстве${manifest.meta ? ` от ${formatTime(new Date(manifest.meta.fetchedAt), tz)}` : ''}`}
            </p>
          )}
        </div>
      </div>

      {card && <TierBand tier={card.tier} tiers={tiers} breakfast={card.breakfast} under16={card.under16} className="shrink-0 py-3" />}

      {/* Нижняя часть */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-xl px-4 pb-[calc(var(--safe-bottom)+20px)] pt-4">
          {loading ? null : noData ? (
            <div className="grid gap-2">
              <Button size="lg" block onClick={() => setAttempt((a) => a + 1)}>
                Повторить
              </Button>
              <Button size="lg" variant="secondary" block onClick={() => finish(false, { focusSearch: true })}>
                <IconSearch size={20} />
                Найти по фамилии
              </Button>
            </div>
          ) : !card ? (
            <div className="grid gap-2">
              {nextButton}
              <Button size="lg" variant="secondary" block onClick={() => finish(false, { focusSearch: true })}>
                <IconSearch size={20} />
                Найти по фамилии
              </Button>
            </div>
          ) : (
            <>
              {canCash && unpaid && (
                <div className="mb-4 rounded-2xl bg-warn-soft p-3">
                  <p className="flex items-center gap-2 font-semibold">
                    <IconCash size={20} />
                    Касса: оплата за {shortName(card.fullName)}
                  </p>
                  <div className="mt-2 flex gap-1 rounded-xl bg-section p-1">
                    {PAYMENT_METHODS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPayMethod(m)}
                        className={cx(
                          'min-h-10 flex-1 rounded-lg text-[15px] font-semibold',
                          payMethod === m ? 'bg-btn text-btn-fg' : 'text-subtle',
                        )}
                      >
                        {PAY_LABELS[m]}
                      </button>
                    ))}
                  </div>
                  {payMethod === 'transfer' ? (
                    // Перевод на месте не проверить: пускаем, а чек человек пришлёт в бот.
                    <>
                      <p className="mt-2 text-[14px] text-subtle">Пропустим, а в бот придут реквизиты и просьба прислать чек. Взнос останется «не оплачено», пока не пришлёт чек.</p>
                      <Button variant="success" block className="mt-2" loading={paying} onClick={() => void letInTransfer()}>
                        Пропустить - оплатит переводом
                      </Button>
                    </>
                  ) : (
                    <>
                      <TextInput
                        className="mt-2 bg-section"
                        inputMode="decimal"
                        placeholder="Сумма, руб."
                        value={amount}
                        invalid={!amountValid}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Button variant="outline" loading={paying} disabled={!amountValid} onClick={() => void acceptPayment(false)}>
                          Принять оплату
                        </Button>
                        <Button variant="success" loading={paying} disabled={!amountValid} onClick={() => void acceptPayment(true)}>
                          {amountValue ? `Принять ${formatRub(amountValue)} и пропустить` : 'Принять и пропустить'}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="grid gap-2">
                {verdict?.canCheckIn && (
                  <Button size="lg" variant="success" block className="min-h-16 text-[20px]" onClick={() => mark()}>
                    <IconCircleCheck size={24} />
                    Отметить
                  </Button>
                )}
                {unpaid && canCash && card.paymentStatus === 'pending' && (
                  <Button size="lg" variant="outline" block onClick={() => void letInUnpaid()}>
                    Пропустить без оплаты
                  </Button>
                )}
                {unpaid && !canCash && (
                  <Button size="lg" variant="secondary" block disabled>
                    {card.paymentStatus === 'pending' ? 'Чек на проверке - позовите кассира' : 'Не оплачено - отправьте на кассу'}
                  </Button>
                )}
                {!verdict?.canCheckIn && nextButton}
                {verdict?.canCheckIn && (
                  <Button size="lg" variant="plain" block onClick={() => finish(false)}>
                    Закрыть
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
