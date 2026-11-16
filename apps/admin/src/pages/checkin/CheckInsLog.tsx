import { Badge, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { AdminCheckInRow } from '@sof/shared';
import { IconSearch } from '@tabler/icons-react';
import type { ColDef, GetRowIdParams, RowClassRules } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { useMemo, useRef, useState } from 'react';
import { useCheckIns, useRevokeCheckIn } from '../../api/checkin.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { DataGrid } from '../../components/grid/DataGrid.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { useCan } from '../../components/SessionProvider.tsx';
import { ErrorState } from '../../components/states.tsx';
import { formatDateTime, formatNumber } from '../../lib/format.ts';
import { CHECKIN_METHOD_LABELS } from '../../lib/labels.ts';
import { notifySuccess } from '../../lib/notify.tsx';
import { StaffName } from '../../components/StaffName.tsx';

type Row = AdminCheckInRow;
type Cell = CustomCellRendererProps<Row>;

const getRowId = (p: GetRowIdParams<Row>) => String(p.data.id);
const DEFAULT_COL_DEF: ColDef<Row> = { sortable: true, resizable: true, filter: true };
const ROW_CLASS_RULES: RowClassRules<Row> = { 'sof-row-cancelled': (p) => !!p.data?.revokedAt };

function ParticipantCell({ data }: Cell) {
  return data ? <ParticipantLink id={data.participantId} name={data.fullName} /> : null;
}

function MethodCell({ data }: Cell) {
  if (!data) return null;
  return (
    <span className="sof-cell">
      <Text span size="sm">
        {CHECKIN_METHOD_LABELS[data.method] ?? data.method}
      </Text>
      {data.offline && (
        <Tooltip label="Отметка сделана без интернета и загружена позже">
          <Badge size="xs" color="gray" variant="outline">
            офлайн
          </Badge>
        </Tooltip>
      )}
    </span>
  );
}

export function CheckInsLog({ checkpointId, live }: { checkpointId: number | null; live: boolean }) {
  const tz = useEventTz();
  const can = useCan();
  const confirm = useConfirm();
  const checkIns = useCheckIns(checkpointId, { live });
  const revoke = useRevokeCheckIn();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 200);
  const canRevoke = can('checkin:revoke');

  const rows = checkIns.data;
  const stats = useMemo(() => {
    const list = rows ?? [];
    const activeRows = list.filter((r) => !r.revokedAt);
    return {
      total: list.length,
      active: activeRows.length,
      revoked: list.length - activeRows.length,
      people: new Set(activeRows.map((r) => r.participantId)).size,
    };
  }, [rows]);

  const doRevoke = async (row: Row) => {
    const ok = await confirm({
      title: 'Отменить отметку?',
      message: `${row.fullName} - «${row.checkpointName}», ${formatDateTime(row.at, tz)}. Если это вход, участник снова будет считаться «не пришёл».`,
      confirmLabel: 'Отменить отметку',
      danger: true,
    });
    if (ok) revoke.mutate(row.id, { onSuccess: () => notifySuccess('Отметка отменена', row.fullName) });
  };
  // Колонки мемоизированы - берём свежий обработчик через ref.
  const doRevokeRef = useRef(doRevoke);
  doRevokeRef.current = doRevoke;

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: 'at',
        field: 'at',
        headerName: 'Время',
        width: 165,
        sort: 'desc',
        cellDataType: false,
        valueFormatter: (p) => formatDateTime(p.value as string, tz),
        getQuickFilterText: () => '',
      },
      { colId: 'fullName', field: 'fullName', headerName: 'Участник', flex: 1, minWidth: 220, cellRenderer: ParticipantCell, cellDataType: 'text' },
      { colId: 'checkpointName', field: 'checkpointName', headerName: 'Точка', width: 190, cellDataType: 'text' },
      {
        colId: 'byName',
        field: 'byName',
        headerName: 'Кто отметил',
        width: 230,
        cellDataType: 'text',
        cellRenderer: (p: { data?: AdminCheckInRow }) => (p.data ? <StaffName name={p.data.byName} username={p.data.byUsername} /> : null),
      },
      {
        colId: 'method',
        headerName: 'Способ',
        width: 170,
        valueGetter: (p) => (p.data ? CHECKIN_METHOD_LABELS[p.data.method] : ''),
        cellRenderer: MethodCell,
        cellDataType: 'text',
      },
      { colId: 'deviceId', field: 'deviceId', headerName: 'Устройство', width: 150, cellClass: 'sof-mono', hide: true, cellDataType: 'text' },
      {
        colId: 'state',
        headerName: 'Статус',
        width: 190,
        sortable: false,
        filter: false,
        valueGetter: (p) => (p.data?.revokedAt ? 'отменена' : 'действует'),
        cellRenderer: ({ data }: Cell) => {
          if (!data) return null;
          if (data.revokedAt) {
            return (
              <Tooltip label={`Отменена ${formatDateTime(data.revokedAt, tz)}`}>
                <Badge color="gray" size="sm">
                  отменена
                </Badge>
              </Tooltip>
            );
          }
          return canRevoke ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              c="red.6"
              onClick={(e) => {
                e.stopPropagation();
                void doRevokeRef.current(data);
              }}
            >
              Отменить отметку
            </Button>
          ) : (
            <Badge color="green" size="sm" variant="light">
              действует
            </Badge>
          );
        },
      },
    ],
    [tz, canRevoke],
  );

  return (
    <Stack gap="sm">
      {checkIns.isError && <ErrorState error={checkIns.error} onRetry={() => void checkIns.refetch()} />}
      <Group justify="space-between" gap="sm" wrap="wrap">
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Поиск по ФИО, точке, сканеру"
          leftSection={<IconSearch size={16} />}
          w={360}
          maw="100%"
          aria-label="Поиск по отметкам"
        />
        <Text size="sm" c="dimmed">
          Отметок: <b>{formatNumber(stats.active)}</b> действующих ({formatNumber(stats.people)} чел.)
          {stats.revoked ? ` · ${formatNumber(stats.revoked)} отменено` : ''}
          {stats.total >= 2000 ? ' · показаны последние 2000' : ''}
        </Text>
      </Group>
      <DataGrid<Row>
        height="max(420px, calc(100dvh - 400px))"
        rowData={rows}
        loading={checkIns.isPending}
        loadingRows
        columnDefs={columnDefs}
        defaultColDef={DEFAULT_COL_DEF}
        getRowId={getRowId}
        quickFilterText={q}
        rowClassRules={ROW_CLASS_RULES}
      />
    </Stack>
  );
}
