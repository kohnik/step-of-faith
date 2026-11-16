import {
  ActionIcon,
  Badge,
  Button,
  Card,
  ColorInput,
  Divider,
  FileButton,
  Group,
  Image,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import type { AdminMerchProduct, AdminMerchSize, MerchMediaKind } from '@sof/shared';
import { IconArrowLeft, IconArrowRight, IconCube3dSphere, IconEye, IconEyeOff, IconPlus, IconRotate360, IconShirt, IconTrash, IconUpload } from '@tabler/icons-react';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { uploadMerchFile, useDeleteProduct, useMerchProducts, useSaveProduct } from '../../api/merch.ts';
import { spinFromFiles } from '../../lib/spin.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatMoney } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const MAX_PHOTOS = 10;
const PHOTO_MAX_MB = 15;
const MODEL_MAX_MB = 25;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Превью вещи в списке - обложка (первое общее фото), как в витрине. */
function coverOf(p: AdminMerchProduct) {
  const photos = p.media.filter((m) => m.kind === 'photo');
  return photos.find((m) => m.colorId === null) ?? photos[0];
}
const totalLeft = (p: AdminMerchProduct) => p.colors.reduce((s, c) => s + c.sizes.reduce((x, z) => x + z.left, 0), 0);

export default function ProductsPanel() {
  const products = useMerchProducts();
  const confirm = useConfirm();
  const [openId, setOpenId] = useState<number | 'new' | null>(null);
  const opened = typeof openId === 'number' ? (products.data?.find((p) => p.id === openId) ?? null) : null;
  const dirty = useRef(false);

  const close = async () => {
    if (dirty.current) {
      const ok = await confirm({ title: 'Закрыть без сохранения?', message: 'Изменения в этой вещи пропадут.', confirmLabel: 'Закрыть', danger: true });
      if (!ok) return;
    }
    dirty.current = false;
    setOpenId(null);
  };

  if (products.isPending) return <BlockSkeleton rows={3} height={140} />;
  if (products.isError) return <ErrorState error={products.error} onRetry={() => void products.refetch()} />;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Порядок в витрине - по полю «Порядок» (меньше - выше). Скрытые вещи участники не видят.
        </Text>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setOpenId('new')}>
          Добавить вещь
        </Button>
      </Group>
      {products.data.length === 0 ? (
        <Card>
          <EmptyBlock icon={<IconShirt size={28} />} title="Пока пусто" description="Добавьте первую вещь: название, цену, цвета, размеры, фото и 3D-модель." />
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="md">
          {products.data.map((p) => {
            const photo = coverOf(p);
            return (
              <Card key={p.id} padding="xs" withBorder style={{ cursor: 'pointer' }} onClick={() => setOpenId(p.id)}>
                <Card.Section>
                  {photo ? (
                    <Image src={photo.thumbUrl ?? photo.url} h={180} fit="cover" alt="" />
                  ) : (
                    <Group h={180} justify="center" bg="var(--mantine-color-default-hover)">
                      <IconShirt size={40} stroke={1.25} />
                    </Group>
                  )}
                </Card.Section>
                <Text fw={600} mt="xs" lineClamp={2}>
                  {p.title}
                </Text>
                <Group justify="space-between" gap={4} mt={4}>
                  <Text size="sm" fw={700}>
                    {formatMoney(p.price)}
                  </Text>
                  <Group gap={4}>
                    {p.media.some((m) => m.kind === 'spin') && (
                      <Badge size="xs" variant="light" leftSection={<IconRotate360 size={10} />}>
                        360°
                      </Badge>
                    )}
                    {p.media.some((m) => m.kind === 'model') && (
                      <Badge size="xs" variant="light" leftSection={<IconCube3dSphere size={10} />}>
                        3D
                      </Badge>
                    )}
                    <Badge size="xs" color={p.published ? 'green' : 'gray'} variant="light">
                      {p.published ? 'в витрине' : 'скрыта'}
                    </Badge>
                  </Group>
                </Group>
                <Text size="xs" c="dimmed" mt={2}>
                  свободно: {totalLeft(p)} шт.
                </Text>
              </Card>
            );
          })}
        </SimpleGrid>
      )}
      <AppModal opened={openId === 'new' || opened !== null} onClose={() => void close()} title={opened?.title ?? 'Новая вещь'} size="xl">
        {(openId === 'new' || opened) && (
          <ProductEditor
            key={opened?.id ?? 'new'}
            p={opened}
            nextSort={(products.data.at(-1)?.sort ?? 0) + 10}
            onDirty={(d) => {
              dirty.current = d;
            }}
            onSaved={(p) => setOpenId(p.id)}
            onDeleted={() => {
              dirty.current = false;
              setOpenId(null);
            }}
          />
        )}
      </AppModal>
    </Stack>
  );
}

