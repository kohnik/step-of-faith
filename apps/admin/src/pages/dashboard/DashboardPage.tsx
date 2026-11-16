import '@mantine/charts/styles.css';

import { BarChart, DonutChart } from '@mantine/charts';
import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  Grid,
  Group,
  Indicator,
  Progress,
  RingProgress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { CATEGORY_LABELS, PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, type DashboardResponse, type Tier, type TiersConfig } from '@sof/shared';
import {
  IconAlertTriangle,
  IconClockHour4,
  IconCircleHalf2,
  IconToolsKitchen2,
  IconCopy,
  IconReceipt2,
  IconRefresh,
  IconUsers,
} from '@tabler/icons-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useDashboard } from '../../api/settings.ts';
import { AppLink } from '../../components/AppLink.tsx';
import { OutcomeBadge } from '../../components/badges.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { useSession, useTiers } from '../../components/SessionProvider.tsx';
import { StatCard } from '../../components/StatCard.tsx';
import { EmptyBlock, ErrorState } from '../../components/states.tsx';
import {
  countLabel,
  formatDateTimeShort,
  formatDayShort,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
  formatTimeSeconds,
} from '../../lib/format.ts';
import { PAYMENT_STATUS_COLORS } from '../../lib/labels.ts';
import { dayKey, offsetLabel, todayKey } from '../../lib/tz.ts';
import { RecentParticipantsCard } from './RecentParticipants.tsx';
import { StaffName } from '../../components/StaffName.tsx';

const QUARTER = 15 * 60_000;

const METHOD_LABEL = { cash: 'наличными', transfer: 'переводом', card: 'картой' } as const;

export default function DashboardPage() {
  const tz = useEventTz();
  const { can, paymentsEnabled } = useSession();
  const dashboard = useDashboard();
  const data = dashboard.data;

  return (
    <Stack gap="lg">
      <PageHeader
        title="Сводка"
        description={`Как идут дела прямо сейчас. Обновляется сама каждые 10 секунд. Время - по часам конференции: ${tz} (${offsetLabel(tz)}).`}
        actions={
          <Group gap="xs">
            {data && (
              <Tooltip label={dashboard.isError ? 'Не получилось обновить - показываем последние данные' : 'Цифры обновляются сами'}>
                <Badge
                  size="lg"
                  variant="light"
                  color={dashboard.isError ? 'red' : 'green'}
                  leftSection={
                    <Indicator processing={!dashboard.isError} color={dashboard.isError ? 'red' : 'green'} size={8} position="middle-center" zIndex={1}>
                      <span />
                    </Indicator>
                  }
                >
                  {dashboard.isError ? 'нет связи' : `обновлено ${formatTimeSeconds(data.generatedAt, tz)}`}
                </Badge>
              </Tooltip>
            )}
            <Tooltip label="Обновить сейчас">
              <ActionIcon variant="default" size="lg" onClick={() => void dashboard.refetch()} loading={dashboard.isFetching} aria-label="Обновить">
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        }
      />

      {dashboard.isError && !data && <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />}

      {/* Вход - наверху: сколько пришло, кто сканирует и проблемы со сканами (во время конференции это главное). */}
      <Grid gap="lg">
        <Grid.Col span={12}>
          <ArrivalsCard data={data} tz={tz} loading={dashboard.isPending} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <ScannersCard data={data} tz={tz} loading={dashboard.isPending} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <AlertsCard data={data} tz={tz} loading={dashboard.isPending} canSeeLog={can('participants:read')} />
        </Grid.Col>
      </Grid>

      {paymentsEnabled && data && data.pendingReceipts > 0 && can('payments:write') && (
        <Alert variant="light" color="yellow" radius="lg" icon={<IconReceipt2 size={20} />}>
          <Group justify="space-between" gap="sm">
            <Text size="sm">
              Ждут проверки чеков: <b>{formatNumber(data.pendingReceipts)}</b>
            </Text>
            <AppLink href="/payments" size="sm" fw={600}>
              Посмотреть →
            </AppLink>
          </Group>
        </Alert>
      )}

      <StatCards
        data={data}
        loading={dashboard.isPending}
        canReceipts={can('payments:write')}
        canPeople={can('participants:read')}
        payments={paymentsEnabled}
      />

      {can('participants:read') && (
        <RecentParticipantsCard
          tz={tz}
          refreshKey={data ? `${data.participants.active}:${data.participants.cancelled}:${data.arrival.arrived}` : ''}
        />
      )}

      <VisitsCard data={data} loading={dashboard.isPending} />
      <TrafficCard data={data} tz={tz} loading={dashboard.isPending} />

      <Grid gap="lg">
        {paymentsEnabled && (
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <PaymentsCard data={data} loading={dashboard.isPending} />
          </Grid.Col>
        )}
        <Grid.Col span={{ base: 12, lg: paymentsEnabled ? 4 : 6 }}>
          <CategoriesCard data={data} loading={dashboard.isPending} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: paymentsEnabled ? 4 : 6 }}>
          <ActivitiesCard data={data} tz={tz} loading={dashboard.isPending} />
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function CardTitle({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="md" gap="sm">
      <div>
        <Title order={4} fz="md">
          {title}
        </Title>
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
      </div>
      {right}
    </Group>
  );
}

