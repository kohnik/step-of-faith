import { ActionIcon, Alert, Badge, Card, Group, SegmentedControl, SimpleGrid, Stack, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ReceiptView } from '@sof/shared';
import { IconCash, IconCircleCheck, IconCircleX, IconHourglass, IconLayoutGrid, IconList, IconListDetails, IconReceipt, IconRefresh, IconSearch } from '@tabler/icons-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useSearch } from 'wouter';
import { useParticipants } from '../../api/participants.ts';
import { useReceipts, useUnsentDrafts, type ReceiptStatus } from '../../api/receipts.ts';
import { AppLink } from '../../components/AppLink.tsx';
import { formatRelative } from '../../lib/format.ts';
import { AppModal } from '../../components/AppModal.tsx';
import { useEvent, useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useCan } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { readStored, writeStored } from '../../lib/storage.ts';
import { PaymentsLedger } from './PaymentsLedger.tsx';
import { ReceiptCard } from './ReceiptCard.tsx';

// Таблица тянет AG Grid - грузим её, только когда выбрали табличный вид.
const ReceiptsTable = lazy(() => import('./ReceiptsTable.tsx').then((m) => ({ default: m.ReceiptsTable })));

type Tab = ReceiptStatus | 'all';
type View = 'cards' | 'table';
type Section = 'ledger' | 'receipts';
const VIEW_KEY = 'payments.view';
const SECTION_KEY = 'payments.section';

const TABS: { value: Tab; label: string; icon: typeof IconHourglass; color: string }[] = [
  { value: 'pending', label: 'На проверке', icon: IconHourglass, color: 'yellow' },
  { value: 'accepted', label: 'Принятые', icon: IconCircleCheck, color: 'green' },
  { value: 'rejected', label: 'Отклонённые', icon: IconCircleX, color: 'red' },
  { value: 'all', label: 'Все', icon: IconList, color: 'gray' },
];

