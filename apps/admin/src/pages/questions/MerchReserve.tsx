import { ActionIcon, Badge, Box, Button, Group, Image, NumberInput, Select, Stack, Text } from '@mantine/core';
import type { AdminMerchProduct, ChatMerchRequest } from '@sof/shared';
import { IconPlus, IconReceipt, IconShirt, IconShoppingBag, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useMerchProducts, useReserveForUser } from '../../api/merch.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { formatMoney } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const ORDER_STATUS: Record<string, { label: string; color: string }> = {
  reserved: { label: 'Бронь', color: 'yellow' },
  paid: { label: 'Оплачено', color: 'green' },
  issued: { label: 'Выдано', color: 'blue' },
  owed: { label: 'В долг', color: 'orange' },
  cancelled: { label: 'Отменена', color: 'gray' },
  expired: { label: 'Истекла', color: 'gray' },
};

/**
 * Заявка на бронь в сообщении участника: что просит. Остатки заявка не трогает - продавец уточняет
 * и бронирует кнопкой; после брони вместо кнопки - код и статус.
 */
export function MerchRequestCard({ request, canReserve, onReserve }: { request: ChatMerchRequest; canReserve: boolean; onReserve: () => void }) {
  const order = request.order;
  const closed = !order || order.status === 'cancelled' || order.status === 'expired';
  /** Что из заявки вошло в бронь: продавец мог забронировать не всё - видно по каждой вещи. */
  const inOrder = (variantId: number) => !closed && order!.variantIds.includes(variantId);
  return (
    <Box mt={6} p={8} style={{ borderRadius: 12, background: 'var(--mantine-color-body)' }}>
      <Group gap={6} mb={4}>
        <IconShoppingBag size={14} />
        <Text size="xs" fw={700} tt="uppercase" c="dimmed">
          Заявка на бронь
        </Text>
      </Group>
      <Stack gap={6}>
        {request.items.map((it) => (
          <Group key={it.variantId} gap="xs" wrap="nowrap">
            {/* Фото этого цвета: сразу видно, какую вещь просят. */}
            <Box
              w={56}
              h={56}
              style={{ flexShrink: 0, borderRadius: 10, overflow: 'hidden', background: 'var(--mantine-color-default-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {it.thumbUrl ? <Image src={it.thumbUrl} alt="" w={56} h={56} fit="cover" /> : <IconShirt size={22} opacity={0.5} />}
            </Box>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" fw={600} lh={1.3}>
                {it.detail?.product ?? it.title}
              </Text>
              {it.detail && (
                <Group gap={6} wrap="nowrap" mt={2}>
                  <Box
                    w={12}
                    h={12}
                    style={{ flexShrink: 0, borderRadius: 999, background: it.detail.hex, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)' }}
                  />
                  <Text size="xs">
                    {it.detail.color} · {it.detail.size}
                    {it.qty > 1 ? ` · × ${it.qty}` : ''}
                  </Text>
                </Group>
              )}
              {!it.detail && it.qty > 1 && <Text size="xs">× {it.qty}</Text>}
              <Group gap={6} mt={2}>
                <Text size="xs" fw={700}>
                  {formatMoney(Number(it.price) * it.qty)}
                </Text>
                {!closed &&
                  (inOrder(it.variantId) ? (
                    <Badge size="xs" color="green" variant="light" tt="none">
                      ✅ в брони
                    </Badge>
                  ) : (
                    <Badge size="xs" color="gray" variant="light" tt="none">
                      не забронировано
                    </Badge>
                  ))}
              </Group>
            </div>
          </Group>
        ))}
      </Stack>
      <Group gap="xs" mt={6}>
        {order && (
          <Badge color={ORDER_STATUS[order.status]?.color ?? 'gray'} variant="light">
            {ORDER_STATUS[order.status]?.label ?? order.status} · {order.code}
          </Badge>
        )}
        {/* Прислали чек перевода - посмотреть и подтвердить в «Мерч» → «Заказы» → «Чеки». */}
        {order?.receiptPending && (
          <Button component="a" href="/merch?receipts=1" size="xs" color="orange" variant="light" leftSection={<IconReceipt size={14} />}>
            Чек на проверке
          </Button>
        )}
        {closed && canReserve && (
          <Button size="xs" leftSection={<IconShoppingBag size={14} />} onClick={onReserve}>
            Забронировать
          </Button>
        )}
      </Group>
    </Box>
  );
}

interface Row {
  key: number;
  variantId: string | null;
  qty: number | string;
}

/**
 * Все размеры всех вещей одним списком: «M · Худи - белый · свободно 3» - размер первым, на телефоне конец строки обрезается.
 * С фото: у разных вещей бывают одинаковые названия (разные принты) - их различает картинка.
 */
function variantOptions(products: AdminMerchProduct[]) {
  const sameTitle = (t: string) => products.filter((x) => x.title === t).length > 1;
  return products.flatMap((p) =>
    p.colors.flatMap((c) => {
      const photos = p.media.filter((m) => m.kind === 'photo');
      const photo = photos.find((m) => m.colorId === c.id) ?? photos.find((m) => m.colorId === null) ?? photos[0];
      return c.sizes.map((s) => ({
        value: String(s.id),
        label: `${s.size} · ${p.title}${p.colors.length > 1 || sameTitle(p.title) ? ` - ${c.name}` : ''}${sameTitle(p.title) ? ` (вещь №${p.id})` : ''} · свободно ${s.left}`,
        disabled: s.left <= 0,
        price: Number(p.price),
        left: s.left,
        thumb: photo?.thumbUrl ?? photo?.url ?? null,
      }));
    }),
  );
}

/** Бронь человеку: по заявке (вещи уже подставлены, можно поправить) или сама - из шапки переписки. */
export function ReserveModal({
  opened,
  onClose,
  userId,
  messageId,
  items,
}: {
  opened: boolean;
  onClose: () => void;
  userId: number;
  messageId: number | null;
  items: ChatMerchRequest['items'];
}) {
  return (
    <AppModal opened={opened} onClose={onClose} title="Забронировать" size="md">
      {opened && <ReserveForm userId={userId} messageId={messageId} items={items} onDone={onClose} />}
    </AppModal>
  );
}

function ReserveForm({ userId, messageId, items, onDone }: { userId: number; messageId: number | null; items: ChatMerchRequest['items']; onDone: () => void }) {
  const products = useMerchProducts();
  const reserve = useReserveForUser();
  // Один ключ на окно: двойное нажатие не забронирует дважды.
  const [requestId] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<Row[]>(() =>
    items.length ? items.map((it, i) => ({ key: i, variantId: String(it.variantId), qty: it.qty })) : [{ key: 0, variantId: null, qty: 1 }],
  );
  const options = useMemo(() => variantOptions(products.data ?? []), [products.data]);
  const byId = new Map(options.map((o) => [o.value, o]));
  const picked = rows.filter((r) => r.variantId !== null);
  const total = picked.reduce((sum, r) => sum + (byId.get(r.variantId!)?.price ?? 0) * (Number(r.qty) || 1), 0);
  const tooMany = picked.some((r) => (Number(r.qty) || 1) > (byId.get(r.variantId!)?.left ?? 0));
  const set = (key: number, patch: Partial<Row>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = () =>
    reserve.mutate(
      { requestId, userId, messageId, items: picked.map((r) => ({ variantId: Number(r.variantId), qty: Number(r.qty) || 1 })) },
      {
        onSuccess: ({ order }) => {
          notifySuccess('Человеку отправили код брони', `Забронировано: ${order.code} · ${formatMoney(order.total)}`);
          onDone();
        },
        onError: (err) => notifyError(err),
      },
    );

  return (
    <Stack gap="sm">
      {rows.map((r, i) => (
        <Stack key={r.key} gap={6} pb="xs" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
          <Group gap="xs" align="flex-end" wrap="nowrap">
            {/* Фото выбранной вещи: одинаковые названия различает картинка. */}
            <Thumb src={r.variantId ? (byId.get(r.variantId)?.thumb ?? null) : null} size={36} />
            <Select
              style={{ flex: 1, minWidth: 0 }}
              label={`Вещь и размер${rows.length > 1 ? ` · ${i + 1}` : ''}`}
              placeholder="Выберите"
              searchable
              data={options.map(({ value, label, disabled }) => ({ value, label, disabled: disabled && value !== r.variantId }))}
              renderOption={({ option }) => (
                <Group gap="xs" wrap="nowrap">
                  <Thumb src={byId.get(option.value)?.thumb ?? null} size={32} />
                  <Text size="sm">{option.label}</Text>
                </Group>
              )}
              value={r.variantId}
              onChange={(v) => set(r.key, { variantId: v })}
              comboboxProps={{ withinPortal: true }}
            />
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed">
              Сколько
            </Text>
            <NumberInput w={80} min={1} max={10} allowDecimal={false} value={r.qty} onChange={(v) => set(r.key, { qty: v })} />
            {rows.length > 1 && (
              <ActionIcon ml="auto" variant="subtle" color="gray" size="lg" aria-label="Убрать" onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}>
                <IconX size={16} />
              </ActionIcon>
            )}
          </Group>
        </Stack>
      ))}
      <Group justify="space-between">
        <Button
          variant="subtle"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => setRows((list) => [...list, { key: Math.max(...list.map((x) => x.key)) + 1, variantId: null, qty: 1 }])}
        >
          Ещё вещь
        </Button>
        {total > 0 && <Text fw={700}>Итого: {formatMoney(total)}</Text>}
      </Group>
      {tooMany && (
        <Text size="sm" c="red">
          Столько свободных нет - уменьшите количество.
        </Text>
      )}
      <Text size="xs" c="dimmed">
        Остаток уменьшится сейчас. Человеку придёт сообщение с кодом брони; срок брони - из настроек мерча.
      </Text>
      <ModalActions>
        <Button variant="default" onClick={onDone}>
          Отмена
        </Button>
        <Button color="green" disabled={picked.length === 0 || tooMany} loading={reserve.isPending} onClick={submit}>
          Забронировать
        </Button>
      </ModalActions>
    </Stack>
  );
}

function Thumb({ src, size }: { src: string | null; size: number }) {
  return (
    <Box
      w={size}
      h={size}
      style={{ flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--mantine-color-default-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {src ? <Image src={src} alt="" w={size} h={size} fit="cover" /> : <IconShirt size={size / 2} opacity={0.5} />}
    </Box>
  );
}
