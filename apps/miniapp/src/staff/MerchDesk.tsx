/**
 * Мерч для продавца с телефона: продать (сразу или в долг), выдать бронь по коду, погасить долг, итоги.
 * Настройки витрины и брони - шестерёнка в шапке. Склад и подробная статистика - в админке, раздел «Мерч».
 */
import {
  formatRub,
  PAYMENT_STATUS_LABELS,
  type AdminMerchOrderView,
  type AdminMerchProduct,
  type MerchPayMethod,
  type MerchScanResponse,
  type MerchSettings,
  type MerchSettingsView,
} from '@sof/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { qrScanner } from '@tma.js/sdk-react';
import { IconCameraOff, IconCheck, IconMinus, IconPhone, IconPlus, IconQrcode, IconSearch, IconSettings } from '@tabler/icons-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, errorMessage, staffBlobUrl } from '../api/client.ts';
import { haptic, unlockAudio } from '../lib/feedback.ts';
import { isoToZonedLocal, zonedLocalToIso } from '../lib/time.ts';
import { uuid } from '../lib/ids.ts';
import { confirmAction } from '../telegram/actions.ts';
import { Badge, Button, Checkbox, Chip, cx, EmptyState, ErrorState, Field, Notice, paymentTone, Section, Segmented, Spinner, TextInput } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { nativeScannerAvailable } from './common.ts';
import { can, useStaff } from './session.ts';
import { SessionExpiredNotice } from './SessionExpired.tsx';

const CameraScanner = lazy(() => import('./CameraScanner.tsx'));

type Tab = 'sell' | 'issue' | 'debts' | 'stats';
type Order = AdminMerchOrderView;

const PRODUCTS = ['merch-desk', 'products'] as const;
const ORDERS = ['merch-desk', 'orders'] as const;
const STATS = ['merch-desk', 'stats'] as const;
const SETTINGS = ['merch-desk', 'settings'] as const;
const METHODS: { value: MerchPayMethod; label: string }[] = [
  { value: 'cash', label: 'Наличные' },
  { value: 'transfer', label: 'Перевод' },
  { value: 'card', label: 'Карта' },
];
const isMoney = (v: string) => /^\d{1,7}(\.\d{1,2})?$/.test(v) && Number(v) > 0;
const debtOf = (o: Order) => Math.max(0, Number(o.total) - Number(o.paidAmount));
const buyerOf = (o: Order) => o.buyerName ?? o.userName;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function MerchDesk() {
  const [tab, setTab] = useState<Tab>('sell');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const staff = useStaff();
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ORDERS, queryFn: staffApi.merchOrders, refetchInterval: 30_000 });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['merch-desk'] })]);
  const owed = (orders.data ?? []).filter((o) => o.status === 'owed').length;
  const receipts = (orders.data ?? []).filter((o) => o.receipt).length;

  return (
    <Page
      title="Мерч"
      subtitle="Продажа, выдача, долги"
      back="/"
      headerRight={
        can(staff, 'merch:stock') && (
          <Button size="sm" variant="secondary" aria-label="Настройки мерча" onClick={() => setSettingsOpen(true)}>
            <IconSettings size={20} />
          </Button>
        )
      }
    >
      <SessionExpiredNotice />
      <Segmented
        value={tab}
        onChange={setTab}
        className="mb-4"
        options={[
          { value: 'sell', label: 'Продать' },
          // Чеки за мерч на проверке - во «Выдать», наверху списка: число - бейджем справа, в одну строку.
          {
            value: 'issue',
            label: receipts ? (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                Выдать
                <span className="rounded-full bg-warn px-1.5 text-[12px] font-bold leading-5 text-black" aria-label={`чеков на проверке: ${receipts}`}>
                  {receipts}
                </span>
              </span>
            ) : (
              'Выдать'
            ),
          },
          { value: 'debts', label: owed ? `Долги ${owed}` : 'Долги' },
          { value: 'stats', label: 'Итоги' },
        ]}
      />
      {tab === 'sell' && <SellTab onSold={() => void refresh()} />}
      {tab === 'issue' && <IssueTab orders={orders} onChanged={() => void refresh()} />}
      {tab === 'debts' && <DebtsTab orders={orders} onChanged={() => void refresh()} />}
      {tab === 'stats' && <StatsTab />}
      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Настройки мерча">
        {settingsOpen && <SettingsForm onDone={() => setSettingsOpen(false)} />}
      </Sheet>
    </Page>
  );
}

// ---------- продать ----------

