import { Anchor, Badge, Button, Card, Chip, Group, Image, Menu, NumberInput, Select, SegmentedControl, SimpleGrid, Stack, Table, Text, Textarea, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { AdminMerchOrderView, MerchPayMethod } from '@sof/shared';
import { IconCash, IconCheck, IconChevronDown, IconCoins, IconFileSpreadsheet, IconPackage, IconReceipt, IconSearch, IconShoppingBag, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { downloadFile } from '../../api/client.ts';
import {
  useAcceptMerchReceipt,
  useBuyerSearch,
  useMerchOrders,
  useMerchProducts,
  useOrderCancel,
  useOrderIssued,
  useOrderPaid,
  useRejectMerchReceipt,
  useRepayDebt,
  useSellOnSite,
} from '../../api/merch.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { countLabel, formatDateTime, formatMoney, formatTime } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { todayKey } from '../../lib/tz.ts';

type Order = AdminMerchOrderView;
type Filter = 'open' | 'receipts' | 'reserved' | 'noanswer' | 'paid' | 'owed' | 'issued' | 'closed' | 'all';

const STATUS: Record<Order['status'], { label: string; color: string }> = {
  reserved: { label: 'Бронь', color: 'yellow' },
  paid: { label: 'Оплачен', color: 'green' },
  issued: { label: 'Выдан', color: 'blue' },
  owed: { label: 'В долг', color: 'orange' },
  cancelled: { label: 'Отменён', color: 'gray' },
  expired: { label: 'Истёк', color: 'gray' },
};
const METHOD: Record<MerchPayMethod, string> = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };
const ORDERS: [string, string, string] = ['заказ', 'заказа', 'заказов'];
const debtOf = (o: Order) => (o.status === 'owed' ? Number(o.total) - Number(o.paidAmount) : 0);
/** Покупатель: кого записал продавец, иначе тот, кто бронировал. */
const buyerOf = (o: Order) => o.buyerName ?? o.userName;

/** «Точно заберёте?»: спросили, но «Да» нет - ждём или уже не ответил. */
const noAnswer = (o: Order) => o.confirm?.state === 'waiting' || o.confirm?.state === 'missed';
const CONFIRM: Record<NonNullable<Order['confirm']>['state'], { label: string; color: string }> = {
  waiting: { label: 'ждём ответа', color: 'yellow' },
  yes: { label: 'ответил «Да»', color: 'green' },
  dropped: { label: 'снята без ответа', color: 'red' },
  missed: { label: 'не ответил', color: 'orange' },
};

const passes = (f: Filter, o: Order) =>
  f === 'all' ||
  (f === 'receipts' && o.receipt !== null) ||
  (f === 'noanswer' && noAnswer(o)) ||
  (f === 'open' && (o.status === 'reserved' || o.status === 'paid' || o.status === 'owed')) ||
  (f === 'closed' && (o.status === 'cancelled' || o.status === 'expired')) ||
  o.status === f;

/** Заказы мерча. `debts` - вкладка «Должники»: только выданное в долг. */
export default function OrdersPanel({ debts = false }: { debts?: boolean }) {
  const tz = useEventTz();
  const orders = useMerchOrders();
  // Из сообщения бота о чеке («?receipts=1») - сразу чеки на проверке.
  const [chosen, setFilter] = useState<Filter>(() => (new URLSearchParams(window.location.search).get('receipts') ? 'receipts' : 'open'));
  const filter: Filter = debts ? 'owed' : chosen;
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase().replace(/^m-?/, ''), 200);
  const [selling, setSelling] = useState(false);
  const [exporting, setExporting] = useState(false);

  const list = useMemo(
    () =>
      (orders.data ?? []).filter(
        (o) =>
          passes(filter, o) &&
          (!q ||
            `${o.code} ${o.userName} ${o.username ?? ''} ${o.buyerName ?? ''} ${o.buyerPhone ?? ''} ${o.items.map((i) => i.title).join(' ')}`
              .toLowerCase()
              .replace(/m-/g, '')
              .includes(q)),
      ),
    [orders.data, filter, q],
  );
  const money = list.reduce((s, o) => s + (o.status === 'cancelled' || o.status === 'expired' ? 0 : Number(o.paidAmount)), 0);
  const awaiting = list.filter((o) => o.status === 'reserved').reduce((s, o) => s + Number(o.total), 0);
  const debt = list.reduce((s, o) => s + debtOf(o), 0);
  // «Точно заберёте?» - по всем заказам, а не только по видимым: сводка над таблицей.
  const asked = (orders.data ?? []).filter((o) => o.confirm);
  const askedBy = asked.map((o) => o.confirm!.by).filter(Boolean).sort().at(-1) ?? null;
  const askCount = (s: NonNullable<Order['confirm']>['state']) => asked.filter((o) => o.confirm!.state === s).length;
  const receipts = (orders.data ?? []).filter((o) => o.receipt).length;

  const exportXlsx = async () => {
    setExporting(true);
    try {
      await downloadFile(`/api/admin/merch/orders/export.xlsx?ids=${list.map((o) => o.id).join(',')}`, `merch-orders-${todayKey(tz)}.xlsx`);
      notifySuccess('Файл Excel скачивается');
    } catch (e) {
      notifyError(e, 'Не получилось выгрузить');
    } finally {
      setExporting(false);
    }
  };

  if (orders.isPending) return <BlockSkeleton rows={4} height={60} />;
  if (orders.isError) return <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />;

  return (
    <Stack gap="md">
      {debts && (
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md" maw={640}>
          <Card padding="md">
            <Text size="sm" fw={600} c="orange">
              Долг всего
            </Text>
            <Text fz={26} fw={800}>
              {formatMoney(debt)}
            </Text>
          </Card>
          <Card padding="md">
            <Text size="sm" fw={600}>
              Должников
            </Text>
            <Text fz={26} fw={800}>
              {list.length}
            </Text>
          </Card>
        </SimpleGrid>
      )}
      <Group gap="sm" wrap="wrap">
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder={debts ? 'Имя, телефон, код' : 'Код (4821), имя, вещь'}
          leftSection={<IconSearch size={16} />}
          style={{ flex: '1 1 240px' }}
          maw={360}
        />
        {!debts && (
          // Фильтры - кнопками с переносом: в одну полосу они слипались.
          <Chip.Group multiple={false} value={filter} onChange={(v) => setFilter(v as Filter)}>
            <Group gap={6} wrap="wrap">
              {(
                [
                  ['open', 'Активные'],
                  ...(receipts || filter === 'receipts' ? [['receipts', `🧾 Чеки · ${receipts}`]] : []),
                  ['reserved', 'Брони'],
                  ...(asked.length ? [['noanswer', `Без ответа · ${askCount('waiting') + askCount('missed')}`]] : []),
                  ['paid', 'Оплачены'],
                  ['owed', 'В долг'],
                  ['issued', 'Выданы'],
                  ['closed', 'Снятые'],
                  ['all', 'Все'],
                ] as [Filter, string][]
              ).map(([value, label]) => (
                <Chip key={value} value={value} size="xs" radius="sm" color={value === 'receipts' ? 'orange' : undefined}>
                  {label}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        )}
        <Group gap="xs" ml="auto">
          <Button variant="light" leftSection={<IconShoppingBag size={16} />} onClick={() => setSelling(true)}>
            Продажа на месте
          </Button>
          <Button variant="default" leftSection={<IconFileSpreadsheet size={16} />} loading={exporting} disabled={list.length === 0} onClick={() => void exportXlsx()}>
            Excel ({list.length})
          </Button>
        </Group>
      </Group>

      {!debts && asked.length > 0 && (
        <Card padding="sm" withBorder>
          <Group gap="xs" wrap="wrap">
            <Text size="sm" fw={700}>
              «Точно заберёте?»{askedBy ? ` · ответить до ${formatTime(askedBy, tz)}` : ''}:
            </Text>
            <Text size="sm">спросили {asked.length}</Text>
            <Badge color="green" variant="light">
              «Да» {askCount('yes')}
            </Badge>
            <Badge color="yellow" variant="light">
              ждём {askCount('waiting')}
            </Badge>
            {askCount('missed') > 0 && (
              <Badge color="orange" variant="light">
                не ответили {askCount('missed')}
              </Badge>
            )}
            {askCount('dropped') > 0 && (
              <Badge color="red" variant="light">
                сняли {askCount('dropped')}
              </Badge>
            )}
          </Group>
        </Card>
      )}

      <Text size="sm" c="dimmed">
        {countLabel(list.length, ORDERS)} · оплачено {formatMoney(money)}
        {awaiting > 0 ? ` · ждём оплаты ${formatMoney(awaiting)}` : ''}
        {debt > 0 && !debts ? ` · в долг ${formatMoney(debt)}` : ''}
      </Text>

      {list.length === 0 ? (
        <Card>
          <EmptyBlock icon={<IconPackage size={28} />} title={q ? 'Ничего не найдено' : debts ? 'Должников нет' : 'Заказов нет'} />
        </Card>
      ) : (
        <Table.ScrollContainer minWidth={720}>
          <Table striped highlightOnHover verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Код</Table.Th>
                <Table.Th>Покупатель</Table.Th>
                <Table.Th>Состав</Table.Th>
                <Table.Th>Сумма</Table.Th>
                <Table.Th>Статус</Table.Th>
                <Table.Th visibleFrom="lg">Создан</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((o) => (
                <OrderRow key={o.id} o={o} tz={tz} />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <AppModal opened={selling} onClose={() => setSelling(false)} title="Продажа на месте" size="md">
        {selling && <SellForm onDone={() => setSelling(false)} />}
      </AppModal>
    </Stack>
  );
}

function OrderRow({ o, tz }: { o: Order; tz: string }) {
  const paid = useOrderPaid();
  const issued = useOrderIssued();
  const cancel = useOrderCancel();
  const confirm = useConfirm();
  const [repaying, setRepaying] = useState(false);
  const busy = paid.isPending || issued.isPending || cancel.isPending;
  const methods = (Object.keys(METHOD) as MerchPayMethod[]).filter((m) => m !== 'transfer' || o.paymentMethod === 'transfer' || o.receiptAt);

  const doCancel = async () => {
    const ok = await confirm({
      title: `Отменить заказ ${o.code}?`,
      message:
        Number(o.paidAmount) > 0
          ? `Внесённые ${formatMoney(o.paidAmount)} отменятся в журнале денег как возврат - отдайте их покупателю. Вещи вернутся на склад.`
          : o.status === 'owed'
            ? 'Вещи вернутся на склад - заберите их у покупателя.'
            : 'Вещи вернутся в витрину, человеку придёт сообщение.',
      confirmLabel: 'Отменить заказ',
      danger: true,
    });
    if (ok) cancel.mutate({ id: o.id, reason: null }, { onSuccess: () => notifySuccess('Заказ отменён'), onError: (e) => notifyError(e) });
  };

  return (
    <Table.Tr>
      <Table.Td>
        <Text fw={800} ff="monospace" style={{ whiteSpace: 'nowrap' }}>
          {o.code}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{buyerOf(o)}</Text>
        {o.buyerPhone && (
          <Anchor href={`tel:${o.buyerPhone}`} size="xs">
            {o.buyerPhone}
          </Anchor>
        )}
        {!o.buyerName && o.username && (
          <Text size="xs" c="dimmed">
            @{o.username}
          </Text>
        )}
        {o.note && (
          <Text size="xs" c="dimmed">
            {o.note}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {/* С фото: у разных вещей бывают одинаковые названия (разные принты). */}
        <Stack gap={4}>
          {o.items.map((i) => (
            <Group key={i.variantId} gap={6} wrap="nowrap">
              {i.thumbUrl ? (
                <Image src={i.thumbUrl} alt="" w={36} h={36} radius="sm" fit="cover" style={{ flexShrink: 0 }} />
              ) : null}
              <Text size="sm">
                {i.title}
                {i.qty > 1 ? ` × ${i.qty}` : ''}
              </Text>
            </Group>
          ))}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text fw={700} size="sm">
          {formatMoney(o.total)}
        </Text>
        {o.status === 'owed' && (
          <Text size="xs" c="orange" fw={600}>
            долг {formatMoney(debtOf(o))}
            {Number(o.paidAmount) > 0 ? `, внесено ${formatMoney(o.paidAmount)}` : ''}
          </Text>
        )}
        {o.paymentMethod && o.status !== 'owed' && (
          <Text size="xs" c="dimmed">
            {METHOD[o.paymentMethod]}
            {o.status === 'reserved' ? ' (собирается)' : ''}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Badge color={STATUS[o.status].color} variant="light">
          {STATUS[o.status].label}
        </Badge>
        {o.status === 'reserved' && o.expiresAt && (
          <Text size="xs" c="dimmed">
            до {formatDateTime(o.expiresAt, tz)}
          </Text>
        )}
        {o.confirm && (
          <Badge color={CONFIRM[o.confirm.state].color} variant="dot" size="sm" mt={4} style={{ textTransform: 'none' }}>
            {CONFIRM[o.confirm.state].label}
            {o.confirm.state === 'waiting' && o.confirm.by ? ` до ${formatTime(o.confirm.by, tz)}` : ''}
          </Badge>
        )}
        {o.receipt ? (
          <ReceiptCheck o={o} />
        ) : (
          o.receiptUrl && (
            <Anchor href={o.receiptUrl} target="_blank" size="xs" display="flex" style={{ alignItems: 'center', gap: 4 }}>
              <IconReceipt size={12} /> чек
            </Anchor>
          )
        )}
      </Table.Td>
      <Table.Td visibleFrom="lg">
        <Text size="xs">{formatDateTime(o.createdAt, tz)}</Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          {o.status === 'reserved' && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button size="xs" color="green" rightSection={<IconChevronDown size={14} />} loading={busy}>
                  Оплачено
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {methods.map((m) => (
                  <Menu.Item key={m} leftSection={<IconCash size={14} />} onClick={() => paid.mutate({ id: o.id, method: m }, { onError: (e) => notifyError(e) })}>
                    {METHOD[m]}
                  </Menu.Item>
                ))}
                <Menu.Divider />
                <Menu.Label>Оплатил и сразу забрал</Menu.Label>
                {methods.map((m) => (
                  <Menu.Item key={`i-${m}`} leftSection={<IconPackage size={14} />} onClick={() => issued.mutate({ id: o.id, method: m }, { onError: (e) => notifyError(e) })}>
                    {METHOD[m]} и выдано
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
          {o.status === 'paid' && (
            <Button size="xs" leftSection={<IconPackage size={14} />} loading={busy} onClick={() => issued.mutate({ id: o.id, method: null }, { onError: (e) => notifyError(e) })}>
              Выдать
            </Button>
          )}
          {o.status === 'owed' && (
            <Button size="xs" color="green" leftSection={<IconCoins size={14} />} disabled={busy} onClick={() => setRepaying(true)}>
              Погасить
            </Button>
          )}
          {(o.status === 'reserved' || o.status === 'paid' || o.status === 'owed') && (
            <Button size="xs" variant="subtle" color="red" px={6} disabled={busy} onClick={() => void doCancel()} aria-label="Отменить">
              <IconX size={16} />
            </Button>
          )}
        </Group>
        <AppModal opened={repaying} onClose={() => setRepaying(false)} title={`Погасить долг · ${o.code}`} size="sm">
          {repaying && <RepayForm o={o} onDone={() => setRepaying(false)} />}
        </AppModal>
      </Table.Td>
    </Table.Tr>
  );
}

/** Погашение долга: всё или часть; каждая доплата - запись в журнале денег. */
function RepayForm({ o, onDone }: { o: Order; onDone: () => void }) {
  const repay = useRepayDebt();
  const left = debtOf(o);
  const [amount, setAmount] = useState<number | string>(left);
  const [method, setMethod] = useState<MerchPayMethod>('cash');
  const n = Number(amount) || 0;
  return (
    <Stack gap="sm">
      <Text size="sm">
        {buyerOf(o)}: долг <b>{formatMoney(left)}</b> из {formatMoney(o.total)}
      </Text>
      <NumberInput label="Сколько отдали, ₽" min={1} max={left} decimalScale={2} value={amount} onChange={setAmount} data-autofocus />
      <SegmentedControl value={method} onChange={(v) => setMethod(v as MerchPayMethod)} data={(Object.keys(METHOD) as MerchPayMethod[]).map((m) => ({ value: m, label: METHOD[m] }))} />
      <ModalActions>
        <Button variant="default" onClick={onDone}>
          Отмена
        </Button>
        <Button
          color="green"
          disabled={n <= 0 || n > left + 0.005}
          loading={repay.isPending}
          onClick={() =>
            repay.mutate(
              { id: o.id, amount: n.toFixed(2), method },
              {
                onSuccess: (r) => (notifySuccess(r.status === 'owed' ? `Осталось ${formatMoney(debtOf(r))}` : 'Долг закрыт', `Принято ${formatMoney(n)}`), onDone()),
                onError: (e) => notifyError(e),
              },
            )
          }
        >
          {n >= left - 0.005 ? 'Долг закрыт' : 'Принять часть'}
        </Button>
      </ModalActions>
    </Stack>
  );
}

/** Покупатель в долг: участник из базы (поиск) или имя и телефон. */
export function BuyerPicker({
  value,
  onChange,
}: {
  value: { participantId: number | null; participantName: string | null; name: string; phone: string };
  onChange: (v: { participantId: number | null; participantName: string | null; name: string; phone: string }) => void;
}) {
  const [mode, setMode] = useState<'participant' | 'manual'>(value.participantId || !value.name ? 'participant' : 'manual');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const hits = useBuyerSearch(q);
  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        value={mode}
        onChange={(v) => {
          setMode(v as typeof mode);
          onChange({ ...value, participantId: null, participantName: null });
        }}
        data={[
          { value: 'participant', label: 'Участник' },
          { value: 'manual', label: 'Имя и телефон' },
        ]}
      />
      {mode === 'participant' ? (
        value.participantId ? (
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={600}>
              <IconCheck size={14} /> {value.participantName}
            </Text>
            <Button size="xs" variant="subtle" onClick={() => onChange({ ...value, participantId: null, participantName: null })}>
              Другой
            </Button>
          </Group>
        ) : (
          <>
            <TextInput placeholder="Фамилия, имя или телефон" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
            {q.length >= 2 && (
              <Stack gap={2}>
                {(hits.data ?? []).map((h) => (
                  <UnstyledButton key={h.id} onClick={() => onChange({ ...value, participantId: h.id, participantName: h.name })} px="xs" py={4} style={{ borderRadius: 6 }}>
                    <Text size="sm" fw={600}>
                      {h.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {[h.city, h.phone].filter(Boolean).join(' · ') || 'без телефона'}
                    </Text>
                  </UnstyledButton>
                ))}
                {hits.data?.length === 0 && (
                  <Text size="xs" c="dimmed">
                    Никого не нашли - запишите имя и телефон.
                  </Text>
                )}
              </Stack>
            )}
          </>
        )
      ) : (
        <Group grow>
          <TextInput label="Имя" value={value.name} onChange={(e) => onChange({ ...value, name: e.currentTarget.value })} maxLength={120} />
          <TextInput label="Телефон" inputMode="tel" value={value.phone} onChange={(e) => onChange({ ...value, phone: e.currentTarget.value })} maxLength={40} />
        </Group>
      )}
    </Stack>
  );
}

/** Продажа без брони: выбрать вещь, цвет, размер, сколько и как заплатили - остаток уменьшится. В долг - с покупателем. */
function SellForm({ onDone }: { onDone: () => void }) {
  const products = useMerchProducts();
  const sell = useSellOnSite();
  const [productId, setProductId] = useState<string | null>(null);
  const [colorId, setColorId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState<number | string>(1);
  const [method, setMethod] = useState<MerchPayMethod>('cash');
  const [debt, setDebt] = useState(false);
  const [paidNow, setPaidNow] = useState<number | string>('');
  const [buyer, setBuyer] = useState({ participantId: null as number | null, participantName: null as string | null, name: '', phone: '' });
  // Один requestId на форму: двойное нажатие не продаст дважды.
  const [requestId] = useState(() => crypto.randomUUID());
  const p = products.data?.find((x) => String(x.id) === productId);
  const c = p?.colors.find((x) => String(x.id) === colorId) ?? (p?.colors.length === 1 ? p.colors[0] : undefined);
  const s = c?.sizes.find((x) => String(x.id) === variantId);
  const n = Number(qty) || 1;

  const total = p && s ? Number(p.price) * n : 0;
  const part = Number(paidNow) || 0;
  const buyerOk = !debt || !!buyer.participantId || (buyer.name.trim() !== '' && buyer.phone.trim() !== '');
  const submit = () => {
    if (!s) return;
    sell.mutate(
      {
        requestId,
        items: [{ variantId: s.id, qty: n }],
        method,
        debt,
        paidNow: debt && part > 0 ? part.toFixed(2) : null,
        buyerParticipantId: buyer.participantId,
        buyerName: buyer.participantId ? null : buyer.name.trim() || null,
        buyerPhone: buyer.participantId ? null : buyer.phone.trim() || null,
      },
      {
        onSuccess: (o) => (notifySuccess(o.status === 'owed' ? `В долг: ${o.code} · долг ${formatMoney(debtOf(o))}` : `Продано: ${o.code} · ${formatMoney(o.total)}`), onDone()),
        onError: (e) => notifyError(e),
      },
    );
  };

  return (
    <Stack gap="sm">
      <Select
        label="Вещь"
        searchable
        data={(products.data ?? []).map((x) => ({ value: String(x.id), label: `${x.title} · ${formatMoney(x.price)}` }))}
        value={productId}
        onChange={(v) => (setProductId(v), setColorId(null), setVariantId(null))}
      />
      {p && p.colors.length > 1 && (
        <Select label="Цвет" data={p.colors.map((x) => ({ value: String(x.id), label: x.name }))} value={colorId} onChange={(v) => (setColorId(v), setVariantId(null))} />
      )}
      {c && (
        <Select
          label="Размер"
          data={c.sizes.map((x) => ({ value: String(x.id), label: `${x.size} - свободно ${x.left}`, disabled: x.left <= 0 }))}
          value={variantId}
          onChange={setVariantId}
        />
      )}
      <NumberInput label="Сколько" min={1} max={s?.left ?? 10} allowDecimal={false} value={qty} onChange={setQty} />
      <SegmentedControl
        value={debt ? 'debt' : 'paid'}
        onChange={(v) => setDebt(v === 'debt')}
        data={[
          { value: 'paid', label: 'Оплачено сразу' },
          { value: 'debt', label: 'В долг' },
        ]}
      />
      {debt && (
        <>
          <BuyerPicker value={buyer} onChange={setBuyer} />
          <NumberInput label="Внесли сейчас, ₽" description="Необязательно: если отдали часть" min={0} max={total || undefined} decimalScale={2} value={paidNow} onChange={setPaidNow} />
        </>
      )}
      {(!debt || part > 0) && (
        <Select label="Оплата" data={(Object.keys(METHOD) as MerchPayMethod[]).map((m) => ({ value: m, label: METHOD[m] }))} value={method} onChange={(v) => setMethod((v ?? 'cash') as MerchPayMethod)} allowDeselect={false} />
      )}
      {p && s && (
        <Text fw={700}>
          {debt ? `Сумма ${formatMoney(total)}, долг ${formatMoney(Math.max(0, total - part))}` : `К оплате: ${formatMoney(total)}`}
        </Text>
      )}
      <ModalActions>
        <Button variant="default" onClick={onDone}>
          Отмена
        </Button>
        <Button color={debt ? 'orange' : 'green'} disabled={!s || n < 1 || n > (s?.left ?? 0) || !buyerOk || part > total} loading={sell.isPending} onClick={submit}>
          {debt ? 'Выдать в долг' : 'Продано и выдано'}
        </Button>
      </ModalActions>
    </Stack>
  );
}

/** Чек перевода на проверке: открыть файлы, принять (бронь - «оплачено») или отклонить с причиной - человеку придёт сообщение. */
function ReceiptCheck({ o }: { o: Order }) {
  const r = o.receipt!;
  const tz = useEventTz();
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const accept = useAcceptMerchReceipt();
  const reject = useRejectMerchReceipt();
  const done = () => {
    setOpen(false);
    setRejecting(false);
    setReason('');
  };
  return (
    <>
      <Button size="compact-xs" color="orange" variant="light" mt={4} leftSection={<IconReceipt size={12} />} onClick={() => setOpen(true)}>
        чек на проверке
      </Button>
      <AppModal opened={open} onClose={done} size="lg" title={<Text fw={700}>{`Чек за ${o.code} · ${buyerOf(o)}`}</Text>}>
        <Stack gap="sm">
          <Text size="sm">
            {o.items.map((i) => `${i.title}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ')} · <b>{formatMoney(o.total)}</b>
          </Text>
          <Text size="xs" c="dimmed">
            Прислали {formatDateTime(r.at, tz)}
            {r.files > 1 ? ` · файлов: ${r.files}` : ''}
          </Text>
          {r.comment && <Text size="sm">Комментарий: {r.comment}</Text>}
          {Array.from({ length: r.files }, (_, n) => (
            <ReceiptFile key={n} url={`/api/admin/merch/receipts/${r.id}/file?n=${n}`} pdf={n === 0 && r.mime === 'application/pdf'} n={n} />
          ))}
          {rejecting ? (
            <>
              <Textarea
                label="Почему не подходит"
                description="Человеку придёт сообщение с причиной - он пришлёт другой чек или оплатит на месте"
                placeholder="Например: сумма не совпадает"
                autosize
                minRows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
              />
              <ModalActions>
                <Button variant="default" onClick={() => setRejecting(false)}>
                  Назад
                </Button>
                <Button
                  color="red"
                  disabled={!reason.trim()}
                  loading={reject.isPending}
                  onClick={() =>
                    reject.mutate(
                      { receiptId: r.id, reason: reason.trim() },
                      { onSuccess: () => (notifySuccess('Чек отклонён', 'Человеку отправили причину'), done()), onError: (e) => notifyError(e) },
                    )
                  }
                >
                  Отклонить
                </Button>
              </ModalActions>
            </>
          ) : (
            <ModalActions>
              <Button variant="default" color="red" leftSection={<IconX size={16} />} onClick={() => setRejecting(true)}>
                Не подходит
              </Button>
              <Button
                color="green"
                leftSection={<IconCheck size={16} />}
                loading={accept.isPending}
                onClick={() =>
                  accept.mutate(r.id, { onSuccess: () => (notifySuccess(`${o.code}: оплата принята`, 'Человеку пришло сообщение'), done()), onError: (e) => notifyError(e) })
                }
              >
                Оплата пришла · {formatMoney(o.total)}
              </Button>
            </ModalActions>
          )}
        </Stack>
      </AppModal>
    </>
  );
}

/** Файл чека: картинка - сразу, PDF и не картинка - ссылкой. */
function ReceiptFile({ url, pdf, n }: { url: string; pdf: boolean; n: number }) {
  const [failed, setFailed] = useState(false);
  if (pdf || failed) {
    return (
      <Button component="a" href={url} target="_blank" rel="noopener noreferrer" variant="light" leftSection={<IconReceipt size={16} />}>
        Открыть файл {n + 1}
      </Button>
    );
  }
  return <Image src={url} alt={`Чек, файл ${n + 1}`} radius="md" mah={520} fit="contain" onError={() => setFailed(true)} />;
}
