import { canUseAdminWeb, CATEGORY_LABELS, PAYMENT_STATUS_LABELS, parseTicketCode, type CheckpointView, type StaffRecentScan } from '@sof/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { qrScanner } from '@tma.js/sdk-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { IconCameraOff, IconChevronRight, IconCloudUpload, IconMapPin, IconScan, IconSearch, IconVolume, IconVolumeOff } from '@tabler/icons-react';
import { ApiError, errorMessage, useOffline } from '../api/client.ts';
import { useEnv } from '../app/env.ts';
import { unlockAudio } from '../lib/feedback.ts';
import { formatTime, yearsLabel } from '../lib/time.ts';
import { setVerticalSwipes } from '../telegram/sdk.ts';
import { Badge, Button, cx, ErrorState, Notice, paymentTone, Spinner, TextInput } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { checkInLabel, type Color } from './checkin.ts';
import { nativeScannerAvailable, useBeforeEvent, useEntranceCheckpoint, useEventTimezone, usePaymentsEnabled, usePersistentFlag, useTiers } from './common.ts';
import { TierBadge } from '../ui/TierBadge.tsx';
import { fromServerCard, localSearch, useManifestState, type CardInfo } from './manifest.ts';
import { dismissIssues, flushOutbox, useOutbox } from './outbox.ts';
import { ResultOverlay, type OverlayResult, type RecentItem, type ScanSubject } from './ResultOverlay.tsx';
import { PersonSheet, type CashSubject } from './Cash.tsx';
import { can, logoutBrowser, useStaff } from './session.ts';
import { SessionExpiredNotice } from './SessionExpired.tsx';

const CameraScanner = lazy(() => import('./CameraScanner.tsx'));


function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

const COLOR_DOT: Record<Color, string> = { green: 'bg-ok', yellow: 'bg-warn', red: 'bg-bad' };

/** Скан с сервера → строка истории. */
function fromServerScan(r: StaffRecentScan): RecentItem {
  const ok = r.outcome === 'new' || r.outcome === 'retry';
  const [color, text]: [Color, string] = r.revoked
    ? ['yellow', 'отменено']
    : ok
      ? ['green', '']
      : r.outcome === 'duplicate'
        ? ['yellow', 'уже был отмечен']
        : r.outcome === 'unpaid'
          ? ['yellow', 'не оплачено']
          : r.outcome === 'revoked_ticket'
            ? ['red', 'QR-код перевыпущен']
            : ['red', 'QR-код не найден'];
  return {
    key: `s${r.id}`,
    name: r.fullName ?? 'Неизвестный QR-код',
    tier: r.tier,
    breakfast: r.breakfast ?? false,
    color,
    text,
    at: new Date(r.at).getTime(),
    checkInId: r.checkInId,
    canUndo: r.canUndo && r.checkInId !== null,
  };
}

const RECENT_KEY = 'sof:recent-scans';
function loadLocalRecent(): RecentItem[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentItem[];
  } catch {
    return [];
  }
}

const ISSUE_TEXT: Record<string, string> = {
  unpaid: 'не оплачено',
  before_event: 'конференция ещё не началась',
  revoked_ticket: 'QR-код перевыпущен',
  cancelled_participant: 'регистрация отменена',
  checkpoint_inactive: 'точка «Вход» закрыта',
  forbidden: 'нет прав',
  check_in_undone: 'отметку отменили',
};

// ---------- поиск по фамилии ----------