// ---------- черновик: всё, что набрали, уходит одной кнопкой «Сохранить» ----------

interface DraftSize {
  key: string;
  id: number | null;
  size: string;
  stock: number;
}
interface DraftColor {
  key: string;
  id: number | null;
  name: string;
  hex: string;
  sizes: DraftSize[];
}
interface DraftMedia {
  key: string;
  id: number | null;
  kind: MerchMediaKind;
  /** Что показать: файл с сервера или ещё не загруженный (blob:). */
  url: string;
  thumbUrl: string | null;
  bytes: number;
  /** key цвета; null - обложка и общие. */
  color: string | null;
  /** Новый файл: загрузится при «Сохранить». */
  file: File | null;
}
interface Draft {
  published: boolean;
  title: string;
  subtitle: string;
  price: number;
  badge: string;
  sort: number;
  descriptionMd: string;
  colors: DraftColor[];
  /** Порядок в списке = порядок в витрине. */
  media: DraftMedia[];
}

let seq = 0;
const newKey = (prefix: string) => `${prefix}${++seq}`;

function toDraft(p: AdminMerchProduct | null, nextSort: number): Draft {
  if (!p) {
    // Без цвета не задать размеры - заводим «Основной», его можно переименовать.
    return {
      published: false,
      title: '',
      subtitle: '',
      price: 0,
      badge: '',
      sort: nextSort,
      descriptionMd: '',
      colors: [{ key: newKey('n'), id: null, name: 'Основной', hex: '#111111', sizes: [] }],
      media: [],
    };
  }
  return {
    published: p.published,
    title: p.title,
    subtitle: p.subtitle ?? '',
    price: Number(p.price),
    badge: p.badge ?? '',
    sort: p.sort,
    descriptionMd: p.descriptionMd,
    colors: p.colors.map((c) => ({
      key: `c${c.id}`,
      id: c.id,
      name: c.name,
      hex: c.hex,
      sizes: c.sizes.map((s) => ({ key: `s${s.id}`, id: s.id, size: s.size, stock: s.stock })),
    })),
    media: p.media.map((m) => ({
      key: `m${m.id}`,
      id: m.id,
      kind: m.kind,
      url: m.url,
      thumbUrl: m.thumbUrl,
      bytes: m.bytes,
      color: m.colorId === null ? null : `c${m.colorId}`,
      file: null,
    })),
  };
}

/** По нему видно, есть ли несохранённое: у новых цветов, размеров и файлов ключи уникальны. */
const fingerprint = (d: Draft) => JSON.stringify({ ...d, media: d.media.map((m) => [m.key, m.color]) });

