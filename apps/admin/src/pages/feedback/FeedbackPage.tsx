import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  CloseButton,
  Group,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_INFO, type AdminFeedbackRow, type AdminFeedbackView, type FeedbackCategory } from '@sof/shared';
import { IconDownload, IconInfoCircle, IconQrcode, IconSearch, IconStar, IconStarFilled, IconTrash } from '@tabler/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toDataURL, toString as qrSvg } from 'qrcode';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { api, downloadFile } from '../../api/client.ts';
import { AppModal } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { CopyValue } from '../../components/CopyValue.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { useCan } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { formatDateTimeShort, telegramUrl } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const BOT = import.meta.env.VITE_BOT_USERNAME?.replace(/^@/, '');
/** Ссылка прямо на форму отзыва в боте - для дизайнеров, постов и экрана. */
const FEEDBACK_LINK = BOT ? `https://t.me/${BOT}?startapp=feedback` : null;
const COLORS: Record<FeedbackCategory, string> = { testimony: 'grape', review: 'blue', suggestion: 'yellow' };

type Filter = { category: FeedbackCategory | 'all'; starred: boolean };
const KEY = (f: Filter) => ['feedback', f] as const;

const query = (f: Filter, ids?: number[]) => {
  const p = new URLSearchParams();
  if (f.category !== 'all') p.set('category', f.category);
  if (f.starred) p.set('starred', '1');
  if (ids?.length) p.set('ids', ids.join(','));
  return p.toString();
};

const norm = (s: string) => s.toLowerCase().replaceAll('ё', 'е');

/** Поиск прямо по загруженным отзывам: мгновенно, без запроса на сервер на каждую букву. Все слова должны найтись. */
function matches(row: AdminFeedbackRow, words: string[]): boolean {
  const hay = norm(`${row.text} ${row.author ? `${row.author.name} ${row.author.username ?? ''}` : ''}`);
  return words.every((w) => hay.includes(w));
}

/** Поле поиска со своим состоянием: набор текста не перерисовывает весь список (иначе на телефоне поле тормозит и теряет буквы). */
function SearchInput({ onSearch }: { onSearch: (q: string) => void }) {
  const [value, setValue] = useState('');
  const [debounced] = useDebouncedValue(value, 150);
  useEffect(() => onSearch(debounced), [debounced, onSearch]);
  return (
    <TextInput
      style={{ flex: 1 }}
      leftSection={<IconSearch size={16} />}
      placeholder="Поиск по тексту и подписи"
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      rightSection={value ? <CloseButton size="sm" aria-label="Очистить поиск" onClick={() => setValue('')} /> : null}
    />
  );
}

/** Скачать файл: через ссылку в документе (иначе часть браузеров клик игнорирует). */
async function download(data: Blob | string, name: string) {
  const blob = typeof data === 'string' ? await (await fetch(data)).blob() : data;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** QR-код и ссылка на форму отзыва: скачать PNG (крупный, для печати) или SVG (для дизайнеров). */
function QrModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  // Картинка PNG, а не SVG: на телефоне её можно зажать пальцем и сохранить (встроенный браузер Telegram скачивать не даёт).
  const png = useQuery({
    queryKey: ['feedback-qr-png'],
    queryFn: () => toDataURL(FEEDBACK_LINK!, { width: 2048, margin: 2, errorCorrectionLevel: 'H' }),
    enabled: opened && !!FEEDBACK_LINK,
    staleTime: Infinity,
  });
  const save = (kind: 'png' | 'svg') =>
    (kind === 'png'
      ? download(png.data ?? '', 'otzyv-qr.png')
      : qrSvg(FEEDBACK_LINK!, { type: 'svg', margin: 2, errorCorrectionLevel: 'H' }).then((svg) => download(new Blob([svg], { type: 'image/svg+xml' }), 'otzyv-qr.svg'))
    ).catch((err: unknown) => notifyError(err));
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>QR-код и ссылка на отзыв</Text>} size="sm">
      {FEEDBACK_LINK ? (
        <Stack gap="md" align="center">
          {png.data ? (
            <img src={png.data} alt="QR-код формы отзыва" width={240} height={240} style={{ display: 'block', borderRadius: 8 }} />
          ) : (
            <QrCode value={FEEDBACK_LINK} size={240} level="H" label="QR-код формы отзыва" />
          )}
          <Text size="sm" c="dimmed" ta="center">
            Открывает форму отзыва прямо в боте. С телефона: нажмите на QR-код и удерживайте → «Сохранить изображение».
          </Text>
          <Group w="100%" justify="center" style={{ minWidth: 0 }}>
            <CopyValue value={FEEDBACK_LINK} display={FEEDBACK_LINK.replace(/^https:\/\//, '')} maw="100%" />
          </Group>
          <Group grow w="100%">
            <Button variant="light" leftSection={<IconDownload size={16} />} disabled={!png.data} onClick={() => void save('png')}>
              PNG
            </Button>
            <Button variant="light" leftSection={<IconDownload size={16} />} onClick={() => void save('svg')}>
              SVG
            </Button>
          </Group>
        </Stack>
      ) : (
        <Text c="dimmed">Не задан ник бота (VITE_BOT_USERNAME) - ссылку не собрать.</Text>
      )}
    </AppModal>
  );
}

