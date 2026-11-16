import { formatRub, type MerchCatalogResponse, type MerchColorView, type MerchOrderView, type MerchProductView } from '@sof/shared';
import {
  IconAlertTriangle,
  IconBox,
  IconCheck,
  IconCopy,
  IconChevronRight,
  IconCube3dSphere,
  IconMessageCircle,
  IconMinus,
  IconPhoto,
  IconPlus,
  IconReceipt,
  IconRotate360,
  IconShirt,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ApiError, errorMessage } from '../../api/client.ts';
import { haptic } from '../../lib/feedback.ts';
import { uuid } from '../../lib/ids.ts';
import { Markdown } from '../../lib/markdown.tsx';
import { formatDateTime } from '../../lib/time.ts';
import { confirmAction } from '../../telegram/actions.ts';
import { useMainButton } from '../../telegram/main-button.ts';
import { Gallery } from '../../ui/Gallery.tsx';
import { Badge, Button, Card, cx, EmptyState, ErrorState, Spinner } from '../../ui/kit.tsx';
import { ModelViewer } from '../../ui/ModelViewer.tsx';
import { SpinViewer } from '../../ui/SpinViewer.tsx';
import { Page, StickyFooter } from '../../ui/Page.tsx';
import { toast } from '../../ui/toast.tsx';
import { participantApi, useMeData } from '../api.ts';
import { CopyableText } from '../CopyableText.tsx';
import { copyText } from '../../telegram/actions.ts';
import { MERCH_CATALOG_KEY } from './prefetch.ts';
import { Countdown, debtLeft, ORDERS_KEY, useOrders } from './orders.tsx';
import { addToRequest } from './request.ts';

function useCatalog() {
  return useQuery({ queryKey: MERCH_CATALOG_KEY, queryFn: () => participantApi.merch(), staleTime: 15_000 });
}

/** Галерея цвета: сначала его фото, потом общие (не больше 10); нет ни тех, ни других - любые фото вещи. */
function photosFor(p: MerchProductView, colorId: number | null) {
  const photos = p.media.filter((m) => m.kind === 'photo');
  const own = photos.filter((m) => m.colorId === colorId && colorId !== null);
  const common = photos.filter((m) => m.colorId === null);
  const list = own.length || common.length ? [...own, ...common] : photos;
  // Одно и то же фото бывает и у цвета, и в общих - показываем один раз.
  return list.filter((m, i) => list.findIndex((x) => x.url === m.url) === i).slice(0, 10);
}

/** Превью в витрине: обложка (первое общее фото), иначе первое фото цвета в наличии, иначе первый кадр 360°. */
function coverFor(p: MerchProductView) {
  const photos = p.media.filter((m) => m.kind === 'photo');
  return photos.find((m) => m.colorId === null) ?? photosFor(p, firstColorInStock(p)?.id ?? null)[0] ?? p.media.find((m) => m.kind === 'spin' && m.thumbUrl);
}

function modelFor(p: MerchProductView, colorId: number | null) {
  const models = p.media.filter((m) => m.kind === 'model');
  return models.find((m) => m.colorId === colorId) ?? models.find((m) => m.colorId === null) ?? null;
}

/** 360° цвета, иначе общий - как с 3D-моделью. */
function spinFor(p: MerchProductView, colorId: number | null) {
  const spins = p.media.filter((m) => m.kind === 'spin');
  return spins.find((m) => m.colorId === colorId) ?? spins.find((m) => m.colorId === null) ?? null;
}

const firstColorInStock = (p: MerchProductView): MerchColorView | undefined => p.colors.find((c) => c.sizes.some((s) => s.left > 0)) ?? p.colors[0];

