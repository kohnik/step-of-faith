import { ActionIcon, Badge, Button, Card, Checkbox, Group, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { PaymentEntryView, PaymentMethod } from '@sof/shared';
import { IconArrowBackUp, IconCash, IconFileSpreadsheet, IconHeartHandshake, IconReceipt, IconSearch, IconUserCheck } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { downloadFile } from '../../api/client.ts';
import { usePaymentsLedger, useUndoDonation } from '../../api/payments.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { useSession } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { countLabel, formatDateTime, formatMoney } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { dayKey, todayKey } from '../../lib/tz.ts';

type Row = PaymentEntryView;
type MethodFilter = 'all' | PaymentMethod;
type KindFilter = 'all' | 'fee' | 'donation';
type Period = 'today' | 'all';

const METHOD: Record<PaymentMethod, { label: string; color: string }> = {
  cash: { label: 'Наличные', color: 'teal' },
  transfer: { label: 'Перевод', color: 'blue' },
  card: { label: 'Карта', color: 'grape' },
};
const SOURCE: Record<Row['source'], string> = {
  desk: 'Касса',
  receipt: 'Чек перевода',
  manual: 'Правка в админке',
  money: 'Банкир',
  merch: 'Мерч',
};
const PEOPLE: [string, string, string] = ['человек', 'человека', 'человек'];
const TIMES: [string, string, string] = ['раз', 'раза', 'раз'];

/** Цифры одной ширины - суммы в столбик читаются ровно. */
const NUM = { fontVariantNumeric: 'tabular-nums' } as const;

const sumOf = (rows: Row[]) => rows.reduce((s, r) => s + Number(r.amount), 0);
const peopleOf = (rows: Row[]) => new Set(rows.map((r) => r.participantId)).size;

/**
 * Все оплаты одним журналом: наличные на кассе, принятые чеки переводов, правки в админке.
 * Сверху - итоги по отобранному (наличные / переводы / всего) и по кассирам; отменённые приёмы в итоги не идут.
 */
export function PaymentsLedger({ tz }: { tz: string }) {
  const ledger = usePaymentsLedger();
  const undo = useUndoDonation();
  const confirm = useConfirm();
  const undoDonation = async (r: Row) => {
    const ok = await confirm({
      title: 'Отменить пожертвование?',
      message: `${r.fullName}, ${formatMoney(r.amount)} - запись останется в журнале перечёркнутой и в итоги не пойдёт.`,
      confirmLabel: 'Отменить пожертвование',
      danger: true,
    });
    if (ok) undo.mutate(r.id, { onSuccess: () => notifySuccess('Пожертвование отменено'), onError: (e) => notifyError(e) });
  };
  const { session } = useSession();
  const { openParticipant, canOpen } = useParticipantDrawer();
  const [method, setMethod] = useState<MethodFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [period, setPeriod] = useState<Period>('all');
  const [who, setWho] = useState<string | null>(null);
  const [showUndone, setShowUndone] = useState(false);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);
  const [exporting, setExporting] = useState(false);

  const rows = ledger.data ?? [];
  const cashiers = useMemo(() => {
    const names = new Map<string, string>();
    for (const r of rows) if (r.acceptedById != null) names.set(String(r.acceptedById), r.acceptedByName ?? '-');
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru')).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const today = todayKey(tz);
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (method === 'all' || r.method === method) &&
          (kind === 'all' || r.kind === kind) &&
          (period === 'all' || dayKey(r.createdAt, tz) === today) &&
          (who === null || String(r.acceptedById) === who) &&
          (!q || r.fullName.toLowerCase().includes(q)),
      ),
    [rows, method, kind, period, who, q, tz, today],
  );
  const counted = filtered.filter((r) => !r.undoneAt);
  const visible = showUndone ? filtered : counted;
  // Карточки «Наличные / Переводы» - взносы; пожертвования - своей карточкой.
  const fees = counted.filter((r) => r.kind === 'fee');
  const donations = counted.filter((r) => r.kind === 'donation');
  const cash = fees.filter((r) => r.method === 'cash');
  const transfer = fees.filter((r) => r.method === 'transfer');
  const card = fees.filter((r) => r.method === 'card');

  // Кто сколько принял на кассе (чеки переводов здесь не считаем - их «принимает» проверяющий в админке).
  const byCashier = useMemo(() => {
    const map = new Map<string, { name: string; cash: number; other: number; donations: number; inBox: number; people: Set<number> }>();
    for (const r of counted) {
      if (r.source !== 'desk') continue;
      const key = String(r.acceptedById ?? 'none');
      const cur = map.get(key) ?? { name: r.acceptedByName ?? 'Удалённый аккаунт', cash: 0, other: 0, donations: 0, inBox: 0, people: new Set<number>() };
      const amount = Number(r.amount);
      if (r.kind === 'donation') cur.donations += amount;
      else if (r.method === 'cash') cur.cash += amount;
      else cur.other += amount;
      // Сколько наличных должно лежать в кассе у этого кассира: взносы и пожертвования наличными.
      if (r.method === 'cash') cur.inBox += amount;
      if (r.kind === 'fee' && r.participantId != null) cur.people.add(r.participantId);
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.cash + b.other + b.donations - (a.cash + a.other + a.donations));
  }, [counted]);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      await downloadFile(`/api/admin/payments/export.xlsx?ids=${visible.map((r) => r.id).join(',')}`, `payments-${today}.xlsx`);
      notifySuccess('Файл Excel скачивается');
    } catch (err) {
      notifyError(err, 'Не получилось выгрузить');
    } finally {
      setExporting(false);
    }
  };

  if (ledger.isPending) return <BlockSkeleton rows={2} height={200} />;
  if (ledger.isError) return <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />;

  const mine = String(session.user.id);
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
        <Total icon={<IconCash size={20} />} color="teal" title="Наличные" sum={sumOf(cash)} people={peopleOf(cash)} />
        <Total
          icon={<IconReceipt size={20} />}
          color="blue"
          title={card.length ? 'Переводы и карта' : 'Переводы'}
          sum={sumOf(transfer) + sumOf(card)}
          people={peopleOf([...transfer, ...card])}
        />
        <Total icon={<IconUserCheck size={20} />} color="dark" title="Всего взносов" sum={sumOf(fees)} people={peopleOf(fees)} strong />
        <Total
          icon={<IconHeartHandshake size={20} />}
          color="pink"
          title="Пожертвования"
          sum={sumOf(donations)}
          caption={countLabel(donations.length, TIMES)}
        />
      </SimpleGrid>

      {byCashier.length > 0 && (
        <Card padding="md">
          <Text fw={600} mb="xs">
            Кто сколько принял на кассе
          </Text>
          <Table.ScrollContainer minWidth={620}>
            <Table verticalSpacing={6} withRowBorders={false}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Кассир</Table.Th>
                  <Table.Th ta="right">Наличные</Table.Th>
                  <Table.Th ta="right">Переводом</Table.Th>
                  <Table.Th ta="right">Пожертвования</Table.Th>
                  <Table.Th ta="right">В кассе наличными</Table.Th>
                  <Table.Th ta="right">Людей</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {byCashier.map((c) => (
                  <Table.Tr key={c.name}>
                    <Table.Td fw={600}>{c.name}</Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {formatMoney(c.cash)}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {c.other ? formatMoney(c.other) : '-'}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {c.donations ? formatMoney(c.donations) : '-'}
                    </Table.Td>
                    <Table.Td ta="right" fw={700} style={NUM}>
                      {formatMoney(c.inBox)}
                    </Table.Td>
                    <Table.Td ta="right">{c.people.size}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      <Group gap="sm" wrap="wrap" align="center">
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Поиск по участнику"
          leftSection={<IconSearch size={16} />}
          style={{ flex: '1 1 220px' }}
          maw={320}
          aria-label="Поиск по участнику"
        />
        <SegmentedControl
          size="xs"
          value={kind}
          onChange={(v) => setKind(v as KindFilter)}
          data={[
            { value: 'all', label: 'Всё' },
            { value: 'fee', label: 'Взносы' },
            { value: 'donation', label: 'Пожертвования' },
          ]}
        />
        <SegmentedControl
          size="xs"
          value={method}
          onChange={(v) => setMethod(v as MethodFilter)}
          data={[
            { value: 'all', label: 'Все' },
            { value: 'cash', label: 'Наличные' },
            { value: 'transfer', label: 'Переводы' },
            ...(rows.some((r) => r.method === 'card') ? [{ value: 'card', label: 'Карта' }] : []),
          ]}
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
          w={220}
          placeholder="Кто принял: все"
          data={[...(cashiers.some((c) => c.value === mine) ? [{ value: mine, label: 'Только мои' }] : []), ...cashiers.filter((c) => c.value !== mine)]}
          value={who}
          onChange={setWho}
          clearable
          aria-label="Кто принял"
        />
        <Checkbox size="xs" label="Показать отменённые" checked={showUndone} onChange={(e) => setShowUndone(e.currentTarget.checked)} />
        <Button
          ml="auto"
          size="xs"
          variant="default"
          leftSection={<IconFileSpreadsheet size={16} />}
          loading={exporting}
          disabled={visible.length === 0}
          onClick={() => void exportXlsx()}
        >
          Excel ({visible.length})
        </Button>
      </Group>

      {visible.length === 0 ? (
        <Card>
          <EmptyBlock
            icon={<IconCash size={28} />}
            title={rows.length ? 'Ничего не найдено' : 'Оплат пока нет'}
            description={rows.length ? 'Поменяйте фильтры.' : 'Здесь появится каждая оплата: наличные на кассе и принятые чеки переводов.'}
          />
        </Card>
      ) : (
        <Card padding={0}>
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="xs" highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={150}>Когда</Table.Th>
                  <Table.Th>Кто</Table.Th>
                  <Table.Th ta="right" w={110}>
                    Сумма
                  </Table.Th>
                  <Table.Th w={110}>Способ</Table.Th>
                  <Table.Th>Принял(а)</Table.Th>
                  <Table.Th w={150}>Откуда</Table.Th>
                  <Table.Th w={44} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visible.map((r) => (
                  <Table.Tr
                    key={r.id}
                    style={{ cursor: canOpen && r.participantId != null ? 'pointer' : undefined, opacity: r.undoneAt ? 0.55 : 1 }}
                    onClick={canOpen && r.participantId != null ? () => openParticipant(r.participantId!) : undefined}
                  >
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt, tz)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600} td={r.undoneAt ? 'line-through' : undefined}>
                        {r.fullName}
                      </Text>
                      {r.comment && (
                        <Text size="xs" c="dimmed">
                          {r.comment}
                        </Text>
                      )}
                      {r.undoneAt && (
                        <Text size="xs" c="red">
                          Отменено {formatDateTime(r.undoneAt, tz)}
                          {r.undoneByName ? `, ${r.undoneByName}` : ''}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right" fw={600} style={{ ...NUM, whiteSpace: 'nowrap' }}>
                      {formatMoney(r.amount)}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Badge variant="light" color={METHOD[r.method].color}>
                          {METHOD[r.method].label}
                        </Badge>
                        {r.kind === 'donation' && (
                          <Badge variant="light" color="pink" leftSection={<IconHeartHandshake size={12} />}>
                            пожертв.
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>{r.acceptedByName ?? '-'}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {SOURCE[r.source]}
                        {r.receiptId ? ` №${r.receiptId}` : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      {r.kind === 'donation' && !r.undoneAt && (
                        <Tooltip label="Отменить пожертвование">
                          <ActionIcon variant="subtle" color="red" aria-label="Отменить пожертвование" onClick={() => void undoDonation(r)}>
                            <IconArrowBackUp size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Stack>
  );
}

function Total({
  icon,
  color,
  title,
  sum,
  people,
  caption,
  strong,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  sum: number;
  people?: number;
  caption?: string;
  strong?: boolean;
}) {
  return (
    <Card padding="md">
      <Group gap="xs" c={color === 'dark' ? undefined : color}>
        {icon}
        <Text size="sm" fw={600}>
          {title}
        </Text>
      </Group>
      <Text fz={26} fw={strong ? 900 : 800} mt={4} style={NUM}>
        {formatMoney(sum)}
      </Text>
      <Text size="sm" c="dimmed">
        {caption ?? countLabel(people ?? 0, PEOPLE)}
      </Text>
    </Card>
  );
}
