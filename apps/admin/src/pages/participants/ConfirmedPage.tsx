import { Card, CloseButton, Divider, Group, Progress, Skeleton, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { CATEGORY_LABELS, tierShort, type AdminParticipantRow } from '@sof/shared';
import { IconSearch, IconUserCheck } from '@tabler/icons-react';
import type { CellClickedEvent, ColDef, GetRowIdParams, GridApi, GridReadyEvent, IRowNode } from 'ag-grid-community';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParticipants } from '../../api/participants.ts';
import { useIsMobile } from '../../components/AppModal.tsx';
import { TierBadge } from '../../components/badges.tsx';
import { useTiers } from '../../components/SessionProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { DataGrid } from '../../components/grid/DataGrid.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { EmptyBlock, ErrorState } from '../../components/states.tsx';
import { countLabel, formatDateTimeShort, formatNumber, formatPercent, formatTime } from '../../lib/format.ts';
import { dayKey, todayKey } from '../../lib/tz.ts';
import { FRESH_MS, useFreshIds } from '../../lib/useFreshIds.ts';
import { StaffName } from '../../components/StaffName.tsx';

type Row = AdminParticipantRow;

const getRowId = (p: GetRowIdParams<Row>) => String(p.data.id);
const DEFAULT_COL_DEF: ColDef<Row> = { sortable: true, resizable: true, minWidth: 70 };

/** Сегодня - только время, иначе дата и время (по часам конференции). */
function arrivedLabel(iso: string | null, tz: string): string {
  if (!iso) return '-';
  return dayKey(iso, tz) === todayKey(tz) ? formatTime(iso, tz) : formatDateTimeShort(iso, tz);
}

function matches(r: Row, q: string): boolean {
  return `${r.fullName} ${r.city} ${CATEGORY_LABELS[r.category]}`.toLowerCase().includes(q);
}

/**
 * «Подтверждённые» - кто уже пришёл (отсканирован на входе). Новые сверху,
 * список обновляется сам каждые 10 секунд, только что пришедшие коротко подсвечиваются.
 */