function SellTab({ onSold }: { onSold: () => void }) {
  const products = useQuery({ queryKey: PRODUCTS, queryFn: staffApi.merchProducts, refetchInterval: 30_000 });
  const [productId, setProductId] = useState<number | null>(null);
  const [colorId, setColorId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [debt, setDebt] = useState(false);
  const [method, setMethod] = useState<MerchPayMethod>('cash');
  const [paidNow, setPaidNow] = useState('');
  const [buyer, setBuyer] = useState<Buyer>(EMPTY_BUYER);
  const [busy, setBusy] = useState(false);
  /** Ключ продажи: не дождались ответа и нажали снова - сервер не продаст дважды. */
  const requestRef = useRef<string | null>(null);

  const list = (products.data ?? []).filter((p) => p.colors.some((c) => c.sizes.length > 0));
  const p = list.find((x) => x.id === productId);
  const c = p?.colors.find((x) => x.id === colorId) ?? (p?.colors.length === 1 ? p.colors[0] : undefined);
  const s = c?.sizes.find((x) => x.id === variantId);
  const total = p && s ? Number(p.price) * qty : 0;
  const part = isMoney(paidNow.trim().replace(',', '.')) ? Number(paidNow.trim().replace(',', '.')) : 0;
  const buyerOk = !debt || !!buyer.participantId || (buyer.name.trim() !== '' && buyer.phone.trim() !== '');
  const valid = !!s && qty >= 1 && qty <= s.left && buyerOk && part <= total;

  const reset = () => {
    setVariantId(null);
    setQty(1);
    setDebt(false);
    setPaidNow('');
    setBuyer(EMPTY_BUYER);
  };

  const sell = async () => {
    if (!valid || !s || !p || busy) return;
    const ok = await confirmAction({
      title: debt ? `В долг на ${formatRub(total)}?` : `Продано за ${formatRub(total)}?`,
      message: `${p.title}${c && p.colors.length > 1 ? `, ${c.name}` : ''}, ${s.size} × ${qty}.${debt ? ` Покупатель: ${buyer.participantName ?? buyer.name.trim()}.` : ''}`,
      ok: debt ? 'Выдать в долг' : 'Продано',
    });
    if (!ok) return;
    setBusy(true);
    requestRef.current ??= uuid();
    try {
      const o = await staffApi.merchSell({
        requestId: requestRef.current,
        items: [{ variantId: s.id, qty }],
        method,
        debt,
        paidNow: debt && part > 0 ? part.toFixed(2) : null,
        buyerParticipantId: debt ? buyer.participantId : null,
        buyerName: debt && !buyer.participantId ? buyer.name.trim() : null,
        buyerPhone: debt && !buyer.participantId ? buyer.phone.trim() : null,
      });
      requestRef.current = null;
      haptic('success');
      toast.success(o.status === 'owed' ? `${o.code}: в долг, осталось ${formatRub(debtOf(o))}` : `${o.code}: продано, ${formatRub(o.total)}`);
      reset();
      onSold();
    } catch (err) {
      if (!(err instanceof ApiError && err.isTransient)) requestRef.current = null;
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (products.isPending) return <Loading />;
  if (products.isError) return <ErrorState error={products.error} onRetry={() => void products.refetch()} />;
  if (list.length === 0) return <EmptyState title="Товаров нет">Склад заполняют в админке: «Мерч» → «Товары».</EmptyState>;

  return (
    <div>
      <Section title="Вещь">
        <div className="grid gap-2">
          {list.map((x) => (
            <ProductButton
              key={x.id}
              p={x}
              active={x.id === productId}
              onClick={() => {
                setProductId(x.id);
                setColorId(null);
                setVariantId(null);
                setQty(1);
              }}
            />
          ))}
        </div>
      </Section>

      {p && p.colors.length > 1 && (
        <Section title="Цвет">
          <div className="flex flex-wrap gap-2">
            {p.colors.map((x) => (
              <Chip key={x.id} active={x.id === c?.id} onClick={() => (setColorId(x.id), setVariantId(null))}>
                <span className="mr-1.5 inline-block size-3 rounded-full align-middle" style={{ background: x.hex }} />
                {x.name}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {c && (
        <Section title="Размер · свободно">
          <div className="flex flex-wrap gap-2">
            {c.sizes.map((x) => (
              <button
                key={x.id}
                type="button"
                disabled={x.left <= 0}
                onClick={() => (setVariantId(x.id), setQty(1))}
                className={cx(
                  'min-h-12 min-w-16 rounded-xl px-3 text-center font-semibold transition disabled:opacity-40',
                  x.id === variantId ? 'bg-btn text-btn-fg' : 'bg-section',
                )}
              >
                <span className="block text-[16px] leading-tight">{x.size}</span>
                <span className="block text-[12px] opacity-75">{x.left > 0 ? `${x.left} шт.` : 'нет'}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {s && (
        <>
          <Section title="Сколько">
            <div className="flex items-center gap-3">
              <Button variant="secondary" disabled={qty <= 1} onClick={() => setQty(qty - 1)} aria-label="Меньше">
                <IconMinus size={20} />
              </Button>
              <span className="w-10 text-center text-[22px] font-bold tabular-nums">{qty}</span>
              <Button variant="secondary" disabled={qty >= s.left} onClick={() => setQty(qty + 1)} aria-label="Больше">
                <IconPlus size={20} />
              </Button>
              <span className="ml-auto text-[20px] font-bold tabular-nums">{formatRub(total)}</span>
            </div>
          </Section>

          <Segmented
            value={debt ? 'debt' : 'paid'}
            onChange={(v) => setDebt(v === 'debt')}
            className="mb-4"
            options={[
              { value: 'paid', label: 'Оплачено' },
              { value: 'debt', label: 'В долг' },
            ]}
          />

          {debt && (
            <>
              <BuyerPicker value={buyer} onChange={setBuyer} />
              <Field label="Внесли сейчас, ₽" optional hint={part > 0 ? `Долг будет ${formatRub(Math.max(0, total - part))}` : `Долг будет ${formatRub(total)}`}>
                <TextInput inputMode="decimal" placeholder="0" value={paidNow} invalid={part > total} onChange={(e) => setPaidNow(e.target.value)} />
              </Field>
            </>
          )}

          {(!debt || part > 0) && (
            <Field label="Как заплатили">
              <Segmented value={method} onChange={setMethod} options={METHODS} />
            </Field>
          )}

          <Button block size="lg" variant={debt ? 'primary' : 'success'} loading={busy} disabled={!valid} onClick={() => void sell()}>
            {debt ? 'Выдать в долг' : `Продано · ${formatRub(total)}`}
          </Button>
        </>
      )}
    </div>
  );
}

function ProductButton({ p, active, onClick }: { p: AdminMerchProduct; active: boolean; onClick: () => void }) {
  const left = p.colors.reduce((n, c) => n + c.sizes.reduce((m, s) => m + s.left, 0), 0);
  const thumb = p.media.find((m) => m.kind === 'photo')?.thumbUrl;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('flex w-full items-center gap-3 rounded-2xl p-3 text-left transition', active ? 'bg-btn text-btn-fg' : 'bg-section')}
    >
      {thumb ? <img src={thumb} alt="" className="size-12 shrink-0 rounded-xl object-cover" /> : <span className="size-12 shrink-0 rounded-xl bg-fill" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{p.title}</span>
        <span className={cx('block text-[13px]', active ? 'opacity-80' : 'text-subtle')}>
          {formatRub(p.price)} · {left > 0 ? `осталось ${left}` : 'закончился'}
        </span>
      </span>
    </button>
  );
}

// ---------- покупатель в долг ----------

interface Buyer {
  participantId: number | null;
  participantName: string | null;
  name: string;
  phone: string;
}
const EMPTY_BUYER: Buyer = { participantId: null, participantName: null, name: '', phone: '' };

function BuyerPicker({ value, onChange }: { value: Buyer; onChange: (b: Buyer) => void }) {
  const [mode, setMode] = useState<'participant' | 'manual'>('participant');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const hits = useQuery({
    queryKey: ['merch-desk', 'buyers', q],
    queryFn: ({ signal }) => staffApi.merchBuyers(q, signal),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
  return (
    <Section title="Покупатель">
      <Segmented
        value={mode}
        onChange={(m) => (setMode(m), onChange(EMPTY_BUYER))}
        className="mb-3"
        options={[
          { value: 'participant', label: 'Участник' },
          { value: 'manual', label: 'Имя и телефон' },
        ]}
      />
      {mode === 'participant' ? (
        value.participantId ? (
          <div className="flex items-center justify-between gap-2 rounded-2xl bg-section p-3">
            <span className="flex items-center gap-2 font-semibold">
              <IconCheck size={18} className="text-ok-fg" />
              {value.participantName}
            </span>
            <button type="button" className="text-[14px] text-accent" onClick={() => onChange(EMPTY_BUYER)}>
              Другой
            </button>
          </div>
        ) : (
          <>
            <div className="relative">
              <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-hint" />
              <TextInput className="pl-10" placeholder="Фамилия, имя или телефон" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {q.length >= 2 && (
              <div className="mt-2 space-y-1">
                {(hits.data ?? []).map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => onChange({ ...EMPTY_BUYER, participantId: h.id, participantName: h.name })}
                    className="block w-full rounded-xl bg-section px-3 py-2 text-left active:opacity-80"
                  >
                    <span className="block font-semibold">{h.name}</span>
                    <span className="block text-[13px] text-subtle">{[h.city, h.phone].filter(Boolean).join(' · ') || 'без телефона'}</span>
                  </button>
                ))}
                {hits.data?.length === 0 && <p className="px-1 text-[14px] text-subtle">Никого не нашли - запишите имя и телефон.</p>}
              </div>
            )}
          </>
        )
      ) : (
        <div className="grid gap-2">
          <TextInput placeholder="Имя" value={value.name} maxLength={120} onChange={(e) => onChange({ ...value, name: e.target.value })} />
          <TextInput placeholder="Телефон" inputMode="tel" value={value.phone} maxLength={40} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
        </div>
      )}
    </Section>
  );
}

// ---------- выдать бронь ----------

type OrdersQuery = ReturnType<typeof useQuery<Order[]>>;

function IssueTab({ orders, onChanged }: { orders: OrdersQuery; onChanged: () => void }) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase().replace(/^m-?/, '');
  const [open, setOpen] = useState<Order | null>(null);
  /** Отсканированный QR-код участника; шторка с ним прячется, пока открыт заказ, и возвращается после выдачи. */
  const [scanned, setScanned] = useState<string | null>(null);
  const list = useMemo(
    () =>
      (orders.data ?? [])
        .filter(
          (o) =>
            (o.status === 'reserved' || o.status === 'paid') &&
            (!q || `${o.code} ${o.userName} ${o.username ?? ''}`.toLowerCase().replace(/m-/g, '').includes(q)),
        )
        // Сначала - брони с чеком на проверке.
        .sort((a, b) => Number(!!b.receipt) - Number(!!a.receipt)),
    [orders.data, q],
  );
  if (orders.isPending) return <Loading />;
  if (orders.isError) return <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />;
  return (
    <div>
      <QrScan onRead={setScanned} paused={scanned !== null} />
      <div className="relative mb-3">
        <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-hint" />
        <TextInput className="pl-10" inputMode="search" placeholder="Код (4821) или имя" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {list.length === 0 ? (
        <EmptyState title={q ? 'Не нашли' : 'Броней нет'}>{q ? 'Проверьте код: его показывают в приложении, раздел «Мерч».' : null}</EmptyState>
      ) : (
        <div className="space-y-2">
          {list.map((o) => (
            <OrderCard key={o.id} o={o} onClick={() => setOpen(o)} />
          ))}
        </div>
      )}
      <ScanSheet code={scanned} hidden={open !== null} onClose={() => setScanned(null)} onOpenOrder={setOpen} />
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open ? `Заказ ${open.code}` : ''}>
        {open && (
          <IssueForm
            o={open}
            onDone={() => {
              setOpen(null);
              onChanged();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

/** Кнопка «Сканировать QR-код»: сканер Telegram на телефоне, иначе камера в приложении. */
function QrScan({ onRead, paused }: { onRead: (code: string) => void; paused: boolean }) {
  const [cameraOn, setCameraOn] = useState(false);
  const [nativeFailed, setNativeFailed] = useState(false);
  const native = nativeScannerAvailable();

  const read = (raw: string) => {
    haptic('light');
    setCameraOn(false);
    onRead(raw);
  };

  const openNative = () => {
    try {
      if (!qrScanner.open.isAvailable() || qrScanner.isOpened()) return;
      let handled = false;
      qrScanner
        .open({
          text: 'Мерч: наведите на QR-код участника - вход НЕ отмечается',
          onCaptured: (qr) => {
            if (handled) return;
            handled = true;
            try {
              qrScanner.close();
            } catch {
              /* ignore */
            }
            read(qr);
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

  return (
    <>
      <Button size="lg" variant="success" block className="mb-3 min-h-14" onClick={scan}>
        {cameraOn ? (
          <>
            <IconCameraOff size={22} /> Закрыть камеру
          </>
        ) : (
          <>
            <IconQrcode size={22} /> Сканировать QR-код участника
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
            <CameraScanner paused={paused} onRead={read} onClose={() => setCameraOn(false)} />
          </div>
        </Suspense>
      )}
      {native && nativeFailed && !cameraOn && (
        <button type="button" onClick={() => setCameraOn(true)} className="mb-2 w-full py-2 text-center text-[15px] text-accent">
          Камера не открывается? Камера в приложении
        </button>
      )}
    </>
  );
}

const SCAN_MISS: Record<Extract<MerchScanResponse, { found: false }>['reason'], string> = {
  invalid_code: 'Это не QR-код участника конференции.',
  unknown_code: 'Такого QR-кода нет - возможно, его заменили. Попросите открыть свежий в «Мои QR-коды».',
  not_found: 'Участник не найден или его регистрацию отменили.',
};

/** Кто подошёл к стойке по QR-коду: взнос (с семьёй) и все его заказы мерча. */
function ScanSheet({ code, hidden, onClose, onOpenOrder }: { code: string | null; hidden: boolean; onClose: () => void; onOpenOrder: (o: Order) => void }) {
  const q = useQuery({ queryKey: ['merch-desk', 'scan', code], queryFn: () => staffApi.merchScan(code!), enabled: code !== null, staleTime: 0 });
  const data = q.data?.found ? q.data : null;
  const active = data?.orders.filter((o) => o.status !== 'issued') ?? [];
  const issued = data?.orders.filter((o) => o.status === 'issued') ?? [];
  return (
    <Sheet open={code !== null && !hidden} onClose={onClose} title={data ? data.card.fullName : 'QR-код участника'}>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !data ? (
        <Notice tone="red">{q.data && !q.data.found ? SCAN_MISS[q.data.reason] : 'Не нашли'}</Notice>
      ) : (
        <div className="space-y-4">
          {data.codeStatus === 'revoked' && <Notice tone="yellow">Этот QR-код заменён новым - проверьте, что это тот человек.</Notice>}
          <div className="space-y-1.5">
            {[data.card, ...data.family].map((c, i) => (
              <div key={c.id} className={cx('flex items-center justify-between gap-3', i > 0 && 'text-subtle')}>
                <span className={cx('min-w-0 truncate', i === 0 ? 'font-semibold' : 'text-[14px]')}>{i === 0 ? 'Взнос' : c.fullName}</span>
                {data.paymentsEnabled && c.paymentStatus !== 'exempt' ? (
                  <Badge tone={paymentTone(c.paymentStatus)} className="shrink-0">
                    {PAYMENT_STATUS_LABELS[c.paymentStatus]}
                  </Badge>
                ) : (
                  <Badge tone="gray" className="shrink-0">
                    Участник
                  </Badge>
                )}
              </div>
            ))}
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-subtle">Мерч</p>
            {active.length === 0 && issued.length === 0 ? (
              <p className="text-[15px] text-subtle">Заказов мерча нет. Продать можно во вкладке «Продать».</p>
            ) : (
              <div className="space-y-2">
                {active.map((o) =>
                  o.status === 'owed' ? (
                    <OrderCard key={o.id} o={o} debt onClick={() => toast.info('Долг гасится во вкладке «Долги»')} />
                  ) : (
                    <OrderCard key={o.id} o={o} onClick={() => onOpenOrder(o)} />
                  ),
                )}
                {issued.map((o) => (
                  <div key={o.id} className="rounded-2xl bg-fill p-3 text-[14px] text-subtle">
                    <span className="font-mono">{o.code}</span> · выдано{o.issuedByName ? ` (${o.issuedByName})` : ''}:{' '}
                    {o.items.map((i) => `${i.title}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ')}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** Фото вещи квадратиком: по названию разные принты не различить; вещей несколько - «+N» в углу. */
function OrderThumb({ o, size = 56 }: { o: Order; size?: number }) {
  const first = o.items.find((i) => i.thumbUrl) ?? o.items[0];
  const more = o.items.length - 1;
  return (
    <span className="relative shrink-0 overflow-hidden rounded-xl bg-fill" style={{ width: size, height: size }}>
      {first?.thumbUrl && <img src={first.thumbUrl} alt="" className="size-full object-cover" loading="lazy" />}
      {more > 0 && <span className="absolute bottom-0.5 right-0.5 rounded-md bg-black/65 px-1 text-[11px] font-bold leading-4 text-white">+{more}</span>}
    </span>
  );
}

function OrderCard({ o, onClick, debt }: { o: Order; onClick: () => void; debt?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="block w-full rounded-2xl bg-section p-3 text-left active:opacity-80">
      <div className="flex items-start gap-3">
        <OrderThumb o={o} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">
            <span className="font-mono">{o.code}</span> · {buyerOf(o)}
          </p>
          <p className="text-[13px] text-subtle">{o.items.map((i) => `${i.title}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ')}</p>
          {o.receipt && <p className="text-[13px] font-bold text-warn-fg">🧾 Чек на проверке</p>}
          {/* «Точно заберёте?»: что ответил человек. */}
          {o.confirm && o.status === 'reserved' && (
            <p className={cx('text-[13px] font-semibold', o.confirm.state === 'yes' ? 'text-ok-fg' : 'text-warn-fg')}>
              {o.confirm.state === 'yes' ? 'Ответил «Да, заберу»' : o.confirm.state === 'waiting' ? 'Ждём ответа на «Точно заберёте?»' : 'Не ответил на «Точно заберёте?»'}
            </p>
          )}
        </div>
        {debt ? (
          <span className="shrink-0 text-right">
            <span className="block text-[17px] font-bold tabular-nums text-warn-fg">{formatRub(debtOf(o))}</span>
            <span className="block text-[12px] text-hint">из {formatRub(o.total)}</span>
          </span>
        ) : (
          <Badge tone={o.status === 'paid' ? 'green' : 'yellow'} className="shrink-0">
            {o.status === 'paid' ? 'Оплачен' : `Бронь · ${formatRub(o.total)}`}
          </Badge>
        )}
      </div>
    </button>
  );
}

function IssueForm({ o, onDone }: { o: Order; onDone: () => void }) {
  const [method, setMethod] = useState<MerchPayMethod>(o.paymentMethod ?? 'cash');
  const [busy, setBusy] = useState(false);
  const paid = o.status === 'paid';
  const cancel = async () => {
    const ok = await confirmAction({
      title: `Отменить ${o.code}?`,
      message: paid
        ? `Заказ оплачен: ${formatRub(o.paidAmount)} отменятся в журнале денег как возврат - отдайте их покупателю. Вещи вернутся в витрину.`
        : 'Вещи вернутся в витрину, человеку придёт сообщение, что бронь отменили организаторы.',
      ok: paid ? 'Отменить заказ' : 'Отменить бронь',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await staffApi.merchCancel(o.id, null);
      haptic('success');
      toast.success(`${o.code}: отменено`);
      onDone();
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const issue = async () => {
    setBusy(true);
    try {
      await staffApi.merchIssue(o.id, paid ? null : method);
      haptic('success');
      toast.success(paid ? `${o.code}: выдано` : `${o.code}: оплачено и выдано`);
      onDone();
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="mb-1 font-semibold">{buyerOf(o)}</p>
      {/* С фото: что отдавать, видно сразу - даже без сканирования. */}
      <ul className="mb-3 space-y-2 text-[15px]">
        {o.items.map((i) => (
          <li key={i.variantId} className="flex items-center gap-3">
            <span className="size-14 shrink-0 overflow-hidden rounded-xl bg-fill">{i.thumbUrl && <img src={i.thumbUrl} alt="" className="size-full object-cover" />}</span>
            <span className="min-w-0 leading-snug">
              {i.title}
              {i.qty > 1 ? ` × ${i.qty}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <p className="mb-4 text-[20px] font-bold">{formatRub(o.total)}</p>
      {o.receipt && !paid && <ReceiptReview o={o} onDone={onDone} />}
      {paid ? (
        <p className="mb-4 text-[14px] text-ok-fg">Уже оплачен{o.paidByName ? ` (принял(а) ${o.paidByName})` : ''} - осталось отдать вещи.</p>
      ) : (
        <Field label="Как заплатили">
          <Segmented value={method} onChange={setMethod} options={METHODS} />
        </Field>
      )}
      <Button block size="lg" variant="success" loading={busy} onClick={() => void issue()}>
        {paid ? 'Выдано' : `Оплачено и выдано · ${formatRub(o.total)}`}
      </Button>
      <Button variant="plain" block className="mt-2 text-danger" disabled={busy} onClick={() => void cancel()}>
        {paid ? 'Отменить заказ' : 'Отменить бронь'}
      </Button>
    </div>
  );
}

/** Чек перевода на проверке: посмотреть файлы, «Оплата пришла» (бронь оплачена) или «Не подходит» с причиной. */
function ReceiptReview({ o, onDone }: { o: Order; onDone: () => void }) {
  const r = o.receipt!;
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      haptic('success');
      toast.success(ok);
      onDone();
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4 rounded-2xl bg-warn-soft p-3">
      <p className="mb-2 text-[14px] font-bold text-warn-fg">🧾 Прислали чек перевода - проверьте, что деньги пришли</p>
      {r.comment && <p className="mb-2 text-[14px]">Комментарий: {r.comment}</p>}
      <div className="space-y-2">
        {Array.from({ length: r.files }, (_, n) => (
          <ReceiptImage key={n} path={`/api/admin/merch/receipts/${r.id}/file?n=${n}`} pdf={n === 0 && r.mime === 'application/pdf'} />
        ))}
      </div>
      {rejecting ? (
        <div className="mt-3 space-y-2">
          <TextInput placeholder="Почему не подходит: сумма, получатель…" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => setRejecting(false)}>
              Назад
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              loading={busy}
              disabled={!reason.trim()}
              onClick={() => void run(() => staffApi.merchReceiptReject(r.id, reason.trim()), `${o.code}: чек отклонён, человеку отправили причину`)}
            >
              Отклонить
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => setRejecting(true)}>
            Не подходит
          </Button>
          <Button variant="success" className="flex-1" loading={busy} onClick={() => void run(() => staffApi.merchReceiptAccept(r.id), `${o.code}: оплата принята`)}>
            Оплата пришла
          </Button>
        </div>
      )}
    </div>
  );
}

/** Файл чека: картинку грузим с токеном команды и показываем; PDF - открыть отдельно. */
function ReceiptImage({ path, pdf }: { path: string; pdf: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    staffBlobUrl(path)
      .then((u) => {
        made = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  if (failed) return <p className="text-[13px] text-bad-fg">Не удалось загрузить файл чека</p>;
  if (!url) return <Spinner className="mx-auto block" />;
  if (pdf) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block rounded-xl bg-section px-3 py-2.5 text-center font-semibold text-accent">
        Открыть PDF чека
      </a>
    );
  }
  return <img src={url} alt="Чек" className="max-h-[60vh] w-full rounded-xl object-contain" />;
}

// ---------- долги ----------

function DebtsTab({ orders, onChanged }: { orders: OrdersQuery; onChanged: () => void }) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const [open, setOpen] = useState<Order | null>(null);
  const all = (orders.data ?? []).filter((o) => o.status === 'owed');
  const list = all.filter((o) => !q || `${buyerOf(o)} ${o.buyerPhone ?? ''} ${o.code}`.toLowerCase().includes(q));
  const sum = all.reduce((n, o) => n + debtOf(o), 0);
  if (orders.isPending) return <Loading />;
  if (orders.isError) return <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />;
  return (
    <div>
      <div className="mb-3 rounded-2xl bg-section p-3">
        <p className="text-[14px] text-subtle">Должны всего</p>
        <p className="text-[26px] font-bold tabular-nums">{formatRub(sum)}</p>
      </div>
      {all.length > 4 && (
        <div className="relative mb-3">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-hint" />
          <TextInput className="pl-10" placeholder="Имя или телефон" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState title={all.length ? 'Не нашли' : 'Должников нет'} />
      ) : (
        <div className="space-y-2">
          {list.map((o) => (
            <OrderCard key={o.id} o={o} debt onClick={() => setOpen(o)} />
          ))}
        </div>
      )}
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open ? `Долг · ${buyerOf(open)}` : ''}>
        {open && (
          <RepayForm
            o={open}
            onDone={() => {
              setOpen(null);
              onChanged();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function RepayForm({ o, onDone }: { o: Order; onDone: () => void }) {
  const left = debtOf(o);
  const [amount, setAmount] = useState(String(Number(left.toFixed(2))));
  const [method, setMethod] = useState<MerchPayMethod>('cash');
  const [busy, setBusy] = useState(false);
  const value = amount.trim().replace(',', '.');
  const valid = isMoney(value) && Number(value) <= left + 0.005;
  const repay = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const r = await staffApi.merchRepay(o.id, value, method);
      haptic('success');
      toast.success(r.status === 'owed' ? `Принято ${formatRub(value)}, осталось ${formatRub(debtOf(r))}` : 'Долг закрыт');
      onDone();
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="text-[15px]">{o.items.map((i) => `${i.title}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ')}</p>
      <p className="mb-1 mt-1 text-[14px] text-subtle">
        Сумма {formatRub(o.total)}
        {Number(o.paidAmount) > 0 ? `, внесено ${formatRub(o.paidAmount)}` : ''}
      </p>
      {o.buyerPhone && (
        <a href={`tel:${o.buyerPhone}`} className="mb-3 inline-flex items-center gap-1.5 text-[15px] text-accent">
          <IconPhone size={16} />
          {o.buyerPhone}
        </a>
      )}
      <p className="mb-4 text-[22px] font-bold text-warn-fg">Долг {formatRub(left)}</p>
      <Field label="Сколько отдали, ₽">
        <TextInput inputMode="decimal" value={amount} invalid={amount !== '' && !valid} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Как">
        <Segmented value={method} onChange={setMethod} options={METHODS} />
      </Field>
      <Button block size="lg" variant="success" loading={busy} disabled={!valid} onClick={() => void repay()}>
        {valid && Number(value) >= left - 0.005 ? 'Долг закрыт' : 'Принять часть'}
      </Button>
    </div>
  );
}

// ---------- итоги ----------

function StatsTab() {
  const staff = useStaff();
  const stats = useQuery({ queryKey: STATS, queryFn: staffApi.merchStats, refetchInterval: 30_000 });
  if (stats.isPending) return <Loading />;
  if (stats.isError) return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  const s = stats.data;
  const mine = s.bySeller.find((x) => x.userId === staff.user.id);
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Tile title="Продано" value={`${s.soldQty} шт.`} />
        <Tile title="Получено" value={formatRub(s.revenue)} />
        <Tile title="Долги" value={formatRub(s.debt.amount)} tone="warn" />
        <Tile title="Вы приняли" value={formatRub(mine?.amount ?? 0)} />
      </div>
      {s.lowStock.length > 0 && (
        <Section title="Заканчивается">
          <div className="flex flex-wrap gap-2">
            {s.lowStock.map((x) => (
              <Badge key={x.variantId} tone={x.left === 0 ? 'red' : 'yellow'}>
                {x.title}: {x.left === 0 ? 'нет' : x.left}
              </Badge>
            ))}
          </div>
        </Section>
      )}
      <Section title="По вещам">
        {s.byProduct.length === 0 ? (
          <p className="px-1 text-[15px] text-subtle">Пока ничего не продали.</p>
        ) : (
          <div className="rounded-2xl bg-section">
            {s.byProduct.map((x) => (
              <div key={x.productId} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2.5 last:border-0">
                <span className="min-w-0 truncate">{x.title}</span>
                <span className="shrink-0 tabular-nums">
                  <b>{x.qty}</b> <span className="text-subtle">· {formatRub(x.amount)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------- настройки ----------

type Draft = Omit<MerchSettings, 'merchReservationHours' | 'merchConfirmAt' | 'merchConfirmHours'> & {
  merchReservationHours: string;
  /** Время вопроса «Точно заберёте?» по часам конференции - значение `datetime-local`. */
  merchConfirmAt: string;
  merchConfirmHours: string;
};

const toDraft = (s: MerchSettingsView, tz: string): Draft => ({
  merchVisible: s.merchVisible,
  merchAdminsOnly: s.merchAdminsOnly,
  merchSalesEnabled: s.merchSalesEnabled,
  merchSelfBooking: s.merchSelfBooking,
  merchReservationHours: s.merchReservationHours ? String(s.merchReservationHours) : '',
  merchOnlinePayment: s.merchOnlinePayment,
  merchPaymentInstructions: s.merchPaymentInstructions,
  merchConfirmAt: isoToZonedLocal(s.merchConfirmAt, tz),
  merchConfirmHours: String(s.merchConfirmHours),
  merchConfirmDrop: s.merchConfirmDrop,
  merchNotify: s.merchNotify,
});

const dayTime = (iso: string, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const hhmm = (iso: string, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Показ витрины, бронь и оплата - продавец меняет их сам, как админ. Черновик и одна кнопка «Сохранить». */
function SettingsForm({ onDone }: { onDone: () => void }) {
  const tz = useStaff().event.timezone;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: SETTINGS, queryFn: staffApi.merchSettings });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !draft) setDraft(toDraft(q.data, tz));
  }, [q.data, draft, tz]);
  if (q.isPending || (q.data && !draft)) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const base = q.data;
  const d = draft!;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...d, [k]: v });
  const hours = d.merchReservationHours.trim() === '' ? null : Number(d.merchReservationHours);
  const badHours = hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 1440);
  const askAt = d.merchConfirmAt ? zonedLocalToIso(d.merchConfirmAt, tz) : null;
  const askHours = Number(d.merchConfirmHours);
  const badAsk = !Number.isInteger(askHours) || askHours < 1 || askHours > 48;
  const askBy = askAt && !badAsk ? new Date(Date.parse(askAt) + askHours * 3600_000).toISOString() : null;
  const next: MerchSettings = { ...d, merchReservationHours: hours, merchConfirmAt: askAt, merchConfirmHours: badAsk ? base.merchConfirmHours : askHours };
  const was: MerchSettings = {
    ...toDraft(base, tz),
    merchReservationHours: base.merchReservationHours,
    // Сравниваем в том же виде, что и черновик: время - с точностью до минуты.
    merchConfirmAt: base.merchConfirmAt ? zonedLocalToIso(isoToZonedLocal(base.merchConfirmAt, tz), tz) : null,
    merchConfirmHours: base.merchConfirmHours,
  };
  // Отметки «кому копии» - объект: сравниваем содержимое.
  const patch = Object.fromEntries(
    Object.entries(next).filter(([k, v]) => JSON.stringify(was[k as keyof MerchSettings]) !== JSON.stringify(v)),
  ) as Partial<MerchSettings>;
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setBusy(true);
    try {
      qc.setQueryData(SETTINGS, await staffApi.saveMerchSettings(patch));
      haptic('success');
      toast.success('Настройки мерча сохранили');
      onDone();
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Option checked={d.merchVisible} onChange={(v) => set('merchVisible', v)} title="Показывать витрину">
        Выключено - витрину не видит никто, даже команда.
      </Option>
      <Option checked={d.merchAdminsOnly} onChange={(v) => set('merchAdminsOnly', v)} disabled={!d.merchVisible} title="Только администраторам">
        Витрину и бронь видят только админы и продавцы - проверить всё перед показом участникам.
      </Option>
      <Option checked={d.merchSalesEnabled} onChange={(v) => set('merchSalesEnabled', v)} disabled={!d.merchVisible} title="Бронь и продажа">
        Выключено - только витрина.
      </Option>
      {d.merchVisible && d.merchSalesEnabled && (
        <>
          <Option checked={d.merchSelfBooking} onChange={(v) => set('merchSelfBooking', v)} title="Бронь сами в приложении">
            {d.merchSelfBooking ? 'Кнопка «Забронировать» - бронь сразу.' : 'Выбирают размер и пишут в чат «Мерч», бронирует команда мерча.'}
          </Option>
          <Option checked={d.merchOnlinePayment} onChange={(v) => set('merchOnlinePayment', v)} disabled={!base.transfersEnabled} title="Оплата переводом в приложении">
            {base.transfersEnabled ? 'Реквизиты - те же, что для взноса. Выключите - останется только бронь, оплата у стола мерча.' : 'Переводы выключены в общих настройках - платят только на месте.'}
          </Option>
          <Field label="Снять неоплаченную бронь через, часов" error={badHours ? 'От 1 до 1440 часов' : null} hint="Пусто - не снимать">
            <TextInput
              inputMode="numeric"
              placeholder="Не снимать"
              value={d.merchReservationHours}
              invalid={badHours}
              onChange={(e) => set('merchReservationHours', e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <p className="mt-4 font-semibold">«Точно заберёте?»</p>
          <p className="mb-2 text-[13px] text-subtle">
            Всем с неоплаченной бронью - сообщение в бот и вопрос на главной в приложении. «Да, заберу» - вопрос пропадает.
          </p>
          <Field label="Когда спросить" hint="Пусто - не спрашивать">
            <TextInput type="datetime-local" value={d.merchConfirmAt} onChange={(e) => set('merchConfirmAt', e.target.value)} />
          </Field>
          <Field label="Сколько часов на ответ" error={badAsk ? 'От 1 до 48 часов' : null}>
            <TextInput inputMode="numeric" value={d.merchConfirmHours} invalid={badAsk} onChange={(e) => set('merchConfirmHours', e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Option checked={d.merchConfirmDrop} onChange={(v) => set('merchConfirmDrop', v)} title="Не ответили вовремя - снять бронь">
            {d.merchConfirmDrop ? 'Вещи вернутся в витрину. Подтверждённые раньше брони не снимаем.' : 'Бронь остаётся - только напоминаем.'}
          </Option>
          {askAt && askBy && (
            <p className="mb-2 text-[14px]">
              Спросим {dayTime(askAt, tz)}, ответить - до {hhmm(askBy, tz)}.
            </p>
          )}
        </>
      )}
      {base.merchNotifyPeople.length > 0 && (
        <div className="mb-2 mt-4">
          <p className="font-semibold">Копии сообщений из «Мерча» в бот</p>
          <p className="mb-2 text-[13px] text-subtle">Написали в папку «Мерч» - копия приходит в бот с кнопкой «Открыть переписку».</p>
          {base.merchNotifyPeople.map((p) => (
            <div key={p.userId} className="mb-1.5">
              <Checkbox
                checked={d.merchNotify[String(p.userId)] ?? p.on}
                onChange={(v) => set('merchNotify', { ...d.merchNotify, [String(p.userId)]: v })}
              >
                <span>{p.name}</span>
                <span className="ml-1.5 text-[13px] text-subtle">{p.roles.map((r) => ROLE_SHORT[r] ?? r).join(', ')}</span>
              </Checkbox>
            </div>
          ))}
        </div>
      )}
      <Button block size="lg" className="mt-2" loading={busy} disabled={!dirty || badHours || badAsk} onClick={() => void save()}>
        Сохранить
      </Button>
    </div>
  );
}

const ROLE_SHORT: Record<string, string> = { seller: 'продавец', admin: 'админ', superadmin: 'суперадмин' };

function Option({ checked, onChange, disabled, title, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <Checkbox checked={checked} onChange={onChange} disabled={disabled}>
        <span className="font-semibold">{title}</span>
        <span className="mt-0.5 block text-[13px] text-subtle">{children}</span>
      </Checkbox>
    </div>
  );
}

function Tile({ title, value, tone }: { title: string; value: string; tone?: 'warn' }) {
  return (
    <div className="rounded-2xl bg-section p-3">
      <p className="text-[13px] text-subtle">{title}</p>
      <p className={cx('text-[20px] font-bold tabular-nums', tone === 'warn' && 'text-warn-fg')}>{value}</p>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Spinner />
    </div>
  );
}
