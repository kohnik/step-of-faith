import { Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ScanLogRow } from '@sof/shared';
import { IconFilter, IconSearch } from '@tabler/icons-react';
import type { ColDef, GetRowIdParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { useScanLog } from '../../api/checkin.ts';
import { OutcomeBadge } from '../../components/badges.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { DataGrid } from '../../components/grid/DataGrid.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { usePaymentsEnabled } from '../../components/SessionProvider.tsx';
import { ErrorState } from '../../components/states.tsx';
import { formatDateTime, formatNumber } from '../../lib/format.ts';
import { SCAN_OUTCOME_LABELS, scanOutcomeLabel } from '../../lib/labels.ts';
import { readStored, writeStored } from '../../lib/storage.ts';
import { StaffName } from '../../components/StaffName.tsx';

type Row = ScanLogRow;
type Cell = CustomCellRendererProps<Row>;

const getRowId = (p: GetRowIdParams<Row>) => String(p.data.id);
const DEFAULT_COL_DEF: ColDef<Row> = { sortable: true, resizable: true, filter: true };

/** Порядок в фильтре: сначала «проблемные» исходы. */
const OUTCOME_ORDER = [
  'duplicate',
  'invalid_code',
  'unknown_code',
  'revoked_ticket',
  'unpaid',
  'cancelled_participant',
  'not_found',
  'forbidden',
  'checkpoint_inactive',
  'before_event',
  'new',
  'retry',
  'event_id_reused',
];

const OUTCOME_OPTIONS = [
  { value: '', label: 'Все исходы' },
  ...OUTCOME_ORDER.filter((o) => o in SCAN_OUTCOME_LABELS).map((o) => ({ value: o, label: SCAN_OUTCOME_LABELS[o] ?? o })),
];

function OutcomeCell({ data }: Cell) {
  return data ? <OutcomeBadge outcome={data.outcome} /> : null;
}

function WhoCell({ data }: Cell) {
  if (!data) return null;
  if (data.fullName) return <ParticipantLink id={data.participantId} name={data.fullName} />;
  return (
    <Text span size="sm" c="dimmed">
      -
    </Text>
  );
}

export function ScanLog({ live }: { live: boolean }) {
  const tz = useEventTz();
  const paymentsEnabled = usePaymentsEnabled();
  // «Не оплачено» бывает, только когда включён приём оплаты.
  const outcomeOptions = paymentsEnabled ? OUTCOME_OPTIONS : OUTCOME_OPTIONS.filter((o) => o.value !== 'unpaid');
  const [outcome, setOutcomeState] = useState<string>(() => {
    const stored = readStored<unknown>('checkin.scanOutcome', '');
    return typeof stored === 'string' && OUTCOME_OPTIONS.some((o) => o.value === stored) ? stored : '';
  });
  const scanLog = useScanLog(outcome || null, { live });
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 200);

  const setOutcome = (value: string) => {
    setOutcomeState(value);
    writeStored('checkin.scanOutcome', value);
  };

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: 'createdAt',
        field: 'createdAt',
        headerName: 'Время',
        width: 165,
        sort: 'desc',
        cellDataType: false,
        valueFormatter: (p) => formatDateTime(p.value as string, tz),
        getQuickFilterText: () => '',
      },
      {
        colId: 'outcome',
        headerName: 'Результат',
        width: 190,
        valueGetter: (p) => (p.data ? scanOutcomeLabel(p.data.outcome) : ''),
        cellRenderer: OutcomeCell,
        cellDataType: 'text',
      },
      { colId: 'fullName', field: 'fullName', headerName: 'Участник', flex: 1, minWidth: 200, cellRenderer: WhoCell, cellDataType: 'text' },
      { colId: 'rawCode', field: 'rawCode', headerName: 'Код', width: 190, cellClass: 'sof-mono', cellDataType: 'text' },
      { colId: 'checkpointName', field: 'checkpointName', headerName: 'Точка', width: 180, cellDataType: 'text' },
      {
        colId: 'staffName',
        field: 'staffName',
        headerName: 'Сканер',
        width: 230,
        cellDataType: 'text',
        cellRenderer: (p: { data?: ScanLogRow }) => (p.data ? <StaffName name={p.data.staffName} username={p.data.staffUsername} /> : null),
      },
      { colId: 'deviceId', field: 'deviceId', headerName: 'Устройство', width: 150, cellClass: 'sof-mono', cellDataType: 'text' },
    ],
    [tz],
  );

  const count = scanLog.data?.length ?? 0;

  return (
    <Stack gap="sm">
      {scanLog.isError && <ErrorState error={scanLog.error} onRetry={() => void scanLog.refetch()} />}
      <Group justify="space-between" gap="sm" wrap="wrap" align="flex-end">
        <Group gap="sm" wrap="wrap" align="flex-end">
          <Select
            label="Исход"
            data={outcomeOptions}
            value={outcome}
            onChange={(v) => setOutcome(v ?? '')}
            allowDeselect={false}
            w={240}
            leftSection={<IconFilter size={16} />}
          />
          <TextInput
            label="Поиск"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="ФИО, код, точка, сканер"
            leftSection={<IconSearch size={16} />}
            w={300}
            maw="100%"
          />
        </Group>
        <Text size="sm" c="dimmed">
          Записей: <b>{formatNumber(count)}</b>
          {count >= 1000 ? ' (последние 1000)' : ''}
        </Text>
      </Group>
      <DataGrid<Row>
        height="max(420px, calc(100dvh - 420px))"
        rowData={scanLog.data}
        loading={scanLog.isPending}
        loadingRows
        columnDefs={columnDefs}
        defaultColDef={DEFAULT_COL_DEF}
        getRowId={getRowId}
        quickFilterText={q}
      />
    </Stack>
  );
}