/** «завтраков: 80 из 100 · вариант с питанием: 200 из 250» - с лимитами из настроек. */
function mealsHint(data: DashboardResponse, tiers: TiersConfig): string {
  const count = (t: Tier) => data.byTier.find((b) => b.tier === t)?.total ?? 0;
  const of = (n: number, limit: number | null) => (limit ? `${formatNumber(n)} из ${formatNumber(limit)}` : formatNumber(n));
  const parts = [`завтраков: ${of(data.meals?.breakfast ?? 0, data.meals?.breakfastLimit ?? null)}`];
  if (tiers.fee35.limit) parts.push(`«${tiers.fee35.label}»: ${of(count('fee35'), tiers.fee35.limit)}`);
  return parts.join(' · ');
}

function StatCards({
  data,
  loading,
  canReceipts,
  canPeople,
  payments,
}: {
  data?: DashboardResponse;
  loading: boolean;
  canReceipts: boolean;
  canPeople: boolean;
  /** Приём оплаты включён - показываем карточку про оплату. */
  payments: boolean;
}) {
  const tiers = useTiers();
  const p = data?.payments;
  const active = data?.participants.active ?? 0;
  // «Оплачено» - внесли полностью или без взноса; остальное - не оплатили, частично или чек на проверке.
  const paid = (p?.paid ?? 0) + (p?.exempt ?? 0);
  const unpaid = (p?.unpaid ?? 0) + (p?.partial ?? 0);
  const pending = p?.pending ?? 0;
  // Оплата не подтверждена: не внесли, внесли частично или чек ещё на проверке - список, где можно принять оплату.
  const notConfirmed = unpaid + pending;
  const paidPct = active ? Math.round((paid / active) * 100) : 0;
  // Пришли на конференцию - отметили на входе хоть раз: браслет выдают один раз, на 2-й день людей не сканируют.
  const eventDay = data?.arrival.eventDay ?? false;
  const arrived = data?.arrival.arrived ?? 0;
  const scannedToday = data?.arrival.today ?? 0;
  const expected = data?.arrival.expected ?? 0;
  const arrivedPct = expected ? Math.round((arrived / expected) * 100) : 0;

  const outOf = (n: number, total: number) => (
    <>
      {formatNumber(n)}
      <Text span c="dimmed" fz="md" fw={600}>
        {' '}
        из {formatNumber(total)}
      </Text>
    </>
  );
  const ring = (pct: number, color: string) => (
    <RingProgress
      size={78}
      thickness={8}
      roundCaps
      sections={[{ value: pct, color }]}
      label={
        <Text ta="center" fw={700} size="sm">
          {pct}%
        </Text>
      }
    />
  );

  return (
    <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
      <StatCard
        label="Участников"
        value={formatNumber(active)}
        hint={
          data
            ? [
                data.participants.cancelled ? `ещё ${formatNumber(data.participants.cancelled)} отменили участие` : 'никто не отменил участие',
                data.under16 ? `до 16 лет: ${formatNumber(data.under16)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        icon={<IconUsers size={22} />}
        loading={loading}
      />
      <StatCard
        label="Пришли на конференцию"
        value={outOf(arrived, expected)}
        hint={
          data ? (
            <>
              ещё не приходили {formatNumber(Math.max(0, expected - arrived))} ·{' '}
              {eventDay && scannedToday > 0 && <>сегодня отсканировали {formatNumber(scannedToday)} · </>}
              <AppLink href="/participants/confirmed" size="sm">
                кто пришёл →
              </AppLink>
            </>
          ) : undefined
        }
        loading={loading}
        side={ring(arrivedPct, 'teal')}
      />
      {payments && (
        <StatCard
          label="Оплачено"
          value={outOf(paid, active)}
          hint={
            data ? (
              <>
                {notConfirmed === 0 ? (
                  'все оплаты подтверждены'
                ) : canPeople ? (
                  <AppLink href="/participants?payment=unpaid,partial,pending" size="sm" fw={600}>
                    не подтверждены: {formatNumber(notConfirmed)} →
                  </AppLink>
                ) : (
                  `не подтверждены: ${formatNumber(notConfirmed)}`
                )}
                {p?.partial ? ` · частично ${formatNumber(p.partial)}` : ''}
                {/* «Без взноса» входит в «оплачено» - иначе цифра не сходится с разбивкой по статусам. */}
                {p?.exempt ? ` · в т. ч. без взноса ${formatNumber(p.exempt)}` : ''}
                {pending > 0 && (
                  <>
                    {' · '}
                    {canReceipts ? (
                      <AppLink href="/payments" size="sm">
                        чек на проверке: {formatNumber(pending)} →
                      </AppLink>
                    ) : (
                      `чек на проверке: ${formatNumber(pending)}`
                    )}
                  </>
                )}
                <br />
                получено {formatMoney(data.money?.received ?? 0)} из {formatMoney(data.money?.expected ?? 0)}
                {!!data.money?.byMethod?.length && (
                  <>
                    <br />
                    {data.money.byMethod.map((m) => `${METHOD_LABEL[m.method]} ${formatMoney(m.amount)}`).join(' · ')}
                  </>
                )}
                {!!data.money?.donations?.count && (
                  <>
                    <br />
                    пожертвования: {formatMoney(data.money.donations.amount)} ({formatNumber(data.money.donations.count)} раз)
                  </>
                )}
              </>
            ) : undefined
          }
          loading={loading}
          side={ring(paidPct, 'green')}
        />
      )}
      <StatCard
        label="Питание во 2-й день"
        value={
          <>
            {formatNumber(data?.meals?.lunchDinner ?? 0)}
            <Text span c="dimmed" fz="md" fw={600}>
              {' '}
              обедов и ужинов
            </Text>
          </>
        }
        hint={data ? mealsHint(data, tiers) : undefined}
        icon={<IconToolsKitchen2 size={22} />}
        color="orange"
        loading={loading}
      />
      {/* Браслеты на входе: чёрный - с питанием, белый - без. Сколько положено и сколько уже пришли. */}
      <StatCard
        label="Браслеты"
        value={
          <Group gap="lg" wrap="nowrap">
            <span>
              ⚫️ {formatNumber(data?.meals?.bracelets?.black.total ?? 0)}
              <Text span c="dimmed" fz="sm" fw={600}>
                {' '}
                чёрных
              </Text>
            </span>
            <span>
              ⚪️ {formatNumber(data?.meals?.bracelets?.white.total ?? 0)}
              <Text span c="dimmed" fz="sm" fw={600}>
                {' '}
                белых
              </Text>
            </span>
          </Group>
        }
        hint={
          data?.meals?.bracelets
            ? `Пришли: с чёрным ${formatNumber(data.meals.bracelets.black.arrived)}, с белым ${formatNumber(data.meals.bracelets.white.arrived)}. Чёрный - обед и ужин, белый - без питания.`
            : undefined
        }
        icon={<IconCircleHalf2 size={22} />}
        color="dark"
        loading={loading}
      />
    </SimpleGrid>
  );
}

function ArrivalsCard({ data, tz, loading }: { data?: DashboardResponse; tz: string; loading: boolean }) {
  const buckets = data?.arrivalsByQuarterHour ?? [];
  const days = useMemo(() => [...new Set(buckets.map((b) => dayKey(b.t, tz)))].sort(), [buckets, tz]);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const today = todayKey(tz);
  const day = pickedDay && days.includes(pickedDay) ? pickedDay : days.includes(today) ? today : (days[days.length - 1] ?? null);

  const chart = useMemo(() => {
    if (!day) return [];
    const inDay = buckets.filter((b) => dayKey(b.t, tz) === day).sort((a, b) => a.t.localeCompare(b.t));
    const first = inDay[0];
    const last = inDay[inDay.length - 1];
    if (!first || !last) return [];
    const byTime = new Map(inDay.map((b) => [new Date(b.t).getTime(), b.n]));
    const out: { time: string; Пришли: number }[] = [];
    for (let t = new Date(first.t).getTime(); t <= new Date(last.t).getTime(); t += QUARTER) {
      out.push({ time: formatTime(new Date(t), tz), Пришли: byTime.get(t) ?? 0 });
    }
    return out;
  }, [buckets, day, tz]);

  const dayTotal = chart.reduce((s, r) => s + r.Пришли, 0);
  const peak = chart.reduce((m, r) => (r.Пришли > m.Пришли ? r : m), { time: '', Пришли: 0 });

  return (
    <Card h="100%">
      <CardTitle
        title="Сколько пришло (по 15 минут)"
        hint={day ? `${countLabel(dayTotal, ['отметка', 'отметки', 'отметок'])} на входе${peak.Пришли ? ` · пик ${peak.time} (${peak.Пришли})` : ''}` : 'Отметки на входе за последние 72 часа'}
        right={
          days.length > 1 ? (
            <SegmentedControl
              size="xs"
              value={day ?? undefined}
              onChange={setPickedDay}
              data={days.map((d) => ({ value: d, label: formatDayShort(d) }))}
            />
          ) : undefined
        }
      />
      {loading ? (
        <Skeleton height={260} radius="md" />
      ) : chart.length === 0 ? (
        <EmptyBlock icon={<IconClockHour4 size={28} />} title="Пока никто не пришёл" description="Здесь появится график, когда начнутся отметки на входе." />
      ) : (
        <BarChart
          h={260}
          data={chart}
          dataKey="time"
          series={[{ name: 'Пришли', color: 'indigo.6' }]}
          tickLine="y"
          gridAxis="y"
          maxBarWidth={28}
          xAxisProps={{ interval: 'preserveStartEnd', minTickGap: 12 }}
          valueFormatter={(v) => formatNumber(v)}
        />
      )}
    </Card>
  );
}

/** Сколько разных людей заходит в бота и в Mini App: сегодня, вчера, в среднем и по дням за две недели. */
function VisitsCard({ data, loading }: { data?: DashboardResponse; loading: boolean }) {
  const days = data?.visits ?? [];
  const today = days.at(-1);
  const yesterday = days.at(-2);
  const week = days.slice(-7);
  const avg = week.length ? Math.round(week.reduce((s, d) => s + d.total, 0) / week.length) : 0;
  const chart = days.map((d) => ({ day: formatDayShort(d.day), 'В боте': d.bot, 'В приложении': d.app }));
  const stat = (label: string, value: number, sub?: string) => (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={26} fw={700} lh={1.2}>
        {formatNumber(value)}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </div>
  );
  return (
    <Card>
      <CardTitle title="Заходы в бота и приложение" hint="Разные люди за день: каждый считается один раз, сколько бы раз ни открывал" />
      {loading ? (
        <Skeleton height={220} radius="md" />
      ) : (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
            {stat('Сегодня', today?.total ?? 0, today ? `бот ${formatNumber(today.bot)} · приложение ${formatNumber(today.app)}` : undefined)}
            {stat('Новых сегодня', today?.new ?? 0, 'впервые открыли бота или приложение')}
            {stat('Вчера', yesterday?.total ?? 0, yesterday ? `бот ${formatNumber(yesterday.bot)} · приложение ${formatNumber(yesterday.app)}` : undefined)}
            {stat('В среднем за день', avg, 'за последние 7 дней')}
          </SimpleGrid>
          {days.some((d) => d.total > 0) && (
            <BarChart
              h={200}
              data={chart}
              dataKey="day"
              series={[
                { name: 'В боте', color: 'indigo.6' },
                { name: 'В приложении', color: 'teal.6' },
              ]}
              tickLine="y"
              gridAxis="y"
              maxBarWidth={18}
              withLegend
              yAxisProps={{ allowDecimals: false }}
              xAxisProps={{ interval: 'preserveStartEnd', minTickGap: 12 }}
              valueFormatter={(v) => formatNumber(v)}
            />
          )}
        </Stack>
      )}
    </Card>
  );
}

/** Нагрузка: сколько запросов приходит в бота (сообщения, кнопки) и в приложение - по часам и по дням. */
function TrafficCard({ data, tz, loading }: { data?: DashboardResponse; tz: string; loading: boolean }) {
  const [range, setRange] = useState<'hours' | 'days'>('hours');
  const hours = data?.traffic.hours ?? [];
  const days = data?.traffic.days ?? [];
  const sum = (x?: { bot: number; app: number }) => (x ? x.bot + x.app : 0);
  const thisHour = hours.at(-1);
  const today = days.at(-1);
  const peak = hours.reduce<(typeof hours)[number] | undefined>((m, h) => (sum(h) > sum(m) ? h : m), undefined);
  const chart =
    range === 'hours'
      ? hours.map((h) => ({ label: formatTime(h.at, tz), Бот: h.bot, Приложение: h.app }))
      : days.map((d) => ({ label: formatDayShort(d.day), Бот: d.bot, Приложение: d.app }));
  const stat = (label: string, value: number, sub?: string) => (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={26} fw={700} lh={1.2}>
        {formatNumber(value)}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </div>
  );
  return (
    <Card>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
        <CardTitle title="Нагрузка" hint="Сколько запросов приходит: в бота - сообщения и нажатия кнопок, в приложение - каждое действие в нём" />
        <SegmentedControl
          size="xs"
          value={range}
          onChange={(v) => setRange(v as 'hours' | 'days')}
          data={[
            { value: 'hours', label: '48 часов' },
            { value: 'days', label: '14 дней' },
          ]}
        />
      </Group>
      {loading ? (
        <Skeleton height={220} radius="md" />
      ) : (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
            {stat('За этот час', sum(thisHour), thisHour ? `бот ${formatNumber(thisHour.bot)} · приложение ${formatNumber(thisHour.app)}` : undefined)}
            {stat('Сегодня', sum(today), today ? `бот ${formatNumber(today.bot)} · приложение ${formatNumber(today.app)}` : undefined)}
            {stat('Пик за 48 часов', sum(peak), peak && sum(peak) > 0 ? `в час с ${formatTime(peak.at, tz)}` : undefined)}
          </SimpleGrid>
          {chart.some((x) => x.Бот + x.Приложение > 0) ? (
            <BarChart
              h={200}
              data={chart}
              dataKey="label"
              type="stacked"
              series={[
                { name: 'Бот', color: 'indigo.6' },
                { name: 'Приложение', color: 'teal.6' },
              ]}
              tickLine="y"
              gridAxis="y"
              maxBarWidth={18}
              withLegend
              yAxisProps={{ allowDecimals: false }}
              xAxisProps={{ interval: 'preserveStartEnd', minTickGap: 16 }}
              valueFormatter={(v) => formatNumber(v)}
            />
          ) : (
            <Text size="sm" c="dimmed">
              Считаем с 3 ноября - график появится, как только придут первые запросы.
            </Text>
          )}
          {(data?.traffic.top.length ?? 0) > 0 && (
            <div>
              <Text fw={600} size="sm" mb={4}>
                Больше всех за 24 часа
              </Text>
              <Table.ScrollContainer minWidth={300}>
              <Table verticalSpacing={4} horizontalSpacing={6} withRowBorders={false} fz="sm" layout="fixed">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Кто</Table.Th>
                    <Table.Th ta="right" w={44}>
                      Бот
                    </Table.Th>
                    <Table.Th ta="right" w={52}>
                      Прил.
                    </Table.Th>
                    <Table.Th ta="right" w={56}>
                      Всего
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data!.traffic.top.map((u) => (
                    <Table.Tr key={u.userId}>
                      {/* Ник - под именем, длинное имя обрезаем: на телефоне таблица должна влезать. */}
                      <Table.Td style={{ overflow: 'hidden' }}>
                        <AppLink href={`/messages/${u.userId}`} size="sm" display="block" truncate="end">
                          {u.name}
                        </AppLink>
                        {u.username && (
                          <Text size="xs" c="dimmed" truncate="end">
                            @{u.username}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatNumber(u.bot)}
                      </Table.Td>
                      <Table.Td ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatNumber(u.app)}
                      </Table.Td>
                      <Table.Td ta="right" fw={700} style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatNumber(u.bot + u.app)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              </Table.ScrollContainer>
            </div>
          )}
        </Stack>
      )}
    </Card>
  );
}

function PaymentsCard({ data, loading }: { data?: DashboardResponse; loading: boolean }) {
  const total = data?.participants.active ?? 0;
  const rows = PAYMENT_STATUSES.map((s) => ({
    status: s,
    name: PAYMENT_STATUS_LABELS[s],
    value: data?.payments[s] ?? 0,
    color: `${PAYMENT_STATUS_COLORS[s]}.6`,
  }));
  const nonZero = rows.filter((r) => r.value > 0);
  return (
    <Card h="100%">
      <CardTitle title="Оплаты" hint="Сколько участников оплатили и сколько ещё нет" />
      {loading ? (
        <Skeleton height={260} radius="md" />
      ) : total === 0 ? (
        <EmptyBlock title="Пока нет участников" />
      ) : (
        <Stack gap="md" align="center">
          <DonutChart
            data={nonZero.map(({ name, value, color }) => ({ name, value, color }))}
            size={170}
            thickness={24}
            paddingAngle={2}
            chartLabel={formatNumber(total)}
            tooltipDataSource="segment"
            valueFormatter={(v) => `${formatNumber(v)} (${formatPercent(v, total)})`}
          />
          <Stack gap={6} w="100%">
            {rows.map((r) => (
              <Group key={r.status} justify="space-between" gap="xs" wrap="nowrap">
                <Group gap={8} wrap="nowrap">
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: `var(--mantine-color-${PAYMENT_STATUS_COLORS[r.status]}-6)`,
                      flexShrink: 0,
                    }}
                  />
                  <Text size="sm">{r.name}</Text>
                </Group>
                <Text size="sm" fw={600} className="sof-tabular">
                  {formatNumber(r.value)}{' '}
                  <Text span c="dimmed" size="xs" fw={400}>
                    {formatPercent(r.value, total)}
                  </Text>
                </Text>
              </Group>
            ))}
          </Stack>
        </Stack>
      )}
    </Card>
  );
}

function CategoriesCard({ data, loading }: { data?: DashboardResponse; loading: boolean }) {
  const chart = (data?.byCategory ?? []).map((c) => ({
    category: CATEGORY_LABELS[c.category],
    Всего: c.total,
    Пришли: c.arrived,
  }));
  return (
    <Card h="100%">
      <CardTitle title="По категориям" hint="Сколько зарегистрировано и сколько уже пришло" />
      {loading ? (
        <Skeleton height={260} radius="md" />
      ) : chart.length === 0 ? (
        <EmptyBlock title="Пока нет участников" />
      ) : (
        <BarChart
          h={260}
          data={chart}
          dataKey="category"
          withLegend
          legendProps={{ verticalAlign: 'bottom', height: 36 }}
          series={[
            { name: 'Всего', color: 'indigo.3' },
            { name: 'Пришли', color: 'teal.6' },
          ]}
          tickLine="y"
          gridAxis="y"
          maxBarWidth={36}
          valueFormatter={(v) => formatNumber(v)}
        />
      )}
    </Card>
  );
}

function ActivitiesCard({ data, tz, loading }: { data?: DashboardResponse; tz: string; loading: boolean }) {
  const rows = data?.activities ?? [];
  return (
    <Card h="100%">
      <CardTitle
        title="Активности с записью"
        hint="Те, что сейчас идут или ещё впереди"
        right={
          <AppLink href="/activities" size="sm">
            Расписание →
          </AppLink>
        }
      />
      {loading ? (
        <Stack gap="xs">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={34} />
          ))}
        </Stack>
      ) : rows.length === 0 ? (
        <EmptyBlock title="Активностей с записью пока нет" description="Когда появятся активности «по записи», здесь будет видно, сколько мест занято." />
      ) : (
        <ScrollArea.Autosize mah={300}>
          <Table verticalSpacing={8}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Активность</Table.Th>
                <Table.Th w={110}>Начало</Table.Th>
                <Table.Th w={170}>Записано</Table.Th>
                <Table.Th w={80} ta="right">
                  Ожидают
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((a) => {
                const pct = a.capacity ? Math.min(100, Math.round((a.registered / a.capacity) * 100)) : 0;
                const full = a.capacity !== null && a.registered >= a.capacity;
                return (
                  <Table.Tr key={a.id}>
                    <Table.Td>
                      <Text size="sm" fw={500} lineClamp={2}>
                        {a.title}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatDateTimeShort(a.startsAt, tz)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={4}>
                        <Text size="xs" className="sof-tabular">
                          {formatNumber(a.registered)}
                          {a.capacity !== null ? ` / ${formatNumber(a.capacity)}` : ' · без лимита'}
                        </Text>
                        {a.capacity !== null && <Progress value={pct} color={full ? 'red' : pct > 80 ? 'orange' : 'indigo'} size="sm" />}
                      </Stack>
                    </Table.Td>
                    <Table.Td ta="right">
                      {a.waitlist > 0 ? (
                        <Badge color="yellow" variant="light">
                          {a.waitlist}
                        </Badge>
                      ) : (
                        <Text size="sm" c="dimmed">
                          -
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}

function ScannersCard({ data, tz, loading }: { data?: DashboardResponse; tz: string; loading: boolean }) {
  const rows = data?.scanners ?? [];
  const max = rows[0]?.count ?? 0;
  return (
    <Card h="100%">
      <CardTitle title="Кто отмечал за сутки" hint="Сколько гостей отметил каждый сканер" />
      {loading ? (
        <Stack gap="xs">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={30} />
          ))}
        </Stack>
      ) : rows.length === 0 ? (
        <EmptyBlock title="Пока нет отметок" />
      ) : (
        <ScrollArea.Autosize mah={320}>
          <Stack gap="sm">
            {rows.slice(0, 15).map((s, i) => (
              <div key={`${s.name}-${i}`}>
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Text size="sm" fw={500} truncate>
                    {i + 1}. <StaffName name={s.name} username={s.username} />
                  </Text>
                  <Tooltip label={`Последняя отметка: ${formatTime(s.lastAt, tz)}`}>
                    <Text size="sm" className="sof-tabular" fw={700}>
                      {formatNumber(s.count)}{' '}
                      <Text span size="xs" c="dimmed" fw={400}>
                        · {formatRelative(s.lastAt)}
                      </Text>
                    </Text>
                  </Tooltip>
                </Group>
                <Progress value={max ? (s.count / max) * 100 : 0} size="xs" mt={4} color="indigo" />
              </div>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}

function AlertsCard({ data, tz, loading, canSeeLog }: { data?: DashboardResponse; tz: string; loading: boolean; canSeeLog: boolean }) {
  const alerts = data?.alerts;
  return (
    <Card h="100%">
      <CardTitle
        title="На что обратить внимание"
        hint="Повторные и неверные сканы за сутки"
        right={
          canSeeLog ? (
            <AppLink href="/checkin?tab=scans" size="sm">
              Журнал сканов →
            </AppLink>
          ) : undefined
        }
      />
      {loading ? (
        <Skeleton height={200} radius="md" />
      ) : !alerts ? null : (
        <Stack gap="md">
          <SimpleGrid cols={2} spacing="sm">
            <Card padding="sm" radius="md" bg="var(--mantine-color-yellow-light)" withBorder={false}>
              <Group gap="xs" wrap="nowrap">
                <IconCopy size={20} color="var(--mantine-color-yellow-filled)" />
                <div>
                  <Text fw={800} fz="xl" lh={1.1} className="sof-tabular">
                    {formatNumber(alerts.duplicates)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    повторных сканов
                  </Text>
                </div>
              </Group>
            </Card>
            <Card padding="sm" radius="md" bg="var(--mantine-color-red-light)" withBorder={false}>
              <Group gap="xs" wrap="nowrap">
                <IconAlertTriangle size={20} color="var(--mantine-color-red-filled)" />
                <div>
                  <Text fw={800} fz="xl" lh={1.1} className="sof-tabular">
                    {formatNumber(alerts.invalid)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    неверных и отключённых кодов
                  </Text>
                </div>
              </Group>
            </Card>
          </SimpleGrid>
          {alerts.recent.length === 0 ? (
            <Text size="sm" c="dimmed">
              Всё спокойно - подозрительных сканов не было.
            </Text>
          ) : (
            <ScrollArea.Autosize mah={260}>
              <Table verticalSpacing={6}>
                <Table.Tbody>
                  {alerts.recent.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td w={64}>
                        <Text size="xs" c="dimmed" className="sof-tabular">
                          {formatTime(r.createdAt, tz)}
                        </Text>
                      </Table.Td>
                      <Table.Td w={150}>
                        <OutcomeBadge outcome={r.outcome} size="xs" />
                      </Table.Td>
                      <Table.Td>
                        {r.fullName ? (
                          <ParticipantLink id={r.participantId} name={r.fullName} size="xs" />
                        ) : (
                          <Text size="xs" className="sof-mono" c="dimmed" truncate maw={220}>
                            {r.rawCode ?? '-'}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td visibleFrom="sm">
                        <Text size="xs" c="dimmed" truncate maw={200}>
                          {[r.checkpointName, r.staffName].filter(Boolean).join(' · ') || '-'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}
        </Stack>
      )}
    </Card>
  );
}