/** Тумблеры: всем участникам или проверка на админах (пока всем выключено). */
function Switches({ view }: { view: AdminFeedbackView }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: { feedbackOpen?: boolean; feedbackAdmins?: boolean }) => api.patch<{ open: boolean; admins: boolean }>('/api/admin/feedback-settings', patch),
    onSuccess: (r, patch) => {
      void qc.invalidateQueries({ queryKey: ['feedback'] });
      notifySuccess(
        patch.feedbackOpen !== undefined
          ? r.open
            ? 'Отзывы открыты всем: кнопка на главной и заставка при первом входе'
            : 'Отзывы скрыты'
          : r.admins
            ? 'Включено для админов - откройте приложение и проверьте'
            : 'Проверка на админах выключена',
      );
    },
    onError: (err) => notifyError(err),
  });
  return (
    <Card withBorder radius="md" padding="md" mb="md">
      <Stack gap="sm">
        <Switch
          size="md"
          checked={view.open}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ feedbackOpen: e.currentTarget.checked })}
          label={<Text fw={600}>Показывать отзывы участникам</Text>}
          description="Живая кнопка «Оставь отзыв» на главной и красивая заставка при первом входе (один раз, пока человек не оставил отзыв)"
        />
        <Switch
          size="md"
          checked={view.open ? false : view.admins}
          disabled={view.open || save.isPending}
          onChange={(e) => save.mutate({ feedbackAdmins: e.currentTarget.checked })}
          label={<Text fw={600}>Проверить на админах</Text>}
          description={
            view.open
              ? 'Не нужно: отзывы уже открыты всем'
              : 'Видят только админы и суперадмины - можно всё проверить. Каждое включение - заставка покажется снова'
          }
        />
        {view.ended && (
          <Alert color="grape" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
            Включён «Конец «Шага веры»» (Настройки): форма отзыва открыта всем зарегистрированным, даже если тумблер выше выключен.
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

/** memo: при поиске и выборе перерисовываются только изменившиеся карточки. */
const FeedbackCard = memo(function FeedbackCard({
  row,
  selected,
  onSelect,
}: {
  row: AdminFeedbackRow;
  selected: boolean;
  onSelect: (id: number, v: boolean) => void;
}) {
  const tz = useEventTz();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const info = FEEDBACK_CATEGORY_INFO[row.category];
  const star = useMutation({
    mutationFn: (starred: boolean) => api.patch(`/api/admin/feedback/${row.id}`, { starred }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['feedback'] }),
    onError: (err) => notifyError(err),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/admin/feedback/${row.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['feedback'] });
      notifySuccess('Отзыв удалён');
    },
    onError: (err) => notifyError(err),
  });
  const link = row.author?.username ? telegramUrl(row.author.username) : null;
  return (
    <Card withBorder radius="md" padding="sm" style={selected ? { borderColor: 'var(--mantine-color-blue-5)' } : undefined}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <Group gap={8} wrap="wrap">
          <Checkbox size="sm" checked={selected} onChange={(e) => onSelect(row.id, e.currentTarget.checked)} aria-label="Отметить" />
          <Badge color={COLORS[row.category]} variant="light" size="md">
            {info.emoji} {info.label}
          </Badge>
          <Text size="xs" c="dimmed">
            {formatDateTimeShort(row.createdAt, tz)}
          </Text>
        </Group>
        <Group gap={2} wrap="nowrap">
          <Tooltip label={row.starred ? 'Убрать из избранного' : 'В избранное'}>
            <ActionIcon variant="subtle" color="yellow" loading={star.isPending} onClick={() => star.mutate(!row.starred)} aria-label="Избранное">
              {row.starred ? <IconStarFilled size={18} /> : <IconStar size={18} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Удалить">
            <ActionIcon
              variant="subtle"
              color="red"
              loading={remove.isPending}
              aria-label="Удалить"
              onClick={async () => {
                if (await confirm({ title: 'Удалить отзыв?', message: 'Текст останется только в истории изменений.', confirmLabel: 'Удалить', danger: true })) remove.mutate();
              }}
            >
              <IconTrash size={17} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <Text mt={8} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {row.text}
      </Text>
      <Text mt={8} size="sm" c="dimmed">
        {row.author ? (
          <>
            {row.author.name}
            {link && (
              <>
                {' · '}
                <Anchor href={link} target="_blank" rel="noopener noreferrer" size="sm">
                  @{row.author.username}
                </Anchor>
              </>
            )}
          </>
        ) : (
          'Анонимно'
        )}
      </Text>
    </Card>
  );
});

