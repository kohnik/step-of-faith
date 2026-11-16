import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  CloseButton,
  Divider,
  Group,
  Kbd,
  Menu,
  MultiSelect,
  Popover,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure, useHotkeys } from '@mantine/hooks';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  PAYMENT_STATUSES,
  TIERS,
  REG_PAYMENT_METHODS,
  type AdminParticipantRow,
  type Category,
  type PaymentStatus,
  type Tier,
} from '@sof/shared';
import {
  IconCash,
  IconChevronDown,
  IconColumns3,
  IconDownload,
  IconFilterOff,
  IconListCheck,
  IconPlaylistAdd,
  IconPlaylistX,
  IconPlus,
  IconSearch,
  IconTag,
  IconUserPlus,
  IconX,
} from '@tabler/icons-react';
import type {
  CellClickedEvent,
  CellKeyDownEvent,
  ColDef,
  ColumnResizedEvent,
  ColumnState,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  IRowNode,
  ModelUpdatedEvent,
  RowClassRules,
  RowSelectionOptions,
  SelectionChangedEvent,
  SelectionColumnDef,
} from 'ag-grid-community';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLocation, useSearch } from 'wouter';
import { downloadFile } from '../../api/client.ts';
import { useCreateList, useListMembers, useParticipantLists } from '../../api/lists.ts';
import { useBulkParticipants, useParticipants } from '../../api/participants.ts';
import { AppLink } from '../../components/AppLink.tsx';
import { AppModal, ModalActions, useIsMobile } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { DataGrid, isTextSelectionClick, SELECTION_COLUMN_ID } from '../../components/grid/DataGrid.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { useSession, useTiers } from '../../components/SessionProvider.tsx';
import { ErrorState } from '../../components/states.tsx';
import { countLabel, formatNumber } from '../../lib/format.ts';
import { CATEGORY_OPTIONS, PAYMENT_STATUS_OPTIONS } from '../../lib/labels.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { BULK_PAYMENT } from '../../lib/permissions.ts';
import { readStored, removeStored, writeStored } from '../../lib/storage.ts';
import { todayKey } from '../../lib/tz.ts';
import { FRESH_MS, useFreshIds } from '../../lib/useFreshIds.ts';
import { buildColumns, cancelledPaid } from './columns.tsx';
import { CreateParticipantModal } from './CreateParticipantModal.tsx';

type Row = AdminParticipantRow;

interface Filters {
  payment: PaymentStatus[];
  categories: Category[];
  /** Вариант участия (взнос); 'none' - старые записи без варианта. */
  tiers: (Tier | 'none')[];
  /** Как собирается платить - для сверки переводов по выписке. */
  methods: ('transfer' | 'cash' | 'none')[];
  under16Only: boolean;
  /** Отменённых прячем: по умолчанию в таблице только те, кто едет. Кто пришёл - на странице «Подтверждённые». */
  showCancelled: boolean;
  dupOnly: boolean;
  /** Отменили регистрацию, но взнос уже внесли - для сверки и возможного возврата. */
  cancelledPaidOnly: boolean;
  /** Отметили в анкете, что готовы оплатить регистрацию за того, у кого нет возможности. */
  sponsorOnly: boolean;
  /** Только с завтраком - сколько завтраков и у кого. */
  breakfastOnly: boolean;
  /** Гости, записавшиеся на месте (короткая форма). */
  onSiteOnly: boolean;
}

const DEFAULT_FILTERS: Filters = {
  payment: [],
  categories: [],
  tiers: [],
  methods: [],
  under16Only: false,
  showCancelled: false,
  dupOnly: false,
  cancelledPaidOnly: false,
  sponsorOnly: false,
  breakfastOnly: false,
  onSiteOnly: false,
};
const FILTERS_KEY = 'participants.filters.v2';
// v2: ФИО стала уже - старые сохранённые ширины сбрасываем.
const COLUMNS_KEY = 'participants.columns.v3';

const PEOPLE: [string, string, string] = ['участник', 'участника', 'участников'];

// Настройки грида - константы: часть опций AG Grid читает только при создании.
const getRowId = (p: GetRowIdParams<Row>) => String(p.data.id);
const ROW_SELECTION: RowSelectionOptions<Row> = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  selectAll: 'filtered',
  enableClickSelection: false,
};
const SELECTION_COLUMN: SelectionColumnDef = { pinned: 'left', width: 48, suppressSizeToFit: true };
const SELECTION_COLUMN_MOBILE: SelectionColumnDef = { width: 44, suppressSizeToFit: true };
const DEFAULT_COL_DEF: ColDef<Row> = { sortable: true, resizable: true, filter: true, minWidth: 70 };
const ROW_CLASS_RULES: RowClassRules<Row> = { 'sof-row-cancelled': (p) => p.data?.status === 'cancelled' };
const isExternalFilterPresent = () => true;

