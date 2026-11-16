import { Anchor, Badge, Card, Collapse, Group, SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import {
  BOT_OUTCOME_LABELS,
  BOT_TOPIC_LABELS,
  BOT_TOPICS,
  type BotMessageRow,
  type BotOutcome,
  type BotRunView,
  type BotScheduledItem,
  type BotTone,
  type BotTopic,
} from '@sof/shared';
import { IconChevronDown, IconClockHour4, IconMessageCircle, IconRobot, IconSearch } from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';
import { useMemo, useState } from 'react';
import { useBotLog, useBotRun, useBotUnreachable } from '../../api/botlog.ts';
import { AppLink } from '../../components/AppLink.tsx';
import { AppModal } from '../../components/AppModal.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatDateTime, formatDateTimeShort, formatNumber, formatTime } from '../../lib/format.ts';

const TONE: Record<BotTone, string> = { green: 'green', yellow: 'yellow', red: 'red', gray: 'gray' };
const OUTCOME_COLOR: Record<BotOutcome, string> = { sent: 'green', blocked: 'red', unreachable: 'orange', no_telegram: 'gray', failed: 'red' };

/**
 * Сообщения бота: что бот отправил сам (напоминания, вопросы, ответы на действия) и ручные рассылки -
 * запуски с цифрами, кому ушло и что ответили, что запланировано, до кого бот не достучится.
 */
/** На телефоне - карточки вместо таблиц: широкая таблица не влезает, а прокрутка вбок прячет цифры. */
const useNarrow = () => useMediaQuery('(max-width: 48em)') ?? false;

export default function BotLogPage() {
  const tz = useEventTz();
  const narrow = useNarrow();
  const q = useBotLog();
  const [topic, setTopic] = useState<BotTopic | 'all'>('all');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [open, setOpen] = useState<BotRunView | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const runs = useMemo(
    () => (q.data?.runs ?? []).filter((r) => (topic === 'all' || r.topic === topic) && (!onlyFailed || r.failed > 0)),
    [q.data, topic, onlyFailed],
  );
  const u = q.data?.unreachable;

  return (
    <Stack gap="md">
      <PageHeader
        title="Сообщения бота"
        description="Что бот отправил сам: напоминания, вопросы, ответы на действия - и ручные рассылки. Нажмите на запуск: кому ушло, кто не получил и что ответили. Журнал ведётся с 6 ноября."
        actions={
          <AppLink href="/broadcasts" size="sm">
            Ручные рассылки →
          </AppLink>
        }
      />
      {q.isPending ? (
        <BlockSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
            <Card padding="md">
              <Text size="sm" fw={600} c="green">
                Сегодня дошло
              </Text>
              <Text fz={28} fw={800}>
                {formatNumber(q.data.today.sent)}
              </Text>
            </Card>
            <Card padding="md">
              <Text size="sm" fw={600} c={q.data.today.failed ? 'red' : 'dimmed'}>
                Сегодня не дошло
              </Text>
              <Text fz={28} fw={800}>
                {formatNumber(q.data.today.failed)}
              </Text>
              <Text size="xs" c="dimmed">
                заблокировали бота, не открывали его, нет Telegram или сбой
              </Text>
            </Card>
            <UnstyledButton onClick={() => setUnreachable(true)}>
              <Card padding="md" h="100%">
                <Text size="sm" fw={600} c="orange">
                  Не достучимся
                </Text>
                <Text fz={28} fw={800}>
                  {formatNumber((u?.blocked ?? 0) + (u?.unreachable ?? 0) + (u?.noTelegram ?? 0))}
                </Text>
                <Text size="xs" c="dimmed">
                  заблокировали {u?.blocked ?? 0} · не открывали бота {u?.unreachable ?? 0} · без Telegram {u?.noTelegram ?? 0} · список →
                </Text>
              </Card>
            </UnstyledButton>
          </SimpleGrid>

          <Card>
            <Group gap="xs" mb="xs">
              <IconClockHour4 size={18} />
              <Title order={4} fz="md">
                Запланировано
              </Title>
            </Group>
            {q.data.scheduled.length === 0 ? (
              <Text size="sm" c="dimmed">
                Ничего не ждёт отправки.
              </Text>
            ) : (
              <Stack gap={4}>
                {q.data.scheduled.map((s) => (
                  <ScheduledRow key={`${s.name}:${s.at}`} s={s} tz={tz} narrow={narrow} />
                ))}
              </Stack>
            )}
          </Card>

          <Card>
            <Group justify="space-between" mb="sm" wrap="wrap">
              <Title order={4} fz="md">
                Запуски за 3 дня
              </Title>
              <Group gap="sm">
                <Select
                  size="xs"
                  w={200}
                  allowDeselect={false}
                  value={topic}
                  onChange={(v) => setTopic((v ?? 'all') as BotTopic | 'all')}
                  data={[{ value: 'all', label: 'Все темы' }, ...BOT_TOPICS.map((t) => ({ value: t, label: BOT_TOPIC_LABELS[t] }))]}
                />
                <Switch size="xs" label="Только где не дошло" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.currentTarget.checked)} />
              </Group>
            </Group>
            {runs.length === 0 ? (
              <EmptyBlock icon={<IconRobot size={28} />} title="Пока пусто" description="Здесь появятся сообщения, которые бот отправит после обновления." />
            ) : narrow ? (
              <Stack gap="xs">
                {runs.map((r) => (
                  <UnstyledButton key={r.key} onClick={() => setOpen(r)} style={{ borderRadius: 12 }}>
                    <Card withBorder padding="sm">
                      <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
                        <div style={{ minWidth: 0 }}>
                          <Text size="sm" fw={600} lh={1.3}>
                            {r.label}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {formatDateTimeShort(r.at, tz)} · {BOT_TOPIC_LABELS[r.topic]}
                          </Text>
                        </div>
                        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                          подробнее →
                        </Text>
                      </Group>
                      <Group gap={4} mt={6}>
                        <Badge color="green" variant="light">
                          дошло {r.sent}
                        </Badge>
                        {r.failed > 0 && (
                          <Badge color="red" variant="light">
                            не дошло {r.failed}
                          </Badge>
                        )}
                        {r.answers?.map((a) => (
                          <Badge key={a.label} color={TONE[a.tone]} variant="light" style={{ textTransform: 'none' }}>
                            {a.label} {a.count}
                          </Badge>
                        ))}
                      </Group>
                    </Card>
                  </UnstyledButton>
                ))}
              </Stack>
            ) : (
              <Table.ScrollContainer minWidth={720}>
                <Table highlightOnHover verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Когда</Table.Th>
                      <Table.Th>Что</Table.Th>
                      <Table.Th>Кому</Table.Th>
                      <Table.Th>Дошло</Table.Th>
                      <Table.Th>Не дошло</Table.Th>
                      <Table.Th>Ответы</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {runs.map((r) => (
                      <Table.Tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => setOpen(r)}>
                        <Table.Td>
                          <Text size="sm" fw={600}>
                            {formatDateTime(r.at, tz)}
                          </Text>
                          {r.lastAt.slice(0, 16) !== r.at.slice(0, 16) && (
                            <Text size="xs" c="dimmed">
                              до {formatTime(r.lastAt, tz)}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{r.label}</Text>
                          <Text size="xs" c="dimmed">
                            {BOT_TOPIC_LABELS[r.topic]}
                          </Text>
                        </Table.Td>
                        <Table.Td>{formatNumber(r.total)}</Table.Td>
                        <Table.Td>
                          <Text size="sm" c="green" fw={600}>
                            {formatNumber(r.sent)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c={r.failed ? 'red' : 'dimmed'} fw={r.failed ? 700 : 400}>
                            {formatNumber(r.failed)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4}>
                            {r.answers?.map((a) => (
                              <Badge key={a.label} color={TONE[a.tone]} variant="light" style={{ textTransform: 'none' }}>
                                {a.label} {a.count}
                              </Badge>
                            ))}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Card>
        </>
      )}
      <RunModal run={open} onClose={() => setOpen(null)} />
      <UnreachableModal opened={unreachable} onClose={() => setUnreachable(false)} />
    </Stack>
  );
}

/** Строка «Запланировано»: нажать - о чём, кому и как будет выглядеть сообщение. */
function ScheduledRow({ s, tz, narrow }: { s: BotScheduledItem; tz: string; narrow: boolean }) {
  const [open, setOpen] = useState(false);
  const who = s.recipients;
  return (
    <div>
      <UnstyledButton onClick={() => setOpen((v) => !v)} w="100%">
        <Group gap="sm" wrap="nowrap">
          <Text size="sm" fw={700} w={narrow ? 92 : 110} style={{ flexShrink: 0 }}>
            {formatDateTimeShort(s.at, tz)}
          </Text>
          <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
            {s.label}
            {s.lines[0] && !open ? (
              <Text span size="xs" c="dimmed">
                {' '}
                · {s.lines[0].replace(/ - .*$/, '')}
                {s.lines.length > 1 ? ` и ещё ${s.lines.length - 1}` : ''}
              </Text>
            ) : null}
          </Text>
          <Badge variant="light" color={who === 0 ? 'red' : 'gray'} style={{ flexShrink: 0, textTransform: 'none' }}>
            {who === null ? s.count : who === 0 ? 'никому' : `${who} чел.`}
          </Badge>
          <IconChevronDown size={14} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined }} />
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Stack gap={4} pl={narrow ? 0 : 118} py={6}>
          {s.lines.map((l) => (
            <Text key={l} size="xs">
              • {l}
            </Text>
          ))}
          {s.preview && (
            <Card withBorder padding="xs" radius="md">
              <Text size="xs" c="dimmed" mb={2}>
                Так будет выглядеть сообщение:
              </Text>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {s.preview}
              </Text>
            </Card>
          )}
          {who === 0 && s.name === 'activity.reminder' && (
            <Text size="xs" c="red">
              Напоминание уйдёт только тем, кто записан на мероприятие или нажал «Напомнить» - сейчас таких нет.
            </Text>
          )}
        </Stack>
      </Collapse>
    </div>
  );
}

type RowFilter = 'all' | 'failed' | 'noanswer';

/** Запуск: каждый человек - дошло ли, что ответил, начало текста. */
function RunModal({ run, onClose }: { run: BotRunView | null; onClose: () => void }) {
  const tz = useEventTz();
  const narrow = useNarrow();
  const q = useBotRun(run?.key ?? null);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const rows = (q.data?.rows ?? []).filter(
    (r) =>
      (filter === 'all' || (filter === 'failed' && r.outcome !== 'sent') || (filter === 'noanswer' && (!r.answer || r.answer.tone !== 'green'))) &&
      (!term || `${r.userName} ${r.username ?? ''}`.toLowerCase().includes(term)),
  );
  return (
    <AppModal opened={run !== null} onClose={onClose} size="xl" title={<Text fw={700}>{run ? `${run.label} · ${formatDateTime(run.at, tz)}` : ''}</Text>}>
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Stack gap="sm">
          <Group gap="xs">
            <Badge color="green" variant="light">
              дошло {q.data.run.sent}
            </Badge>
            <Badge color={q.data.run.failed ? 'red' : 'gray'} variant="light">
              не дошло {q.data.run.failed}
            </Badge>
            {q.data.run.answers?.map((a) => (
              <Badge key={a.label} color={TONE[a.tone]} variant="light" style={{ textTransform: 'none' }}>
                {a.label} {a.count}
              </Badge>
            ))}
          </Group>
          <Group gap="sm" wrap="wrap">
            <TextInput size="xs" placeholder="Имя или ник" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
            <SegmentedControl
              size="xs"
              value={filter}
              onChange={(v) => setFilter(v as RowFilter)}
              data={[
                { value: 'all', label: 'Все' },
                { value: 'failed', label: 'Не дошло' },
                ...(q.data.run.answers ? [{ value: 'noanswer', label: 'Без «Да»' }] : []),
              ]}
            />
          </Group>
          {narrow ? (
            <Stack gap={6}>
              {rows.map((r) => (
                <MessageCard key={`${r.id}:${r.userId}`} r={r} tz={tz} />
              ))}
            </Stack>
          ) : (
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing={6}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Кому</Table.Th>
                    <Table.Th>Итог</Table.Th>
                    {q.data.run.answers && <Table.Th>Ответ</Table.Th>}
                    <Table.Th>Сообщение</Table.Th>
                    <Table.Th>Когда</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((r) => (
                    <MessageRow key={`${r.id}:${r.userId}`} r={r} tz={tz} withAnswer={!!q.data.run.answers} />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {rows.length === 0 && (
            <Text size="sm" c="dimmed" ta="center">
              Никого
            </Text>
          )}
        </Stack>
      )}
    </AppModal>
  );
}

/** Сообщение карточкой - для телефона: кому, дошло ли, ответ и начало текста. */
export function MessageCard({ r, tz, showKind = false }: { r: BotMessageRow; tz: string; showKind?: boolean }) {
  return (
    <Card withBorder padding="xs">
      <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} lh={1.3}>
              {showKind ? r.label : r.userName}
            </Text>
            {!showKind && r.userId && (
              <Anchor href={`/messages/${r.userId}`} target="_blank" size="xs" title="Открыть переписку">
                <IconMessageCircle size={14} />
              </Anchor>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {!showKind && r.username ? `@${r.username} · ` : ''}
            {formatDateTimeShort(r.at, tz)}
          </Text>
        </div>
        <Badge color={OUTCOME_COLOR[r.outcome]} variant="light" style={{ textTransform: 'none', flexShrink: 0 }}>
          {BOT_OUTCOME_LABELS[r.outcome]}
        </Badge>
      </Group>
      {r.answer && (
        <Badge color={TONE[r.answer.tone]} variant="light" mt={4} style={{ textTransform: 'none' }}>
          {r.answer.label}
        </Badge>
      )}
      {r.preview && (
        <Text size="xs" mt={4} lineClamp={3}>
          {r.preview}
        </Text>
      )}
    </Card>
  );
}

export function MessageRow({ r, tz, withAnswer, showKind = false }: { r: BotMessageRow; tz: string; withAnswer?: boolean; showKind?: boolean }) {
  return (
    <Table.Tr>
      <Table.Td>
        {showKind ? (
          <Text size="sm">{r.label}</Text>
        ) : (
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600}>
              {r.userName}
            </Text>
            {r.userId && (
              <Anchor href={`/messages/${r.userId}`} target="_blank" size="xs" title="Открыть переписку">
                <IconMessageCircle size={14} />
              </Anchor>
            )}
          </Group>
        )}
        {!showKind && r.username && (
          <Text size="xs" c="dimmed">
            @{r.username}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Badge color={OUTCOME_COLOR[r.outcome]} variant="light" style={{ textTransform: 'none' }}>
          {BOT_OUTCOME_LABELS[r.outcome]}
        </Badge>
        {r.error && r.outcome === 'failed' && (
          <Text size="xs" c="dimmed" lineClamp={1}>
            {r.error}
          </Text>
        )}
      </Table.Td>
      {withAnswer && (
        <Table.Td>
          {r.answer ? (
            <Badge color={TONE[r.answer.tone]} variant="light" style={{ textTransform: 'none' }}>
              {r.answer.label}
            </Badge>
          ) : (
            <Text size="xs" c="dimmed">
              -
            </Text>
          )}
        </Table.Td>
      )}
      <Table.Td maw={340}>
        <Text size="xs" lineClamp={2} c={r.preview ? undefined : 'dimmed'}>
          {r.preview ?? '-'}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{formatDateTime(r.at, tz)}</Text>
      </Table.Td>
    </Table.Tr>
  );
}

const REASON: Record<'blocked' | 'unreachable' | 'no_telegram', { label: string; color: string }> = {
  blocked: { label: 'заблокировал бота', color: 'red' },
  unreachable: { label: 'не открывал бота', color: 'orange' },
  no_telegram: { label: 'нет Telegram', color: 'gray' },
};

/** До кого бот не достучится: им ни одно напоминание не придёт - звонить или говорить на месте. */
function UnreachableModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const q = useBotUnreachable(opened);
  const narrow = useNarrow();
  return (
    <AppModal opened={opened} onClose={onClose} size="xl" title={<Text fw={700}>До кого бот не достучится</Text>}>
      <Text size="sm" c="dimmed" mb="sm">
        Аккаунты с участниками, которым бот не может написать: заблокировали бота, ни разу его не открывали или записаны без Telegram. Напоминания им не
        придут - сообщите по телефону или на месте.
      </Text>
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <Text size="sm">Таких нет - бот достучится до всех.</Text>
      ) : narrow ? (
        <Stack gap={6}>
          {q.data.map((r) => (
            <Card key={r.userId ?? r.name} withBorder padding="xs">
              <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
                <Text size="sm" fw={600}>
                  {r.name}
                  {r.username ? ` · @${r.username}` : ''}
                </Text>
                <Badge color={REASON[r.reason].color} variant="light" style={{ textTransform: 'none', flexShrink: 0 }}>
                  {REASON[r.reason].label}
                </Badge>
              </Group>
              <Text size="xs" mt={2}>
                {r.people.join(', ')}
                {r.phone ? ` · ${r.phone}` : ''}
              </Text>
            </Card>
          ))}
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={600}>
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Аккаунт</Table.Th>
                <Table.Th>Почему</Table.Th>
                <Table.Th>Участники</Table.Th>
                <Table.Th>Телефон</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {q.data.map((r) => (
                <Table.Tr key={r.userId ?? r.name}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {r.name}
                    </Text>
                    {r.username && (
                      <Text size="xs" c="dimmed">
                        @{r.username}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={REASON[r.reason].color} variant="light" style={{ textTransform: 'none' }}>
                      {REASON[r.reason].label}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{r.people.join(', ')}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{r.phone ?? '-'}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </AppModal>
  );
}