export default function FeedbackPage() {
  const can = useCan();
  const [filter, setFilter] = useState<Filter>({ category: 'all', starred: false });
  const [q, setQ] = useState('');
  const view = useQuery({
    queryKey: KEY(filter),
    queryFn: ({ signal }) => api.get<AdminFeedbackView>(`/api/admin/feedback?${query(filter)}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [qrOpen, setQrOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const words = useMemo(() => norm(q).split(/\s+/).filter(Boolean), [q]);
  const items = useMemo(() => {
    const all = view.data?.items ?? [];
    return words.length ? all.filter((r) => matches(r, words)) : all;
  }, [view.data, words]);
  const visibleSelected = items.filter((i) => selected.has(i.id)).map((i) => i.id);
  const toggle = useCallback(
    (id: number, v: boolean) =>
      setSelected((s) => {
        const next = new Set(s);
        if (v) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const total = view.data ? FEEDBACK_CATEGORIES.reduce((s, c) => s + view.data!.counts[c], 0) : 0;

  const exportXlsx = async () => {
    setExporting(true);
    try {
      // Excel - отмеченные, а при поиске - найденные (поиск идёт в браузере, серверу передаём номера).
      const ids = visibleSelected.length ? visibleSelected : words.length ? items.map((i) => i.id) : undefined;
      await downloadFile(`/api/admin/feedback/export.xlsx?${query(filter, ids)}`, 'otzyvy.xlsx');
    } catch (err) {
      notifyError(err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Отзывы"
        description="Свидетельства, отзывы и пожелания участников из приложения"
        actions={
          <Group gap="xs">
            <Button variant="light" leftSection={<IconQrcode size={16} />} onClick={() => setQrOpen(true)}>
              QR и ссылка
            </Button>
            <Button variant="light" leftSection={<IconDownload size={16} />} loading={exporting} disabled={!items.length} onClick={() => void exportXlsx()}>
              {visibleSelected.length ? `Excel (${visibleSelected.length})` : 'Excel'}
            </Button>
          </Group>
        }
      />
      <QrModal opened={qrOpen} onClose={() => setQrOpen(false)} />
      {view.isPending ? (
        <BlockSkeleton rows={5} />
      ) : view.isError ? (
        <ErrorState error={view.error} onRetry={() => void view.refetch()} />
      ) : (
        <>
          {can('settings:write') && <Switches view={view.data} />}
          <SimpleGrid cols={{ base: 3 }} spacing="xs" mb="md">
            {FEEDBACK_CATEGORIES.map((c) => (
              <Card key={c} withBorder radius="md" padding="xs">
                <Text fz={11} c="dimmed" lh={1.3}>
                  {FEEDBACK_CATEGORY_INFO[c].emoji}
                  <br />
                  {FEEDBACK_CATEGORY_INFO[c].plural}
                </Text>
                <Text fw={700} fz={22}>
                  {view.data.counts[c]}
                </Text>
              </Card>
            ))}
          </SimpleGrid>
          <Stack gap="xs" mb="md">
            <ScrollArea type="never">
              <SegmentedControl
                value={filter.category}
                onChange={(v) => setFilter((x) => ({ ...x, category: v as Filter['category'] }))}
                data={[
                  { value: 'all', label: `Все · ${total}` },
                  ...FEEDBACK_CATEGORIES.map((c) => ({ value: c, label: `${FEEDBACK_CATEGORY_INFO[c].emoji} ${FEEDBACK_CATEGORY_INFO[c].plural}` })),
                ]}
              />
            </ScrollArea>
            <Group gap="xs" wrap="nowrap">
              <SearchInput onSearch={setQ} />
              <Chip checked={filter.starred} onChange={(v) => setFilter((x) => ({ ...x, starred: v }))} color="yellow" variant="light">
                ⭐ Избранные
              </Chip>
            </Group>
            {items.length > 0 && (
              <Group gap="xs" justify="space-between">
                <Checkbox
                  size="sm"
                  label={visibleSelected.length ? `Отмечено: ${visibleSelected.length}` : 'Отметить все'}
                  checked={visibleSelected.length > 0 && visibleSelected.length === items.length}
                  indeterminate={visibleSelected.length > 0 && visibleSelected.length < items.length}
                  onChange={(e) => setSelected(e.currentTarget.checked ? new Set(items.map((i) => i.id)) : new Set())}
                />
                <Text size="xs" c="dimmed">
                  {visibleSelected.length ? 'Excel - только отмеченные' : `Показано: ${items.length}. Excel - всё, что показано`}
                </Text>
              </Group>
            )}
          </Stack>
          {items.length === 0 ? (
            <Card withBorder radius="md" padding="lg">
              <Text c="dimmed" ta="center">
                {total === 0 ? 'Пока никто не оставил отзыв.' : 'Ничего не найдено - смените фильтр.'}
              </Text>
            </Card>
          ) : (
            <Stack gap="xs">
              {items.map((row) => (
                <FeedbackCard key={row.id} row={row} selected={selected.has(row.id)} onSelect={toggle} />
              ))}
            </Stack>
          )}
        </>
      )}
    </>
  );
}