/**
 * Сохранённый вид таблицы появился до новых колонок (например, «Завтрак»): ставим новую колонку туда же,
 * где она стоит по умолчанию (после соседа слева), а не в самый конец.
 */
function withNewColumns(saved: ColumnState[], defaults: ColumnState[]): ColumnState[] {
  const out = [...saved];
  const known = new Set(saved.map((c) => c.colId));
  defaults.forEach((col, i) => {
    if (known.has(col.colId)) return;
    const prev = defaults.slice(0, i).reverse().find((c) => known.has(c.colId));
    const at = prev ? out.findIndex((c) => c.colId === prev.colId) + 1 : 0;
    out.splice(at, 0, col);
    known.add(col.colId);
  });
  return out;
}

/** Списки: показать только список; при добавлении в список - спрятать тех, кто уже в нём. */
interface ListView {
  only: number | null;
  hideIn: number | null;
}

function passes(f: Filters, r: Row, payments: boolean, lists: ListView): boolean {
  if (lists.only !== null && !r.lists.includes(lists.only)) return false;
  if (lists.hideIn !== null && r.lists.includes(lists.hideIn)) return false;
  if (f.cancelledPaidOnly) return cancelledPaid(r);
  if (!f.showCancelled && r.status !== 'active') return false;
  // Фильтр по оплате работает, только когда приём оплаты включён (иначе он невидим).
  if (payments && f.payment.length && !f.payment.includes(r.paymentStatus)) return false;
  if (f.categories.length && !f.categories.includes(r.category)) return false;
  if (f.tiers.length && !f.tiers.includes(r.tier ?? 'none')) return false;
  if (payments && f.methods.length && !f.methods.includes(r.paymentMethod ?? 'none')) return false;
  if (f.under16Only && !r.under16) return false;
  if (f.dupOnly && !r.possibleDuplicate) return false;
  if (payments && f.sponsorOnly && !r.sponsorOffer) return false;
  if (f.breakfastOnly && !r.breakfast) return false;
  if (f.onSiteOnly && !r.onSite) return false;
  return true;
}

/** Фильтры из браузера - с проверкой: там может лежать что угодно от старых версий. */
function loadFilters(): Filters {
  const s = readStored<Partial<Record<keyof Filters, unknown>>>(FILTERS_KEY, {});
  const list = <T extends string>(value: unknown, allowed: readonly T[]): T[] =>
    Array.isArray(value) ? value.filter((v): v is T => allowed.includes(v as T)) : [];
  return {
    payment: list(s.payment, PAYMENT_STATUSES),
    categories: list(s.categories, CATEGORIES),
    tiers: list(s.tiers, [...TIERS, 'none'] as const),
    methods: list(s.methods, [...REG_PAYMENT_METHODS, 'none'] as const),
    under16Only: s.under16Only === true,
    showCancelled: s.showCancelled === true,
    cancelledPaidOnly: s.cancelledPaidOnly === true,
    dupOnly: s.dupOnly === true,
    sponsorOnly: s.sponsorOnly === true,
    breakfastOnly: s.breakfastOnly === true,
    onSiteOnly: s.onSiteOnly === true,
  };
}

function isDefaultFilters(f: Filters, payments: boolean): boolean {
  return (
    (!payments || f.payment.length === 0) &&
    f.categories.length === 0 &&
    f.tiers.length === 0 &&
    (!payments || f.methods.length === 0) &&
    !f.under16Only &&
    !f.showCancelled &&
    !f.cancelledPaidOnly &&
    !f.dupOnly &&
    (!payments || !f.sponsorOnly) &&
    !f.breakfastOnly &&
    !f.onSiteOnly
  );
}