export default function ConfirmedPage() {
  const tz = useEventTz();
  const tiers = useTiers();
  const mobile = useIsMobile();
  const participants = useParticipants(true, { live: true });
  const { openParticipant } = useParticipantDrawer();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);
  const apiRef = useRef<GridApi<Row> | null>(null);

  const { confirmed, total } = useMemo(() => {
    const active = (participants.data ?? []).filter((r) => r.status === 'active');
    const arrived = active.filter((r) => r.arrivedAt).sort((a, b) => (b.arrivedAt ?? '').localeCompare(a.arrivedAt ?? ''));
    return { confirmed: arrived, total: active.length };
  }, [participants.data]);

  const ids = useMemo(() => (participants.data ? confirmed.map((r) => r.id) : undefined), [participants.data, confirmed]);
  const fresh = useFreshIds(ids);
  const shown = useMemo(() => (q ? confirmed.filter((r) => matches(r, q)) : confirmed), [confirmed, q]);

  // В таблице (компьютер) новые строки мигают средствами AG Grid.
  useEffect(() => {
    const api = apiRef.current;
    if (!fresh.size || !api || api.isDestroyed()) return;
    const rowNodes = [...fresh].map((id) => api.getRowNode(String(id))).filter((n): n is IRowNode<Row> => !!n);
    if (rowNodes.length) api.flashCells({ rowNodes, flashDuration: FRESH_MS, fadeDuration: 800 });
  }, [fresh]);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      { colId: 'fullName', field: 'fullName', headerName: 'ФИО', flex: 2, minWidth: 180 },
      {
        colId: 'arrivedAt',
        field: 'arrivedAt',
        headerName: 'Пришёл',
        width: 130,
        sort: 'desc',
        valueFormatter: (p) => arrivedLabel(p.value as string | null, tz),
      },
      {
        colId: 'arrivedBy',
        headerName: 'Отметил',
        width: 280,
        // Для поиска и сортировки - имя и ник; в ячейке ник ссылкой на Telegram.
        valueGetter: (p) => (p.data?.arrivedBy ? `${p.data.arrivedBy.name}${p.data.arrivedBy.username ? ` @${p.data.arrivedBy.username}` : ''}` : ''),
        cellRenderer: (p: { data?: Row }) =>
          p.data?.arrivedBy ? (
            <span className="sof-cell">
              <StaffName name={p.data.arrivedBy.name} username={p.data.arrivedBy.username} />
            </span>
          ) : null,
      },
      { colId: 'age', field: 'age', headerName: 'Возраст', width: 100, type: 'numericColumn' },
      { colId: 'city', field: 'city', headerName: 'Нас. пункт', flex: 1, minWidth: 130 },
      {
        colId: 'tier',
        headerName: 'Вариант',
        width: 200,
        valueGetter: (p) => {
          const cfg = p.data?.tier ? tiers[p.data.tier] : undefined;
          return cfg ? tierShort(cfg, p.data?.breakfast) : '';
        },
        cellRenderer: (p: { data?: Row }) =>
          p.data ? (
            <span className="sof-cell">
              <TierBadge tier={p.data.tier} tiers={tiers} breakfast={p.data.breakfast} />
            </span>
          ) : null,
      },
    ],
    [tz, tiers],
  );

  const onGridReady = useCallback((e: GridReadyEvent<Row>) => {
    apiRef.current = e.api;
  }, []);
  const onCellClicked = useCallback((e: CellClickedEvent<Row>) => e.data && openParticipant(e.data.id), [openParticipant]);

  const pct = total ? Math.round((confirmed.length / total) * 100) : 0;

  return (
    <Stack gap="md">
      <PageHeader
        title="Подтверждённые"
        description="Кто уже пришёл - отсканирован на входе. Новые появляются сверху, список обновляется сам каждые 10 секунд."
      />

      <Card>
        {participants.isPending ? (
          <Skeleton height={56} />
        ) : (
          <Stack gap="xs">
            <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
              <Text fz={mobile ? 24 : 32} fw={800} lh={1.1} className="sof-tabular">
                Подтверждено {formatNumber(confirmed.length)}{' '}
                <Text span inherit c="dimmed" fw={700} style={{ whiteSpace: 'nowrap' }}>
                  из {formatNumber(total)}
                </Text>
              </Text>
              <Text size="sm" c="dimmed">
                {formatPercent(confirmed.length, total)} · ещё ждём {formatNumber(Math.max(0, total - confirmed.length))}
              </Text>
            </Group>
            <Progress value={pct} size="lg" color="teal" radius="xl" />
          </Stack>
        )}
      </Card>

      <TextInput
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        placeholder="Найти: фамилия, имя, город"
        leftSection={<IconSearch size={16} />}
        rightSection={search ? <CloseButton size="sm" onClick={() => setSearch('')} aria-label="Очистить поиск" /> : null}
        maw={mobile ? undefined : 420}
        aria-label="Поиск среди подтверждённых"
      />

      {participants.isError && !participants.data ? (
        <ErrorState error={participants.error} onRetry={() => void participants.refetch()} />
      ) : !participants.isPending && shown.length === 0 ? (
        <Card>
          <EmptyBlock
            icon={<IconUserCheck size={28} />}
            title={q ? 'Никого не нашли' : 'Пока никто не пришёл'}
            description={q ? 'Проверьте написание.' : 'Как только волонтёры начнут сканировать QR-коды на входе, люди появятся здесь.'}
          />
        </Card>
      ) : mobile ? (
        <MobileList rows={shown} fresh={fresh} tz={tz} loading={participants.isPending} onOpen={openParticipant} />
      ) : (
        <DataGrid<Row>
          height="max(420px, calc(100dvh - 400px))"
          clickable
          rowData={participants.isPending ? undefined : shown}
          loading={participants.isPending}
          columnDefs={columnDefs}
          defaultColDef={DEFAULT_COL_DEF}
          getRowId={getRowId}
          onGridReady={onGridReady}
          onCellClicked={onCellClicked}
        />
      )}
      {!participants.isPending && q && shown.length > 0 && (
        <Text size="xs" c="dimmed">
          Нашлось: {countLabel(shown.length, ['человек', 'человека', 'человек'])}
        </Text>
      )}
    </Stack>
  );
}

/** Телефон: простой список - имя и время прихода, ниже возраст, город, категория. */
function MobileList({
  rows,
  fresh,
  tz,
  loading,
  onOpen,
}: {
  rows: Row[];
  fresh: ReadonlySet<number>;
  tz: string;
  loading: boolean;
  onOpen: (id: number) => void;
}) {
  const tiers = useTiers();
  if (loading) {
    return (
      <Stack gap={6}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={48} radius="md" />
        ))}
      </Stack>
    );
  }
  return (
    <Card padding={0}>
      {rows.map((r, i) => (
        <Fragment key={r.id}>
          {i > 0 && <Divider />}
          <UnstyledButton onClick={() => onOpen(r.id)} px="md" py="sm" w="100%" className={fresh.has(r.id) ? 'sof-fresh' : undefined}>
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} truncate>
                  {r.fullName}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {[r.age === null ? 'гость на месте' : countLabel(r.age, ['год', 'года', 'лет']), r.city].filter(Boolean).join(' · ')}
                </Text>
                <TierBadge tier={r.tier} tiers={tiers} breakfast={r.breakfast} size="xs" />
                {r.arrivedBy && (
                  <Text size="xs" c="dimmed" mt={2} style={{ whiteSpace: 'normal' }}>
                    Отметил: <StaffName name={r.arrivedBy.name} username={r.arrivedBy.username} size="xs" />
                  </Text>
                )}
              </div>
              <Text size="sm" fw={700} c="teal" className="sof-tabular" style={{ whiteSpace: 'nowrap' }}>
                {arrivedLabel(r.arrivedAt, tz)}
              </Text>
            </Group>
          </UnstyledButton>
        </Fragment>
      ))}
    </Card>
  );
}
