import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Divider,
  Menu,
  MultiSelect,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  activityKindLabel,
  activityKindOptions,
  type ActivityStatus,
  type ActivityView,
  type CounselorAdminView,
  type SeminarBlockView,
} from '@sof/shared';
import {
  IconCalendarEvent,
  IconChevronDown,
  IconChevronRight,
  IconHeartHandshake,
  IconInfoCircle,
  IconLayoutList,
  IconMapPin,
  IconPlus,
  IconSchool,
  IconSearch,
  IconTimeline,
  IconUser,
} from '@tabler/icons-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useActivities, useUpdateActivity } from '../../api/activities.ts';
import { useCounseling } from '../../api/counseling.ts';
import { useRooms, useSeminars } from '../../api/seminars.ts';
import { notifyError } from '../../lib/notify.tsx';
import { useIsMobile } from '../../components/AppModal.tsx';
import { ActivityKindBadge, ActivityStatusBadge } from '../../components/badges.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { ProgramSwitches } from '../../components/ProgramSwitches.tsx';
import { useCan, useSession } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { capitalizeFirst, countLabel, formatDayLong, formatDayShort, formatTime } from '../../lib/format.ts';
import { REGISTRATION_MODE_LABELS } from '../../lib/labels.ts';
import { readStored, writeStored } from '../../lib/storage.ts';
import { dayKey, offsetLabel, todayKey } from '../../lib/tz.ts';
import { ageLabel, registrationLabel } from './ActivityDetails.tsx';
import { CounselingDrawer, CounselingSetupModal, COUNSELORS, DEFAULT_WINDOW, windowOf } from '../counseling/CounselingParts.tsx';
import { BlockModal, SeminarBlockDrawer } from '../seminars/SeminarBlockPanel.tsx';
import { ActivityFormModal } from './ActivityFormModal.tsx';
import { DayTimeline, type TimelineExtra } from './DayTimeline.tsx';
import { RegistrationsDrawer } from './RegistrationsDrawer.tsx';
import { RowActions, useActivityDelete, useBlockActions, useCounselingDayActions } from './rowActions.tsx';
import { BlockPeopleDrawer } from '../seminars/BlockPeopleDrawer.tsx';
import { CounselingPeopleDrawer } from '../counseling/CounselingPeopleDrawer.tsx';

type View = 'list' | 'timeline';
type StatusFilter = 'all' | ActivityStatus;

const STATUS_OPTIONS = [
  { value: 'all', label: 'Все' },
  { value: 'published', label: 'Видимые' },
  { value: 'draft', label: 'Скрытые' },
  { value: 'cancelled', label: 'Отменённые' },
];

const COUNSELING_KIND = 'Душепопечение';
const TOPICS: [string, string, string] = ['тема', 'темы', 'тем'];
const ACTIVITIES: [string, string, string] = ['активность', 'активности', 'активностей'];

/**
 * Строка расписания: обычное мероприятие, блок семинаров (все темы - одной строкой)
 * или душепопечение дня (все служители - одной строкой). Блок и душепопечение настраиваются в боковой панели.
 */
type Entry =
  | { type: 'activity'; key: string; startsAt: string; endsAt: string; activity: ActivityView }
  | { type: 'block'; key: string; startsAt: string; endsAt: string; block: SeminarBlockView }
  | { type: 'counseling'; key: string; startsAt: string; endsAt: string; day: string; counselors: CounselorAdminView[] };

/** Душепопечение по дням: одно окно на день - от начала первого служителя до конца последнего. */
function counselingDays(counselors: CounselorAdminView[], tz: string) {
  const map = new Map<string, CounselorAdminView[]>();
  for (const c of counselors) {
    const d = dayKey(c.startsAt, tz);
    map.set(d, [...(map.get(d) ?? []), c]);
  }
  return [...map.entries()].map(([day, list]) => ({
    day,
    counselors: list,
    startsAt: list.reduce((m, c) => (c.startsAt < m ? c.startsAt : m), list[0]!.startsAt),
    endsAt: list.reduce((m, c) => (c.endsAt > m ? c.endsAt : m), list[0]!.endsAt),
  }));
}

/** Группы по времени начала: «15:00 · 4 активности» - параллельные активности сразу видны вместе. */
function groupByStart(items: Entry[], tz: string): { time: string; items: Entry[] }[] {
  const groups: { time: string; items: Entry[] }[] = [];
  for (const e of [...items].sort((x, y) => x.startsAt.localeCompare(y.startsAt))) {
    const time = formatTime(e.startsAt, tz);
    const last = groups[groups.length - 1];
    if (last && last.time === time) last.items.push(e);
    else groups.push({ time, items: [e] });
  }
  return groups;
}

const blockRegistered = (b: SeminarBlockView) => b.topics.reduce((s, t) => s + t.registered, 0);
const blockCapacity = (b: SeminarBlockView) => b.rooms.reduce((s, r) => s + r.capacity, 0);