export default function ParticipantsPage() {
  const tz = useEventTz();
  const { can, paymentsEnabled } = useSession();
  const confirm = useConfirm();
  const { openParticipant } = useParticipantDrawer();
  // Список обновляется сам каждые 10 секунд; новые строки коротко подсвечиваются.
  const participants = useParticipants(true, { live: true });
  const bulk = useBulkParticipants();
  // На телефоне: без закреплённых колонок и без галочек выбора (массовые действия - на компьютере).
  const mobile = useIsMobile();
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const urlParams = new URLSearchParams(useSearch());
  const initialSearch = urlParams.get('q') ?? '';
  // Списки: ?list=ID - показать только этот список, ?add=ID - набираем людей в список галочками.
  const listOnly = Number(urlParams.get('list')) || null;
  const addTo = Number(urlParams.get('add')) || null;
  // Со сводки: «не подтверждены» → сразу список с фильтром по оплате, остальные фильтры сброшены.
  const urlPayment = urlParams.get('payment');

  // Открыли список («Кто в списке», набор людей) - показываем его целиком: запомненные фильтры и поиск не применяем.
  const listMode = listOnly ?? addTo;
  const [search, setSearch] = useState(listMode !== null ? '' : initialSearch);
  const [debouncedSearch] = useDebouncedValue(search, 200);
  const [filters, setFilters] = useState<Filters>(() => {
    if (listMode !== null) return DEFAULT_FILTERS;
    if (!urlPayment) return loadFilters();
    const payment = urlPayment.split(',').filter((v): v is PaymentStatus => (PAYMENT_STATUSES as readonly string[]).includes(v));
    return { ...DEFAULT_FILTERS, payment };
  });
  const [, navigate] = useLocation();
  // Фильтр со сводки применили - из адреса убираем, чтобы при обновлении страницы не сбрасывал выбранное вручную.
  useEffect(() => {
    if (urlPayment) navigate('/participants', { replace: true });
  }, []);
  const filtersRef = useRef(filters);
  const paymentsRef = useRef(paymentsEnabled);
  const canLists = can('participants:write');
  const lists = useParticipantLists();
  const members = useListMembers();
  const createList = useCreateList();
  const listNames = useMemo(() => new Map((lists.data ?? []).map((l) => [l.id, l.name])), [lists.data]);
  const addList = addTo !== null ? lists.data?.find((l) => l.id === addTo) : undefined;
  const onlyList = listOnly !== null ? lists.data?.find((l) => l.id === listOnly) : undefined;
  const [hideAdded, setHideAdded] = useState(true);
  const [newListOpened, newListHandlers] = useDisclosure(false);
  const [newListName, setNewListName] = useState('');
  const listViewRef = useRef<ListView>({ only: null, hideIn: null });
  const apiRef = useRef<GridApi<Row> | null>(null);
  const [selected, setSelected] = useState<Row[]>([]);
  const [displayed, setDisplayed] = useState(0);
  const [createOpened, createHandlers] = useDisclosure(false);
  const [categoryOpened, categoryHandlers] = useDisclosure(false);
  const [bulkCategory, setBulkCategory] = useState<Category | null>(null);
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  useHotkeys([
    ['mod+K', () => searchRef.current?.focus()],
    ['/', () => searchRef.current?.focus()],
  ]);

  const tiers = useTiers();
  const columnDefs = useMemo(
    () => buildColumns(tz, { payments: paymentsEnabled, mobile, tiers, listNames }),
    [tz, paymentsEnabled, mobile, tiers, listNames],
  );
  const rows = participants.data;
  const rowIds = useMemo(() => rows?.map((r) => r.id), [rows]);
  const fresh = useFreshIds(rowIds);
  useEffect(() => {
    const api = apiRef.current;
    if (!fresh.size || !api || api.isDestroyed()) return;
    const rowNodes = [...fresh].map((id) => api.getRowNode(String(id))).filter((n): n is IRowNode<Row> => !!n);
    if (rowNodes.length) api.flashCells({ rowNodes, flashDuration: FRESH_MS, fadeDuration: 800 });
  }, [fresh]);
  const total = rows?.length ?? 0;

  const summary = useMemo(() => {
    const list = rows ?? [];
    return {
      active: list.filter((r) => r.status === 'active').length,
      duplicates: list.filter((r) => r.possibleDuplicate).length,
      under16: list.filter((r) => r.under16 && r.status === 'active').length,
      cancelledPaid: list.filter(cancelledPaid).length,
      sponsors: list.filter((r) => r.sponsorOffer && r.status === 'active').length,
      onSite: list.filter((r) => r.onSite && r.status === 'active').length,
      breakfast: list.filter((r) => r.breakfast && r.status === 'active').length,
    };
  }, [rows]);

  // Внешние фильтры: храним в ref (колбэки грида не пересоздаются) и сохраняем в браузере.
  useEffect(() => {
    filtersRef.current = filters;
    paymentsRef.current = paymentsEnabled;
    writeStored(FILTERS_KEY, filters);
    apiRef.current?.onFilterChanged();
  }, [filters, paymentsEnabled]);

  // Переключились на другой список прямо на странице - тоже без старых фильтров.
  const prevListMode = useRef(listMode);
  useEffect(() => {
    if (listMode === prevListMode.current) return;
    prevListMode.current = listMode;
    if (listMode === null) return;
    setFilters(DEFAULT_FILTERS);
    setSearch('');
    apiRef.current?.setFilterModel(null);
  }, [listMode]);

  useEffect(() => {
    listViewRef.current = { only: listOnly, hideIn: addTo !== null && hideAdded ? addTo : null };
    apiRef.current?.onFilterChanged();
  }, [listOnly, addTo, hideAdded]);

  const saveColumns = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    // Вид таблицы запоминаем только на компьютере - на телефоне он свой, упрощённый.
    if (mobileRef.current) return;
    saveTimer.current = window.setTimeout(() => {
      const api = apiRef.current;
      if (api && !api.isDestroyed()) writeStored(COLUMNS_KEY, api.getColumnState());
    }, 300);
  }, []);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // Таблица пересоздаётся при смене телефон ↔ компьютер - выбранные строки сбрасываются.
  // На телефоне галочки - только когда набираем людей в список.
  const selectable = !mobile || addTo !== null;
  const addingRef = useRef(addTo !== null);
  addingRef.current = addTo !== null;
  useEffect(() => setSelected([]), [mobile, selectable]);

  const onGridReady = useCallback((e: GridReadyEvent<Row>) => {
    apiRef.current = e.api;
    removeStored('participants.columns.v1');
    if (mobileRef.current) return;
    const saved = readStored<ColumnState[] | null>(COLUMNS_KEY, null);
    if (saved?.length) e.api.applyColumnState({ state: withNewColumns(saved, e.api.getColumnState()), applyOrder: true });
  }, []);

  const resetView = () => {
    const api = apiRef.current;
    if (!api) return;
    api.resetColumnState();
    api.setFilterModel(null);
    removeStored(COLUMNS_KEY);
    setFilters(DEFAULT_FILTERS);
    setSearch('');
  };

  const doesExternalFilterPass = useCallback(
    (node: IRowNode<Row>) => !node.data || passes(filtersRef.current, node.data, paymentsRef.current, listViewRef.current),
    [],
  );
  const onModelUpdated = useCallback((e: ModelUpdatedEvent<Row>) => setDisplayed(e.api.getDisplayedRowCount()), []);
  const onSelectionChanged = useCallback((e: SelectionChangedEvent<Row>) => setSelected(e.api.getSelectedRows()), []);
  const onCellClicked = useCallback(
    (e: CellClickedEvent<Row>) => {
      if (!e.data || e.column.getColId() === SELECTION_COLUMN_ID || isTextSelectionClick()) return;
      // Набираем людей в список: нажатие по строке ставит или снимает галочку - с телефона так удобнее.
      if (addingRef.current) {
        e.node.setSelected(!e.node.isSelected());
        return;
      }
      openParticipant(e.data.id);
    },
    [openParticipant],
  );
  const onCellKeyDown = useCallback(
    (e: CellKeyDownEvent<Row>) => {
      const key = (e.event as KeyboardEvent | null | undefined)?.key;
      if (key === 'Enter' && e.data && e.column.getColId() !== SELECTION_COLUMN_ID) openParticipant(e.data.id);
    },
    [openParticipant],
  );
  const onColumnResized = useCallback(
    (e: ColumnResizedEvent<Row>) => {
      if (e.finished) saveColumns();
    },
    [saveColumns],
  );

  const runBulkPayment = async (action: 'mark_paid' | 'mark_unpaid') => {
    const ids = selected.map((r) => r.id);
    const who = countLabel(ids.length, PEOPLE);
    const ok = await confirm(
      action === 'mark_paid'
        ? {
            title: 'Отметить оплату?',
            message: `${who} - отметим как «Оплачено». Если нужно указать сумму, её можно поправить в карточке участника. «Без взноса» и «чек на проверке» не меняются - чеки принимают во вкладке «Чеки».`,
            confirmLabel: 'Да, оплачено',
          }
        : {
            title: 'Снять отметку об оплате?',
            message: `${who} - вернём статус «Не оплачено» и сотрём внесённую сумму и дату оплаты. Пригодится, если оплату отметили по ошибке. «Без взноса» и «чек на проверке» не меняются.`,
            confirmLabel: 'Снять оплату',
            danger: true,
          },
    );
    if (!ok) return;
    bulk.mutate(
      { action, ids },
      {
        onSuccess: (res) => {
          const skipped = ids.length - res.updated;
          notifySuccess(`Готово: ${countLabel(res.updated, PEOPLE)}${skipped > 0 ? ` · не изменились: ${skipped}` : ''}`);
          apiRef.current?.deselectAll();
        },
      },
    );
  };

  const runBulkCategory = () => {
    if (!bulkCategory) return;
    const ids = selected.map((r) => r.id);
    bulk.mutate(
      { action: 'set_category', ids, category: bulkCategory },
      {
        onSuccess: (res) => {
          notifySuccess(`Категория «${CATEGORY_LABELS[bulkCategory]}»: ${countLabel(res.updated, PEOPLE)}`);
          categoryHandlers.close();
          setBulkCategory(null);
          apiRef.current?.deselectAll();
        },
      },
    );
  };

  const exportXlsx = async () => {
    setExporting(true);
    try {
      await downloadFile('/api/admin/participants/export.xlsx', `participants-${todayKey(tz)}.xlsx`);
      notifySuccess('Файл Excel скачивается');
    } catch (err) {
      notifyError(err, 'Не получилось выгрузить');
    } finally {
      setExporting(false);
    }
  };

  const addToList = (listId: number, name: string) => {
    const ids = selected.map((r) => r.id);
    members.mutate(
      { id: listId, ids },
      {
        onSuccess: (res) => {
          const added = res.added ?? 0;
          notifySuccess(
            added === ids.length
              ? `В список «${name}»: ${countLabel(added, PEOPLE)}`
              : `В список «${name}»: ${countLabel(added, PEOPLE)} · уже были в нём: ${formatNumber(ids.length - added)}`,
          );
          apiRef.current?.deselectAll();
        },
        onError: (err) => notifyError(err),
      },
    );
  };

  const removeFromList = async (listId: number, name: string) => {
    const ids = selected.map((r) => r.id);
    const ok = await confirm({
      title: 'Убрать из списка?',
      message: `${countLabel(ids.length, PEOPLE)} уберём из списка «${name}». Сами участники останутся в базе.`,
      confirmLabel: 'Убрать',
      danger: true,
    });
    if (!ok) return;
    members.mutate(
      { id: listId, ids, remove: true },
      {
        onSuccess: (res) => {
          notifySuccess(`Убрали из «${name}»: ${countLabel(res.removed ?? 0, PEOPLE)}`);
          apiRef.current?.deselectAll();
        },
        onError: (err) => notifyError(err),
      },
    );
  };

  const createAndAdd = () => {
    const name = newListName.trim();
    if (!name) return;
    createList.mutate(name, {
      onSuccess: (list) => {
        newListHandlers.close();
        setNewListName('');
        addToList(list.id, list.name);
      },
      onError: (err) => notifyError(err),
    });
  };

  const setListOnly = (id: number | null) => navigate(id ? `/participants?list=${id}` : '/participants', { replace: true });

  // Сколько людей из открытого списка видно без фильтров - чтобы подсказать, если фильтры часть скрыли.
  const listShown = useMemo(
    () => (listOnly === null ? 0 : (rows ?? []).filter((r) => r.lists.includes(listOnly) && (r.status === 'active' || filters.showCancelled)).length),
    [rows, listOnly, filters.showCancelled],
  );
  const showWholeList = () => {
    setFilters(DEFAULT_FILTERS);
    setSearch('');
    apiRef.current?.setFilterModel(null);
  };

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const canBulkPayment = paymentsEnabled && can(...BULK_PAYMENT);
  const canBulkCategory = can('participants:write');

  return (
    <Stack gap="md">
      <PageHeader
        title="Участники"
        description={
          rows
            ? `Сейчас ${countLabel(summary.active, ['участник', 'участника', 'участников'])}${total - summary.active ? `, ещё ${formatNumber(total - summary.active)} отменили участие` : ''}. Нажмите на строку, чтобы открыть карточку человека.`
            : 'Все, кто зарегистрировался. Нажмите на строку, чтобы открыть карточку человека.'
        }
        actions={
          <>
            <ColumnsMenu apiRef={apiRef} onReset={resetView} />
            {can('export') && (
              <Tooltip label="Выгрузим всю базу целиком - фильтры таблицы не учитываются">
                <Button variant="default" leftSection={<IconDownload size={16} />} loading={exporting} onClick={() => void exportXlsx()}>
                  Экспорт в Excel
                </Button>
              </Tooltip>
            )}
            {can('participants:write') && (
              <Button leftSection={<IconUserPlus size={16} />} onClick={createHandlers.open}>
                Добавить участника
              </Button>
            )}
          </>
        }
      />

      {addTo !== null && (
        <Alert color="indigo" variant="light" icon={<IconListCheck size={18} />} title={addList ? `Добавляем в список «${addList.name}»` : 'Добавляем в список'}>
          <Stack gap="xs">
            <Text size="sm">
              Найдите людей поиском и фильтрами, отметьте галочками (или просто нажмите на строку) и нажмите «Добавить в список».
              {addList ? ` Сейчас в списке: ${countLabel(addList.count, PEOPLE)}.` : ''}
            </Text>
            <Group gap="sm" wrap="wrap">
              <Button
                leftSection={<IconPlaylistAdd size={16} />}
                disabled={!addList || selected.length === 0}
                loading={members.isPending}
                onClick={() => addList && addToList(addList.id, addList.name)}
              >
                Добавить в список{selected.length ? ` (${formatNumber(selected.length)})` : ''}
              </Button>
              <Chip size="sm" checked={hideAdded} onChange={setHideAdded}>
                Скрыть тех, кто уже в списке
              </Chip>
              <Button variant="default" ml="auto" onClick={() => navigate('/participants/lists')}>
                Готово
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {participants.isError && <ErrorState error={participants.error} onRetry={() => void participants.refetch()} />}

      <Card padding="md">
        <Stack gap="sm">
          <Group gap="sm" wrap="wrap" align="center">
            <TextInput
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder={
                paymentsEnabled
                  ? 'Поиск: ФИО, телефон, город, QR-код, код оплаты, @username'
                  : 'Поиск: ФИО, телефон, город, QR-код, @username'
              }
              aria-label="Поиск по базе"
              leftSection={<IconSearch size={16} />}
              rightSection={
                search ? (
                  <CloseButton size="sm" onClick={() => setSearch('')} aria-label="Очистить поиск" />
                ) : (
                  <Kbd size="xs">/</Kbd>
                )
              }
              style={{ flex: '1 1 340px' }}
            />
            {paymentsEnabled && (
              <MultiSelect
                data={PAYMENT_STATUS_OPTIONS}
                value={filters.payment}
                onChange={(v) => setFilter('payment', v)}
                placeholder={filters.payment.length ? undefined : 'Оплата: любая'}
                aria-label="Фильтр по оплате"
                clearable
                w={230}
                maxDropdownHeight={260}
              />
            )}
            {paymentsEnabled && (
              <MultiSelect
                data={[
                  { value: 'transfer', label: 'Переводом' },
                  { value: 'cash', label: 'Наличными' },
                  { value: 'none', label: 'Не выбрано' },
                ]}
                value={filters.methods}
                onChange={(v) => setFilter('methods', v as Filters['methods'])}
                placeholder={filters.methods.length ? undefined : 'Как платит: любой'}
                aria-label="Фильтр по способу оплаты"
                clearable
                w={220}
              />
            )}
            <MultiSelect
              data={[...TIERS.map((t) => ({ value: t, label: tiers[t].short })), { value: 'none', label: 'Без варианта' }]}
              value={filters.tiers}
              onChange={(v) => setFilter('tiers', v as Filters['tiers'])}
              placeholder={filters.tiers.length ? undefined : 'Вариант: любой'}
              aria-label="Фильтр по варианту участия"
              clearable
              w={260}
              maxDropdownHeight={260}
            />
            <MultiSelect
              data={CATEGORY_OPTIONS}
              value={filters.categories}
              onChange={(v) => setFilter('categories', v)}
              placeholder={filters.categories.length ? undefined : 'Категория: любая'}
              aria-label="Фильтр по категории"
              clearable
              w={230}
              maxDropdownHeight={260}
            />
            {addTo === null && (lists.data?.length ?? 0) > 0 && (
              <Select
                data={(lists.data ?? []).map((l) => ({ value: String(l.id), label: `${l.name} (${formatNumber(l.count)})` }))}
                value={listOnly !== null ? String(listOnly) : null}
                onChange={(v) => setListOnly(v ? Number(v) : null)}
                placeholder="Список: любой"
                aria-label="Фильтр по списку"
                clearable
                w={230}
                maxDropdownHeight={260}
              />
            )}
          </Group>
          <Group gap="sm" wrap="wrap">
            <Chip size="xs" color="gray" checked={filters.showCancelled} onChange={(v) => setFilter('showCancelled', v)}>
              Показать отменённых{total - summary.active ? ` (${formatNumber(total - summary.active)})` : ''}
            </Chip>
            {(summary.cancelledPaid > 0 || filters.cancelledPaidOnly) && (
              <Chip size="xs" color="orange" checked={filters.cancelledPaidOnly} onChange={(v) => setFilter('cancelledPaidOnly', v)}>
                Отменённые с оплатой ({summary.cancelledPaid})
              </Chip>
            )}
            <Chip size="xs" color="orange" checked={filters.under16Only} onChange={(v) => setFilter('under16Only', v)}>
              Только до 16{summary.under16 ? ` (${summary.under16})` : ''}
            </Chip>
            <Chip size="xs" color="orange" checked={filters.dupOnly} onChange={(v) => setFilter('dupOnly', v)}>
              Только похожие на дубли{summary.duplicates ? ` (${summary.duplicates})` : ''}
            </Chip>
            <Chip size="xs" color="yellow" checked={filters.breakfastOnly} onChange={(v) => setFilter('breakfastOnly', v)}>
              Только с завтраком{summary.breakfast ? ` (${summary.breakfast})` : ''}
            </Chip>
            {(summary.onSite > 0 || filters.onSiteOnly) && (
              <Chip size="xs" color="grape" checked={filters.onSiteOnly} onChange={(v) => setFilter('onSiteOnly', v)}>
                Только короткая анкета ({summary.onSite})
              </Chip>
            )}
            {paymentsEnabled && (
              <Chip size="xs" color="pink" checked={filters.sponsorOnly} onChange={(v) => setFilter('sponsorOnly', v)}>
                Только готовые оплатить за другого{summary.sponsors ? ` (${summary.sponsors})` : ''}
              </Chip>
            )}
            {!isDefaultFilters(filters, paymentsEnabled) && (
              <Button size="compact-sm" variant="subtle" leftSection={<IconFilterOff size={14} />} onClick={() => setFilters(DEFAULT_FILTERS)}>
                Сбросить фильтры
              </Button>
            )}
            {summary.duplicates > 0 && (
              <AppLink href="/participants/duplicates" size="xs" ml="auto">
                Посмотреть дубли →
              </AppLink>
            )}
          </Group>
          {onlyList && rows && displayed < listShown && (
            <Alert color="yellow" variant="light" p="xs">
              <Group gap="sm" wrap="wrap">
                <Text size="sm">
                  Из списка «{onlyList.name}» видно {formatNumber(displayed)} из {formatNumber(listShown)} - остальных скрывают фильтры или поиск.
                </Text>
                <Button size="compact-sm" variant="light" color="yellow" leftSection={<IconFilterOff size={14} />} onClick={showWholeList}>
                  Показать всех из списка
                </Button>
              </Group>
            </Alert>
          )}
        </Stack>
      </Card>

      <Group justify="space-between" gap="sm" wrap="wrap" mih={36}>
        <Text size="sm" c="dimmed">
          Показано <b>{formatNumber(displayed)}</b> из {formatNumber(total)}
          {selected.length > 0 && (
            <>
              {' '}
              · выбрано <b>{formatNumber(selected.length)}</b>
            </>
          )}
        </Text>
        {selected.length > 0 && (
          <Group gap="xs" wrap="wrap">
            {addList && (
              <Button size="xs" leftSection={<IconPlaylistAdd size={14} />} loading={members.isPending} onClick={() => addToList(addList.id, addList.name)}>
                Добавить в «{addList.name}» ({formatNumber(selected.length)})
              </Button>
            )}
            {canBulkPayment && (
              <Menu position="bottom-end">
                <Menu.Target>
                  <Button size="xs" variant="light" leftSection={<IconCash size={14} />} rightSection={<IconChevronDown size={14} />} loading={bulk.isPending}>
                    Оплата
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={() => void runBulkPayment('mark_paid')}>Отметить оплату</Menu.Item>
                  <Menu.Item color="red" onClick={() => void runBulkPayment('mark_unpaid')}>
                    Снять оплату
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
            {canLists && addTo === null && (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlaylistAdd size={14} />}
                    rightSection={<IconChevronDown size={14} />}
                    loading={members.isPending}
                  >
                    В список
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {(lists.data ?? []).map((l) => (
                    <Menu.Item key={l.id} onClick={() => addToList(l.id, l.name)}>
                      {l.name}
                    </Menu.Item>
                  ))}
                  {(lists.data?.length ?? 0) > 0 && <Menu.Divider />}
                  <Menu.Item leftSection={<IconPlus size={14} />} onClick={newListHandlers.open}>
                    Новый список…
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
            {canLists && onlyList && (
              <Button
                size="xs"
                variant="light"
                color="red"
                leftSection={<IconPlaylistX size={14} />}
                onClick={() => void removeFromList(onlyList.id, onlyList.name)}
              >
                Убрать из «{onlyList.name}»
              </Button>
            )}
            {canBulkCategory && (
              <Button size="xs" variant="light" leftSection={<IconTag size={14} />} onClick={categoryHandlers.open}>
                Сменить категорию
              </Button>
            )}
            <Button size="xs" variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={() => apiRef.current?.deselectAll()}>
              Снять выделение
            </Button>
          </Group>
        )}
      </Group>

      <DataGrid<Row>
        // Смена телефон ↔ компьютер пересоздаёт таблицу: выбор строк и закрепление задаются при создании.
        key={`${mobile ? 'mobile' : 'desktop'}${selectable ? '-select' : ''}`}
        height={mobile ? 'max(420px, calc(100dvh - 300px))' : 'max(460px, calc(100dvh - 380px))'}
        clickable
        rowData={rows}
        loading={participants.isPending}
        loadingRows
        columnDefs={columnDefs}
        defaultColDef={DEFAULT_COL_DEF}
        getRowId={getRowId}
        rowSelection={selectable ? ROW_SELECTION : undefined}
        selectionColumnDef={selectable ? (mobile ? SELECTION_COLUMN_MOBILE : SELECTION_COLUMN) : undefined}
        quickFilterText={debouncedSearch}
        includeHiddenColumnsInQuickFilter
        cacheQuickFilter
        isExternalFilterPresent={isExternalFilterPresent}
        doesExternalFilterPass={doesExternalFilterPass}
        rowClassRules={ROW_CLASS_RULES}
        onGridReady={onGridReady}
        onModelUpdated={onModelUpdated}
        onSelectionChanged={onSelectionChanged}
        onCellClicked={onCellClicked}
        onCellKeyDown={onCellKeyDown}
        onColumnMoved={saveColumns}
        onColumnVisible={saveColumns}
        onColumnPinned={saveColumns}
        onSortChanged={saveColumns}
        onColumnResized={onColumnResized}
        maintainColumnOrder
      />

      <CreateParticipantModal opened={createOpened} onClose={createHandlers.close} />

      <AppModal opened={newListOpened} onClose={newListHandlers.close} title={<Text fw={700}>Новый список</Text>} size="sm">
        <Stack gap="md">
          <Text size="sm">
            Выбрано: <b>{countLabel(selected.length, PEOPLE)}</b> - создадим список и сразу добавим их.
          </Text>
          <TextInput
            label="Название"
            placeholder="Например: Россияне"
            value={newListName}
            onChange={(e) => setNewListName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createAndAdd();
            }}
            maxLength={80}
            data-autofocus
          />
          <ModalActions>
            <Button variant="default" onClick={newListHandlers.close}>
              Отмена
            </Button>
            <Button disabled={!newListName.trim()} loading={createList.isPending || members.isPending} onClick={createAndAdd}>
              Создать и добавить
            </Button>
          </ModalActions>
        </Stack>
      </AppModal>

      <AppModal opened={categoryOpened} onClose={categoryHandlers.close} title={<Text fw={700}>Сменить категорию</Text>} size="sm">
        <Stack gap="md">
          <Text size="sm">
            Выбрано: <b>{countLabel(selected.length, PEOPLE)}</b>. Какую категорию им поставить?
          </Text>
          <Select
            label="Категория"
            data={CATEGORY_OPTIONS}
            value={bulkCategory}
            onChange={(v) => setBulkCategory(v)}
            placeholder="Выберите категорию"
            comboboxProps={{ withinPortal: true }}
          />
          <ModalActions>
            <Button variant="default" onClick={categoryHandlers.close}>
              Отмена
            </Button>
            <Button disabled={!bulkCategory} loading={bulk.isPending} onClick={runBulkCategory}>
              Применить
            </Button>
          </ModalActions>
        </Stack>
      </AppModal>
    </Stack>
  );
}

function ColumnsMenu({ apiRef, onReset }: { apiRef: RefObject<GridApi<Row> | null>; onReset: () => void }) {
  const [opened, setOpened] = useState(false);
  const [, setVersion] = useState(0);
  const api = apiRef.current;
  const columns =
    opened && api && !api.isDestroyed()
      ? (api.getColumns() ?? [])
          .filter((c) => c.getColId() !== SELECTION_COLUMN_ID)
          .map((c) => ({
            id: c.getColId(),
            name: c.getColDef().headerName ?? c.getColId(),
            visible: c.isVisible(),
            locked: !!c.getColDef().lockVisible,
          }))
      : [];

  const setVisible = (ids: string[], visible: boolean) => {
    apiRef.current?.setColumnsVisible(ids, visible);
    setVersion((v) => v + 1);
  };

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={300} shadow="md" withinPortal>
      <Popover.Target>
        <Button variant="default" leftSection={<IconColumns3 size={16} />} onClick={() => setOpened((o) => !o)}>
          Колонки
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="sm" fw={600} mb="xs">
          Какие колонки показывать
        </Text>
        <ScrollArea.Autosize mah={340} type="auto">
          <Stack gap={8} pr="xs">
            {columns.map((c) => (
              <Checkbox
                key={c.id}
                label={c.name}
                checked={c.visible}
                disabled={c.locked}
                onChange={(e) => setVisible([c.id], e.currentTarget.checked)}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <Divider my="sm" />
        <Group justify="space-between" gap="xs">
          <Button size="compact-sm" variant="subtle" onClick={() => setVisible(columns.map((c) => c.id), true)}>
            Показать все
          </Button>
          <Button
            size="compact-sm"
            variant="subtle"
            color="red"
            onClick={() => {
              onReset();
              setVersion((v) => v + 1);
            }}
          >
            Сбросить вид
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          Таблица запоминает в этом браузере, какие колонки видны, их порядок, ширину и сортировку. Колонки можно
          перетаскивать за заголовок.
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}