function Swatches({ colors, value, onChange, size = 'md' }: { colors: MerchColorView[]; value?: number; onChange?: (id: number) => void; size?: 'sm' | 'md' }) {
  if (colors.length < 2 && size === 'sm') return null;
  return (
    <div className={cx('flex flex-wrap items-center', size === 'sm' ? 'gap-1' : 'gap-2.5')}>
      {colors.map((c) => {
        const active = c.id === value;
        const dot = (
          <span
            className={cx('block rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)]', size === 'sm' ? 'size-3' : 'size-8')}
            style={{ background: c.hex }}
          />
        );
        return onChange ? (
          <button
            key={c.id}
            type="button"
            aria-label={c.name}
            aria-pressed={active}
            onClick={() => onChange(c.id)}
            className={cx('rounded-full p-1 transition', active ? 'shadow-[0_0_0_2px_var(--color-fg)]' : 'opacity-80')}
          >
            {dot}
          </button>
        ) : (
          <span key={c.id}>{dot}</span>
        );
      })}
    </div>
  );
}

// ---------- витрина ----------

export function MerchCatalog() {
  const [, navigate] = useLocation();
  const catalog = useCatalog();
  // Заказы - и когда бронь выключили: долг и оплаченное должно быть видно.
  const orders = useOrders(!!catalog.data);
  const active = (orders.data ?? []).filter((o) => o.status === 'reserved' || o.status === 'paid' || o.status === 'owed');
  const debt = (orders.data ?? []).reduce((sum, o) => sum + debtLeft(o), 0);

  return (
    <Page back="/">
      <header className="mb-5 px-1 pt-1">
        <p className="text-[12px] font-bold uppercase tracking-[0.28em] text-brand">Шаг веры · 2026</p>
        <h1 className="mt-1 font-display text-[40px] font-bold uppercase leading-[0.95] tracking-tight">Мерч</h1>
        <p className="mt-2 max-w-xs text-[15px] leading-snug text-subtle">Футболки, лонгсливы, то, что удобно, и то, что нужно всем, кто хочет быть в покое!</p>
      </header>

      {(orders.data?.length ?? 0) > 0 && (
        <button
          type="button"
          onClick={() => navigate('/merch/orders')}
          className="mb-4 flex w-full items-center gap-3 rounded-2xl bg-section px-4 py-3 text-left active:opacity-80"
        >
          <IconBox size={22} className="text-brand" />
          <span className="flex-1">
            <span className="block font-semibold">Мои заказы</span>
            {debt > 0 && <span className="block text-[13px] font-semibold text-warn-fg">Долг: {formatRub(debt)} - оплатите у стола мерча</span>}
          </span>
          {active.length > 0 && <Badge tone={debt > 0 ? 'yellow' : 'blue'}>{active.length}</Badge>}
          <IconChevronRight size={18} className="text-hint" />
        </button>
      )}

      {catalog.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : catalog.data.products.length === 0 ? (
        <EmptyState icon={IconShirt} hue="pink" title="Скоро здесь будет мерч">
          Следите за новостями - покажем всё заранее.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-5">
          {catalog.data.products.map((p) => (
            <ProductCard key={p.id} p={p} onOpen={() => navigate(`/merch/${p.id}`)} />
          ))}
        </div>
      )}

      {/* Вопрос сюда - в папку «Мерч» у команды: отвечает продавец. */}
      <button
        type="button"
        onClick={() => navigate('/questions?topic=merch')}
        className="mt-6 flex w-full items-center gap-3 rounded-2xl bg-section px-4 py-3 text-left active:opacity-80"
      >
        <IconMessageCircle size={22} className="text-accent" />
        <span className="flex-1">
          <span className="block font-semibold">Вопрос по мерчу</span>
          <span className="block text-[13px] text-subtle">Размеры, бронь, оплата, выдача</span>
        </span>
        <IconChevronRight size={18} className="text-hint" />
      </button>
    </Page>
  );
}

