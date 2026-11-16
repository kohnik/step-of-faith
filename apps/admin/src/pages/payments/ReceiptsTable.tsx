import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import type { ReceiptView } from '@sof/shared';
import { IconFileSpreadsheet } from '@tabler/icons-react';
import type { ColDef, GridApi, IDateFilterParams, RowClickedEvent, RowSelectionOptions } from 'ag-grid-community';
import { useCallback, useMemo, useState } from 'react';
import { downloadFile } from '../../api/client.ts';
import { DataGrid, isTextSelectionClick } from '../../components/grid/DataGrid.tsx';
import { countLabel, formatDateTime, formatMoney } from '../../lib/format.ts';
import { RECEIPT_KIND_LABELS } from '../../lib/labels.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { dayKey, localDateKey, todayKey } from '../../lib/tz.ts';

type Row = ReceiptView;

const STATUS: Record<Row['status'], { label: string; color: string }> = {
  pending: { label: 'На проверке', color: 'yellow' },
  accepted: { label: 'Принят', color: 'green' },
  rejected: { label: 'Отклонён', color: 'red' },
};

const RECEIPTS: [string, string, string] = ['чек', 'чека', 'чеков'];

const ROW_SELECTION: RowSelectionOptions<Row> = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  selectAll: 'filtered',
  enableClickSelection: false,
};
const DEFAULT_COL_DEF: ColDef<Row> = { sortable: true, resizable: true, filter: true, floatingFilter: true, minWidth: 70 };
const getRowId = (p: { data: Row }) => String(p.data.id);
const amountOf = (r: Row): number | null => (r.amount == null ? null : Number(r.amount));

function buildColumns(tz: string): ColDef<Row>[] {
  // Фильтр «Прислан» - по дню по часам конференции.
  const dayComparator: IDateFilterParams['comparator'] = (filterDate, cellValue) => {
    if (typeof cellValue !== 'string' || !cellValue) return -1;
    const cell = dayKey(cellValue, tz);
    const filter = localDateKey(filterDate);
    return cell < filter ? -1 : cell > filter ? 1 : 0;
  };
  return [
    { colId: 'id', field: 'id', headerName: '№', width: 90, filter: 'agNumberColumnFilter', type: 'numericColumn' },
    {
      colId: 'kind',
      headerName: 'Вид',
      width: 140,
      valueGetter: (p) => (p.data ? `${RECEIPT_KIND_LABELS[p.data.kind]}${p.data.merchOrder ? ` ${p.data.merchOrder.code}` : ''}` : ''),
      filter: 'agTextColumnFilter',
    },
    {
      colId: 'amount',
      headerName: 'Сумма',
      width: 120,
      valueGetter: (p) => (p.data ? amountOf(p.data) : null),
      valueFormatter: (p) => formatMoney(p.value as number | null),
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
    },
    {
      colId: 'createdAt',
      field: 'createdAt',
      headerName: 'Прислан',
      width: 165,
      valueFormatter: (p) => formatDateTime(p.value as string, tz),
      // Иначе грид сам видит в ISO-строке «дату со временем»: просит в фильтре время и сравнивает до секунды.
      cellDataType: false,
      filter: 'agDateColumnFilter',
      filterParams: { comparator: dayComparator, buttons: ['reset'], maxNumConditions: 1, browserDatePicker: true } satisfies IDateFilterParams,
    },
    { colId: 'userName', field: 'userName', headerName: 'Кто прислал', width: 190, filter: 'agTextColumnFilter' },
    {
      colId: 'status',
      headerName: 'Статус',
      width: 140,
      valueGetter: (p) => (p.data ? STATUS[p.data.status].label : ''),
      cellRenderer: (p: { data?: Row }) =>
        p.data ? (
          <Badge color={STATUS[p.data.status].color} variant="light" size="sm">
            {STATUS[p.data.status].label}
          </Badge>
        ) : null,
      filter: 'agTextColumnFilter',
    },
    {
      colId: 'people',
      headerName: 'За кого',
      width: 240,
      valueGetter: (p) => p.data?.participants.map((x) => x.fullName).join(', ') ?? '',
      filter: 'agTextColumnFilter',
    },
    { colId: 'paymentRef', field: 'paymentRef', headerName: 'Код оплаты', width: 120, filter: 'agTextColumnFilter' },
    { colId: 'comment', field: 'comment', headerName: 'Комментарий', width: 200, filter: 'agTextColumnFilter' },
    { colId: 'reviewerName', field: 'reviewerName', headerName: 'Проверил', width: 160, filter: 'agTextColumnFilter' },
  ];
}