function ManualSearch({
  checkpoint,
  tz,
  onPick,
  inputRef,
}: {
  checkpoint: CheckpointView;
  tz: string;
  onPick: (card: CardInfo) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const payments = usePaymentsEnabled();
  const tiers = useTiers();
  const search = useQuery({
    queryKey: ['staff-search', checkpoint.id, term],
    queryFn: async ({ signal }) => {
      try {
        const res = await staffApi.search(term, checkpoint.id, signal);
        return { items: res.items.map(fromServerCard), offline: false };
      } catch (err) {
        if (err instanceof ApiError && err.isNetwork) return { items: await localSearch(term, checkpoint.id), offline: true };
        throw err;
      }
    },
    enabled: term.length >= 2,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });
  const items = term.length >= 2 ? (search.data?.items ?? []) : [];

  return (
    <section className="mb-5">
      <div className="relative">
        <IconSearch size={20} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-hint" />
        <TextInput
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          placeholder="Фамилия, имя или телефон"
          className="pl-11"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {term.length >= 2 && (
        <div className="mt-2">
          {search.isFetching && items.length === 0 ? (
            <div className="flex justify-center py-4">
              <Spinner className="text-btn" />
            </div>
          ) : search.isError ? (
            <p className="px-1 py-2 text-[15px] text-danger">{errorMessage(search.error)}</p>
          ) : items.length === 0 ? (
            <p className="px-1 py-2 text-[15px] text-subtle">Никого не нашли</p>
          ) : (
            <div className="rounded-2xl bg-section p-1">
              {search.data?.offline && <p className="px-3 pt-2 text-[13px] text-warn-fg">Нет связи - ищем в базе на устройстве</p>}
              {items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPick(c)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left active:bg-fill"
                >
                  <span className="min-w-0 flex-1">
                    <span className={cx('block font-semibold leading-snug', c.status === 'cancelled' && 'text-hint line-through')}>
                      {c.fullName}
                    </span>
                    <span className="block text-[13px] text-subtle">
                      {yearsLabel(c.age)}
                      {c.category !== 'participant' ? ` · ${CATEGORY_LABELS[c.category]}` : ''}
                      {c.checkIn ? ` · отмечен ${checkInLabel(c.checkIn, tz)}` : ''}
                    </span>
                    <TierBadge bracelet tier={c.tier} tiers={tiers} breakfast={c.breakfast} size="sm" className="mt-0.5" />
                  </span>
                  {payments && (
                    <Badge tone={paymentTone(c.paymentStatus)} className="shrink-0">
                      {PAYMENT_STATUS_LABELS[c.paymentStatus]}
                    </Badge>
                  )}
                  <IconChevronRight size={20} className="text-hint" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- экран ----------

export default function Scanner() {
  const staff = useStaff();
  const env = useEnv();
  const tz = useEventTimezone();
  const tiers = useTiers();
  const qc = useQueryClient();
  const offline = useOffline();
  const entrance = useEntranceCheckpoint();
  const cp = entrance.checkpoint;
  const manifest = useManifestState();
  const outbox = useOutbox();
  const [sound, setSound] = usePersistentFlag('sof:scan-sound', true);
  const [subject, setSubject] = useState<ScanSubject | null>(null);
  // До начала конференции сканер - касса: скан открывает оплату, вход не отмечается.
  const payMode = useBeforeEvent();
  const [cashSubject, setCashSubject] = useState<CashSubject | null>(null);
  // История сканов хранится на сервере; на устройстве - копия на случай, когда нет связи.
  const [recent, setRecent] = useState<RecentItem[]>(loadLocalRecent);
  useEffect(() => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 10)));
    } catch {
      /* ignore */
    }
  }, [recent]);
  const native = nativeScannerAvailable();
  const [nativeFailed, setNativeFailed] = useState(false);
  const [cameraOn, setCameraOn] = useState(() => !native && sessionStorage.getItem('sof:camera-on') === '1');
  const lastRead = useRef<{ text: string; at: number } | null>(null);
  const seq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setVerticalSwipes(false);
    return () => setVerticalSwipes(true);
  }, []);

  const acceptRead = useCallback((text: string) => {
    const now = Date.now();
    const last = lastRead.current;
    if (last && last.text === text && now - last.at < 2000) {
      last.at = now; // тот же код всё ещё перед камерой - ждём 2 секунды тишины
      return false;
    }
    lastRead.current = { text, at: now };
    return true;
  }, []);

  const startSubject = useCallback(
    (s: Omit<ScanSubject, 'id' | 'checkpoint'>) => {
      if (payMode) {
        setCashSubject(s.participantId ? { participantId: s.participantId, via: 'search' } : { code: s.raw ?? '', via: 'qr' });
        return;
      }
      if (!cp) return;
      seq.current += 1;
      setSubject({ ...s, id: seq.current, checkpoint: cp });
    },
    [cp, payMode],
  );

  const onRawScanRef = useRef((raw: string, via: 'native' | 'camera') => {
    void raw;
    void via;
  });
  onRawScanRef.current = (raw, via) => startSubject({ source: 'scan', via, raw, canonical: parseTicketCode(raw), participantId: null });

  const openNative = useCallback(
    (text?: string, silent = false) => {
      try {
        if (!qrScanner.open.isAvailable() || qrScanner.isOpened()) return;
        let handled = false;
        qrScanner
          .open({
            text: (text ?? (payMode ? 'Оплата: наведите на QR-код. Вход не отмечается' : 'Наведите камеру на QR-код')).slice(0, 100),
            onCaptured: (qr) => {
              if (handled || !acceptRead(qr)) return;
              handled = true;
              try {
                qrScanner.close();
              } catch {
                /* ignore */
              }
              onRawScanRef.current(qr, 'native');
            },
          })
          .catch(() => {
            if (!silent) setNativeFailed(true);
          });
      } catch {
        if (silent) return;
        setNativeFailed(true);
        toast.error('Сканер Telegram не открылся - попробуйте камеру в приложении');
      }
    },
    [acceptRead],
  );

  // Две цифры сверху: за последний час и мои отметки. Обновляем раз в 20 секунд и после каждой отметки.
  const serverRecent = useQuery({
    queryKey: ['staff-recent', cp?.id],
    queryFn: () => staffApi.recent(cp!.id),
    enabled: Boolean(cp),
    refetchInterval: 30_000,
    retry: false,
  });
  const history = serverRecent.isSuccess && !offline ? serverRecent.data.map(fromServerScan) : recent;

  const stats = useQuery({
    queryKey: ['staff-stats', cp?.id],
    queryFn: () => staffApi.stats(cp!.id),
    enabled: Boolean(cp),
    refetchInterval: 20_000,
    retry: false,
  });

  const onCameraRead = useCallback(
    (text: string) => {
      if (subject || !acceptRead(text)) return;
      onRawScanRef.current(text, 'camera');
    },
    [subject, acceptRead],
  );

  const onOverlayClose = (res: OverlayResult) => {
    const was = subject;
    setSubject(null);
    if (res.focusSearch) {
      window.setTimeout(() => searchRef.current?.focus(), 100);
    } else if (res.reopen && was?.via === 'native') {
      // Сразу следующий скан: окно сканера Telegram открываем почти без паузы.
      window.setTimeout(() => openNative(res.popupText), 100);
    }
  };

  /** Итог отметки (приходит в фоне, иногда уже после закрытия экрана результата). */
  const onRecord = useCallback(
    (item: RecentItem) => {
      setRecent((list) => [item, ...list.filter((x) => x.key !== item.key)].slice(0, 10));
      void qc.invalidateQueries({ queryKey: ['staff-recent'] });
      void qc.invalidateQueries({ queryKey: ['staff-stats'] });
      void qc.invalidateQueries({ queryKey: ['staff-search'] });
    },
    [qc],
  );

  // Отмена из «Последних отметок»: своя свежая отметка (сервер сам говорит canUndo).
  const [undoingKey, setUndoingKey] = useState<string | null>(null);
  const undoFromHistory = async (r: RecentItem) => {
    if (!r.checkInId || undoingKey) return;
    setUndoingKey(r.key);
    try {
      await staffApi.revoke(r.checkInId);
      toast.success(`${r.name}: отметка отменена`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUndoingKey(null);
      void qc.invalidateQueries({ queryKey: ['staff-recent'] });
      void qc.invalidateQueries({ queryKey: ['staff-stats'] });
      void qc.invalidateQueries({ queryKey: ['staff-search'] });
    }
  };

  const sendNow = async () => {
    const n = await flushOutbox();
    if (n > 0) toast.success(`Отправлено: ${n}`);
    else toast.info('Пока не получилось - попробуем автоматически');
  };

  const startCamera = () => {
    unlockAudio();
    setCameraOn(true);
    sessionStorage.setItem('sof:camera-on', '1');
  };

  const tapScan = () => {
    unlockAudio();
    if (native && !nativeFailed) openNative();
    else startCamera();
  };

  // Кнопка сразу под цифрами, во всю ширину.
  const scanText = cameraOn ? (
    <>
      <IconCameraOff size={22} />
      Закрыть камеру
    </>
  ) : (
    <>
      <IconScan size={24} />
      Сканировать QR-код
    </>
  );
  const onScanButton = () => {
    if (cameraOn) {
      setCameraOn(false);
      sessionStorage.removeItem('sof:camera-on');
    } else tapScan();
  };

  const hasHome = can(staff, 'activities:own') || can(staff, 'activities:all') || canUseAdminWeb(staff.roles);
  const backTarget = hasHome ? '/' : env.mode === 'telegram' ? '~/' : null;

  return (
    <Page
      title="Сканер"
      subtitle={
        cp ? (
          <span className="inline-flex items-center gap-1">
            <IconMapPin size={16} />
            {cp.name}
          </span>
        ) : undefined
      }
      back={backTarget}
      headerRight={
        <button
          type="button"
          onClick={() => setSound(!sound)}
          className={cx('flex size-10 items-center justify-center rounded-full bg-section', sound ? 'text-accent' : 'text-hint')}
          aria-label={sound ? 'Выключить звук' : 'Включить звук'}
        >
          {sound ? <IconVolume size={22} /> : <IconVolumeOff size={22} />}
        </button>
      }
    >
      <SessionExpiredNotice />
      {!cp ? (
        entrance.loading ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-9 text-btn" />
          </div>
        ) : entrance.error ? (
          <ErrorState error={entrance.error} title="Не удалось открыть сканер" onRetry={entrance.refetch} />
        ) : (
          <Notice tone="red" className="mb-4">
            <p className="font-semibold">Нет точки «Вход»</p>
            <p className="mt-1">Сканеру не на чем отмечать. Попросите администратора включить точку «Вход» в админке.</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={entrance.refetch}>
              Проверить ещё раз
            </Button>
          </Notice>
        )
      ) : (
        <>
          {/* Неотправленное - только когда оно есть */}
          {(outbox.count > 0 || outbox.issues.length > 0 || (!manifest.meta && !manifest.syncing && offline)) && (
            <div className="mb-3 space-y-2">
              {outbox.count > 0 && (
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-warn-soft px-4 py-2.5">
                  <span className="flex items-center gap-2 font-semibold text-warn-fg">
                    <IconCloudUpload size={20} />
                    Не отправлено: {outbox.count}
                    {offline ? ' · нет связи' : ''}
                  </span>
                  <Button size="sm" variant="outline" loading={outbox.flushing} onClick={() => void sendNow()}>
                    Отправить
                  </Button>
                </div>
              )}
              {outbox.issues.length > 0 && (
                <div className="rounded-2xl bg-bad-soft px-4 py-2.5 text-bad-fg">
                  <p className="font-semibold">Сервер не принял отметки, сделанные без связи:</p>
                  <ul className="mt-1 text-[14px]">
                    {outbox.issues.slice(-5).map((i) => (
                      <li key={i.clientEventId}>
                        {i.label || 'Участник'} - {ISSUE_TEXT[i.outcome] ?? 'отклонено'}
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="mt-1 text-[14px] font-semibold underline" onClick={dismissIssues}>
                    Понятно
                  </button>
                </div>
              )}
              {!manifest.meta && !manifest.syncing && offline && (
                <Notice tone="yellow">Нет связи, а QR-коды ещё не загружены на устройство - сканер их не узнает.</Notice>
              )}
            </div>
          )}

          {payMode && (
            <Notice tone="blue" className="mb-3">
              <p className="font-semibold">До начала конференции сканер принимает взносы</p>
              <p className="mt-0.5 text-[14px]">Отсканируйте QR-код или найдите по фамилии - откроется оплата. Приход не отмечается.</p>
            </Notice>
          )}

          {/* Две цифры */}
          {!payMode && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div className="rounded-2xl bg-section px-4 py-3">
              <p className="text-[28px] font-bold leading-none">{stats.data?.lastHour ?? '-'}</p>
              <p className="mt-1 text-[13px] text-subtle">за последний час</p>
            </div>
            <div className="rounded-2xl bg-section px-4 py-3">
              <p className="text-[28px] font-bold leading-none">{stats.data?.byMe ?? '-'}</p>
              <p className="mt-1 text-[13px] text-subtle">отсканировано мной</p>
            </div>
          </div>
          )}

          <Button size="lg" block className="mb-5 min-h-16 text-[18px]" onClick={onScanButton}>
            {scanText}
          </Button>

          {cameraOn && (
            <Suspense
              fallback={
                <div className="mb-3 flex aspect-[4/5] items-center justify-center rounded-3xl bg-black">
                  <Spinner className="size-8 text-white" />
                </div>
              }
            >
              <CameraScanner
                paused={Boolean(subject || cashSubject)}
                onRead={onCameraRead}
                onClose={() => {
                  setCameraOn(false);
                  sessionStorage.removeItem('sof:camera-on');
                }}
              />
            </Suspense>
          )}
          {native && nativeFailed && !cameraOn && (
            <button type="button" onClick={startCamera} className="mb-2 w-full py-2 text-center text-[15px] text-accent">
              Камера не открывается? Камера в приложении
            </button>
          )}

          {/* Поиск по фамилии - сразу на экране */}
          <p className="mb-2 px-1 text-[15px] font-semibold">Поиск по фамилии</p>
          <ManualSearch
            checkpoint={cp}
            tz={tz}
            inputRef={searchRef}
            onPick={(c) => startSubject({ source: 'manual', via: 'search', raw: null, canonical: null, participantId: c.id })}
          />

          {!payMode && history.length > 0 && (
            <section className="mb-5 mt-2">
              <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-head">Последние отметки</p>
              <div className="rounded-2xl bg-section px-3 py-1">
                {history.slice(0, 10).map((r) => (
                  <div key={r.key} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
                    <span className={cx('size-2.5 shrink-0 rounded-full', COLOR_DOT[r.color])} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{r.name}</span>
                      {r.text && <span className="block text-[13px] text-subtle">{r.text}</span>}
                      <TierBadge bracelet tier={r.tier} tiers={tiers} breakfast={r.breakfast} size="sm" />
                    </span>
                    <span className="shrink-0 text-[13px] text-subtle">{formatTime(new Date(r.at), tz)}</span>
                    {r.canUndo && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="shrink-0"
                        loading={undoingKey === r.key}
                        onClick={() => void undoFromHistory(r)}
                      >
                        Отменить
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {env.mode === 'browser' && !hasHome && (
        <button
          type="button"
          className="mb-4 mt-2 w-full py-2 text-center text-[14px] text-hint"
          onClick={() => {
            void logoutBrowser().then(() => window.location.assign('/staff/login'));
          }}
        >
          {staff.user.name} · Выйти
        </button>
      )}

      {payMode && (
        <PersonSheet
          subject={cashSubject}
          canAccept={can(staff, 'payments:write')}
          onClose={() => setCashSubject(null)}
          onScanNext={() => {
            setCashSubject(null);
            window.setTimeout(tapScan, 200);
          }}
        />
      )}
      {subject && (
        <ResultOverlay key={subject.id} subject={subject} tz={tz} sound={sound} onClose={onOverlayClose} onRecord={onRecord} />
      )}
    </Page>
  );
}