function ProductCard({ p, onOpen }: { p: MerchProductView; onOpen: () => void }) {
  const photo = coverFor(p);
  const has360 = p.media.some((m) => m.kind === 'spin');
  const has3d = !has360 && p.media.some((m) => m.kind === 'model');
  return (
    <button type="button" onClick={onOpen} className="group flex h-full flex-col text-left active:opacity-90">
      <div className="relative aspect-[4/5] overflow-hidden rounded-3xl bg-fill">
        {photo ? (
          <img
            src={photo.thumbUrl ?? photo.url}
            alt={p.title}
            loading="lazy"
            decoding="async"
            className={cx('size-full object-cover transition duration-300 group-active:scale-[1.02]', !p.available && 'grayscale')}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-hint">
            <IconShirt size={40} stroke={1.25} />
          </div>
        )}
        {p.badge && (
          <span className="absolute left-2.5 top-2.5 rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-white">
            {p.badge}
          </span>
        )}
        {(has360 || has3d) && (
          <span className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur">
            {has360 ? <IconRotate360 size={13} /> : <IconCube3dSphere size={13} />} {has360 ? '360°' : '3D'}
          </span>
        )}
        {!p.available && (
          <span className="absolute inset-x-2.5 bottom-2.5 rounded-full bg-black/70 py-1 text-center text-[12px] font-bold uppercase tracking-wider text-white">
            Sold out
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 px-1 text-[15px] font-semibold leading-snug">{p.title}</p>
      <div className="mt-auto flex items-center justify-between gap-2 px-1 pt-1">
        <span className="font-display text-[15px] font-bold">{formatRub(p.price)}</span>
        <Swatches colors={p.colors} size="sm" />
      </div>
    </button>
  );
}

// ---------- карточка вещи ----------

export function MerchProductScreen({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const p = catalog.data?.products.find((x) => x.id === id);
  const [colorId, setColorId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  /** null - сами: есть фото - фото, нет фото, но есть 360° или 3D - сразу его. '3d' - объёмный вид: 360°, если есть, иначе 3D. */
  const [picked, setView] = useState<'photo' | '3d' | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(uuid());

  const color = p?.colors.find((c) => c.id === colorId) ?? (p ? firstColorInStock(p) : undefined);
  const size = color?.sizes.find((s) => s.id === variantId) ?? null;
  const photos = useMemo(() => (p ? photosFor(p, color?.id ?? null) : []), [p, color?.id]);
  const spin = p ? spinFor(p, color?.id ?? null) : null;
  const model = p && !spin ? modelFor(p, color?.id ?? null) : null;
  const turn = spin ?? model;
  const view = picked ?? (photos.length === 0 && turn ? '3d' : 'photo');
  const sales = catalog.data?.sales === true;
  /** Бронируют сами; иначе - выбирают размер и пишут в чат, бронирует команда мерча. */
  const selfBooking = catalog.data?.selfBooking === true;
  const maxQty = Math.min(10, size?.left ?? 1);

  /** В заявку на бронь: вещь, цвет, размер, сколько - и в переписку «Мерч». Остатки не трогаем. */
  const ask = () => {
    if (!p || !size || !color) return;
    addToRequest({
      variantId: size.id,
      qty,
      title: p.colors.length > 1 ? `${p.title} - ${color.name}, ${size.size}` : `${p.title}, ${size.size}`,
      price: p.price,
      thumbUrl: photos[0]?.thumbUrl ?? photos[0]?.url ?? null,
    });
    haptic('success');
    navigate('/questions?topic=merch');
  };

  const book = async () => {
    if (!p || !size || busy) return;
    setBusy(true);
    try {
      await participantApi.merchOrder({ requestId: requestId.current, items: [{ variantId: size.id, qty }], paymentMethod: 'cash' });
      requestId.current = uuid();
      haptic('success');
      toast.success('Забронировано! Код и оплата - в «Мои заказы»');
      await Promise.all([qc.invalidateQueries({ queryKey: MERCH_CATALOG_KEY }), qc.invalidateQueries({ queryKey: ORDERS_KEY })]);
      navigate('/merch/orders');
    } catch (err) {
      haptic('error');
      // Заказ не прошёл - следующая попытка с новым ключом (иначе сервер вернул бы ту же ошибку).
      if (err instanceof ApiError && !err.isTransient) requestId.current = uuid();
      toast.error(errorMessage(err));
      if (err instanceof ApiError && (err.code === 'sold_out' || err.code === 'not_available')) void catalog.refetch();
    } finally {
      setBusy(false);
    }
  };

  const buttonText = !size ? 'Выберите размер' : selfBooking ? `Забронировать · ${formatRub(Number(p?.price ?? 0) * qty)}` : 'Забронировать / спросить';
  const act = () => (selfBooking ? void book() : ask());
  const native = useMainButton({ text: buttonText, visible: sales && !!p?.available, enabled: !!size, loading: busy, onClick: act });

  if (catalog.isPending) {
    return (
      <Page back="/merch">
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </Page>
    );
  }
  if (catalog.isError) {
    return (
      <Page back="/merch">
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      </Page>
    );
  }
  if (!p) {
    return (
      <Page back="/merch">
        <EmptyState icon={IconShirt} title="Этой вещи уже нет в витрине" />
      </Page>
    );
  }

  return (
    <Page back="/merch" bottomInset={sales && p.available && !native}>
      <div className="-mx-4 -mt-2 mb-4">
        <div className="relative aspect-[4/5] overflow-hidden rounded-b-[2rem] bg-fill">
          {view === '3d' && spin ? (
            <SpinViewer key={spin.url} src={spin.url} poster={spin.thumbUrl} alt={p.title} className="size-full" />
          ) : view === '3d' && model ? (
            <ModelViewer key={model.url} src={model.url} poster={photos[0]?.url} alt={p.title} className="size-full" />
          ) : photos.length ? (
            <Gallery photos={photos} alt={p.title} className="size-full" />
          ) : (
            <div className="flex size-full items-center justify-center text-hint">
              <IconShirt size={56} stroke={1.25} />
            </div>
          )}
          {turn && (
            <div className="absolute right-3 top-3 flex rounded-full bg-black/55 p-1 backdrop-blur">
              {(['photo', '3d'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    haptic('selection');
                    setView(v);
                  }}
                  className={cx(
                    'flex items-center gap-1 rounded-full px-3 py-1 text-[13px] font-bold transition',
                    view === v ? 'bg-white text-black' : 'text-white opacity-80',
                  )}
                >
                  {v === 'photo' ? <IconPhoto size={15} /> : spin ? <IconRotate360 size={15} /> : <IconCube3dSphere size={15} />}
                  {v === 'photo' ? 'Фото' : spin ? '360°' : '3D'}
                </button>
              ))}
            </div>
          )}
          {p.badge && (
            <span className="absolute left-3 top-3 rounded-full bg-brand px-3 py-1 text-[12px] font-extrabold uppercase tracking-wider text-white">{p.badge}</span>
          )}
        </div>
      </div>

      <div className="px-1">
        <h1 className="font-display text-[26px] font-bold uppercase leading-tight tracking-tight">{p.title}</h1>
        {p.subtitle && <p className="mt-1 text-[15px] text-subtle">{p.subtitle}</p>}
        <p className="mt-3 font-display text-[24px] font-bold">{formatRub(p.price)}</p>
      </div>

      {p.colors.length > 1 && (
        <section className="mt-5 px-1">
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-subtle">
            Цвет · <span className="normal-case tracking-normal text-fg">{color?.name}</span>
          </p>
          <Swatches
            colors={p.colors}
            value={color?.id}
            onChange={(cid) => {
              haptic('selection');
              setColorId(cid);
              setVariantId(null);
              setQty(1);
            }}
          />
        </section>
      )}

      {color && color.sizes.length > 0 && (
        <section className="mt-5 px-1">
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-subtle">Размер</p>
          <div className="flex flex-wrap gap-2">
            {color.sizes.map((s) => {
              const out = s.left <= 0;
              const active = s.id === size?.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={out || !sales}
                  onClick={() => {
                    haptic('selection');
                    setVariantId(s.id);
                    setQty(1);
                  }}
                  className={cx(
                    'relative min-w-14 rounded-2xl px-4 py-2.5 text-[15px] font-bold transition',
                    active ? 'bg-fg text-page' : 'bg-section',
                    out && 'text-hint line-through',
                    !sales && !out && 'cursor-default',
                  )}
                >
                  {s.size}
                  {/* Сколько осталось - у каждого размера; мало (≤3) - оранжевым. */}
                  {!out && (
                    <span
                      className={cx(
                        'absolute -right-1 -top-2 rounded-full px-1.5 text-[10px] font-bold',
                        s.left <= 3 ? 'bg-warn-soft text-warn-fg' : 'bg-ok-soft text-ok-fg',
                      )}
                    >
                      {s.left}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {size && <p className={cx('mt-2 text-[13px] font-semibold', size.left <= 3 ? 'text-warn-fg' : 'text-subtle')}>Осталось {size.left} шт.</p>}
        </section>
      )}

      {sales && size && maxQty > 1 && (
        <section className="mt-5 flex items-center gap-4 px-1">
          <p className="text-[13px] font-semibold uppercase tracking-wider text-subtle">Сколько</p>
          <div className="flex items-center gap-1 rounded-2xl bg-section p-1">
            <button type="button" aria-label="Меньше" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))} className="flex size-9 items-center justify-center rounded-xl disabled:opacity-30">
              <IconMinus size={18} />
            </button>
            <span className="w-8 text-center text-[17px] font-bold tabular-nums">{qty}</span>
            <button type="button" aria-label="Больше" disabled={qty >= maxQty} onClick={() => setQty((q) => Math.min(maxQty, q + 1))} className="flex size-9 items-center justify-center rounded-xl disabled:opacity-30">
              <IconPlus size={18} />
            </button>
          </div>
        </section>
      )}

      {p.descriptionMd.trim() && (
        <Card className="mt-6">
          <Markdown source={p.descriptionMd} />
        </Card>
      )}

      {!sales && p.available && <p className="mt-6 px-1 text-center text-[14px] text-subtle">Бронь откроется скоро - следите за новостями.</p>}
      {sales && !selfBooking && p.available && (
        <p className="mt-6 px-1 text-center text-[14px] text-subtle">Выберите размер и нажмите «Забронировать / спросить» - уточним детали в чате и забронируем.</p>
      )}
      {!p.available && <p className="mt-6 px-1 text-center text-[14px] font-semibold text-subtle">Всё разобрали</p>}

      {sales && p.available && !native && (
        <StickyFooter>
          <Button size="lg" block disabled={!size} loading={busy} onClick={act}>
            {!selfBooking && size && <IconMessageCircle size={20} />}
            {buttonText}
          </Button>
        </StickyFooter>
      )}
    </Page>
  );
}

// ---------- мои заказы ----------

const STATUS: Record<MerchOrderView['status'], { label: string; tone: 'yellow' | 'green' | 'blue' | 'gray' | 'red' }> = {
  reserved: { label: 'Бронь', tone: 'yellow' },
  paid: { label: 'Оплачено', tone: 'green' },
  issued: { label: 'Выдано', tone: 'blue' },
  owed: { label: 'Выдано в долг', tone: 'yellow' },
  cancelled: { label: 'Отменён', tone: 'gray' },
  expired: { label: 'Бронь истекла', tone: 'gray' },
};

export function MerchOrders() {
  const me = useMeData();
  const catalog = useCatalog();
  const orders = useOrders(true);
  return (
    <Page back="/merch" title="Мои заказы">
      {orders.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : orders.isError ? (
        <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
      ) : orders.data.length === 0 ? (
        <EmptyState icon={IconBox} title="Заказов пока нет" />
      ) : (
        <div className="space-y-4">
          {orders.data.map((o) => (
            <OrderCard key={o.id} o={o} tz={me.event.timezone} catalog={catalog.data} />
          ))}
        </div>
      )}
    </Page>
  );
}

function OrderCard({ o, tz, catalog }: { o: MerchOrderView; tz: string; catalog?: MerchCatalogResponse }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const transfers = Boolean(catalog?.paymentInstructions);
  const open = o.status === 'reserved';
  const done = o.status === 'cancelled' || o.status === 'expired';

  const run = async (fn: () => Promise<MerchOrderView>, ok?: string) => {
    setBusy(true);
    try {
      const updated = await fn();
      qc.setQueryData<MerchOrderView[]>(ORDERS_KEY, (list) => list?.map((x) => (x.id === updated.id ? updated : x)));
      void qc.invalidateQueries({ queryKey: MERCH_CATALOG_KEY });
      if (ok) toast.success(ok);
      haptic('success');
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    const ok = await confirmAction({ title: `Заказ ${o.code}`, message: 'Отменить бронь? Вещи вернутся в витрину.', ok: 'Отменить бронь', destructive: true });
    if (ok) await run(() => participantApi.merchCancel(o.id), 'Бронь отменена');
  };

  return (
    <Card className={cx(done && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wider text-subtle">Код выдачи</p>
          <p className="font-display text-[28px] font-bold leading-none tracking-wide">{o.code}</p>
        </div>
        <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
      </div>

      <div className="mt-4 space-y-2">
        {o.items.map((it) => (
          <div key={it.variantId} className="flex items-center gap-3">
            <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-fill">{it.thumbUrl && <img src={it.thumbUrl} alt="" className="size-full object-cover" />}</div>
            <p className="min-w-0 flex-1 text-[15px] leading-snug">
              {it.title}
              {it.qty > 1 && <span className="text-subtle"> × {it.qty}</span>}
            </p>
            <span className="shrink-0 font-semibold">{formatRub(Number(it.price) * it.qty)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-between border-t border-line pt-3 text-[17px] font-bold">
        <span>Итого</span>
        <span>{formatRub(o.total)}</span>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          {o.confirmBy && (
            <div className="space-y-2 rounded-2xl bg-warn-soft p-3">
              <p className="text-[14px] font-semibold text-warn-fg">
                {o.confirmDrops
                  ? `Точно заберёте? Подтвердите до ${formatDateTime(o.confirmBy, tz)} - иначе бронь снимется.`
                  : `Точно заберёте? Ответьте, пожалуйста, до ${formatDateTime(o.confirmBy, tz)}.`}
              </p>
              <Countdown until={o.confirmBy} drops={o.confirmDrops} />
              <Button block loading={busy} onClick={() => void run(() => participantApi.merchConfirm(o.id), 'Спасибо, ждём вас!')}>
                Да, заберу
              </Button>
            </div>
          )}
          {o.expiresAt && <p className="text-[14px] text-subtle">Бронь снимется {formatDateTime(o.expiresAt, tz)}, если не оплатить.</p>}
          {transfers && (
            <MethodSwitch value={o.paymentMethod === 'transfer' ? 'transfer' : 'cash'} busy={busy} onChange={(m) => void run(() => participantApi.merchMethod(o.id, m))} />
          )}
          {o.paymentMethod === 'transfer' && transfers ? (
            // Как перевод взноса в «Оплате»: реквизиты с копированием, код в комментарий, чек обязательно.
            <div className="rounded-2xl bg-fill p-3">
              <p className="whitespace-pre-wrap break-words text-[16px] leading-relaxed">
                <CopyableText text={catalog!.paymentInstructions} />
              </p>
              <p className="mt-3 border-t border-line pt-3 text-[15px] leading-snug">В комментарии к переводу укажите код брони:</p>
              <button
                type="button"
                onClick={async () => {
                  if (await copyText(o.code)) toast.success('Скопировано');
                  else toast.error('Не получилось скопировать');
                }}
                className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl bg-section px-3 py-2.5 text-left active:opacity-70"
              >
                <span className="text-[15px] font-semibold">{o.code}</span>
                <IconCopy size={18} className="shrink-0 text-accent" aria-label="Скопировать" />
              </button>
              {!o.receiptAt && (
                <div className="mt-3 flex gap-2.5 rounded-xl border-2 border-danger bg-danger/10 px-3 py-2.5">
                  <IconAlertTriangle size={22} className="mt-0.5 shrink-0 text-danger" />
                  <p className="text-[16px] font-bold leading-snug text-danger">
                    Обязательно: после перевода прикрепите фото, скриншот или PDF чека.
                    <span className="mt-1 block text-[14px] font-medium">Без чека оплату не засчитаем.</span>
                  </p>
                </div>
              )}
              <div className="mt-3" />
              <input
                ref={file}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (f) void run(() => participantApi.merchReceipt(o.id, f), 'Чек отправлен - проверим и подтвердим');
                }}
              />
              {o.receiptAt ? (
                <div className="flex items-center gap-2 text-[14px] font-semibold text-ok-fg">
                  <IconCheck size={18} /> Чек отправлен, ждём проверки
                  <button type="button" className="ml-auto text-link" onClick={() => file.current?.click()} disabled={busy}>
                    Заменить
                  </button>
                </div>
              ) : (
                <Button variant="secondary" block loading={busy} onClick={() => file.current?.click()}>
                  <IconReceipt size={18} /> Прикрепить чек
                </Button>
              )}
            </div>
          ) : (
            <p className="text-[14px]">Забрать и оплатить - у стола мерча в фойе церкви. Назовите код брони или покажите QR-код участника.</p>
          )}
          <Button variant="plain" block disabled={busy} onClick={() => void cancel()} className="text-danger">
            Отменить бронь
          </Button>
        </div>
      )}
      {o.status === 'paid' && <p className="mt-4 text-[14px]">Оплачено. Забрать - у стола мерча в фойе церкви. Назовите код брони или покажите QR-код участника.</p>}
      {o.status === 'owed' && (
        // Выдали в долг: сколько внесли и сколько осталось - и куда нести.
        <div className="mt-4 rounded-2xl bg-warn-soft p-3">
          <p className="text-[15px] font-bold text-warn-fg">Осталось оплатить: {formatRub(debtLeft(o))}</p>
          {Number(o.paidAmount) > 0 && <p className="mt-0.5 text-[14px] text-subtle">Уже внесено: {formatRub(o.paidAmount)}</p>}
          <p className="mt-1 text-[14px] leading-snug">Оплатить - у стола мерча в фойе церкви. Назовите код или покажите QR-код участника.</p>
        </div>
      )}
      {o.status === 'issued' && o.issuedAt && <p className="mt-4 text-[14px] text-subtle">Выдано {formatDateTime(o.issuedAt, tz)}.</p>}
      {o.status === 'expired' && <p className="mt-4 text-[14px] text-subtle">Бронь не оплатили вовремя - вещи вернулись в витрину.</p>}
      {o.status === 'cancelled' && o.cancelReason && <p className="mt-4 text-[14px] text-subtle">{o.cancelReason}</p>}
    </Card>
  );
}

/** «Переводом / Наличными» - как у взноса в «Оплате». */
function MethodSwitch({ value, busy, onChange }: { value: 'cash' | 'transfer'; busy: boolean; onChange: (m: 'cash' | 'transfer') => void }) {
  const options: ['transfer' | 'cash', string][] = [
    ['transfer', 'Переводом'],
    ['cash', 'Наличными'],
  ];
  return (
    <div role="radiogroup" aria-label="Как оплатите" className="flex min-h-10 gap-1 rounded-xl bg-fill p-1">
      {options.map(([m, label]) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          disabled={busy}
          onClick={() => m !== value && onChange(m)}
          className={cx(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[14px] font-semibold transition',
            value === m ? 'bg-btn text-btn-fg' : 'text-subtle',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