/**
 * «10 руб. × 15 чел. = 150 руб.» - по сумме чека, по возрастанию. Отклонённые в итог не идут (деньги не приняты),
 * чеки без суммы - отдельной строкой.
 */
function summarize(rows: Row[]) {
  const byAmount = new Map<number, number>();
  let unknown = 0;
  let rejected = 0;
  for (const r of rows) {
    if (r.status === 'rejected') {
      rejected += 1;
      continue;
    }
    const a = amountOf(r);
    if (a == null) unknown += 1;
    else byAmount.set(a, (byAmount.get(a) ?? 0) + 1);
  }
  const lines = [...byAmount.entries()].sort((x, y) => x[0] - y[0]).map(([amount, n]) => ({ amount, n, sum: amount * n }));
  return { lines, unknown, rejected, total: lines.reduce((s, l) => s + l.sum, 0) };
}

/**
 * Чеки строками: фильтры под заголовками, галочки, сводка «сумма × сколько» и выгрузка в Excel.
 * Сводка и выгрузка - по отмеченным галочкой, а если ничего не отмечено - по всему, что осталось после фильтров.
 */
export function ReceiptsTable({ rows, tz, onOpen }: { rows: Row[]; tz: string; onOpen: (r: Row) => void }) {
  const columnDefs = useMemo(() => buildColumns(tz), [tz]);
  const [shown, setShown] = useState<{ rows: Row[]; selected: boolean }>({ rows, selected: false });
  const [exporting, setExporting] = useState(false);

  const recount = useCallback((api: GridApi<Row>) => {
    const selected = api.getSelectedRows();
    if (selected.length) {
      setShown({ rows: selected, selected: true });
      return;
    }
    const visible: Row[] = [];
    api.forEachNodeAfterFilterAndSort((n) => n.data && visible.push(n.data));
    setShown({ rows: visible, selected: false });
  }, []);

  const summary = useMemo(() => summarize(shown.rows), [shown.rows]);

  const onRowClicked = useCallback(
    (e: RowClickedEvent<Row>) => {
      const target = e.event?.target as HTMLElement | null;
      // Галочка выбора - не открытие карточки.
      if (!e.data || isTextSelectionClick() || target?.closest('.ag-selection-checkbox, .ag-checkbox-input-wrapper')) return;
      onOpen(e.data);
    },
    [onOpen],
  );

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const ids = shown.rows.map((r) => r.id).join(',');
      await downloadFile(`/api/admin/receipts/export.xlsx?ids=${ids}`, `receipts-${todayKey(tz)}.xlsx`);
      notifySuccess('Файл Excel скачивается');
    } catch (err) {
      notifyError(err, 'Не получилось выгрузить');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Stack gap="md">
      <Card padding="md">
        <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
          <Stack gap={2}>
            <Text fw={600}>
              Переводы - {shown.selected ? 'по отмеченным' : 'по отобранным'}: {countLabel(shown.rows.length, RECEIPTS)}
            </Text>
            {summary.lines.map((l) => (
              <Text key={l.amount} size="sm" ff="monospace">
                {formatMoney(l.amount)} × {l.n} чел. = {formatMoney(l.sum)}
              </Text>
            ))}
            {summary.unknown > 0 && (
              <Text size="sm" c="dimmed">
                Без суммы: {countLabel(summary.unknown, RECEIPTS)}
              </Text>
            )}
            {summary.rejected > 0 && (
              <Text size="sm" c="dimmed">
                Отклонённые в итог не входят: {countLabel(summary.rejected, RECEIPTS)}
              </Text>
            )}
            <Text fw={700} mt={4}>
              Итого: {formatMoney(summary.total)}
            </Text>
          </Stack>
          <Stack gap={4} align="flex-end">
            <Button
              leftSection={<IconFileSpreadsheet size={16} />}
              variant="default"
              loading={exporting}
              disabled={shown.rows.length === 0}
              onClick={() => void exportXlsx()}
            >
              Выгрузить в Excel ({shown.rows.length})
            </Button>
            <Text size="xs" c="dimmed" ta="right" maw={260}>
              {shown.selected ? 'Только отмеченные галочкой' : 'Всё, что осталось после фильтров. Отметьте галочками, чтобы выгрузить часть'}
            </Text>
          </Stack>
        </Group>
      </Card>

      <DataGrid<Row>
        height={600}
        clickable
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={DEFAULT_COL_DEF}
        getRowId={getRowId}
        rowSelection={ROW_SELECTION}
        rowHeight={38}
        onRowClicked={onRowClicked}
        onGridReady={(e) => recount(e.api)}
        onRowDataUpdated={(e) => recount(e.api)}
        onFilterChanged={(e) => recount(e.api)}
        onSelectionChanged={(e) => recount(e.api)}
      />
    </Stack>
  );
}
