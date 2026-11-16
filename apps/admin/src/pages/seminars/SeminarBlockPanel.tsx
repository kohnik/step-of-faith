import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Group,
  List,
  Menu,
  Popover,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import type { RoomView, SeminarBlockView, SeminarsSummary, SeminarTopicRow, SeminarTopicView } from '@sof/shared';
import {
  IconArrowRight,
  IconArrowsShuffle,
  IconDots,
  IconDownload,
  IconInfoCircle,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSchool,
  IconSend,
  IconTrash,
  IconUserQuestion,
  IconUsers,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useRegistrations } from '../../api/activities.ts';
import {
  useDeleteTopic,
  useDistributeSeminars,
  useMoveSeminarPerson,
  usePublishSeminars,
  useRooms,
  useSaveBlock,
  useSaveTopic,
  useSeminarAutoPlan,
  useSeminarChanged,
  useSeminars,
  useSetSessionRoom,
  useUnplaced,
} from '../../api/seminars.ts';
import { downloadFile } from '../../api/client.ts';
import { useInternalLink } from '../../components/AppLink.tsx';
import { AppModal, ModalActions, useIsMobile } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { CopyValue } from '../../components/CopyValue.tsx';
import { EventDateTimeInput, TzHint } from '../../components/dates.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { ProgramSwitches } from '../../components/ProgramSwitches.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { countLabel, formatDayLong, formatNumber, formatTime } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { dayKey, isoToWall, sameInstant, wallToIso } from '../../lib/tz.ts';
import { useBlockActions } from '../activities/rowActions.tsx';

const PEOPLE: [string, string, string] = ['человек', 'человека', 'человек'];

const BOT = import.meta.env.VITE_BOT_USERNAME?.replace(/^@/, '');
/** Ссылка для канала: бот и сразу мини-апп на семинарах (у бота настроено главное приложение). */
const SEMINARS_LINK = BOT ? `https://t.me/${BOT}?startapp=seminars` : null;
const TOPICS: [string, string, string] = ['тему', 'темы', 'тем'];

// ---------- поток: время и залы ----------

/**
 * Создать или настроить поток семинаров. `defaultDay` - день, с которого открыли (расписание);
 * после создания `onSaved` получает поток - расписание сразу открывает его настройку.
 */
