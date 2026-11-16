import {
  ActionIcon,
  Autocomplete,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { MoneyKind, MoneySummary, PaymentEntryView, PaymentMethod } from '@sof/shared';
import {
  IconArrowBackUp,
  IconArrowDownLeft,
  IconArrowUpRight,
  IconBuildingBank,
  IconFileSpreadsheet,
  IconScale,
  IconSearch,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { downloadFile } from '../../api/client.ts';
import { useAddMoney, useCancelMoney, useMoney } from '../../api/money.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { useSession } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatDateTime, formatMoney } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { dayKey, todayKey } from '../../lib/tz.ts';

type Row = PaymentEntryView;
type KindFilter = 'all' | MoneyKind;
type Period = 'today' | 'all';

const KIND: Record<MoneyKind, { label: string; color: string }> = {
  fee: { label: 'Взнос', color: 'teal' },
  donation: { label: 'Пожертвование', color: 'pink' },
  merch: { label: 'Мерч', color: 'violet' },
  income: { label: 'Приход', color: 'green' },
  payout: { label: 'Выдача', color: 'red' },
};
const METHOD: Record<PaymentMethod, { label: string; color: string }> = {
  cash: { label: 'Наличные', color: 'teal' },
  transfer: { label: 'Перевод', color: 'blue' },
  card: { label: 'Карта', color: 'grape' },
};
const SOURCE_LABEL: Partial<Record<MoneyKind, string>> = { fee: 'Взносы', donation: 'Пожертвования', merch: 'Мерч', income: 'Прочий приход' };
/** Частые статьи расхода - подсказки; можно написать свою. */
const CATEGORIES = ['Закупки', 'Питание', 'Транспорт', 'Аренда', 'Печать', 'Мерч', 'Подарки'];
/** Что банкир отменяет здесь: свои записи и пожертвования. Взнос - в карточке участника, мерч - отменой заказа. */
const CANCELLABLE: MoneyKind[] = ['payout', 'income', 'donation'];

const NUM = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } as const;

/**
 * Банкир: все деньги конференции одним журналом - взносы, пожертвования, мерч, прочий приход и выдачи.
 * Сверху - сколько пришло, сколько выдали и сколько должно остаться (всего и по способам).
 */
export default function MoneyPage() {
  const tz = useEventTz();
  const money = useMoney();
  const [entry, setEntry] = useState<'payout' | 'income' | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);

  return (
    <Stack gap="md">
      <PageHeader
        title="Деньги"
        description="Весь приход и расход: взносы, пожертвования, мерч, выдачи. Отменённое остаётся в журнале с причиной и в итоги не идёт."
        actions={
          <>
            <Button color="red" variant="light" leftSection={<IconArrowUpRight size={16} />} onClick={() => setEntry('payout')}>
              Выдать деньги
            </Button>
            <Button color="green" variant="light" leftSection={<IconArrowDownLeft size={16} />} onClick={() => setEntry('income')}>
              Принять деньги
            </Button>
          </>
        }
      />
      {money.isPending ? (
        <BlockSkeleton rows={3} height={140} />
      ) : money.isError ? (
        <ErrorState error={money.error} onRetry={() => void money.refetch()} />
      ) : (
        <>
          <Summary s={money.data.summary} />
          <Journal rows={money.data.entries} tz={tz} onCancel={setCancelling} />
        </>
      )}

      <AppModal opened={entry !== null} onClose={() => setEntry(null)} title={entry === 'payout' ? 'Выдать деньги' : 'Принять деньги'} size="md">
        {entry && <EntryForm kind={entry} categories={categoriesOf(money.data?.entries ?? [])} onDone={() => setEntry(null)} />}
      </AppModal>
      <AppModal opened={cancelling !== null} onClose={() => setCancelling(null)} title="Отменить запись" size="md">
        {cancelling && <CancelForm row={cancelling} onDone={() => setCancelling(null)} />}
      </AppModal>
    </Stack>
  );
}

function categoriesOf(rows: Row[]): string[] {
  const used = rows.flatMap((r) => (r.category ? [r.category] : []));
  return [...new Set([...CATEGORIES, ...used])];
}