function ProductEditor({
  p,
  nextSort,
  onDirty,
  onSaved,
  onDeleted,
}: {
  p: AdminMerchProduct | null;
  nextSort: number;
  onDirty: (dirty: boolean) => void;
  onSaved: (p: AdminMerchProduct) => void;
  onDeleted: () => void;
}) {
  const saveProduct = useSaveProduct();
  const del = useDeleteProduct();
  const confirm = useConfirm();
  const [initial] = useState(() => toDraft(p, nextSort));
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const saving = status !== null;
  /** blob:-ссылки на ещё не загруженные файлы - освобождаем, когда редактор закрыли. */
  const blobs = useRef(new Set<string>());
  /** Уже загруженные файлы черновика - если сохранение сорвалось, второй раз не грузим. */
  const uploaded = useRef(new Map<string, string>());

  const base = useMemo(() => (p ? toDraft(p, nextSort) : initial), [p, nextSort, initial]);
  const dirty = fingerprint(draft) !== fingerprint(base);
  // Вещь поменяли не здесь (второй админ, другая вкладка): нетронутый черновик подтягиваем к свежим данным.
  const lastBase = useRef(base);
  useEffect(() => {
    if (fingerprint(lastBase.current) === fingerprint(base)) return;
    setDraft((d) => (fingerprint(d) === fingerprint(lastBase.current) ? base : d));
    lastBase.current = base;
  }, [base]);

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const urls = blobs.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const blobUrl = (file: File) => {
    const url = URL.createObjectURL(file);
    blobs.current.add(url);
    return url;
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setColor = (key: string, fn: (c: DraftColor) => DraftColor) => setDraft((d) => ({ ...d, colors: d.colors.map((c) => (c.key === key ? fn(c) : c)) }));
  const setMedia = (fn: (list: DraftMedia[]) => DraftMedia[]) => setDraft((d) => ({ ...d, media: fn(d.media) }));

  const save = async () => {
    const unnamed = draft.colors.find((c) => !c.name.trim());
    if (unnamed) return notifyError(new Error('У каждого цвета должно быть название'), 'Не сохранилось');
    setStatus('Сохраняю…');
    try {
      const pending = draft.media.filter((m) => m.file && !uploaded.current.has(m.key));
      for (const [i, m] of pending.entries()) {
        setStatus(`Загружаю файлы: ${i + 1} из ${pending.length}`);
        uploaded.current.set(m.key, (await uploadMerchFile(m.file!)).file);
      }
      setStatus('Сохраняю…');
      const saved = await saveProduct.mutateAsync({
        id: p?.id ?? null,
        title: draft.title.trim(),
        subtitle: draft.subtitle.trim() || null,
        descriptionMd: draft.descriptionMd,
        price: draft.price,
        badge: draft.badge.trim() || null,
        sort: draft.sort,
        published: draft.published,
        colors: draft.colors.map((c) => ({
          id: c.id,
          key: c.key,
          name: c.name.trim(),
          hex: c.hex,
          sizes: c.sizes.map((s) => ({ id: s.id, size: s.size, stock: s.stock })),
        })),
        media: draft.media.map((m) => ({ id: m.id, file: m.id === null ? uploaded.current.get(m.key)! : null, color: m.color })),
      });
      const next = toDraft(saved, nextSort);
      lastBase.current = next;
      setDraft(next);
      uploaded.current.clear();
      notifySuccess('Сохранено');
      onSaved(saved);
    } catch (e) {
      notifyError(e, 'Не сохранилось');
    } finally {
      setStatus(null);
    }
  };

  const remove = async () => {
    if (!p) return;
    const ok = await confirm({ title: 'Удалить вещь?', message: 'Вещь, фото и 3D-модель удалятся насовсем.', confirmLabel: 'Удалить', danger: true });
    if (ok) del.mutate(p.id, { onSuccess: () => (notifySuccess('Удалено'), onDeleted()), onError: (e) => notifyError(e) });
  };

  const removeColor = async (c: DraftColor) => {
    const files = draft.media.filter((m) => m.color === c.key).length;
    if (files) {
      const ok = await confirm({
        title: `Удалить цвет «${c.name}»?`,
        message: `Его фото и 3D (${files} шт.) тоже уберутся. Насовсем - после «Сохранить».`,
        confirmLabel: 'Удалить',
        danger: true,
      });
      if (!ok) return;
    }
    setDraft((d) => ({ ...d, colors: d.colors.filter((x) => x.key !== c.key), media: d.media.filter((m) => m.color !== c.key) }));
  };

  const live = new Map((p?.colors ?? []).flatMap((c) => c.sizes.map((s) => [s.id, s] as const)));
  const groups = [{ value: 'all', label: 'Обложка и общие' }, ...draft.colors.map((c) => ({ value: c.key, label: `Цвет «${c.name || 'без названия'}»` }))];
  const media = { draft, groups, setMedia, blobUrl };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Switch
          size="md"
          label={draft.published ? 'В витрине' : 'Скрыта'}
          checked={draft.published}
          onChange={(e) => set({ published: e.currentTarget.checked })}
          thumbIcon={draft.published ? <IconEye size={12} /> : <IconEyeOff size={12} />}
        />
        {p && (
          <Tooltip label={p.hasOrders ? 'Вещь уже заказывали - её можно только скрыть' : 'Удалить насовсем'}>
            <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} disabled={p.hasOrders} loading={del.isPending} onClick={() => void remove()}>
              Удалить
            </Button>
          </Tooltip>
        )}
      </Group>

      <Stack gap="sm">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <TextInput label="Название" required maxLength={80} value={draft.title} onChange={(e) => set({ title: e.currentTarget.value })} data-autofocus={!p || undefined} />
          <TextInput label="Подзаголовок" maxLength={120} placeholder="Оверсайз, 100% хлопок" value={draft.subtitle} onChange={(e) => set({ subtitle: e.currentTarget.value })} />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
          <NumberInput label="Цена, руб." min={0} decimalScale={2} value={draft.price} onChange={(v) => set({ price: Number(v) || 0 })} />
          <TextInput label="Плашка" placeholder="NEW, Limited" maxLength={20} value={draft.badge} onChange={(e) => set({ badge: e.currentTarget.value })} />
          <NumberInput label="Порядок" description="меньше - выше" allowDecimal={false} value={draft.sort} onChange={(v) => set({ sort: Number(v) || 0 })} />
        </SimpleGrid>
        <Textarea
          label="Описание"
          description="Можно **жирный**, списки, ссылки"
          autosize
          minRows={3}
          maxRows={10}
          maxLength={4000}
          value={draft.descriptionMd}
          onChange={(e) => set({ descriptionMd: e.currentTarget.value })}
        />
      </Stack>

      <Card withBorder padding="sm">
        <MediaGroup
          {...media}
          colorKey={null}
          title="Обложка и общие фото"
          hint={`Первое фото - превью вещи в витрине. Общие фото и 360° показываются у всех цветов. Фото - JPG/PNG/WebP до ${PHOTO_MAX_MB} МБ. 360° - архив .zip с кадрами оборота (frame_001, frame_002…) или сами кадры.`}
        />
      </Card>

      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={700}>Цвета и размеры</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => set({ colors: [...draft.colors, { key: newKey('n'), id: null, name: 'Новый цвет', hex: '#ffffff', sizes: [] }] })}
          >
            Цвет
          </Button>
        </Group>
        {draft.colors.map((c) => (
          <Card key={c.key} withBorder padding="sm">
            <ColorEditor c={c} live={live} canDelete={draft.colors.length > 1} onChange={(fn) => setColor(c.key, fn)} onDelete={() => void removeColor(c)} />
            <Divider my="sm" variant="dashed" />
            <MediaGroup
              {...media}
              colorKey={c.key}
              title={`Фото цвета «${c.name || 'без названия'}»`}
              hint="Показываются, когда в витрине выбрали этот цвет (первыми, перед общими). Свой 360° цвета - вместо общего."
            />
          </Card>
        ))}
      </Stack>

      <ModalActions justify="space-between">
        <Text size="sm" c={dirty ? 'yellow' : 'dimmed'}>
          {status ?? (dirty ? 'Есть несохранённые изменения' : p ? 'Всё сохранено' : 'Новая вещь - ещё не сохранена')}
        </Text>
        <Group gap="sm">
          <Button variant="default" disabled={!dirty || saving} onClick={() => setDraft(base)}>
            Отменить
          </Button>
          <Button loading={saving} disabled={!dirty || !draft.title.trim()} onClick={() => void save()}>
            Сохранить
          </Button>
        </Group>
      </ModalActions>
    </Stack>
  );
}