export function BlockModal({
  block,
  opened,
  onClose,
  defaultDay = null,
  suggestedTitle,
  onSaved,
}: {
  block: SeminarBlockView | null;
  opened: boolean;
  onClose: () => void;
  defaultDay?: string | null;
  suggestedTitle?: string;
  onSaved?: (block: SeminarBlockView) => void;
}) {
  const tz = useEventTz();
  const rooms = useRooms();
  const save = useSaveBlock();
  const confirm = useConfirm();
  const [title, setTitle] = useState(block?.title ?? suggestedTitle ?? '');
  const [startsAt, setStartsAt] = useState<string | null>(block ? isoToWall(block.startsAt, tz) : defaultDay ? `${defaultDay} 17:00:00` : null);
  const [endsAt, setEndsAt] = useState<string | null>(block ? isoToWall(block.endsAt, tz) : defaultDay ? `${defaultDay} 18:00:00` : null);
  const [roomIds, setRoomIds] = useState<string[] | null>(block ? block.rooms.map((r) => String(r.id)) : null);
  const [error, setError] = useState<string | null>(null);
  // Новый поток: по умолчанию отмечены все залы справочника - лишние проще снять.
  const picked = roomIds ?? (rooms.data ?? []).map((r) => String(r.id));
  const capacity = (rooms.data ?? []).filter((r) => picked.includes(String(r.id))).reduce((s, r) => s + r.capacity, 0);

  const submit = async () => {
    const s = wallToIso(startsAt, tz);
    const e = wallToIso(endsAt, tz);
    if (!title.trim()) return setError('Как называется поток?');
    if (!s || !e) return setError('Укажите начало и окончание');
    if (new Date(e) < new Date(s)) return setError('Окончание раньше начала');
    // Перенос начала - каждому распределённому на показанные сеансы бот пришлёт новое время.
    const registered = block ? block.topics.filter((t) => t.status === 'published').reduce((n, t) => n + t.registered, 0) : 0;
    if (block && registered > 0 && !sameInstant(s, block.startsAt)) {
      const ok = await confirm({
        title: 'Перенести поток?',
        message: `Распределённым на семинары потока (${countLabel(registered, PEOPLE)}) придёт сообщение с новым временем.`,
        confirmLabel: 'Перенести',
      });
      if (!ok) return;
    }
    save.mutate(
      {
        id: block?.id ?? null,
        input: block
          ? { title: title.trim(), startsAt: s, endsAt: e, roomIds: picked.map(Number) }
          : { title: title.trim(), startsAt: s, endsAt: e, roomIds: picked.map(Number), registrationOpen: false, hidden: false },
      },
      {
        onSuccess: (b) => {
          notifySuccess(block ? 'Поток сохранён' : 'Поток создан', b.title);
          onClose();
          onSaved?.(b);
        },
        onError: (err) => notifyError(err),
      },
    );
  };

  return (
    <AppModal opened={opened} onClose={onClose} size="lg" title={<Text fw={700}>{block ? 'Время и залы потока' : 'Новый поток семинаров'}</Text>}>
      <Stack gap="sm">
        <TextInput label="Название" placeholder="Семинары: 1-ый поток" required value={title} onChange={(e) => setTitle(e.currentTarget.value)} data-autofocus />
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <EventDateTimeInput label="Начало" required value={startsAt} onChange={setStartsAt} />
          <EventDateTimeInput label="Окончание" required value={endsAt} onChange={setEndsAt} />
        </SimpleGrid>
        <TzHint />
        <Checkbox.Group
          label="Залы в этом потоке"
          description={picked.length ? `Всего мест: ${formatNumber(capacity)}` : 'Отметьте, какие залы свободны в это время'}
          value={picked}
          onChange={setRoomIds}
        >
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={6} mt="xs">
            {(rooms.data ?? []).map((r) => (
              <Checkbox key={r.id} value={String(r.id)} label={`${r.name} - ${formatNumber(r.capacity)}`} />
            ))}
          </SimpleGrid>
        </Checkbox.Group>
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} loading={save.isPending}>
            {block ? 'Сохранить' : 'Создать поток'}
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

// ---------- темы ----------

function TopicModal({ topic, opened, onClose }: { topic: SeminarTopicView | null; opened: boolean; onClose: () => void }) {
  const save = useSaveTopic();
  const [title, setTitle] = useState(topic?.title ?? '');
  const [host, setHost] = useState(topic?.host ?? '');
  const [description, setDescription] = useState(topic?.description ?? '');
  const [visible, setVisible] = useState(topic ? !topic.hidden : true);
  const submit = () => {
    save.mutate(
      {
        id: topic?.id ?? null,
        input: { title: title.trim(), host: host.trim() || null, description: description.trim() || null, hidden: !visible },
      },
      {
        onSuccess: () => {
          notifySuccess(topic ? 'Тема сохранена' : 'Тема добавлена во все потоки', title.trim());
          onClose();
        },
        onError: (err) => notifyError(err),
      },
    );
  };
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>{topic ? 'Изменить тему' : 'Новая тема'}</Text>}>
      <Stack gap="sm">
        <TextInput label="Тема" required value={title} onChange={(e) => setTitle(e.currentTarget.value)} data-autofocus />
        <TextInput label="Спикер" placeholder="Кто ведёт" value={host} onChange={(e) => setHost(e.currentTarget.value)} />
        <Textarea label="Описание" autosize minRows={2} maxRows={6} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <Switch
          label="Показывать участникам"
          description="Выключено - тему нельзя выбрать, в распределении она не участвует."
          checked={visible}
          onChange={(e) => setVisible(e.currentTarget.checked)}
        />
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} loading={save.isPending} disabled={!title.trim()}>
            Сохранить
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