export default function PaymentsPage() {
  const params = new URLSearchParams(useSearch());
  const initialTab = (params.get('tab') as Tab | null) ?? 'pending';
  // Ссылка с ?tab= (например, «чеки на проверке» из меню) - сразу в чеки; иначе - где были в прошлый раз.
  const [section, setSectionState] = useState<Section>(() =>
    params.get('tab') ? 'receipts' : readStored<string>(SECTION_KEY, 'ledger') === 'receipts' ? 'receipts' : 'ledger',
  );
  const setSection = (v: Section) => {
    setSectionState(v);
    writeStored(SECTION_KEY, v);
  };
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.value === initialTab) ? initialTab : 'pending');
  const [view, setViewState] = useState<View>(() => (readStored<string>(VIEW_KEY, 'cards') === 'table' ? 'table' : 'cards'));
  const setView = (v: View) => {
    setViewState(v);
    writeStored(VIEW_KEY, v);
  };
  /** Чек, открытый из таблицы (карточка в окне). */
  const [openId, setOpenId] = useState<number | null>(null);
  const can = useCan();
  const tz = useEventTz();
  const { settings } = useEvent();
  const pending = useReceipts('pending');
  const inReceipts = section === 'receipts';
  const accepted = useReceipts('accepted', inReceipts && tab === 'accepted');
  const rejected = useReceipts('rejected', inReceipts && tab === 'rejected');
  const all = useReceipts('all', inReceipts && tab === 'all');
  const current = tab === 'pending' ? pending : tab === 'accepted' ? accepted : tab === 'rejected' ? rejected : all;
  // Суммы «к оплате» из базы - если роль видит базу.
  const participants = useParticipants(inReceipts && can('participants:read'));
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);
  const [order, setOrder] = useState<'old' | 'new'>('old');
  /** Вид чека: взносы, пожертвования, мерч - или все. */
  const [kind, setKind] = useState<'all' | ReceiptView['kind']>('all');

  const dueById = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of participants.data ?? []) if (p.amountDue) map.set(p.id, Number(p.amountDue));
    return map;
  }, [participants.data]);

  const dueHint = (r: ReceiptView): number | null => {
    if (r.expectedTotal) return Number(r.expectedTotal);
    if (!participants.data) return null;
    return r.participants.reduce((sum, p) => sum + (dueById.get(p.id) ?? 0), 0);
  };

  const list = useMemo(() => {
    let items = current.data ?? [];
    if (kind !== 'all') items = items.filter((r) => r.kind === kind);
    if (q) {
      items = items.filter((r) =>
        `${r.userName} ${r.paymentRef} ${r.comment ?? ''} ${r.merchOrder?.code ?? ''} ${r.participants.map((p) => p.fullName).join(' ')}`.toLowerCase().includes(q),
      );
    }
    const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return order === 'old' ? sorted : sorted.reverse();
  }, [current.data, q, order, kind]);

  const counts: Record<Tab, number | undefined> = {
    pending: pending.data?.length,
    accepted: accepted.data?.length,
    rejected: rejected.data?.length,
    all: all.data?.length,
  };
  const opened = openId == null ? null : (current.data?.find((r) => r.id === openId) ?? null);

  return (
    <Stack gap="md">
      <PageHeader
        title="Оплаты и чеки"
        description={
          section === 'ledger'
            ? 'Каждая оплата строкой: наличные на кассе, принятые чеки переводов и правки в админке - кто, сколько, чем и кто принял. Нажмите на строку - откроется карточка участника.'
            : 'Чеки переводов: за взнос, пожертвования и за мерч. Проверьте сумму и получателя. Принятый чек за взнос отмечает оплату людям из него, за мерч - оплачивает бронь, пожертвование идёт в журнал денег.'
        }
        actions={
          section === 'receipts' ? (
            <Tooltip label="Обновить">
              <ActionIcon variant="default" size="lg" onClick={() => void current.refetch()} loading={current.isFetching} aria-label="Обновить">
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
          ) : undefined
        }
      />

      <SegmentedControl
        value={section}
        onChange={(v) => setSection(v as Section)}
        fullWidth
        maw={520}
        data={[
          { value: 'ledger', label: <Group gap={6} wrap="nowrap" justify="center"><IconCash size={16} />Все оплаты</Group> },
          {
            value: 'receipts',
            label: (
              <Group gap={6} wrap="nowrap" justify="center">
                <IconReceipt size={16} />
                Чеки переводов
                {!!pending.data?.length && (
                  <Badge size="xs" color="yellow" variant="filled">
                    {pending.data.length}
                  </Badge>
                )}
              </Group>
            ),
          },
        ]}
      />

      {section === 'ledger' && <PaymentsLedger tz={tz} />}

      {section === 'receipts' && (
        <>
          {settings?.paymentInstructions && (
            <Card padding="sm" radius="md">
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--mantine-font-size-sm)', fontWeight: 600 }}>
                  Реквизиты, которые видят участники
                </summary>
                <div style={{ marginTop: 8 }}>
                  <Markdown source={settings.paymentInstructions} />
                </div>
              </details>
            </Card>
          )}

          <UnsentDrafts enabled={can('payments:write')} />

          <Tabs value={tab} onChange={(v) => v && setTab(v as Tab)}>
            <Tabs.List>
              {TABS.map((t) => (
                <Tabs.Tab
                  key={t.value}
                  value={t.value}
                  leftSection={<t.icon size={16} />}
                  rightSection={
                    counts[t.value] !== undefined ? (
                      <Badge size="sm" variant={t.value === 'pending' && counts[t.value] ? 'filled' : 'light'} color={t.color}>
                        {counts[t.value]}
                      </Badge>
                    ) : undefined
                  }
                >
                  {t.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>

          <Group gap="sm" wrap="wrap">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="Поиск: имя, код оплаты, участник, комментарий"
              leftSection={<IconSearch size={16} />}
              style={{ flex: '1 1 320px' }}
              maw={520}
              aria-label="Поиск по чекам"
            />
            <SegmentedControl
              size="xs"
              value={kind}
              onChange={(v) => setKind(v as typeof kind)}
              aria-label="Вид чека"
              data={[
                { value: 'all', label: 'Все' },
                { value: 'fee', label: 'Взнос' },
                { value: 'donation', label: 'Пожертвования' },
                { value: 'merch', label: 'Мерч' },
              ]}
            />
            <SegmentedControl
              size="xs"
              value={order}
              onChange={(v) => setOrder(v as 'old' | 'new')}
              data={[
                { value: 'old', label: 'Сначала старые' },
                { value: 'new', label: 'Сначала новые' },
              ]}
            />
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(v) => setView(v as View)}
              aria-label="Вид"
              data={[
                { value: 'cards', label: <Group gap={4} wrap="nowrap"><IconLayoutGrid size={14} />Карточки</Group> },
                { value: 'table', label: <Group gap={4} wrap="nowrap"><IconListDetails size={14} />Таблица</Group> },
              ]}
            />
          </Group>

          {current.isPending ? (
            <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
              {[0, 1, 2].map((i) => (
                <BlockSkeleton key={i} rows={1} height={380} />
              ))}
            </SimpleGrid>
          ) : current.isError ? (
            <ErrorState error={current.error} onRetry={() => void current.refetch()} />
          ) : list.length === 0 ? (
            <Card>
              <EmptyBlock
                icon={<IconCircleCheck size={28} />}
                title={q ? 'Ничего не найдено' : tab === 'pending' ? 'Все чеки проверены' : 'Пока пусто'}
                description={tab === 'pending' && !q ? 'Новые чеки появятся здесь автоматически.' : undefined}
              />
            </Card>
          ) : view === 'table' ? (
            <Suspense fallback={<BlockSkeleton rows={1} height={600} />}>
              <ReceiptsTable rows={list} tz={tz} onOpen={(r) => setOpenId(r.id)} />
            </Suspense>
          ) : (
            <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
              {list.map((r) => (
                <ReceiptCard key={r.id} receipt={r} canReview={can('payments:write')} dueHint={dueHint(r)} />
              ))}
            </SimpleGrid>
          )}
        </>
      )}

      <AppModal opened={opened !== null} onClose={() => setOpenId(null)} title={opened ? `Чек №${opened.id}` : ''} size="lg">
        {opened && <ReceiptCard receipt={opened} canReview={can('payments:write')} dueHint={dueHint(opened)} />}
      </AppModal>
    </Stack>
  );
}

/** Прислали чек, но не нажали «Отправить»: в «Чеках» его нет - команда пишет человеку в переписке. */
function UnsentDrafts({ enabled }: { enabled: boolean }) {
  const drafts = useUnsentDrafts(enabled);
  if (!drafts.data?.length) return null;
  return (
    <Alert color="yellow" variant="light" title={`Прислали чек, но не нажали «Отправить»: ${drafts.data.length}`}>
      <Stack gap={4}>
        {drafts.data.map((d) => (
          <Group key={d.id} gap="xs" wrap="nowrap" justify="space-between">
            <Text size="sm" style={{ minWidth: 0 }} truncate>
              {d.userName}
              {d.people.length ? ` · ${d.people.join(', ')}` : ''}
              {d.files > 1 ? ` · файлов: ${d.files}` : ''} · {formatRelative(d.createdAt)}
            </Text>
            <AppLink href={`/messages/${d.userId}`} size="sm" style={{ flexShrink: 0 }}>
              Написать
            </AppLink>
          </Group>
        ))}
      </Stack>
    </Alert>
  );
}