// ---------- цвет и размеры ----------

function ColorEditor({
  c,
  live,
  canDelete,
  onChange,
  onDelete,
}: {
  c: DraftColor;
  live: ReadonlyMap<number, AdminMerchSize>;
  canDelete: boolean;
  onChange: (fn: (c: DraftColor) => DraftColor) => void;
  onDelete: () => void;
}) {
  const [newSize, setNewSize] = useState('');
  const missing = STANDARD_SIZES.filter((s) => !c.sizes.some((x) => x.size.toLowerCase() === s.toLowerCase()));
  const addSizes = (names: string[]) => onChange((x) => ({ ...x, sizes: [...x.sizes, ...names.map((size) => ({ key: newKey('z'), id: null, size, stock: 0 }))] }));
  const addOne = () => {
    const size = newSize.trim();
    if (!size) return;
    if (c.sizes.some((s) => s.size.toLowerCase() === size.toLowerCase())) return notifyError(new Error(`Размер ${size} у этого цвета уже есть`), 'Повтор');
    addSizes([size]);
    setNewSize('');
  };
  const setSize = (key: string, patch: Partial<DraftSize>) => onChange((x) => ({ ...x, sizes: x.sizes.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));

  return (
    <>
      <Group gap="sm" align="flex-end" wrap="nowrap">
        <TextInput
          label="Цвет"
          value={c.name}
          onChange={(e) => {
            // Значение - сразу: к моменту, когда React вызовет обновление, e.currentTarget уже null (и редактор падал).
            const name = e.currentTarget.value;
            onChange((x) => ({ ...x, name }));
          }}
          style={{ flex: 1 }}
          maxLength={40}
        />
        <ColorInput label="Оттенок" value={c.hex} onChange={(hex) => onChange((x) => ({ ...x, hex }))} format="hex" w={150} />
        <Tooltip label={canDelete ? 'Удалить цвет' : 'Должен остаться хотя бы один цвет'}>
          <ActionIcon variant="subtle" color="red" size="lg" disabled={!canDelete} onClick={onDelete} aria-label="Удалить цвет">
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Table mt="sm" verticalSpacing={4} withRowBorders={false}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Размер</Table.Th>
            <Table.Th>Всего, шт.</Table.Th>
            <Table.Th>Бронь</Table.Th>
            <Table.Th>Оплачено</Table.Th>
            <Table.Th>Выдано</Table.Th>
            <Table.Th>Свободно</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {c.sizes.map((s) => {
            const l = s.id === null ? undefined : live.get(s.id);
            const inOrders = l ? l.reserved + l.paid + l.issued : 0;
            const left = Math.max(0, s.stock - inOrders);
            return (
              <Table.Tr key={s.key}>
                <Table.Td fw={700}>
                  {s.size}{' '}
                  {s.id === null && (
                    <Badge size="xs" color="yellow" variant="light">
                      новый
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    size="xs"
                    w={90}
                    min={inOrders}
                    allowDecimal={false}
                    allowNegative={false}
                    value={s.stock}
                    onChange={(v) => setSize(s.key, { stock: Math.max(0, Math.trunc(Number(v) || 0)) })}
                  />
                </Table.Td>
                <Table.Td>{l?.reserved || '-'}</Table.Td>
                <Table.Td>{l?.paid || '-'}</Table.Td>
                <Table.Td>{l?.issued || '-'}</Table.Td>
                <Table.Td>
                  <Badge color={left > 0 ? 'green' : 'gray'} variant="light">
                    {left}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={inOrders ? 'Уже заказывали - поставьте 0' : 'Удалить размер'}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={inOrders > 0}
                      onClick={() => onChange((x) => ({ ...x, sizes: x.sizes.filter((z) => z.key !== s.key) }))}
                      aria-label="Удалить размер"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      <Group gap="xs" mt="xs">
        <TextInput
          size="xs"
          placeholder="Размер, например M"
          value={newSize}
          onChange={(e) => setNewSize(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && addOne()}
          maxLength={20}
          w={180}
        />
        <Button size="xs" variant="light" disabled={!newSize.trim()} onClick={addOne}>
          Добавить размер
        </Button>
        {missing.length > 0 && (
          <Button size="xs" variant="subtle" onClick={() => addSizes(missing)}>
            + {missing.join(', ')}
          </Button>
        )}
      </Group>
    </>
  );
}

// ---------- фото и 3D ----------

let viewerLoader: Promise<unknown> | null = null;

function ModelPreview({ src }: { src: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    (viewerLoader ??= import('@google/model-viewer')).then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  return ready ? (
    createElement('model-viewer' as 'div', {
      src,
      'camera-controls': true,
      'auto-rotate': true,
      'environment-image': 'neutral',
      style: { width: '100%', height: 120, background: 'var(--mantine-color-default-hover)' },
    } as never)
  ) : (
    <Group h={120} justify="center">
      <IconCube3dSphere size={32} stroke={1.25} />
    </Group>
  );
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

/**
 * Набор фото и 3D: обложка и общие (colorKey = null) или фото одного цвета.
 * До 10 фото на набор, одна 3D-модель (новая заменяет прежнюю). Всё - в черновик, на сервер - по «Сохранить».
 */
function MediaGroup({
  draft,
  groups,
  setMedia,
  blobUrl,
  colorKey,
  title,
  hint,
}: {
  draft: Draft;
  groups: { value: string; label: string }[];
  setMedia: (fn: (list: DraftMedia[]) => DraftMedia[]) => void;
  blobUrl: (file: File) => string;
  colorKey: string | null;
  title: string;
  hint: string;
}) {
  const items = draft.media.filter((m) => m.color === colorKey);
  const photos = items.filter((m) => m.kind === 'photo');
  const model = items.find((m) => m.kind === 'model');
  const spin = items.find((m) => m.kind === 'spin');
  const left = MAX_PHOTOS - photos.length;
  const [packing, setPacking] = useState(false);
  /** Сбросить выбор файла: иначе тот же архив второй раз не выбрать. */
  const resetSpin = useRef<() => void>(null);

  const onPhotos = (files: File[]) => {
    const ok = files.filter((f) => {
      const problem = !PHOTO_TYPES.includes(f.type) ? 'Фото - только JPG, PNG или WebP' : f.size > PHOTO_MAX_MB * 1024 * 1024 ? `Фото больше ${PHOTO_MAX_MB} МБ` : null;
      if (problem) notifyError(new Error(problem), f.name);
      return !problem;
    });
    if (ok.length > left) notifyError(new Error(`Можно ещё ${Math.max(0, left)} фото из ${MAX_PHOTOS} - лишние не добавили`), 'Слишком много фото');
    const added = ok.slice(0, Math.max(0, left)).map((file): DraftMedia => {
      const url = blobUrl(file);
      return { key: newKey('u'), id: null, kind: 'photo', url, thumbUrl: url, bytes: file.size, color: colorKey, file };
    });
    setMedia((list) => [...list, ...added]);
  };

  const onModel = (file: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.glb')) return notifyError(new Error('3D-модель - только файл .glb'), file.name);
    if (file.size > MODEL_MAX_MB * 1024 * 1024) return notifyError(new Error(`3D-модель больше ${MODEL_MAX_MB} МБ - сожмите её (Draco или meshopt)`), file.name);
    const next: DraftMedia = { key: newKey('u'), id: null, kind: 'model', url: blobUrl(file), thumbUrl: null, bytes: file.size, color: colorKey, file };
    // Модель в наборе одна: новая встаёт на место прежней.
    setMedia((list) => (list.some((m) => m.kind === 'model' && m.color === colorKey) ? list.map((m) => (m.kind === 'model' && m.color === colorKey ? next : m)) : [...list, next]));
  };

  /** 360°: архив с кадрами или сами кадры → один файл; в наборе один, новый встаёт на место прежнего. */
  const onSpin = async (files: File[]) => {
    if (files.length === 0) return;
    setPacking(true);
    try {
      const made = await spinFromFiles(files);
      const posterUrl = blobUrl(new File([made.poster], 'poster', { type: made.poster.type }));
      const next: DraftMedia = { key: newKey('u'), id: null, kind: 'spin', url: posterUrl, thumbUrl: posterUrl, bytes: made.file.size, color: colorKey, file: made.file };
      setMedia((list) => (list.some((m) => m.kind === 'spin' && m.color === colorKey) ? list.map((m) => (m.kind === 'spin' && m.color === colorKey ? next : m)) : [...list, next]));
      notifySuccess(`360°: ${made.frames} кадров - сохранится по «Сохранить»`);
    } catch (err) {
      notifyError(err, 'Не получилось сделать 360°');
    } finally {
      setPacking(false);
      resetSpin.current?.();
    }
  };

  // Поменять местами с соседом в этом наборе.
  const move = (i: number, dir: -1 | 1) => {
    const a = items[i];
    const b = items[i + dir];
    if (!a || !b) return;
    setMedia((list) => {
      const out = [...list];
      const ia = out.findIndex((x) => x.key === a.key);
      const ib = out.findIndex((x) => x.key === b.key);
      [out[ia], out[ib]] = [out[ib]!, out[ia]!];
      return out;
    });
  };

  const regroup = (m: DraftMedia, value: string | null) => {
    const color = !value || value === 'all' ? null : value;
    if (color === m.color) return;
    const there = draft.media.filter((x) => x.color === color);
    if (m.kind === 'photo' && there.filter((x) => x.kind === 'photo').length >= MAX_PHOTOS) {
      return notifyError(new Error(`Там уже ${MAX_PHOTOS} фото - сначала уберите лишние`), 'Не перенесли');
    }
    if (m.kind === 'model' && there.some((x) => x.kind === 'model')) return notifyError(new Error('Там уже есть 3D-модель - сначала удалите её'), 'Не перенесли');
    if (m.kind === 'spin' && there.some((x) => x.kind === 'spin')) return notifyError(new Error('Там уже есть 360° - сначала удалите его'), 'Не перенесли');
    setMedia((list) => list.map((x) => (x.key === m.key ? { ...x, color } : x)));
  };

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="flex-end" gap="xs">
        <div>
          <Group gap={6}>
            <Text fw={700} size="sm">
              {title}
            </Text>
            <Badge size="xs" variant="light" color={left > 0 ? 'gray' : 'orange'}>
              фото {photos.length} / {MAX_PHOTOS}
            </Badge>
            {spin && (
              <Badge size="xs" variant="light" color="teal">
                360° есть
              </Badge>
            )}
            {model && (
              <Badge size="xs" variant="light" color="grape">
                3D есть
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        </div>
        <Group gap="xs">
          <FileButton onChange={onPhotos} accept={PHOTO_TYPES.join(',')} multiple disabled={left <= 0}>
            {(props) => (
              <Button {...props} size="xs" leftSection={<IconUpload size={14} />} disabled={left <= 0}>
                Фото
              </Button>
            )}
          </FileButton>
          <FileButton resetRef={resetSpin} onChange={(files) => void onSpin(files)} accept=".zip,application/zip,image/webp,image/jpeg,image/png" multiple>
            {(props) => (
              <Button {...props} size="xs" variant="light" color="teal" loading={packing} leftSection={<IconRotate360 size={14} />}>
                {spin ? 'Заменить 360°' : '360°'}
              </Button>
            )}
          </FileButton>
          {/* 3D-модели больше не загружаем (их заменил 360°), но уже загруженную можно заменить или удалить. */}
          {model && (
            <FileButton onChange={onModel} accept=".glb,model/gltf-binary">
              {(props) => (
                <Button {...props} size="xs" variant="light" color="grape" leftSection={<IconCube3dSphere size={14} />}>
                  Заменить 3D
                </Button>
              )}
            </FileButton>
          )}
        </Group>
      </Group>
      {items.length === 0 ? (
        <Text size="xs" c="dimmed">
          Пусто.
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 3, sm: 5 }} spacing="xs">
          {items.map((m, i) => {
            const cover = colorKey === null && m.key === photos[0]?.key;
            return (
              <Card key={m.key} withBorder padding={0}>
                <div style={{ position: 'relative' }}>
                  {m.kind === 'photo' ? (
                    <Image src={m.thumbUrl ?? m.url} h={120} fit="cover" alt="" />
                  ) : m.kind === 'spin' ? (
                    <div style={{ position: 'relative' }}>
                      <Image src={m.thumbUrl ?? m.url} h={120} fit="contain" alt="" bg="var(--mantine-color-default-hover)" />
                      <IconRotate360 size={22} style={{ position: 'absolute', right: 6, bottom: 6, opacity: 0.75 }} />
                    </div>
                  ) : (
                    <ModelPreview src={m.url} />
                  )}
                  {m.id === null && (
                    <Tooltip label="Загрузится, когда нажмёте «Сохранить»">
                      <Badge size="xs" color="yellow" variant="filled" pos="absolute" top={6} left={6}>
                        новое
                      </Badge>
                    </Tooltip>
                  )}
                </div>
                <Stack gap={2} p={4}>
                  <Group justify="space-between" gap={0} wrap="nowrap">
                    <Badge size="xs" variant="light" color={m.kind === 'spin' ? 'teal' : m.kind === 'model' ? 'grape' : cover ? 'blue' : 'gray'}>
                      {m.kind === 'spin' ? `360° · ${mb(m.bytes)}` : m.kind === 'model' ? `3D · ${mb(m.bytes)}` : cover ? 'обложка' : 'фото'}
                    </Badge>
                    <Group gap={0} wrap="nowrap">
                      <ActionIcon size="xs" variant="subtle" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Левее">
                        <IconArrowLeft size={12} />
                      </ActionIcon>
                      <ActionIcon size="xs" variant="subtle" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Правее">
                        <IconArrowRight size={12} />
                      </ActionIcon>
                      <ActionIcon size="xs" variant="subtle" color="red" onClick={() => setMedia((list) => list.filter((x) => x.key !== m.key))} aria-label="Удалить">
                        <IconTrash size={12} />
                      </ActionIcon>
                    </Group>
                  </Group>
                  <Select
                    size="xs"
                    aria-label="Перенести в набор"
                    data={groups}
                    value={m.color ?? 'all'}
                    allowDeselect={false}
                    onChange={(v) => regroup(m, v)}
                  />
                </Stack>
              </Card>
            );
          })}
        </SimpleGrid>
      )}
    </Stack>
  );
}