function Summary({ s }: { s: MoneySummary }) {
  const sources: { kind: MoneyKind; amount: string }[] = [
    { kind: 'fee', amount: s.income.fee },
    { kind: 'donation', amount: s.income.donation },
    { kind: 'merch', amount: s.income.merch },
    { kind: 'income', amount: s.income.income },
  ];
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <Big icon={<IconArrowDownLeft size={20} />} color="green" title="Пришло" sum={s.income.total} />
        <Big icon={<IconArrowUpRight size={20} />} color="red" title="Выдано" sum={s.payout} />
        <Big icon={<IconScale size={20} />} color="dark" title="Должно остаться" sum={s.balance} strong />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
        <Card padding="md">
          <Group justify="space-between" mb="xs">
            <Text fw={600}>По способам</Text>
            <Text size="xs" c="dimmed">
              остаток
            </Text>
          </Group>
          {/* Карточка узкая (треть ширины): по строке на способ - остаток крупно, приход и выдачи мелко под ним. */}
          <Stack gap={10}>
            {s.byMethod.map((m) => (
              <div key={m.method}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text fw={600}>{METHOD[m.method].label}</Text>
                  <Text fw={700} style={NUM}>
                    {formatMoney(m.balance)}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" style={NUM}>
                  пришло {formatMoney(m.in)} · выдано {formatMoney(m.out)}
                </Text>
              </div>
            ))}
          </Stack>
        </Card>
        <Card padding="md">
          <Text fw={600} mb="xs">
            Откуда пришло
          </Text>
          <Stack gap={6}>
            {sources.map((x) => (
              <Group key={x.kind} justify="space-between">
                <Badge variant="light" color={KIND[x.kind].color} tt="none">
                  {SOURCE_LABEL[x.kind]}
                </Badge>
                <Text fw={600} style={NUM}>
                  {formatMoney(x.amount)}
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>
        <Card padding="md">
          <Text fw={600} mb="xs">
            На что выдали
          </Text>
          {s.payoutsByCategory.length === 0 ? (
            <Text size="sm" c="dimmed">
              Выдач пока не было.
            </Text>
          ) : (
            <Stack gap={6}>
              {s.payoutsByCategory.map((c) => (
                <Group key={c.category} justify="space-between" wrap="nowrap">
                  <Text size="sm" truncate>
                    {c.category}{' '}
                    <Text span c="dimmed" size="xs">
                      × {c.count}
                    </Text>
                  </Text>
                  <Text fw={600} style={NUM}>
                    {formatMoney(c.amount)}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

function Big({ icon, color, title, sum, strong }: { icon: React.ReactNode; color: string; title: string; sum: string; strong?: boolean }) {
  return (
    <Card padding="md">
      <Group gap="xs" c={color === 'dark' ? undefined : color}>
        {icon}
        <Text size="sm" fw={600}>
          {title}
        </Text>
      </Group>
      <Text fz={28} fw={strong ? 900 : 800} mt={4} style={NUM}>
        {formatMoney(sum)}
      </Text>
    </Card>
  );
}

function Journal({ rows, tz, onCancel }: { rows: Row[]; tz: string; onCancel: (r: Row) => void }) {
  const { session } = useSession();
  const { openParticipant, canOpen } = useParticipantDrawer();
  const [kind, setKind] = useState<KindFilter>('all');
  const [method, setMethod] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('all');
  const [who, setWho] = useState<string | null>(null);
  const [showUndone, setShowUndone] = useState(false);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);
  const [exporting, setExporting] = useState(false);

  const people = useMemo(() => {
    const names = new Map<string, string>();
    for (const r of rows) if (r.acceptedById != null) names.set(String(r.acceptedById), r.acceptedByName ?? '-');
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru')).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const today = todayKey(tz);
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (kind === 'all' || r.kind === kind) &&
          (method === null || r.method === method) &&
          (period === 'all' || dayKey(r.createdAt, tz) === today) &&
          (who === null || String(r.acceptedById) === who) &&
          (showUndone || !r.undoneAt) &&
          (!q || `${r.fullName} ${r.comment ?? ''} ${r.category ?? ''} ${r.merchOrderCode ?? ''}`.toLowerCase().includes(q)),
      ),
    [rows, kind, method, period, who, showUndone, q, tz, today],
  );
  const counted = filtered.filter((r) => !r.undoneAt);
  const inSum = counted.filter((r) => r.kind !== 'payout').reduce((s, r) => s + Number(r.amount), 0);
  const outSum = counted.filter((r) => r.kind === 'payout').reduce((s, r) => s + Number(r.amount), 0);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      await downloadFile(`/api/admin/money/export.xlsx?ids=${filtered.map((r) => r.id).join(',')}`, `money-${today}.xlsx`);
      notifySuccess('Файл Excel скачивается');
    } catch (err) {
      notifyError(err, 'Не получилось выгрузить');
    } finally {
      setExporting(false);
    }
  };

  const mine = String(session.user.id);
  return (
    <Stack gap="sm" mt="md">
      <Text fw={700} fz="lg">
        Журнал
      </Text>
      <Group gap="sm" wrap="wrap" align="center">
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Кто, на что, код заказа"
          leftSection={<IconSearch size={16} />}
          style={{ flex: '1 1 220px' }}
          maw={320}
          aria-label="Поиск по журналу"
        />
        <SegmentedControl
          size="xs"
          value={kind}
          onChange={(v) => setKind(v as KindFilter)}
          data={[
            { value: 'all', label: 'Всё' },
            { value: 'fee', label: 'Взносы' },
            { value: 'donation', label: 'Пожертв.' },
            { value: 'merch', label: 'Мерч' },
            { value: 'income', label: 'Приход' },
            { value: 'payout', label: 'Выдачи' },
          ]}
        />
        <Select
          size="xs"
          w={140}
          placeholder="Способ: все"
          data={(Object.keys(METHOD) as PaymentMethod[]).map((m) => ({ value: m, label: METHOD[m].label }))}
          value={method}
          onChange={setMethod}
          clearable
          aria-label="Способ"
        />
        <SegmentedControl
          size="xs"
          value={period}
          onChange={(v) => setPeriod(v as Period)}
          data={[
            { value: 'all', label: 'За всё время' },
            { value: 'today', label: 'Сегодня' },
          ]}
        />
        <Select
          size="xs"
          w={200}
          placeholder="Кто записал: все"
          data={[...(people.some((c) => c.value === mine) ? [{ value: mine, label: 'Только мои' }] : []), ...people.filter((c) => c.value !== mine)]}
          value={who}
          onChange={setWho}
          clearable
          aria-label="Кто записал"
        />
        <Checkbox size="xs" label="Показать отменённые" checked={showUndone} onChange={(e) => setShowUndone(e.currentTarget.checked)} />
        <Button
          ml="auto"
          size="xs"
          variant="default"
          leftSection={<IconFileSpreadsheet size={16} />}
          loading={exporting}
          disabled={filtered.length === 0}
          onClick={() => void exportXlsx()}
        >
          Excel ({filtered.length})
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        По отобранному: пришло {formatMoney(inSum)}
        {outSum ? ` · выдано ${formatMoney(outSum)}` : ''}
      </Text>

      {filtered.length === 0 ? (
        <Card>
          <EmptyBlock
            icon={<IconBuildingBank size={28} />}
            title={rows.length ? 'Ничего не найдено' : 'Записей пока нет'}
            description={rows.length ? 'Поменяйте фильтры.' : 'Здесь появится каждый приход и каждая выдача денег.'}
          />
        </Card>
      ) : (
        <Card padding={0}>
          <Table.ScrollContainer minWidth={860}>
            <Table verticalSpacing="xs" highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={140}>Когда</Table.Th>
                  <Table.Th w={150}>Что</Table.Th>
                  <Table.Th>Кто / кому</Table.Th>
                  <Table.Th ta="right" w={120}>
                    Сумма
                  </Table.Th>
                  <Table.Th w={120}>Способ</Table.Th>
                  <Table.Th>Записал(а)</Table.Th>
                  <Table.Th w={44} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered.map((r) => {
                  const clickable = canOpen && r.participantId != null;
                  const out = r.kind === 'payout';
                  return (
                    <Table.Tr
                      key={r.id}
                      style={{ cursor: clickable ? 'pointer' : undefined, opacity: r.undoneAt ? 0.55 : 1 }}
                      onClick={clickable ? () => openParticipant(r.participantId!) : undefined}
                    >
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt, tz)}</Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={KIND[r.kind].color} tt="none" style={{ overflow: 'visible' }}>
                          {KIND[r.kind].label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={600} td={r.undoneAt ? 'line-through' : undefined}>
                          {r.fullName}
                        </Text>
                        {(r.comment || r.category || r.merchOrderCode) && (
                          <Text size="xs" c="dimmed">
                            {[r.category, r.kind === 'merch' && r.merchOrderCode ? `заказ ${r.merchOrderCode}` : r.comment].filter(Boolean).join(' · ')}
                          </Text>
                        )}
                        {r.undoneAt && (
                          <Text size="xs" c="red">
                            Отменено {formatDateTime(r.undoneAt, tz)}
                            {r.undoneByName ? `, ${r.undoneByName}` : ''}
                            {r.undoReason ? `: ${r.undoReason}` : ''}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right" fw={700} c={out ? 'red' : undefined} style={{ ...NUM, whiteSpace: 'nowrap' }}>
                        {out ? '−' : '+'}
                        {formatMoney(r.amount)}
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={METHOD[r.method].color} tt="none">
                          {METHOD[r.method].label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{r.acceptedByName ?? '-'}</Table.Td>
                      <Table.Td onClick={(e) => e.stopPropagation()}>
                        {CANCELLABLE.includes(r.kind) && !r.undoneAt && (
                          <Tooltip label="Отменить запись">
                            <ActionIcon variant="subtle" color="red" aria-label="Отменить запись" onClick={() => onCancel(r)}>
                              <IconArrowBackUp size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Stack>
  );
}

/** Выдать или принять: всё набирается в форме и записывается одной кнопкой. */
function EntryForm({ kind, categories, onDone }: { kind: 'payout' | 'income'; categories: string[]; onDone: () => void }) {
  const add = useAddMoney();
  // Один requestId на форму: повторное нажатие или плохая связь не запишут дважды.
  const [requestId] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [counterparty, setCounterparty] = useState('');
  const [comment, setComment] = useState('');
  const [category, setCategory] = useState('');
  const payout = kind === 'payout';
  const sum = Number(amount.replace(',', '.'));
  const valid = /^\d{1,7}([.,]\d{1,2})?$/.test(amount.trim()) && sum > 0 && counterparty.trim() && comment.trim();

  const submit = () =>
    add.mutate(
      { requestId, kind, amount: amount.trim(), method, counterparty: counterparty.trim(), comment: comment.trim(), category: category.trim() || null },
      {
        onSuccess: () => {
          notifySuccess(payout ? `Выдано ${formatMoney(sum)}` : `Принято ${formatMoney(sum)}`, counterparty.trim());
          onDone();
        },
        onError: (e) => notifyError(e),
      },
    );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) submit();
      }}
    >
      <Stack gap="sm">
        <TextInput label="Сумма, ₽" placeholder="1500" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} data-autofocus required />
        <SegmentedControl
          value={method}
          onChange={(v) => setMethod(v as PaymentMethod)}
          data={[
            { value: 'cash', label: 'Наличные' },
            { value: 'transfer', label: 'Перевод' },
            { value: 'card', label: 'Карта' },
          ]}
        />
        <TextInput
          label={payout ? 'Кому' : 'От кого'}
          placeholder={payout ? 'Имя, телефон или организация' : 'Имя или организация'}
          value={counterparty}
          onChange={(e) => setCounterparty(e.currentTarget.value)}
          maxLength={120}
          required
        />
        <Textarea
          label={payout ? 'На что' : 'За что'}
          placeholder={payout ? 'Вода и стаканы на 300 человек' : 'Возврат аванса за зал'}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          maxLength={300}
          autosize
          minRows={2}
          required
        />
        <Autocomplete label="Статья" description="Необязательно: по статьям видно, на что ушли деньги" data={categories} value={category} onChange={setCategory} maxLength={60} />
        <ModalActions>
          <Button variant="default" onClick={onDone}>
            Отмена
          </Button>
          <Button type="submit" color={payout ? 'red' : 'green'} disabled={!valid} loading={add.isPending}>
            {payout ? 'Выдать' : 'Принять'}
            {sum > 0 ? ` ${formatMoney(sum)}` : ''}
          </Button>
        </ModalActions>
      </Stack>
    </form>
  );
}

function CancelForm({ row, onDone }: { row: Row; onDone: () => void }) {
  const cancel = useCancelMoney();
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 2;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        cancel.mutate({ id: row.id, reason: reason.trim() }, { onSuccess: () => (notifySuccess('Запись отменена'), onDone()), onError: (e) => notifyError(e) });
      }}
    >
      <Stack gap="sm">
        <Text size="sm">
          {KIND[row.kind].label}: <b>{row.fullName}</b>, {formatMoney(row.amount)} - запись останется в журнале зачёркнутой и в итоги не пойдёт.
        </Text>
        <Textarea label="Причина" placeholder="Ошиблись суммой" value={reason} onChange={(e) => setReason(e.currentTarget.value)} maxLength={300} autosize minRows={2} data-autofocus required />
        <ModalActions>
          <Button variant="default" onClick={onDone}>
            Не отменять
          </Button>
          <Button type="submit" color="red" disabled={!ok} loading={cancel.isPending}>
            Отменить запись
          </Button>
        </ModalActions>
      </Stack>
    </form>
  );
}
