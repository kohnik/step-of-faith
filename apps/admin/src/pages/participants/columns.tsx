import { Anchor, Badge, Text, Tooltip } from '@mantine/core';
import {
  CATEGORY_LABELS,
  PAYMENT_STATUS_LABELS,
  REG_PAYMENT_METHOD_LABELS,
  formatTicketCode,
  braceletOf,
  tierShort,
  type AdminParticipantRow,
  type TiersConfig,
} from '@sof/shared';
import { IconAlertTriangle, IconCheck, IconCoffee, IconHeart, IconUsers } from '@tabler/icons-react';
import type { ColDef, IDateFilterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { CategoryBadge, PaymentBadge, TierBadge, TierBracelet, Under16Badge } from '../../components/badges.tsx';
import { formatDate, formatDateTime, formatMoney, formatTicket, telegramUrl } from '../../lib/format.ts';
import { GENDER_SHORT, PARTICIPANT_STATUS_LABELS, relationLabel } from '../../lib/labels.ts';
import { dayKey, localDateKey } from '../../lib/tz.ts';

type Row = AdminParticipantRow;
type Cell = CustomCellRendererProps<Row>;

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** Сравнение для фильтра дат AG Grid: значение ячейки - `YYYY-MM-DD`. */
function ymdComparator(filterLocalDateAtMidnight: Date, cellValue: unknown): number {
  if (typeof cellValue !== 'string' || !cellValue) return -1;
  const filter = localDateKey(filterLocalDateAtMidnight);
  return cellValue < filter ? -1 : cellValue > filter ? 1 : 0;
}

/** Даты-время сравниваем по дню события (а не браузера). */
function tzDayComparator(tz: string) {
  return (filterLocalDateAtMidnight: Date, cellValue: unknown): number => {
    if (typeof cellValue !== 'string' || !cellValue) return -1;
    const cell = dayKey(cellValue, tz);
    const filter = localDateKey(filterLocalDateAtMidnight);
    return cell < filter ? -1 : cell > filter ? 1 : 0;
  };
}

function dateFilter(comparator: IDateFilterParams['comparator']): Pick<ColDef<Row>, 'filter' | 'filterParams'> {
  return {
    filter: 'agDateColumnFilter',
    filterParams: {
      comparator,
      buttons: ['reset'],
      maxNumConditions: 1,
      browserDatePicker: true,
    } satisfies IDateFilterParams,
  };
}

const toNumber = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

function NameCell({ data }: Cell) {
  if (!data) return null;
  return (
    <span className="sof-cell">
      <Text size="sm" fw={600} truncate className={data.status === 'cancelled' ? 'sof-cell-strike' : undefined}>
        {data.fullName}
      </Text>
      {data.possibleDuplicate && (
        <Tooltip label="Возможный дубль: такой же человек есть в другом аккаунте">
          <IconAlertTriangle size={15} color="var(--mantine-color-orange-6)" style={{ flexShrink: 0 }} />
        </Tooltip>
      )}
    </span>
  );
}

/**
 * Подтверждён = отсканирован на входе. Узкая колонка: зелёный кружок с галочкой у пришедших.
 * У остальных - пусто: до конференции не пришёл никто, и строй крестиков читался как «что-то не так с оплатой».
 */
function ConfirmedCell({ data, tz }: Cell & { tz: string }) {
  if (!data?.arrivedAt) return null;
  return (
    <Tooltip label={`Пришёл(ла) ${formatDateTime(data.arrivedAt, tz)}`} openDelay={300}>
      <span className="sof-confirmed" data-on aria-label="Подтверждён">
        <IconCheck size={14} stroke={3} />
      </span>
    </Tooltip>
  );
}

function PaymentCell({ data }: Cell) {
  return data ? <PaymentBadge status={data.paymentStatus} /> : null;
}

function CategoryCell({ data }: Cell) {
  return data ? <CategoryBadge category={data.category} /> : null;
}

function StatusCell({ data }: Cell) {
  if (!data) return null;
  return data.status === 'active' ? (
    <Text span size="sm" c="dimmed">
      Активен
    </Text>
  ) : (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <Badge color="gray" variant="filled" size="sm">
        Отменён
      </Badge>
      {/* Отменил после оплаты - деньги у нас: видно сразу, для сверки и возможного возврата. */}
      {cancelledPaid(data) && (
        <Badge color="orange" variant="light" size="sm">
          оплачено {formatMoney(data.amountPaid)}
        </Badge>
      )}
    </span>
  );
}

/** Регистрация отменена, а деньги уже внесены (полностью или частично). */
export const cancelledPaid = (r: Row) => r.status === 'cancelled' && Number(r.amountPaid ?? 0) > 0;

function AccountCell({ data }: Cell) {
  if (!data) return null;
  const tg = telegramUrl(data.ownerUsername);
  return (
    <span className="sof-cell">
      <Text size="sm" truncate>
        {data.ownerName}
      </Text>
      {tg && (
        <Anchor href={tg} target="_blank" rel="noopener noreferrer" size="xs" c="dimmed" onClick={(e) => e.stopPropagation()}>
          @{data.ownerUsername}
        </Anchor>
      )}
      {data.ownerTgId === null && (
        <Tooltip label="Аккаунт без Telegram (добавлен вручную)">
          <Badge size="xs" color="gray" variant="outline">
            без TG
          </Badge>
        </Tooltip>
      )}
    </span>
  );
}

function FamilyCell({ data }: Cell) {
  if (!data) return null;
  return (
    <span className="sof-cell">
      <IconUsers size={14} color="var(--mantine-color-dimmed)" />
      <Text span size="sm">
        {data.familySize}
      </Text>
    </span>
  );
}

function DuplicateCell({ data }: Cell) {
  if (!data?.possibleDuplicate) return null;
  return (
    <Badge color="orange" size="sm" variant="light" leftSection={<IconAlertTriangle size={12} />}>
      дубль?
    </Badge>
  );
}

function BreakfastCell({ data }: Cell) {
  if (!data?.breakfast) return null;
  return (
    <Badge color="yellow" size="sm" variant="light" leftSection={<IconCoffee size={12} />}>
      да
    </Badge>
  );
}

function OnSiteCell({ data }: Cell) {
  if (!data?.onSite) return null;
  return (
    <Badge color="grape" size="sm" variant="light">
      короткая анкета
    </Badge>
  );
}

function SponsorCell({ data }: Cell) {
  if (!data?.sponsorOffer) return null;
  return (
    <Badge color="pink" size="sm" variant="light" leftSection={<IconHeart size={12} />}>
      да
    </Badge>
  );
}

function ArrivedCell({ data, valueFormatted }: Cell) {
  if (!data?.arrivedAt) {
    return (
      <Text span size="sm" c="dimmed">
        -
      </Text>
    );
  }
  return (
    <Badge color="teal" variant="light" size="sm">
      {valueFormatted}
    </Badge>
  );
}

export const DEFAULT_HIDDEN = new Set(['id', 'relation', 'paymentNote', 'paidAt', 'ownerPhone', 'updatedAt', 'holderName', 'category', 'paymentRef']);

/** Колонки про оплату - показываем, только когда приём оплаты включён. */
export const PAYMENT_COLUMNS = new Set([
  'paymentStatus',
  'amountDue',
  'amountPaid',
  'paidAt',
  'paymentRef',
  'paymentNote',
  'paymentMethod',
  'sponsorOffer',
]);

/**
 * @param opts.payments приём оплаты включён - показываем колонки про оплату.
 * @param opts.mobile узкий экран: ничего не закрепляем слева, чтобы таблица помещалась.
 */
export function buildColumns(
  tz: string,
  opts: { payments: boolean; mobile?: boolean; tiers: TiersConfig; listNames?: Map<number, string> },
): ColDef<Row>[] {
  const listsOf = (r: Row | undefined) => (r?.lists ?? []).map((id) => opts.listNames?.get(id)).filter((n): n is string => !!n);
  const TierCell = ({ data }: Cell) => (data ? <TierBadge tier={data.tier} tiers={opts.tiers} breakfast={data.breakfast} /> : null);
  const columns: ColDef<Row>[] = [
    {
      colId: 'confirmed',
      headerName: '',
      headerTooltip: 'Пришёл: зелёная галочка - отсканирован на входе',
      width: 48,
      minWidth: 48,
      maxWidth: 48,
      pinned: opts.mobile ? null : 'left',
      lockVisible: true,
      resizable: false,
      suppressHeaderMenuButton: true,
      suppressHeaderFilterButton: true,
      filter: false,
      cellClass: 'sof-col-confirmed',
      headerClass: 'sof-col-confirmed',
      valueGetter: (p) => (p.data?.arrivedAt ? 1 : 0),
      cellRenderer: (p: Cell) => <ConfirmedCell {...p} tz={tz} />,
      getQuickFilterText: () => '',
    },
    {
      colId: 'fullName',
      field: 'fullName',
      headerName: 'ФИО',
      pinned: opts.mobile ? null : 'left',
      width: 180,
      minWidth: 140,
      lockVisible: true,
      filter: 'agTextColumnFilter',
      cellRenderer: NameCell,
      cellDataType: 'text',
    },
    {
      colId: 'tier',
      headerName: 'Вариант',
      width: 190,
      // С завтраком - «Обед и ужин + завтрак»: поиск по колонке «завтрак» найдёт всех с завтраком.
      valueGetter: (p) => {
        const cfg = p.data?.tier ? opts.tiers[p.data.tier] : undefined;
        return cfg ? tierShort(cfg, p.data?.breakfast) : '';
      },
      filter: 'agTextColumnFilter',
      cellRenderer: TierCell,
      cellDataType: 'text',
    },
    {
      colId: 'bracelet',
      headerName: 'Браслет',
      headerTooltip: 'Чёрный - с питанием (обед и ужин), белый - без питания. Задаётся в «Настройки» → «Варианты участия».',
      width: 140,
      valueGetter: (p) => {
        const b = p.data?.status === 'active' ? braceletOf(opts.tiers, p.data.tier) : null;
        return b === 'black' ? 'чёрный' : b === 'white' ? 'белый' : '';
      },
      cellRenderer: ({ data }: Cell) => (data && data.status === 'active' ? <TierBracelet tier={data.tier} tiers={opts.tiers} /> : null),
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'breakfast',
      headerName: 'Завтрак',
      headerTooltip: 'Завтрак к варианту (+доплата)',
      width: 110,
      valueGetter: (p) => (p.data?.breakfast ? 'да' : ''),
      cellRenderer: BreakfastCell,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      getQuickFilterText: () => '',
    },
    {
      colId: 'age',
      field: 'age',
      headerName: 'Возраст',
      width: 100,
      filter: 'agNumberColumnFilter',
      cellDataType: 'number',
      type: 'rightAligned',
    },
    {
      colId: 'under16',
      headerName: 'До 16',
      width: 95,
      valueGetter: (p) => (p.data?.under16 ? 'да' : ''),
      cellRenderer: ({ data }: Cell) => (data?.under16 ? <Under16Badge /> : null),
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      getQuickFilterText: () => '',
    },
    {
      colId: 'birthDate',
      field: 'birthDate',
      headerName: 'Дата рождения',
      width: 140,
      cellDataType: false,
      valueFormatter: (p) => formatDate(p.value as string | null),
      getQuickFilterText: (p) => `${p.data?.birthDate ?? ''} ${formatDate(p.data?.birthDate)}`,
      ...dateFilter(ymdComparator),
    },
    {
      colId: 'gender',
      headerName: 'Пол',
      width: 80,
      valueGetter: (p) => (p.data ? GENDER_SHORT[p.data.gender] : ''),
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'city',
      field: 'city',
      headerName: 'Нас. пункт',
      width: 150,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'church',
      field: 'church',
      headerName: 'Церковь',
      width: 170,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      tooltipField: 'church',
    },
    {
      colId: 'phone',
      field: 'phone',
      headerName: 'Телефон',
      width: 160,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      getQuickFilterText: (p) => `${p.data?.phone ?? ''} ${digits(p.data?.phone)}`,
    },
    {
      colId: 'telegramUsername',
      headerName: 'Ник TG',
      width: 150,
      valueGetter: (p) => (p.data?.telegramUsername ? `@${p.data.telegramUsername}` : ''),
      cellRenderer: ({ data, value }: Cell) =>
        data?.telegramUsername ? (
          <Anchor href={telegramUrl(data.telegramUsername) ?? undefined} target="_blank" rel="noopener noreferrer" size="sm" onClick={(e) => e.stopPropagation()}>
            {value as string}
          </Anchor>
        ) : null,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'category',
      headerName: 'Категория',
      width: 140,
      valueGetter: (p) => (p.data ? CATEGORY_LABELS[p.data.category] : ''),
      filter: 'agTextColumnFilter',
      cellRenderer: CategoryCell,
      cellDataType: 'text',
    },
    {
      colId: 'lists',
      headerName: 'Списки',
      headerTooltip: 'Свои списки из «Участники → Списки»: по ним делают рассылки',
      width: 160,
      // Поиск по таблице находит и по названию списка.
      valueGetter: (p) => listsOf(p.data).join(', '),
      filter: 'agTextColumnFilter',
      cellRenderer: (p: Cell) => (
        <>
          {listsOf(p.data).map((n) => (
            <Badge key={n} size="sm" variant="light" color="indigo" mr={4} tt="none">
              {n}
            </Badge>
          ))}
        </>
      ),
      cellDataType: 'text',
    },
    {
      colId: 'status',
      headerName: 'Статус',
      width: 200,
      // Сохранённая раньше ширина (115) обрезала бы плашку «оплачено» у отменённых.
      minWidth: 190,
      valueGetter: (p) =>
        p.data ? PARTICIPANT_STATUS_LABELS[p.data.status] + (cancelledPaid(p.data) ? `, оплачено ${formatMoney(p.data.amountPaid)}` : '') : '',
      filter: 'agTextColumnFilter',
      cellRenderer: StatusCell,
      cellDataType: 'text',
    },
    {
      colId: 'paymentStatus',
      headerName: 'Оплата',
      width: 165,
      valueGetter: (p) => (p.data ? PAYMENT_STATUS_LABELS[p.data.paymentStatus] : ''),
      filter: 'agTextColumnFilter',
      cellRenderer: PaymentCell,
      cellDataType: 'text',
    },
    {
      colId: 'paymentMethod',
      headerName: 'Как платит',
      width: 150,
      valueGetter: (p) => (p.data?.paymentMethod ? REG_PAYMENT_METHOD_LABELS[p.data.paymentMethod] : ''),
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'amountDue',
      headerName: 'К оплате',
      width: 120,
      valueGetter: (p) => toNumber(p.data?.amountDue),
      valueFormatter: (p) => formatMoney(p.value as number | null),
      filter: 'agNumberColumnFilter',
      cellDataType: 'number',
      type: 'rightAligned',
    },
    {
      colId: 'amountPaid',
      headerName: 'Оплачено',
      width: 120,
      valueGetter: (p) => toNumber(p.data?.amountPaid),
      valueFormatter: (p) => formatMoney(p.value as number | null),
      filter: 'agNumberColumnFilter',
      cellDataType: 'number',
      type: 'rightAligned',
    },
    {
      colId: 'arrivedAt',
      field: 'arrivedAt',
      headerName: 'Пришёл',
      width: 160,
      cellDataType: false,
      valueFormatter: (p) => formatDateTime(p.value as string | null, tz, ''),
      cellRenderer: ArrivedCell,
      getQuickFilterText: () => '',
      ...dateFilter(tzDayComparator(tz)),
    },
    {
      colId: 'ticketCode',
      field: 'ticketCode',
      headerName: 'QR-код',
      width: 175,
      cellDataType: 'text',
      valueFormatter: (p) => formatTicket(p.value as string | null, ''),
      cellClass: 'sof-mono',
      filter: 'agTextColumnFilter',
      filterValueGetter: (p) => (p.data?.ticketCode ? `${p.data.ticketCode} ${formatTicketCode(p.data.ticketCode)}` : ''),
      getQuickFilterText: (p) => (p.data?.ticketCode ? `${p.data.ticketCode} ${formatTicketCode(p.data.ticketCode)}` : ''),
    },
    {
      colId: 'account',
      headerName: 'Аккаунт',
      width: 230,
      valueGetter: (p) => (p.data ? `${p.data.ownerName}${p.data.ownerUsername ? ` @${p.data.ownerUsername}` : ''}` : ''),
      // В общем поиске - только @ник аккаунта: по имени того, кто регистрировал, «Александр» находил всю его семью и друзей.
      getQuickFilterText: (p) => (p.data?.ownerUsername ? `@${p.data.ownerUsername} ${p.data.ownerUsername}` : ''),
      filter: 'agTextColumnFilter',
      cellRenderer: AccountCell,
      cellDataType: 'text',
    },
    {
      colId: 'paymentRef',
      field: 'paymentRef',
      headerName: 'Код оплаты',
      width: 125,
      cellClass: 'sof-mono',
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'familySize',
      field: 'familySize',
      headerName: 'Семья',
      width: 95,
      filter: 'agNumberColumnFilter',
      cellRenderer: FamilyCell,
      cellDataType: 'number',
      getQuickFilterText: () => '',
    },
    {
      colId: 'possibleDuplicate',
      headerName: 'Возможный дубль',
      width: 150,
      valueGetter: (p) => (p.data?.possibleDuplicate ? 'да' : ''),
      cellRenderer: DuplicateCell,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      getQuickFilterText: () => '',
    },
    {
      colId: 'onSite',
      headerName: 'Короткая анкета',
      headerTooltip: 'Записался в день конференции по короткой форме: Ф.И., телефон, пол - без даты рождения и города',
      width: 110,
      valueGetter: (p) => (p.data?.onSite ? 'да' : ''),
      cellRenderer: OnSiteCell,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      getQuickFilterText: () => '',
    },
    {
      colId: 'sponsorOffer',
      headerName: 'Готов оплатить за другого',
      headerTooltip: 'Отметил в анкете, что готов оплатить регистрацию за того, у кого нет возможности',
      width: 120,
      valueGetter: (p) => (p.data?.sponsorOffer ? 'да' : ''),
      cellRenderer: SponsorCell,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      getQuickFilterText: () => '',
    },
    {
      colId: 'createdAt',
      field: 'createdAt',
      headerName: 'Создан',
      width: 160,
      cellDataType: false,
      valueFormatter: (p) => formatDateTime(p.value as string | null, tz),
      getQuickFilterText: () => '',
      ...dateFilter(tzDayComparator(tz)),
    },
    // --- скрытые по умолчанию ---
    {
      colId: 'id',
      field: 'id',
      headerName: 'ID',
      width: 90,
      filter: 'agNumberColumnFilter',
      cellDataType: 'number',
    },
    {
      colId: 'relation',
      headerName: 'Кем приходится',
      width: 140,
      valueGetter: (p) => (p.data ? relationLabel(p.data.relation) : ''),
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'holderName',
      field: 'holderName',
      headerName: 'QR-код также у',
      width: 170,
      // Не в общем поиске: ищем человека по его данным, а не по тому, у кого его QR-код. Фильтр колонки остаётся.
      getQuickFilterText: () => '',
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
    },
    {
      colId: 'paymentNote',
      field: 'paymentNote',
      headerName: 'Комментарий к оплате',
      width: 240,
      // Там «принял(а) <кассир>» у каждого оплатившего - по имени кассира находились сотни людей. Фильтр колонки остаётся.
      getQuickFilterText: () => '',
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      tooltipField: 'paymentNote',
    },
    {
      colId: 'paidAt',
      field: 'paidAt',
      headerName: 'Когда оплачено',
      width: 160,
      cellDataType: false,
      valueFormatter: (p) => formatDateTime(p.value as string | null, tz, ''),
      getQuickFilterText: () => '',
      ...dateFilter(tzDayComparator(tz)),
    },
    {
      colId: 'ownerPhone',
      field: 'ownerPhone',
      headerName: 'Телефон аккаунта',
      width: 160,
      filter: 'agTextColumnFilter',
      cellDataType: 'text',
      getQuickFilterText: (p) => `${p.data?.ownerPhone ?? ''} ${digits(p.data?.ownerPhone)}`,
    },
    {
      colId: 'updatedAt',
      field: 'updatedAt',
      headerName: 'Изменён',
      width: 160,
      cellDataType: false,
      valueFormatter: (p) => formatDateTime(p.value as string | null, tz),
      getQuickFilterText: () => '',
      ...dateFilter(tzDayComparator(tz)),
    },
  ];
  return columns
    .filter((col) => opts.payments || !PAYMENT_COLUMNS.has(col.colId ?? ''))
    .map((col) => ({ ...col, hide: DEFAULT_HIDDEN.has(col.colId ?? '') }));
}
