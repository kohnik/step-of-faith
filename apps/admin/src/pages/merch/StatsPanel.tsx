import { Badge, Card, Group, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type { MerchStats } from '@sof/shared';
import { IconAlertTriangle, IconCash, IconCoins, IconPackage, IconShirt } from '@tabler/icons-react';
import { useMerchStats } from '../../api/merch.ts';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { formatMoney } from '../../lib/format.ts';

const METHOD: Record<MerchStats['byMethod'][number]['method'], string> = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };
const NUM = { fontVariantNumeric: 'tabular-nums' } as const;

/** Сколько продали, сколько получили денег, кто должен и что заканчивается. */
export default function StatsPanel() {
  const stats = useMerchStats();
  if (stats.isPending) return <BlockSkeleton rows={3} height={140} />;
  if (stats.isError) return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  const s = stats.data;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
        <Tile icon={<IconShirt size={20} />} color="violet" title="Продано, шт." value={String(s.soldQty)} caption={`заказов: ${s.orders}`} />
        <Tile icon={<IconCash size={20} />} color="green" title="Получено денег" value={formatMoney(s.revenue)} caption={`продано на ${formatMoney(s.salesTotal)}`} />
        <Tile icon={<IconCoins size={20} />} color="orange" title="Долги" value={formatMoney(s.debt.amount)} caption={`должников: ${s.debt.count}`} />
        <Tile
          icon={<IconAlertTriangle size={20} />}
          color={s.lowStock.some((x) => x.left === 0) ? 'red' : 'yellow'}
          title="Заканчивается"
          value={String(s.lowStock.length)}
          caption={`закончилось: ${s.lowStock.filter((x) => x.left === 0).length}`}
        />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Card padding="md">
          <Text fw={600} mb="xs">
            По вещам
          </Text>
          <Rows rows={s.byProduct.map((x) => ({ key: x.productId, label: x.title, qty: x.qty, amount: x.amount }))} empty="Пока ничего не продали." />
        </Card>
        <Card padding="md">
          <Text fw={600} mb="xs">
            По цветам и размерам
          </Text>
          <Rows rows={s.byItem.map((x) => ({ key: x.title, label: x.title, qty: x.qty, amount: x.amount }))} empty="Пока ничего не продали." />
        </Card>
        <Card padding="md">
          <Text fw={600} mb="xs">
            Деньги по способам
          </Text>
          {s.byMethod.length === 0 ? (
            <Text size="sm" c="dimmed">
              Оплат пока нет.
            </Text>
          ) : (
            <Stack gap={6}>
              {s.byMethod.map((m) => (
                <Group key={m.method} justify="space-between">
                  <Text size="sm">
                    {METHOD[m.method]}{' '}
                    <Text span size="xs" c="dimmed">
                      × {m.count}
                    </Text>
                  </Text>
                  <Text fw={600} style={NUM}>
                    {formatMoney(m.amount)}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Card>
        <Card padding="md">
          <Text fw={600} mb="xs">
            Кто принял деньги
          </Text>
          {s.bySeller.length === 0 ? (
            <Text size="sm" c="dimmed">
              Оплат пока нет.
            </Text>
          ) : (
            <Stack gap={6}>
              {s.bySeller.map((x) => (
                <Group key={x.userId ?? 'none'} justify="space-between" wrap="nowrap">
                  <Text size="sm" truncate>
                    {x.name}{' '}
                    <Text span size="xs" c="dimmed">
                      × {x.count}
                    </Text>
                  </Text>
                  <Text fw={600} style={NUM}>
                    {formatMoney(x.amount)}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Card>
      </SimpleGrid>

      <Card padding="md">
        <Group gap="xs" mb="xs">
          <IconPackage size={18} />
          <Text fw={600}>Что заканчивается (3 шт. и меньше)</Text>
        </Group>
        {s.lowStock.length === 0 ? (
          <Text size="sm" c="dimmed">
            Всего хватает.
          </Text>
        ) : (
          <Group gap="xs">
            {s.lowStock.map((x) => (
              <Badge key={x.variantId} variant="light" color={x.left === 0 ? 'red' : 'yellow'} tt="none" size="lg">
                {x.title}: {x.left === 0 ? 'нет' : `${x.left} из ${x.stock}`}
              </Badge>
            ))}
          </Group>
        )}
      </Card>
    </Stack>
  );
}

function Tile({ icon, color, title, value, caption }: { icon: React.ReactNode; color: string; title: string; value: string; caption: string }) {
  return (
    <Card padding="md">
      <Group gap="xs" c={color}>
        {icon}
        <Text size="sm" fw={600}>
          {title}
        </Text>
      </Group>
      <Text fz={26} fw={800} mt={4} style={NUM}>
        {value}
      </Text>
      <Text size="sm" c="dimmed">
        {caption}
      </Text>
    </Card>
  );
}

function Rows({ rows, empty }: { rows: { key: string | number; label: string; qty: number; amount: string }[]; empty: string }) {
  if (rows.length === 0)
    return (
      <Text size="sm" c="dimmed">
        {empty}
      </Text>
    );
  return (
    <Table verticalSpacing={4} withRowBorders={false}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th ta="right">Шт.</Table.Th>
          <Table.Th ta="right">Сумма</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.key}>
            <Table.Td>{r.label}</Table.Td>
            <Table.Td ta="right" fw={700} style={NUM}>
              {r.qty}
            </Table.Td>
            <Table.Td ta="right" style={NUM}>
              {formatMoney(r.amount)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