/** Темы - одни на все потоки: что выбирают участники и сколько голосов у каждой. */
export function TopicsCard({ summary }: { summary: SeminarsSummary }) {
  const remove = useDeleteTopic();
  const confirm = useConfirm();
  const [modal, setModal] = useState<{ opened: boolean; topic: SeminarTopicView | null; key: number }>({ opened: false, topic: null, key: 0 });
  const open = (topic: SeminarTopicView | null) => setModal((m) => ({ opened: true, topic, key: m.key + 1 }));
  const max = Math.max(1, ...summary.topics.map((t) => t.votes));
  const del = async (t: SeminarTopicView) => {
    const ok = await confirm({
      title: 'Удалить тему?',
      message: `«${t.title}» пропадёт из всех потоков${t.votes ? `, ${countLabel(t.votes, PEOPLE)} потеряют свой выбор` : ''}. Тем, кого уже поставили на неё, придёт сообщение.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (ok) remove.mutate(t.id, { onError: (err) => notifyError(err) });
  };
  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="xs">
        <div>
          <Text fw={700} size="lg">
            Темы
          </Text>
          <Text size="sm" c="dimmed">
            Одни на все потоки. Участник выбирает {countLabel(Math.max(summary.picks, 1), TOPICS)}.
          </Text>
        </div>
        <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => open(null)}>
          Добавить тему
        </Button>
      </Group>
      {summary.topics.length === 0 ? (
        <Text size="sm" c="dimmed">
          Тем пока нет. Добавьте темы - у каждой появится сеанс в каждом потоке.
        </Text>
      ) : (
        <Table verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Тема</Table.Th>
              <Table.Th style={{ textAlign: 'right' }}>Выбрали</Table.Th>
              <Table.Th w={80} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...summary.topics]
              .sort((a, b) => b.votes - a.votes || a.sort - b.sort)
              .map((t) => (
                <Table.Tr key={t.id} style={{ opacity: t.hidden ? 0.6 : 1 }}>
                  <Table.Td>
                    <Text fw={600} size="sm">
                      {t.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {[t.host, t.hidden ? 'скрыта от участников' : null].filter(Boolean).join(' · ') || ' '}
                    </Text>
                  </Table.Td>
                  <Table.Td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className="sof-tabular">
                    <Group gap={8} justify="flex-end" wrap="nowrap">
                      <div style={{ width: 80, height: 6, borderRadius: 3, background: 'var(--mantine-color-default-border)' }}>
                        <div style={{ width: `${(t.votes / max) * 100}%`, height: 6, borderRadius: 3, background: 'var(--mantine-primary-color-filled)' }} />
                      </div>
                      <Text fw={700} size="sm" w={36}>
                        {formatNumber(t.votes)}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <ActionIcon onClick={() => open(t)} aria-label={`Изменить: ${t.title}`}>
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon color="red" onClick={() => void del(t)} aria-label={`Удалить: ${t.title}`}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
          </Table.Tbody>
        </Table>
      )}
      <TopicModal key={modal.key} topic={modal.topic} opened={modal.opened} onClose={() => setModal((m) => ({ ...m, opened: false }))} />
    </Card>
  );
}

// ---------- распределение и публикация ----------

/** Выбор тем, распределение по потокам и залам, публикация - сразу для всех потоков. */
export function PlanCard({ summary, blocks }: { summary: SeminarsSummary; blocks: SeminarBlockView[] }) {
  const tz = useEventTz();
  const distribute = useDistributeSeminars();
  const publish = usePublishSeminars();
  const autoPlan = useSeminarAutoPlan();
  const confirm = useConfirm();
  const auto = summary.autoPlan;
  const visible = blocks.filter((b) => !b.hidden);
  const placed = visible.reduce((s, b) => s + b.topics.reduce((n, t) => n + t.registered, 0), 0);
  const unplaced = visible.reduce((s, b) => s + b.unplaced, 0);
  const nothingToPublish = summary.publishedAt !== null && !summary.dirty;
  const [changedOpen, setChangedOpen] = useState(false);

  const run = (reset: boolean) =>
    distribute.mutate(reset, {
      onSuccess: (r) => notifySuccess(r.placed ? `Распределено: ${countLabel(r.placed, PEOPLE)}` : 'Новых мест не понадобилось', 'Семинары'),
      onError: (err) => notifyError(err),
    });
  const runAgain = async () => {
    const ok = await confirm({
      title: 'Распределить заново?',
      message: 'Разложим заново всех, кроме ручных переносов.',
      confirmLabel: 'Распределить заново',
    });
    if (ok) run(true);
  };
  const doPublish = async () => {
    const ok = await confirm({
      title: summary.publishedAt ? 'Опубликовать изменения?' : 'Опубликовать распределение?',
      message: summary.publishedAt
        ? 'Сообщение придёт только тем, у кого что-то поменялось.'
        : 'Каждый увидит свои семинары и залы и получит сообщение в бот.',
      confirmLabel: 'Опубликовать',
    });
    if (!ok) return;
    publish.mutate(undefined, { onSuccess: () => notifySuccess('Распределение опубликовано', 'Семинары'), onError: (err) => notifyError(err) });
  };

  return (
    <Card withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" gap="sm">
          <div>
            <Group gap={4} wrap="nowrap">
              <Text fw={700} size="lg">
                Распределение
              </Text>
              <PlanRules />
            </Group>
            <Text size="sm" c="dimmed">
              Выбрали {formatNumber(summary.voters)} из {formatNumber(summary.participants)} · мест {formatNumber(placed)}
            </Text>
          </div>
          <Group gap="xs">
            <Button.Group>
              {!auto && (
                <Button variant="light" leftSection={<IconArrowsShuffle size={16} />} loading={distribute.isPending} onClick={() => run(false)}>
                  Распределить
                </Button>
              )}
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button variant="light" px={8} aria-label="Ещё" loading={auto && distribute.isPending}>
                    <IconDots size={16} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconArrowsShuffle size={16} />} onClick={() => void runAgain()}>
                    Распределить заново
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Button.Group>
            <Button
              leftSection={<IconSend size={16} />}
              variant={nothingToPublish ? 'default' : 'filled'}
              disabled={nothingToPublish || placed === 0}
              loading={publish.isPending}
              onClick={() => void doPublish()}
            >
              {!summary.publishedAt ? 'Опубликовать' : summary.dirty ? 'Опубликовать изменения' : 'Опубликовано'}
            </Button>
          </Group>
        </Group>
        <ProgramSwitches only={['seminars']} card={false} hints={false} />
        <Switch
          label="Распределять автоматически"
          description={auto ? undefined : 'Только кнопкой «Распределить»'}
          checked={auto}
          disabled={autoPlan.isPending}
          onChange={(e) =>
            autoPlan.mutate(e.currentTarget.checked, {
              onSuccess: (r) => notifySuccess(r.autoPlan ? 'Распределяем автоматически' : 'Распределение - только кнопкой', 'Семинары'),
              onError: (err) => notifyError(err),
            })
          }
        />
        {SEMINARS_LINK && (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
              Ссылка для канала:
            </Text>
            <CopyValue value={SEMINARS_LINK} />
          </Group>
        )}
        <Group gap="xs">
          {summary.publishedAt ? (
            <Badge color="teal" variant="light">
              Опубликовано в {formatTime(summary.publishedAt, tz)}
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              Ещё не опубликовано
            </Badge>
          )}
          {summary.publishedAt && summary.dirty && (
            <Badge color="yellow" variant="filled">
              Есть неопубликованные изменения
            </Badge>
          )}
          {unplaced > 0 && (
            <Badge color="orange" variant="light">
              Без места: {formatNumber(unplaced)}
            </Badge>
          )}
        </Group>
        {summary.changed > 0 && (
          <Alert color="grape" variant="light" icon={<IconRefresh size={16} />} py={8}>
            <Group gap="sm">
              <Text size="sm">Поменяли выбор: {formatNumber(summary.changed)}</Text>
              {auto && (
                <UnstyledButton onClick={() => run(false)} fz="sm" c="grape" fw={600} disabled={distribute.isPending}>
                  Пересадить
                </UnstyledButton>
              )}
              <UnstyledButton onClick={() => setChangedOpen(true)} fz="sm" c="grape" fw={600}>
                Кто?
              </UnstyledButton>
            </Group>
          </Alert>
        )}
        {visible.map((b) => {
          const seats = b.topics.reduce((s, t) => s + (t.roomId !== null ? (b.rooms.find((r) => r.id === t.roomId)?.capacity ?? 0) : 0), 0);
          return (
            seats < summary.voters && (
              <Alert key={b.id} color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
                {b.title}: мест {formatNumber(seats)} на {formatNumber(summary.voters)} человек - добавьте залы.
              </Alert>
            )
          );
        })}
      </Stack>
      <ChangedDrawer opened={changedOpen} onClose={() => setChangedOpen(false)} />
    </Card>
  );
}

/** Правила распределения - по кнопке «i», чтобы не занимали карточку. */
function PlanRules() {
  return (
    <Popover position="bottom-start" width={300} shadow="md" withinPortal>
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" aria-label="Как распределяем">
          <IconInfoCircle size={18} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <List size="sm" spacing={4}>
          <List.Item>По одной своей теме в каждом потоке</List.Item>
          <List.Item>Самая популярная тема - один раз, в 1-м потоке</List.Item>
          <List.Item>Больше людей - больше зал</List.Item>
          <List.Item>Ручные переносы не трогаем</List.Item>
          <List.Item>После публикации залы закреплены</List.Item>
        </List>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Кто поменял выбор после распределения: где сидит и что выбрал теперь. */
function ChangedDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const mobile = useIsMobile();
  const q = useSeminarChanged(opened);
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={mobile ? '100%' : 560}
      title={
        <Group gap="xs">
          <IconRefresh size={18} />
          <Text fw={700}>Поменяли выбор</Text>
        </Group>
      }
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Места за ними сохраняются, пока не пересадите: «Распределить» сделает это по новому выбору, или перенесите вручную в карточке потока.
        </Text>
        {q.isPending ? (
          <BlockSkeleton rows={3} height={24} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <Text size="sm" c="dimmed">
            Никто не передумал.
          </Text>
        ) : (
          <Table verticalSpacing={6} horizontalSpacing="xs">
            <Table.Tbody>
              {q.data.map((r) => (
                <Table.Tr key={r.participantId}>
                  <Table.Td>
                    <ParticipantLink id={r.participantId} name={r.fullName} />
                    {r.age !== null && (
                      <Text span size="xs" c="dimmed">
                        {' '}
                        · {r.age}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed">
                      Сейчас:{' '}
                      {r.now.map((t, i) => (
                        <Text key={i} span size="xs" td={r.dropped.includes(t) ? 'line-through' : undefined} c={r.dropped.includes(t) ? 'red' : undefined}>
                          {i > 0 ? ' · ' : ''}
                          {t}
                        </Text>
                      ))}
                    </Text>
                    <Text size="xs">
                      Хочет: <b>{r.wants.join(' · ')}</b>
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Drawer>
  );
}

// ---------- сеансы потока ----------

function roomLabel(rooms: RoomView[], id: number | null): string {
  const r = rooms.find((x) => x.id === id);
  return r ? `${r.name} · ${formatNumber(r.capacity)}` : '-';
}

/** Бейдж в узкой колонке не обрезаем многоточием. */
const FULL_LABEL = { label: { overflow: 'visible' } } as const;

function FitBadge({ t }: { t: SeminarTopicRow }) {
  if (t.roomId === null) {
    return t.registered > 0 ? (
      <Badge color="red" variant="light" styles={FULL_LABEL}>
        нет зала
      </Badge>
    ) : (
      <Badge color="gray" variant="light" styles={FULL_LABEL}>
        не идёт
      </Badge>
    );
  }
  if (t.overflow > 0) {
    return (
      <Badge color="red" variant="filled" styles={FULL_LABEL}>
        не влезают +{formatNumber(t.overflow)}
      </Badge>
    );
  }
  return (
    <Badge color="teal" variant="light" styles={FULL_LABEL}>
      влезают
    </Badge>
  );
}

/** Цвет заполненности: свободно - зелёный, почти полный - жёлтый и оранжевый, сверх мест - красный. */
function fillColor(taken: number, capacity: number): string {
  if (taken > capacity) return 'red';
  const pct = capacity ? taken / capacity : 0;
  return pct >= 0.9 ? 'orange' : pct >= 0.7 ? 'yellow' : 'teal';
}

/** Сколько мест занято из скольких: шкала и «12 из 40». */
function FillBar({ taken, capacity, w }: { taken: number; capacity: number; w?: number | string }) {
  const pct = capacity ? Math.round((taken / capacity) * 100) : 0;
  return (
    <Stack gap={3} w={w}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="xs" fw={600} className="sof-tabular" style={{ whiteSpace: 'nowrap' }}>
          {formatNumber(taken)} из {formatNumber(capacity)}
        </Text>
        <Text size="xs" c={taken > capacity ? 'red' : 'dimmed'} className="sof-tabular">
          {pct}%
        </Text>
      </Group>
      <Progress value={Math.min(100, pct)} color={fillColor(taken, capacity)} size="md" radius="xl" />
    </Stack>
  );
}

/** Заполненность сеанса: шкала по залу; нет зала или не влезают - ещё и пометка. */
function SessionFill({ t, room, w }: { t: SeminarTopicRow; room: { capacity: number } | null; w?: number | string }) {
  if (!room) return <FitBadge t={t} />;
  return (
    <Stack gap={4} w={w}>
      <FillBar taken={t.registered} capacity={room.capacity} />
      {t.overflow > 0 && <FitBadge t={t} />}
    </Stack>
  );
}

/** Зал сеанса: «Авто» (решает распределение) или вручную. Под ним - какой зал сейчас опубликован, если отличается. */
function SessionRoomSelect({ block, t }: { block: SeminarBlockView; t: SeminarTopicRow }) {
  const setRoom = useSetSessionRoom();
  const room = block.rooms.find((r) => r.id === t.roomId) ?? null;
  const options = [
    { value: 'auto', label: t.plannedRoomId === null ? (room ? `Авто: ${room.name}` : 'Авто: не идёт') : 'Авто' },
    ...block.rooms.map((r) => ({ value: String(r.id), label: `${r.name} · ${formatNumber(r.capacity)}` })),
  ];
  return (
    <div>
      <Select
        size="xs"
        data={options}
        value={t.plannedRoomId === null ? 'auto' : String(t.plannedRoomId)}
        allowDeselect={false}
        disabled={setRoom.isPending}
        aria-label={`Зал: ${t.title}`}
        onChange={(v) =>
          setRoom.mutate({ sessionId: t.id, roomId: v === 'auto' || v === null ? null : Number(v) }, { onError: (err) => notifyError(err) })
        }
        comboboxProps={{ withinPortal: true }}
      />
      {t.publishedRoomId !== null && t.publishedRoomId !== t.roomId && (
        <Text size="xs" c="dimmed" mt={2}>
          опубликован: {roomLabel(block.rooms, t.publishedRoomId)}
        </Text>
      )}
    </div>
  );
}

/** Куда можно перенести человека в этом потоке: сеансы с залом и «убрать из потока». */
function moveOptions(block: SeminarBlockView, exceptId: number | null) {
  return [
    ...block.topics
      .filter((t) => t.roomId !== null && t.id !== exceptId)
      .map((t) => {
        const cap = block.rooms.find((r) => r.id === t.roomId)?.capacity ?? 0;
        return { value: String(t.id), label: `${t.title} (${formatNumber(t.registered)}/${formatNumber(cap)})` };
      }),
    ...(exceptId !== null ? [{ value: 'none', label: 'Убрать из потока' }] : []),
  ];
}

/** Кто стоит на сеансе - с переносом на другой сеанс потока. */
function SessionPeopleDrawer({ block, session, onClose }: { block: SeminarBlockView; session: SeminarTopicRow | null; onClose: () => void }) {
  const mobile = useIsMobile();
  const q = useRegistrations(session?.id ?? null);
  const move = useMoveSeminarPerson();
  const rows = (q.data ?? []).filter((r) => r.status === 'registered');
  const room = block.rooms.find((r) => r.id === (session?.roomId ?? null));
  return (
    <Drawer
      opened={session !== null}
      onClose={onClose}
      position="right"
      size={mobile ? '100%' : 560}
      title={
        <Group gap="xs">
          <IconUsers size={18} />
          <Text fw={700}>Кто на семинаре</Text>
        </Group>
      }
    >
      {session && (
        <Stack gap="sm">
          <div>
            <Text fw={700} size="lg">
              {session.title}
            </Text>
            <Text size="sm" c="dimmed">
              {block.title} · {room ? `${room.name}, ${formatNumber(room.capacity)} мест` : 'без зала'} · {countLabel(rows.length, PEOPLE)}
            </Text>
          </div>
          {q.isPending ? (
            <BlockSkeleton rows={3} height={24} />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : rows.length === 0 ? (
            <Text size="sm" c="dimmed">
              Пока никого
            </Text>
          ) : (
            <Table verticalSpacing={4} horizontalSpacing="xs">
              <Table.Tbody>
                {rows.map((r, i) => (
                  <Table.Tr key={r.participantId}>
                    <Table.Td w={28} c="dimmed">
                      {i + 1}
                    </Table.Td>
                    <Table.Td>
                      <ParticipantLink id={r.participantId} name={r.fullName} />
                      {r.age !== null && (
                        <Text span size="xs" c="dimmed">
                          {' '}
                          · {r.age}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td w={200}>
                      <Select
                        size="xs"
                        placeholder="Перенести…"
                        data={moveOptions(block, session.id)}
                        value={null}
                        disabled={move.isPending}
                        aria-label={`Перенести: ${r.fullName}`}
                        comboboxProps={{ withinPortal: true }}
                        onChange={(v) =>
                          v &&
                          move.mutate(
                            { participantId: r.participantId, blockId: block.id, activityId: v === 'none' ? null : Number(v) },
                            { onSuccess: () => notifySuccess('Перенесено', r.fullName), onError: (err) => notifyError(err) },
                          )
                        }
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

/** Выбрали темы, но в этом потоке без места: кого куда поставить вручную. */
function UnplacedDrawer({ block, opened, onClose }: { block: SeminarBlockView; opened: boolean; onClose: () => void }) {
  const mobile = useIsMobile();
  const q = useUnplaced(opened ? block.id : null);
  const move = useMoveSeminarPerson();
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={mobile ? '100%' : 560}
      title={
        <Group gap="xs">
          <IconUserQuestion size={18} />
          <Text fw={700}>Без места · {block.title}</Text>
        </Group>
      }
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Выбрали темы, но в этом потоке места не получили: тема здесь не идёт или её ещё не распределяли. Поставьте вручную или нажмите «Распределить».
        </Text>
        {q.isPending ? (
          <BlockSkeleton rows={3} height={24} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <Text size="sm" c="dimmed">
            Все на местах.
          </Text>
        ) : (
          <Table verticalSpacing={4} horizontalSpacing="xs">
            <Table.Tbody>
              {q.data.map((r) => (
                <Table.Tr key={r.participantId}>
                  <Table.Td>
                    <ParticipantLink id={r.participantId} name={r.fullName} />
                    <Text size="xs" c="dimmed">
                      {r.topics.join(' · ')}
                    </Text>
                  </Table.Td>
                  <Table.Td w={200}>
                    <Select
                      size="xs"
                      placeholder="Поставить на…"
                      data={moveOptions(block, null)}
                      value={null}
                      disabled={move.isPending}
                      aria-label={`Поставить: ${r.fullName}`}
                      comboboxProps={{ withinPortal: true }}
                      onChange={(v) =>
                        v &&
                        move.mutate(
                          { participantId: r.participantId, blockId: block.id, activityId: Number(v) },
                          { onSuccess: () => notifySuccess('Поставлен', r.fullName), onError: (err) => notifyError(err) },
                        )
                      }
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Drawer>
  );
}

function SessionRow({ block, t, onPeople }: { block: SeminarBlockView; t: SeminarTopicRow; onPeople: () => void }) {
  const room = block.rooms.find((r) => r.id === t.roomId) ?? null;
  return (
    <Table.Tr style={{ opacity: t.hidden || (t.roomId === null && t.registered === 0) ? 0.6 : 1 }}>
      <Table.Td>
        <Text fw={600} size="sm">
          {t.title}
        </Text>
        <Text size="xs" c="dimmed">
          {[t.host, t.hidden ? 'скрыта' : null].filter(Boolean).join(' · ') || ' '}
        </Text>
      </Table.Td>
      <Table.Td style={{ textAlign: 'right' }} className="sof-tabular">
        {formatNumber(t.votes)}
      </Table.Td>
      <Table.Td style={{ textAlign: 'right' }} className="sof-tabular">
        <UnstyledButton onClick={onPeople} aria-label={`Кто на семинаре: ${t.title}`}>
          <Text fw={700} td="underline" style={{ textDecorationStyle: 'dotted' }}>
            {formatNumber(t.registered)}
          </Text>
        </UnstyledButton>
      </Table.Td>
      <Table.Td miw={230}>
        <SessionRoomSelect block={block} t={t} />
      </Table.Td>
      <Table.Td miw={170}>
        <SessionFill t={t} room={room} />
      </Table.Td>
    </Table.Tr>
  );
}

/** Узкий экран: сеанс - карточкой, зал - во всю ширину. */
function SessionCard({ block, t, onPeople }: { block: SeminarBlockView; t: SeminarTopicRow; onPeople: () => void }) {
  const room = block.rooms.find((r) => r.id === t.roomId) ?? null;
  return (
    <Card withBorder radius="md" p="sm" style={{ opacity: t.hidden || (t.roomId === null && t.registered === 0) ? 0.65 : 1 }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <div style={{ minWidth: 0 }}>
          <Text fw={600} size="sm" lh={1.3}>
            {t.title}
          </Text>
          <Text size="xs" c="dimmed">
            {[t.host, t.hidden ? 'скрыта от участников' : null, `выбрали ${formatNumber(t.votes)}`].filter(Boolean).join(' · ')}
          </Text>
        </div>
        <UnstyledButton onClick={onPeople} aria-label={`Кто на семинаре: ${t.title}`} style={{ flexShrink: 0 }}>
          <Stack gap={0} align="flex-end">
            <Text fw={800} size="lg" lh={1.1} className="sof-tabular">
              {formatNumber(t.registered)}
            </Text>
            <Text size="xs" c="dimmed">
              распределено
            </Text>
          </Stack>
        </UnstyledButton>
      </Group>
      <div style={{ marginTop: 8 }}>
        <SessionRoomSelect block={block} t={t} />
      </div>
      <div style={{ marginTop: 8 }}>
        <SessionFill t={t} room={room} />
      </div>
    </Card>
  );
}

/**
 * Поток семинаров: сеансы тем с залами и людьми, ручные переносы, «без места».
 * `compact` - узкий экран или боковая панель: сеансы карточками, кнопки в столбик.
 */
export function SeminarBlockPanel({
  block,
  compact,
  onSettings,
  onDeleted,
}: {
  block: SeminarBlockView;
  compact: boolean;
  onSettings: () => void;
  onDeleted?: () => void;
}) {
  const tz = useEventTz();
  const [peopleOf, setPeopleOf] = useState<SeminarTopicRow | null>(null);
  const [unplacedOpen, setUnplacedOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadLists = async () => {
    setDownloading(true);
    try {
      await downloadFile(`/api/admin/seminars/${block.id}/registrations.xlsx`, `${block.title}.xlsx`);
    } catch (err) {
      notifyError(err, 'Не удалось скачать списки');
    } finally {
      setDownloading(false);
    }
  };
  const registered = block.topics.reduce((s, t) => s + t.registered, 0);
  const capacity = block.topics.reduce((s, t) => s + (block.rooms.find((r) => r.id === t.roomId)?.capacity ?? 0), 0);
  const overflow = block.topics.reduce((s, t) => s + t.overflow, 0);
  const freeRooms = block.rooms.filter((r) => block.freeRoomIds.includes(r.id));
  // Сеанс открытой карточки - свежий из потока (после переноса счётчики меняются).
  const peopleSession = peopleOf ? (block.topics.find((t) => t.id === peopleOf.id) ?? peopleOf) : null;

  const blockActions = useBlockActions(block);
  const delBlock = () => blockActions.del(onDeleted);

  const menu = (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="default" size="lg" aria-label="Ещё">
          <IconDots size={18} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconPencil size={16} />} onClick={onSettings}>
          Время и залы потока
        </Menu.Item>
        <Menu.Item leftSection={<IconDownload size={16} />} onClick={() => void downloadLists()} disabled={downloading || block.topics.length === 0}>
          Скачать списки (.xlsx)
        </Menu.Item>
        <Menu.Item leftSection={<IconTrash size={16} />} color="red" onClick={() => void delBlock()}>
          Удалить поток
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
  const visibleSwitch = (
    <Switch label="Участвует в семинарах" checked={!block.hidden} disabled={blockActions.toggling} onChange={() => void blockActions.toggleHidden()} />
  );

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start" wrap={compact ? 'nowrap' : 'wrap'} gap="sm">
        <div style={{ minWidth: 0 }}>
          <Text fw={700} size="lg" lh={1.25}>
            {block.title}
          </Text>
          <Text size="sm" c="dimmed">
            {formatDayLong(dayKey(block.startsAt, tz))}, {formatTime(block.startsAt, tz)}–{formatTime(block.endsAt, tz)}
          </Text>
          <Text size="sm" c="dimmed">
            Распределено {formatNumber(registered)} из {formatNumber(capacity)} мест
          </Text>
          {capacity > 0 && (
            <Progress value={Math.min(100, (registered / capacity) * 100)} color={fillColor(registered, capacity)} size="sm" radius="xl" mt={6} w={260} maw="100%" />
          )}
        </div>
        {compact ? (
          menu
        ) : (
          <Group gap="xs" wrap="wrap">
            {visibleSwitch}
            {menu}
          </Group>
        )}
      </Group>
      {compact && visibleSwitch}

      <Group gap="xs">
        {block.roomsPublishedAt ? (
          <Badge color="teal" variant="light">
            Опубликовано в {formatTime(block.roomsPublishedAt, tz)}
          </Badge>
        ) : (
          <Badge color="gray" variant="light">
            Ещё не опубликовано
          </Badge>
        )}
        {block.roomsPublishedAt && block.dirty && (
          <Badge color="yellow" variant="filled">
            Есть неопубликованные изменения
          </Badge>
        )}
        {overflow > 0 && (
          <Badge color="red" variant="light">
            Не влезают: {formatNumber(overflow)}
          </Badge>
        )}
        {block.unplaced > 0 && (
          <Button size="compact-sm" variant="light" color="orange" leftSection={<IconUserQuestion size={14} />} onClick={() => setUnplacedOpen(true)}>
            Без места: {formatNumber(block.unplaced)}
          </Button>
        )}
      </Group>

      {block.hidden && (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
          Поток выключен: участники его не видят, в распределении он не участвует.
        </Alert>
      )}
      {block.rooms.length === 0 && (
        <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
          В потоке нет залов - добавьте их в «Время и залы потока».
        </Alert>
      )}

      {block.topics.length === 0 ? (
        <Text size="sm" c="dimmed">
          Тем пока нет - добавьте их в карточке «Темы».
        </Text>
      ) : compact ? (
        <Stack gap="xs">
          {block.topics.map((t) => (
            <SessionCard key={t.id} block={block} t={t} onPeople={() => setPeopleOf(t)} />
          ))}
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Тема</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Выбрали</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Распределено</Table.Th>
                <Table.Th>
                  <Tooltip label="«Авто» - распределение ставит в зал по числу голосов. Можно поставить зал вручную." multiline w={260}>
                    <span>Зал</span>
                  </Tooltip>
                </Table.Th>
                <Table.Th>Заполнено</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {block.topics.map((t) => (
                <SessionRow key={t.id} block={block} t={t} onPeople={() => setPeopleOf(t)} />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {freeRooms.length > 0 && (
        <Text size="xs" c="dimmed">
          Свободны: {freeRooms.map((r) => `${r.name} (${formatNumber(r.capacity)})`).join(', ')}
        </Text>
      )}
      <SessionPeopleDrawer block={block} session={peopleSession} onClose={() => setPeopleOf(null)} />
      <UnplacedDrawer block={block} opened={unplacedOpen} onClose={() => setUnplacedOpen(false)} />
    </Stack>
  );
}

/** Поток прямо из расписания: боковая панель (на телефоне - во весь экран). */
export function SeminarBlockDrawer({ blockId, opened, onClose }: { blockId: number | null; opened: boolean; onClose: () => void }) {
  const mobile = useIsMobile();
  const seminars = useSeminars(opened);
  const block = seminars.data?.find((b) => b.id === blockId) ?? null;
  const [settings, setSettings] = useState({ opened: false, key: 0 });
  const allLink = useInternalLink('/seminars', onClose);
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={mobile ? '100%' : 560}
      title={
        <Group gap="xs">
          <IconSchool size={18} />
          <Text fw={700}>Поток семинаров</Text>
        </Group>
      }
    >
      {block ? (
        <Stack gap="md">
          <SeminarBlockPanel
            block={block}
            compact
            onSettings={() => setSettings((s) => ({ opened: true, key: s.key + 1 }))}
            onDeleted={onClose}
          />
          <Button component="a" variant="subtle" rightSection={<IconArrowRight size={16} />} {...allLink}>
            Темы и распределение
          </Button>
          <BlockModal key={settings.key} block={block} opened={settings.opened} onClose={() => setSettings((s) => ({ ...s, opened: false }))} />
        </Stack>
      ) : seminars.isPending ? (
        <BlockSkeleton rows={4} />
      ) : (
        <Text c="dimmed">Поток не найден - возможно, его удалили.</Text>
      )}
    </Drawer>
  );
}