export default function ActivitiesPage() {
  const tz = useEventTz();
  const can = useCan();
  const { session } = useSession();
  const activities = useActivities(true, true);
  const mobile = useIsMobile();
  // На телефоне по умолчанию - список (таймлайн там тесный); выбор запоминаем только на компьютере.
  const [view, setViewState] = useState<View>(() =>
    !mobile && readStored<unknown>('activities.view', 'list') === 'timeline' ? 'timeline' : 'list',
  );
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kinds, setKinds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [form, setForm] = useState<{ opened: boolean; activity: ActivityView | null }>({ opened: false, activity: null });
  const [regs, setRegs] = useState<{ opened: boolean; activity: ActivityView | null }>({ opened: false, activity: null });
  const [newBlock, setNewBlock] = useState({ opened: false, key: 0 });
  const [setup, setSetup] = useState({ opened: false, key: 0 });
  const [blockPanel, setBlockPanel] = useState<{ opened: boolean; id: number | null }>({ opened: false, id: null });
  const [counselingPanel, setCounselingPanel] = useState<{ opened: boolean; day: string | null }>({ opened: false, day: null });
  // «Люди» у блока семинаров и у душепопечения дня.
  const [blockPeople, setBlockPeople] = useState<{ opened: boolean; id: number | null }>({ opened: false, id: null });
  const [counselingPeople, setCounselingPeople] = useState<{ opened: boolean; day: string | null }>({ opened: false, day: null });

  const setView = (v: View) => {
    setViewState(v);
    if (!mobile) writeStored('activities.view', v);
  };

  const all = activities.data ?? [];
  const rooms = useRooms();
  // Семинары и душепопечение настраивают админы (полный доступ к расписанию).
  const canAll = can('activities:all');
  const seminars = useSeminars(canAll);
  const counseling = useCounseling(canAll);
  const blocks = canAll ? seminars.data : undefined;
  const counselors = canAll ? (counseling.data?.counselors ?? []) : [];
  const kindOptions = useMemo(
    () => activityKindOptions([...all.map((a) => a.kind), ...(counselors.length ? [COUNSELING_KIND] : [])]),
    [all, counselors.length],
  );
  const onlyOwn = !canAll;
  const canEdit = (a: ActivityView) => canAll || (can('activities:own') && a.createdBy === session.user.id);

  const filtered = useMemo(
    () =>
      all.filter((a) => {
        if (status !== 'all' && a.status !== status) return false;
        if (kinds.length && !kinds.includes(activityKindLabel(a.kind))) return false;
        if (q && !`${a.title} ${a.location ?? ''} ${a.host ?? ''} ${a.description ?? ''}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    [all, status, kinds, q],
  );

  // Темы блока - одной строкой блока; душепопечение дня - одной строкой.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const statusOk = status === 'all' || status === 'published';
    const kindOk = (label: string) => !kinds.length || kinds.includes(label);
    const textOk = (text: string) => !q || text.toLowerCase().includes(q);
    for (const a of filtered) {
      if (a.block && blocks) continue;
      out.push({ type: 'activity', key: `a${a.id}`, startsAt: a.startsAt, endsAt: a.endsAt, activity: a });
    }
    if (blocks && statusOk && kindOk('Семинар')) {
      for (const b of blocks) {
        if (!textOk([b.title, ...b.topics.flatMap((t) => [t.title, t.host ?? ''])].join(' '))) continue;
        out.push({ type: 'block', key: `b${b.id}`, startsAt: b.startsAt, endsAt: b.endsAt, block: b });
      }
    }
    if (statusOk && kindOk(COUNSELING_KIND)) {
      for (const d of counselingDays(counselors, tz)) {
        if (!textOk([COUNSELING_KIND, ...d.counselors.flatMap((c) => [c.name, c.place ?? ''])].join(' '))) continue;
        out.push({ type: 'counseling', key: `c${d.day}`, ...d });
      }
    }
    return out;
  }, [filtered, blocks, counselors, status, kinds, q, tz]);

  const byDay = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      const key = dayKey(e.startsAt, tz);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    for (const list of map.values()) list.sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries, tz]);

  const days = byDay.map(([d]) => d);
  const today = todayKey(tz);
  const timelineDay = pickedDay && days.includes(pickedDay) ? pickedDay : days.includes(today) ? today : (days[0] ?? null);
  // День, с которого добавляем: в таймлайне - выбранный.
  const contextDay = view === 'timeline' ? timelineDay : null;

  const openCreate = () => setForm({ opened: true, activity: null });
  const openBlock = (id: number) => setBlockPanel({ opened: true, id });
  const openCounseling = (day: string) => setCounselingPanel({ opened: true, day });
  const openBlockPeople = (id: number) => setBlockPeople({ opened: true, id });
  const openCounselingPeople = (day: string) => setCounselingPeople({ opened: true, day });
  // Тема семинара настраивается в своём блоке, а не формой мероприятия.
  const openEdit = (a: ActivityView) => (a.block && blocks ? openBlock(a.block.id) : setForm({ opened: true, activity: a }));
  const openRegs = (a: ActivityView) => setRegs({ opened: true, activity: a });
  const openNewBlock = () => setNewBlock((m) => ({ opened: true, key: m.key + 1 }));
  const openSetup = () => setSetup((m) => ({ opened: true, key: m.key + 1 }));
  const lastCounselor = counselors.at(-1);
  const counselingDefaults = lastCounselor ? windowOf(lastCounselor, tz) : { ...DEFAULT_WINDOW, day: contextDay };

  // Таймлайн: темы блока стоят в залах по распределению (до публикации - по плану), душепопечение - своей колонкой.
  const dayEntries = byDay.find(([d]) => d === timelineDay)?.[1] ?? [];
  const timelineActivities = dayEntries.flatMap((e): ActivityView[] => {
    if (e.type === 'activity') return [e.activity];
    if (e.type !== 'block') return [];
    return all
      .filter((a) => a.block?.id === e.block.id && a.status !== 'cancelled')
      .map((a) => {
        const row = e.block.topics.find((t) => t.id === a.id);
        const room = row?.roomId != null ? e.block.rooms.find((r) => r.id === row.roomId)?.name : undefined;
        return room && room !== a.location ? { ...a, location: room } : a;
      });
  });
  const timelineExtras: TimelineExtra[] = dayEntries.flatMap((e): TimelineExtra[] =>
    e.type === 'counseling'
      ? [
          {
            key: e.key,
            place: COUNSELING_KIND,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            title: COUNSELING_KIND,
            subtitle: `${countLabel(e.counselors.length, COUNSELORS)} · записано ${e.counselors.reduce((s, c) => s + c.bookings.length, 0)}`,
            color: 'pink',
            onClick: () => openCounseling(e.day),
          },
        ]
      : [],
  );

  const addButton = canAll ? (
    <Menu position="bottom-end" withinPortal width={280}>
      <Menu.Target>
        <Button leftSection={<IconPlus size={16} />} rightSection={<IconChevronDown size={14} />}>
          Добавить
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconCalendarEvent size={18} />} onClick={openCreate}>
          <Text size="sm" fw={600}>
            Мероприятие
          </Text>
          <Text size="xs" c="dimmed">
            Служение, сессия, мастер-класс
          </Text>
        </Menu.Item>
        <Menu.Item leftSection={<IconSchool size={18} />} onClick={openNewBlock}>
          <Text size="sm" fw={600}>
            Поток семинаров
          </Text>
          <Text size="xs" c="dimmed">
            Несколько тем в одно время, залы - по выбору участников
          </Text>
        </Menu.Item>
        <Menu.Item leftSection={<IconHeartHandshake size={18} />} onClick={openSetup}>
          <Text size="sm" fw={600}>
            Душепопечение
          </Text>
          <Text size="xs" c="dimmed">
            Служители и запись по времени
          </Text>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  ) : (
    <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
      Новая активность
    </Button>
  );

  return (
    <Stack gap="md">
      <PageHeader
        title="Расписание"
        description={`Мероприятия, блоки семинаров и душепопечение - всё здесь: нажмите на строку, чтобы настроить. Время - по часам конференции: ${tz} (${offsetLabel(tz)}). Скрытые видны только команде.`}
        actions={addButton}
      />

      {onlyOwn && (
        <Alert variant="light" color="blue" icon={<IconInfoCircle size={18} />} radius="lg">
          Вы видите и редактируете только свои активности. Всё расписание - у админов.
        </Alert>
      )}

      <ProgramSwitches />

      <Card padding="md">
        <Group gap="sm" wrap="wrap">
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as View)}
            fullWidth={mobile}
            style={mobile ? { flex: '1 1 100%' } : undefined}
            data={[
              {
                value: 'list',
                label: (
                  <Group gap={6} wrap="nowrap" justify="center">
                    <IconLayoutList size={16} /> Список
                  </Group>
                ),
              },
              {
                value: 'timeline',
                label: (
                  <Group gap={6} wrap="nowrap" justify="center">
                    <IconTimeline size={16} /> По залам
                  </Group>
                ),
              },
            ]}
          />
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Поиск: название, место, ведущий"
            leftSection={<IconSearch size={16} />}
            style={{ flex: '1 1 240px' }}
            aria-label="Поиск по активностям"
          />
          <MultiSelect
            data={kindOptions}
            value={kinds}
            onChange={(v) => setKinds(v)}
            placeholder={kinds.length ? undefined : 'Тип: любой'}
            clearable
            style={{ flex: mobile ? '1 1 100%' : '0 1 230px' }}
            aria-label="Тип активности"
          />
          {mobile ? (
            <Select
              data={STATUS_OPTIONS.map((o) => (o.value === 'all' ? { ...o, label: 'Любой статус' } : o))}
              value={status}
              onChange={(v) => v && setStatus(v as StatusFilter)}
              allowDeselect={false}
              style={{ flex: '1 1 100%' }}
              aria-label="Статус"
            />
          ) : (
            <SegmentedControl size="xs" value={status} onChange={(v) => setStatus(v as StatusFilter)} data={STATUS_OPTIONS} />
          )}
        </Group>
      </Card>

      {activities.isPending ? (
        <BlockSkeleton rows={6} height={48} />
      ) : activities.isError ? (
        <ErrorState error={activities.error} onRetry={() => void activities.refetch()} />
      ) : entries.length === 0 ? (
        <Card>
          <EmptyBlock
            icon={<IconCalendarEvent size={28} />}
            title={all.length || blocks?.length || counselors.length ? 'Ничего не найдено' : 'Расписание пока пустое'}
            description={
              all.length || blocks?.length || counselors.length
                ? 'Измените фильтры или поиск.'
                : 'Добавьте мероприятие, поток семинаров или душепопечение.'
            }
            action={!all.length && !blocks?.length && !counselors.length ? addButton : undefined}
          />
        </Card>
      ) : view === 'timeline' ? (
        <Stack gap="sm">
          {days.length > 1 && (
            <SegmentedControl
              value={timelineDay ?? undefined}
              onChange={setPickedDay}
              data={days.map((d) => ({ value: d, label: formatDayShort(d) }))}
              fullWidth={mobile}
              style={mobile ? undefined : { alignSelf: 'flex-start' }}
            />
          )}
          {timelineDay && (
            <>
              <Title order={4}>{capitalizeFirst(formatDayLong(timelineDay))}</Title>
              <DayTimeline
                day={timelineDay}
                tz={tz}
                activities={timelineActivities}
                extras={timelineExtras}
                canEdit={canEdit}
                onEdit={openEdit}
                onRegs={openRegs}
                rooms={rooms.data ?? []}
              />
              <Text size="xs" c="dimmed">
                Колонки - залы (рядом вместимость). Темы семинаров стоят в залах по распределению. Нажмите на блок - покажем
                подробности. Пунктир - скрыто, зачёркнуто - отменено, красная рамка - два мероприятия в одном зале в одно время,
                красная линия - сейчас.
              </Text>
            </>
          )}
        </Stack>
      ) : mobile ? (
        <Stack gap="lg">
          {byDay.map(([day, items]) => (
            <MobileDay
              key={day}
              day={day}
              today={today}
              items={items}
              tz={tz}
              canEdit={canEdit}
              onEdit={openEdit}
              onRegs={openRegs}
              onBlock={openBlock}
              onCounseling={openCounseling}
              onBlockPeople={openBlockPeople}
              onCounselingPeople={openCounselingPeople}
            />
          ))}
        </Stack>
      ) : (
        <Stack gap="lg">
          {byDay.map(([day, items]) => (
            <Card key={day} padding={0}>
              <Group justify="space-between" px="md" py="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                <Group gap="xs">
                  <Title order={4}>{capitalizeFirst(formatDayLong(day))}</Title>
                  {day === today && (
                    <Badge color="indigo" variant="filled" size="sm">
                      сегодня
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed">
                  {countLabel(items.length, ACTIVITIES)}
                </Text>
              </Group>
              <Table.ScrollContainer minWidth={860} type="native">
                <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th w={110}>Время</Table.Th>
                      <Table.Th>Активность</Table.Th>
                      <Table.Th w={240}>Запись</Table.Th>
                      <Table.Th w={150}>Статус</Table.Th>
                      <Table.Th w={170} />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {items.map((e) =>
                      e.type === 'activity' ? (
                        <ActivityRow
                          key={e.key}
                          a={e.activity}
                          tz={tz}
                          editable={canEdit(e.activity)}
                          onEdit={() => openEdit(e.activity)}
                          onRegs={() => openRegs(e.activity)}
                        />
                      ) : e.type === 'block' ? (
                        <BlockRow
                          key={e.key}
                          b={e.block}
                          tz={tz}
                          onOpen={() => openBlock(e.block.id)}
                          onPeople={() => openBlockPeople(e.block.id)}
                        />
                      ) : (
                        <CounselingRow
                          key={e.key}
                          e={e}
                          tz={tz}
                          open={counseling.data?.open ?? false}
                          onOpen={() => openCounseling(e.day)}
                          onPeople={() => openCounselingPeople(e.day)}
                        />
                      ),
                    )}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
          ))}
        </Stack>
      )}

      <ActivityFormModal
        opened={form.opened}
        activity={form.activity}
        defaultDay={contextDay}
        onClose={() => setForm((f) => ({ ...f, opened: false }))}
      />
      <RegistrationsDrawer activity={regs.activity} opened={regs.opened} onClose={() => setRegs((r) => ({ ...r, opened: false }))} />
      {canAll && (
        <>
          <BlockModal
            key={`nb-${newBlock.key}`}
            block={null}
            defaultDay={contextDay}
            suggestedTitle={`Семинар ${(blocks?.length ?? 0) + 1}`}
            opened={newBlock.opened}
            onClose={() => setNewBlock((m) => ({ ...m, opened: false }))}
            onSaved={(b) => openBlock(b.id)}
          />
          <CounselingSetupModal
            key={`cs-${setup.key}`}
            existing={counselors.map((c) => c.name)}
            defaults={counselingDefaults}
            opened={setup.opened}
            onClose={() => setSetup((m) => ({ ...m, opened: false }))}
            onDone={openCounseling}
          />
          <SeminarBlockDrawer blockId={blockPanel.id} opened={blockPanel.opened} onClose={() => setBlockPanel((d) => ({ ...d, opened: false }))} />
          <CounselingDrawer
            day={counselingPanel.day}
            opened={counselingPanel.opened}
            onClose={() => setCounselingPanel((d) => ({ ...d, opened: false }))}
          />
          <BlockPeopleDrawer
            block={blocks?.find((b) => b.id === blockPeople.id) ?? null}
            opened={blockPeople.opened}
            onClose={() => setBlockPeople((d) => ({ ...d, opened: false }))}
          />
          <CounselingPeopleDrawer
            day={counselingPeople.day}
            opened={counselingPeople.opened}
            onClose={() => setCounselingPeople((d) => ({ ...d, opened: false }))}
          />
        </>
      )}
    </Stack>
  );
}

/** Блок семинаров одной строкой: темы, сколько записалось, опубликованы ли залы. Нажатие - настройка. */
function BlockRow({ b, tz, onOpen, onPeople }: { b: SeminarBlockView; tz: string; onOpen: () => void; onPeople: () => void }) {
  const visible = b.topics.filter((t) => !t.hidden && (t.roomId !== null || t.status === 'published'));
  const actions = useBlockActions(b);
  const registered = blockRegistered(b);
  const capacity = blockCapacity(b);
  const pct = capacity ? Math.min(100, (registered / capacity) * 100) : 0;
  return (
    <Table.Tr onClick={onOpen} style={{ cursor: 'pointer', opacity: b.hidden ? 0.7 : 1 }}>
      <Table.Td>
        <Text fw={700} size="sm" className="sof-tabular">
          {formatTime(b.startsAt, tz)}
        </Text>
        <Text size="xs" c="dimmed" className="sof-tabular">
          до {formatTime(b.endsAt, tz)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={4}>
          <Text fw={600} size="sm">
            {b.title}
          </Text>
          <Group gap="xs" wrap="wrap">
            <ActivityKindBadge kind="Семинар" size="xs" />
            <Text size="xs" c={b.topics.length ? 'dimmed' : 'orange'} lineClamp={1}>
              {b.topics.length
                ? `${countLabel(visible.length, TOPICS)}: ${visible.map((t) => t.title).join(' · ')}`
                : 'Тем пока нет - добавьте'}
            </Text>
          </Group>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap={4}>
          <Text size="xs" className="sof-tabular">
            <b>{registered}</b>
            {capacity ? ` / ${capacity} мест` : ' · залов нет'}
          </Text>
          {capacity > 0 && <Progress value={pct} size="sm" color={pct > 90 ? 'orange' : 'indigo'} />}
          <Text size="xs" c="dimmed">
            <Text span size="xs" c={b.registrationOpen ? 'teal' : 'dimmed'}>
              {b.registrationOpen ? 'выбор открыт' : 'выбор закрыт'}
            </Text>
            {' · '}
            <Text span size="xs" c={b.roomsPublishedAt && b.dirty ? 'yellow' : 'dimmed'}>
              {b.roomsPublishedAt ? (b.dirty ? 'есть изменения' : 'опубликовано') : 'не опубликовано'}
            </Text>
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <ActivityStatusBadge status={!b.hidden && visible.length ? 'published' : 'draft'} />
      </Table.Td>
      <Table.Td>
        <RowActions
          label={b.title}
          hidden={b.hidden}
          onDelete={() => void actions.del()}
          deleting={actions.deleting}
          onToggle={() => void actions.toggleHidden()}
          toggling={actions.toggling}
          onPeople={onPeople}
          onEdit={onOpen}
        />
      </Table.Td>
    </Table.Tr>
  );
}

type CounselingEntry = Extract<Entry, { type: 'counseling' }>;

/** Душепопечение дня одной строкой: служители, сколько окошек занято. Нажатие - настройка. */
function CounselingRow({
  e,
  tz,
  open,
  onOpen,
  onPeople,
}: {
  e: CounselingEntry;
  tz: string;
  open: boolean;
  onOpen: () => void;
  onPeople: () => void;
}) {
  const actions = useCounselingDayActions(e.counselors);
  const booked = e.counselors.reduce((s, c) => s + c.bookings.length, 0);
  const slots = e.counselors.reduce((s, c) => s + c.slots.length, 0);
  const pct = slots ? Math.min(100, (booked / slots) * 100) : 0;
  return (
    <Table.Tr onClick={onOpen} style={{ cursor: 'pointer', opacity: actions.hidden ? 0.7 : 1 }}>
      <Table.Td>
        <Text fw={700} size="sm" className="sof-tabular">
          {formatTime(e.startsAt, tz)}
        </Text>
        <Text size="xs" c="dimmed" className="sof-tabular">
          до {formatTime(e.endsAt, tz)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={4}>
          <Text fw={600} size="sm">
            {COUNSELING_KIND}
          </Text>
          <Group gap="xs" wrap="wrap">
            <Badge color="pink" size="xs" variant="dot">
              {COUNSELING_KIND}
            </Badge>
            <Text size="xs" c="dimmed" lineClamp={1}>
              {countLabel(e.counselors.length, COUNSELORS)}: {e.counselors.map((c) => c.name).join(' · ')}
            </Text>
          </Group>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap={4}>
          <Text size="xs" className="sof-tabular">
            <b>{booked}</b> / {slots} окошек
          </Text>
          <Progress value={pct} size="sm" color="pink" />
          <Text size="xs" c={open ? 'teal' : 'dimmed'}>
            {open ? 'запись открыта' : 'запись закрыта'}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <ActivityStatusBadge status={actions.hidden ? 'draft' : 'published'} />
      </Table.Td>
      <Table.Td>
        <RowActions
          label={`${COUNSELING_KIND}, ${formatTime(e.startsAt, tz)}`}
          hidden={actions.hidden}
          onDelete={() => void actions.del()}
          deleting={actions.deleting}
          onToggle={() => void actions.toggleHidden()}
          toggling={actions.toggling}
          onPeople={onPeople}
          onEdit={onOpen}
        />
      </Table.Td>
    </Table.Tr>
  );
}

function ActivityRow({
  a,
  tz,
  editable,
  onEdit,
  onRegs,
}: {
  a: ActivityView;
  tz: string;
  editable: boolean;
  onEdit: () => void;
  onRegs: () => void;
}) {
  const required = a.registrationMode === 'required';
  const pct = a.capacity ? Math.min(100, (a.registeredCount / a.capacity) * 100) : 0;
  const full = a.capacity !== null && a.registeredCount >= a.capacity;
  const cancelled = a.status === 'cancelled';
  const hidden = a.status === 'draft';
  const update = useUpdateActivity();
  const remove = useActivityDelete();
  // Глаз: одним нажатием показать или спрятать мероприятие от участников.
  const toggleVisible = () =>
    update.mutate({ id: a.id, patch: { status: hidden ? 'published' : 'draft' } }, { onError: (err) => notifyError(err) });
  return (
    <Table.Tr style={{ opacity: cancelled ? 0.6 : hidden ? 0.7 : 1 }}>
      <Table.Td>
        <Text fw={700} size="sm" className="sof-tabular">
          {formatTime(a.startsAt, tz)}
        </Text>
        <Text size="xs" c="dimmed" className="sof-tabular">
          до {formatTime(a.endsAt, tz)}
          {dayKey(a.endsAt, tz) !== dayKey(a.startsAt, tz) ? ' (след. день)' : ''}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={4}>
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} size="sm" td={cancelled ? 'line-through' : undefined} lineClamp={2}>
              {a.title}
            </Text>
          </Group>
          <Group gap="xs" wrap="wrap">
            <ActivityKindBadge kind={a.kind} size="xs" />
            {a.location && (
              <Group gap={2} wrap="nowrap">
                <IconMapPin size={12} color="var(--mantine-color-dimmed)" />
                <Text size="xs" c="dimmed">
                  {a.location}
                </Text>
              </Group>
            )}
            {a.host && (
              <Group gap={2} wrap="nowrap">
                <IconUser size={12} color="var(--mantine-color-dimmed)" />
                <Text size="xs" c="dimmed">
                  {a.host}
                </Text>
              </Group>
            )}
            {(a.minAge !== null || a.maxAge !== null) && (
              <Badge size="xs" variant="outline" color="gray">
                {a.minAge !== null && a.maxAge !== null
                  ? `${a.minAge}–${a.maxAge} лет`
                  : a.minAge !== null
                    ? `от ${a.minAge} лет`
                    : `до ${a.maxAge} лет`}
              </Badge>
            )}
          </Group>
        </Stack>
      </Table.Td>
      <Table.Td>
        {required ? (
          <Stack gap={4}>
            <Group gap={6} justify="space-between" wrap="nowrap">
              <Text size="xs" className="sof-tabular">
                <b>{a.registeredCount}</b>
                {a.capacity !== null ? ` / ${a.capacity}` : ' · без лимита'}
              </Text>
              {a.waitlistCount > 0 && (
                <Badge size="xs" color="yellow" variant="light">
                  ожидают {a.waitlistCount}
                </Badge>
              )}
            </Group>
            {a.capacity !== null && <Progress value={pct} size="sm" color={full ? 'red' : pct > 80 ? 'orange' : 'indigo'} />}
          </Stack>
        ) : (
          <Text size="xs" c="dimmed">
            {REGISTRATION_MODE_LABELS.none}
            {a.interestCount > 0 ? ` · интерес: ${a.interestCount}` : ''}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <ActivityStatusBadge status={a.status} />
      </Table.Td>
      <Table.Td>
        {editable && (
          <RowActions
            label={a.title}
            hidden={cancelled ? null : hidden}
            onDelete={() => void remove.run(a)}
            deleting={remove.pending}
            onToggle={toggleVisible}
            toggling={update.isPending}
            onPeople={onRegs}
            onEdit={onEdit}
          />
        )}
      </Table.Td>
    </Table.Tr>
  );
}

/** Телефон: день → группы по времени начала → компактные карточки активностей. */
function MobileDay({
  day,
  today,
  items,
  tz,
  canEdit,
  onEdit,
  onRegs,
  onBlock,
  onCounseling,
  onBlockPeople,
  onCounselingPeople,
}: {
  day: string;
  today: string;
  items: Entry[];
  tz: string;
  canEdit: (a: ActivityView) => boolean;
  onEdit: (a: ActivityView) => void;
  onRegs: (a: ActivityView) => void;
  onBlock: (id: number) => void;
  onCounseling: (day: string) => void;
  onBlockPeople: (id: number) => void;
  onCounselingPeople: (day: string) => void;
}) {
  const groups = useMemo(() => groupByStart(items, tz), [items, tz]);
  return (
    <Card padding={0}>
      <Group justify="space-between" px="md" py="sm" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <Title order={4} fz="md">
            {capitalizeFirst(formatDayLong(day))}
          </Title>
          {day === today && (
            <Badge color="indigo" variant="filled" size="sm">
              сегодня
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {countLabel(items.length, ACTIVITIES)}
        </Text>
      </Group>
      {groups.map((g) => (
        <Fragment key={g.time}>
          <Group gap={6} px="md" py={6} bg="var(--mantine-color-default-hover)" wrap="nowrap">
            <Text fw={800} size="sm" className="sof-tabular">
              {g.time}
            </Text>
            <Text size="sm" c="dimmed">
              · {countLabel(g.items.length, ACTIVITIES)}
            </Text>
          </Group>
          {g.items.map((e, i) => (
            <Fragment key={e.key}>
              {i > 0 && <Divider />}
              {e.type === 'activity' ? (
                <MobileActivity
                  a={e.activity}
                  tz={tz}
                  editable={canEdit(e.activity)}
                  onEdit={() => onEdit(e.activity)}
                  onRegs={() => onRegs(e.activity)}
                />
              ) : e.type === 'block' ? (
                <MobileBlock
                  b={e.block}
                  tz={tz}
                  onOpen={() => onBlock(e.block.id)}
                  onPeople={() => onBlockPeople(e.block.id)}
                />
              ) : (
                <MobileCounseling e={e} tz={tz} onOpen={() => onCounseling(e.day)} onPeople={() => onCounselingPeople(e.day)} />
              )}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </Card>
  );
}

function MobileActivity({
  a,
  tz,
  editable,
  onEdit,
  onRegs,
}: {
  a: ActivityView;
  tz: string;
  editable: boolean;
  onEdit: () => void;
  onRegs: () => void;
}) {
  const cancelled = a.status === 'cancelled';
  const hidden = a.status === 'draft';
  const update = useUpdateActivity();
  const remove = useActivityDelete();
  const age = ageLabel(a);
  const full = a.capacity !== null && a.registeredCount >= a.capacity;
  const meta = [`${formatTime(a.startsAt, tz)}–${formatTime(a.endsAt, tz)}`, a.location, a.host].filter(Boolean).join(' · ');
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs" px="md" py="sm" align="flex-start" style={{ opacity: cancelled ? 0.6 : 1 }}>
      <UnstyledButton onClick={editable ? onEdit : undefined} disabled={!editable} style={{ minWidth: 0, flex: 1, cursor: editable ? 'pointer' : 'default' }}>
        <Text fw={600} size="sm" td={cancelled ? 'line-through' : undefined}>
          {a.title}
        </Text>
        <Text size="xs" c="dimmed">
          {meta}
        </Text>
        <Group gap={6} mt={4} wrap="wrap">
          <ActivityKindBadge kind={a.kind} size="xs" />
          {a.status !== 'published' && <ActivityStatusBadge status={a.status} size="xs" />}
          {a.registrationMode === 'required' && (
            <Badge size="xs" variant="light" color={full ? 'red' : 'indigo'}>
              {registrationLabel(a).toLowerCase()}
            </Badge>
          )}
          {a.waitlistCount > 0 && (
            <Badge size="xs" color="yellow" variant="light">
              ожидают {a.waitlistCount}
            </Badge>
          )}
          {age && (
            <Badge size="xs" variant="outline" color="gray">
              {age}
            </Badge>
          )}
        </Group>
      </UnstyledButton>
      {editable && (
        <RowActions
          size="lg"
          label={a.title}
          hidden={cancelled ? null : hidden}
          onDelete={() => void remove.run(a)}
          deleting={remove.pending}
          onToggle={() =>
            update.mutate({ id: a.id, patch: { status: hidden ? 'published' : 'draft' } }, { onError: (err) => notifyError(err) })
          }
          toggling={update.isPending}
          onPeople={onRegs}
          onEdit={onEdit}
        />
      )}
    </Group>
  );
}

/** Телефон: блок семинаров или душепопечение одной строкой - нажатие открывает настройку. */
function MobileSummary({
  title,
  meta,
  badge,
  note,
  onOpen,
  actions,
  dimmed,
}: {
  title: string;
  meta: string;
  badge: ReactNode;
  note: string;
  onOpen: () => void;
  /** Ряд кнопок (удалить, скрыть, люди, изменить) вместо стрелки. */
  actions?: ReactNode;
  dimmed?: boolean;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs" px="md" py="sm" align="flex-start" style={{ opacity: dimmed ? 0.7 : 1 }}>
      <UnstyledButton onClick={onOpen} style={{ minWidth: 0, flex: 1 }}>
        <div>
          <Text fw={600} size="sm">
            {title}
          </Text>
          <Text size="xs" c="dimmed">
            {meta}
          </Text>
          <Group gap={6} mt={4} wrap="wrap">
            {badge}
            <Text size="xs" c="dimmed">
              {note}
            </Text>
          </Group>
        </div>
      </UnstyledButton>
      {actions ?? <IconChevronRight size={18} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />}
    </Group>
  );
}

/** Телефон: блок семинаров строкой - с кнопками удалить, скрыть, люди, изменить. */
function MobileBlock({ b, tz, onOpen, onPeople }: { b: SeminarBlockView; tz: string; onOpen: () => void; onPeople: () => void }) {
  const actions = useBlockActions(b);
  return (
    <MobileSummary
      title={b.title}
      meta={`${formatTime(b.startsAt, tz)}–${formatTime(b.endsAt, tz)} · ${countLabel(b.topics.length, TOPICS)}`}
      badge={
        <>
          <ActivityKindBadge kind="Семинар" size="xs" />
          {b.hidden && <ActivityStatusBadge status="draft" size="xs" />}
        </>
      }
      note={`записалось ${blockRegistered(b)}${blockCapacity(b) ? ` из ${blockCapacity(b)}` : ''} · ${
        b.roomsPublishedAt ? (b.dirty ? 'есть изменения залов' : 'залы опубликованы') : 'залы не опубликованы'
      }`}
      onOpen={onOpen}
      dimmed={b.hidden}
      actions={
        <RowActions
          size="lg"
          label={b.title}
          hidden={b.hidden}
          onDelete={() => void actions.del()}
          deleting={actions.deleting}
          onToggle={() => void actions.toggleHidden()}
          toggling={actions.toggling}
          onPeople={onPeople}
          onEdit={onOpen}
        />
      }
    />
  );
}

/** Телефон: душепопечение дня строкой - с кнопками удалить, скрыть, люди, изменить. */
function MobileCounseling({ e, tz, onOpen, onPeople }: { e: CounselingEntry; tz: string; onOpen: () => void; onPeople: () => void }) {
  const actions = useCounselingDayActions(e.counselors);
  return (
    <MobileSummary
      title={COUNSELING_KIND}
      meta={`${formatTime(e.startsAt, tz)}–${formatTime(e.endsAt, tz)} · ${countLabel(e.counselors.length, COUNSELORS)}`}
      badge={
        <>
          <Badge color="pink" size="xs" variant="dot">
            {COUNSELING_KIND}
          </Badge>
          {actions.hidden && <ActivityStatusBadge status="draft" size="xs" />}
        </>
      }
      note={`записано ${e.counselors.reduce((s, c) => s + c.bookings.length, 0)} из ${e.counselors.reduce((s, c) => s + c.slots.length, 0)} окошек`}
      onOpen={onOpen}
      dimmed={actions.hidden}
      actions={
        <RowActions
          size="lg"
          label={`${COUNSELING_KIND}, ${formatTime(e.startsAt, tz)}`}
          hidden={actions.hidden}
          onDelete={() => void actions.del()}
          deleting={actions.deleting}
          onToggle={() => void actions.toggleHidden()}
          toggling={actions.toggling}
          onPeople={onPeople}
          onEdit={onOpen}
        />
      }
    />
  );
}
