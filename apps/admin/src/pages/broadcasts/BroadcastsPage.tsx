import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Grid,
  Group,
  Loader,
  Progress,
  Select,
  Spoiler,
  Stack,
  Switch,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { tgHtml, type BroadcastView, type Category, type Segment } from '@sof/shared';
import {
  IconBold,
  IconClock,
  IconItalic,
  IconLink,
  IconPlayerStop,
  IconSend,
  IconSpeakerphone,
  IconStrikethrough,
  IconTestPipe,
  IconUnderline,
  IconUsers,
} from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { useActivities } from '../../api/activities.ts';
import { useParticipantLists } from '../../api/lists.ts';
import { useBroadcastPreview, useBroadcasts, useCancelBroadcast, useCreateBroadcast } from '../../api/broadcasts.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { EventDateTimeInput, TzHint } from '../../components/dates.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { AppLink } from '../../components/AppLink.tsx';
import { useSession } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { countLabel, formatDateTime, formatDateTimeShort, formatNumber, formatRelative } from '../../lib/format.ts';
import {
  BROADCAST_STATUS_COLORS,
  BROADCAST_STATUS_LABELS,
  CATEGORY_OPTIONS,
  SEGMENT_KIND_HINTS,
  SEGMENT_KIND_LABELS,
  segmentLabel,
} from '../../lib/labels.ts';
import { notifySuccess } from '../../lib/notify.tsx';
import { ACTIVITIES_ANY } from '../../lib/permissions.ts';
import { wallToIso } from '../../lib/tz.ts';

const MAX_TEXT = 4000;
const RECIPIENTS: [string, string, string] = ['получатель', 'получателя', 'получателей'];

// Списки идут отдельной группой в самом конце - каждый своим пунктом.
const KIND_OPTIONS = (Object.keys(SEGMENT_KIND_LABELS) as Segment['kind'][])
  .filter((k) => k !== 'list')
  .map((k) => ({ value: k, label: SEGMENT_KIND_LABELS[k] }));
/** Пока приём оплаты выключен, группа «Не оплатили» не нужна. */
const KIND_OPTIONS_NO_PAYMENTS = KIND_OPTIONS.filter((o) => o.value !== 'unpaid');

function buildSegment(kind: Segment['kind'], category: Category | null, activityId: string | null, listId: number | null): Segment | null {
  switch (kind) {
    case 'list':
      return listId ? { kind, listId } : null;
    case 'category':
      return category ? { kind, category } : null;
    case 'activity':
      return activityId ? { kind, activityId: Number(activityId) } : null;
    case 'all':
    case 'unpaid':
    case 'not_arrived':
    case 'arrived':
    case 'staff':
      return { kind };
  }
}

export default function BroadcastsPage() {
  const tz = useEventTz();
  const { session, can, paymentsEnabled } = useSession();
  const confirm = useConfirm();
  const activities = useActivities(can(...ACTIVITIES_ANY));
  const broadcasts = useBroadcasts();
  const create = useCreateBroadcast();

  const lists = useParticipantLists();
  // Со страницы «Списки»: ?list=ID - сразу «Кому: этот список».
  const urlList = Number(new URLSearchParams(useSearch()).get('list')) || null;
  const [text, setText] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** Обернуть выделенное маркерами (как в Telegram); без выделения - вставить пример и выделить его. */
  const wrap = (before: string, after: string, sample: string) => {
    const el = textRef.current;
    const from = el?.selectionStart ?? text.length;
    const to = el?.selectionEnd ?? text.length;
    const inner = text.slice(from, to) || sample;
    setText(text.slice(0, from) + before + inner + after + text.slice(to));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + before.length, from + before.length + inner.length);
    });
  };
  const addLink = () => {
    const el = textRef.current;
    const from = el?.selectionStart ?? text.length;
    const to = el?.selectionEnd ?? text.length;
    const label = text.slice(from, to) || 'текст ссылки';
    const url = 'https://';
    setText(`${text.slice(0, from)}[${label}](${url})${text.slice(to)}`);
    // Курсор - на адрес: осталось вставить ссылку.
    const at = from + label.length + 3 + url.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };
  const [pickedKind, setKind] = useState<Segment['kind']>(urlList ? 'list' : 'all');
  const [listId, setListId] = useState<number | null>(urlList);
  const kind: Segment['kind'] = pickedKind === 'unpaid' && !paymentsEnabled ? 'all' : pickedKind;
  const [category, setCategory] = useState<Category | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [alsoAnnouncement, setAlsoAnnouncement] = useState(false);
  const [touched, setTouched] = useState(false);

  const segment = useMemo(() => buildSegment(kind, category, activityId, listId), [kind, category, activityId, listId]);
  const listName = (id: number) => lists.data?.find((l) => l.id === id)?.name;
  const baseOptions = paymentsEnabled ? KIND_OPTIONS : KIND_OPTIONS_NO_PAYMENTS;
  const kindData = lists.data?.length
    ? [
        { group: 'Группы', items: baseOptions },
        { group: 'Списки', items: lists.data.map((l) => ({ value: `list:${l.id}`, label: `${l.name} · ${formatNumber(l.count)}` })) },
      ]
    : baseOptions;
  const kindValue = kind === 'list' ? (listId ? `list:${listId}` : null) : kind;
  const [debouncedSegment] = useDebouncedValue(segment, 300);
  const preview = useBroadcastPreview(debouncedSegment);

  const activityTitle = (id: number) => activities.data?.find((a) => a.id === id)?.title;
  const activityOptions = (activities.data ?? [])
    .filter((a) => a.registrationMode === 'required' && a.status !== 'cancelled')
    .map((a) => ({ value: String(a.id), label: `${a.title} · ${formatDateTimeShort(a.startsAt, tz)}` }));

  const trimmed = text.trim();
  const textError = touched && !trimmed ? 'Напишите текст сообщения' : trimmed.length > MAX_TEXT ? `Не длиннее ${MAX_TEXT} символов` : null;
  const scheduledIso = scheduled ? wallToIso(scheduledAt, tz) : null;
  const scheduleError =
    scheduled && touched
      ? !scheduledIso
        ? 'Укажите дату и время'
        : new Date(scheduledIso).getTime() < Date.now() + 60_000
          ? 'Время уже прошло'
          : null
      : null;
  const segmentError =
    touched && !segment ? (kind === 'category' ? 'Выберите категорию' : kind === 'list' ? 'Выберите список' : 'Выберите активность') : null;

  const valid = !!trimmed && trimmed.length <= MAX_TEXT && !!segment && (!scheduled || (!!scheduledIso && new Date(scheduledIso).getTime() > Date.now()));

  const sendTest = () => {
    setTouched(true);
    if (!trimmed || !segment) return;
    create.mutate(
      { text: trimmed, segment, scheduledAt: null, test: true, alsoAnnouncement: false },
      { onSuccess: () => notifySuccess('Отправили вам в Telegram - посмотрите, как выглядит') },
    );
  };

  const send = async () => {
    setTouched(true);
    if (!valid || !segment) return;
    const recipients = preview.data;
    const ok = await confirm({
      title: scheduled ? 'Запланировать рассылку?' : 'Отправить рассылку?',
      message: (
        <Stack gap="sm">
          <Group gap="xs">
            <ThemeIcon variant="light" size="sm" radius="xl">
              <IconUsers size={12} />
            </ThemeIcon>
            <Text size="sm">
              {segmentLabel(segment, activityTitle, listName)}:{' '}
              <b>{recipients === undefined ? 'считаем…' : countLabel(recipients, RECIPIENTS)}</b>
            </Text>
          </Group>
          {scheduled && scheduledIso && (
            <Group gap="xs">
              <ThemeIcon variant="light" size="sm" radius="xl" color="blue">
                <IconClock size={12} />
              </ThemeIcon>
              <Text size="sm">Отправка {formatDateTime(scheduledIso, tz)}</Text>
            </Group>
          )}
          {alsoAnnouncement && <Text size="sm">Текст также появится в ленте объявлений.</Text>}
          <div className="sof-chat-bg">
            <div className="sof-broadcast-preview" dangerouslySetInnerHTML={{ __html: tgHtml(trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed) }} />
          </div>
          <Text size="xs" c="dimmed">
            Остановить рассылку можно, пока она идёт, но уже доставленные сообщения останутся у людей.
          </Text>
        </Stack>
      ),
      confirmLabel: scheduled ? 'Запланировать' : `Отправить${recipients ? ` (${formatNumber(recipients)})` : ''}`,
    });
    if (!ok) return;
    create.mutate(
      { text: trimmed, segment, scheduledAt: scheduledIso, test: false, alsoAnnouncement },
      {
        onSuccess: (b) => {
          notifySuccess(
            scheduled ? `Запланировали: ${countLabel(b.total, RECIPIENTS)}` : `Отправляем: ${countLabel(b.total, RECIPIENTS)}`,
          );
          setText('');
          setTouched(false);
          setScheduled(false);
          setScheduledAt(null);
          setAlsoAnnouncement(false);
        },
      },
    );
  };

  return (
    <Stack gap="md">
      <PageHeader
        title="Рассылки"
        description="Напишите сообщение - бот разошлёт его в Telegram выбранной группе. Дойдёт до всех, у кого есть Telegram и кто не заблокировал бота."
        actions={
          <AppLink href="/bot-log" size="sm">
            Что бот отправил сам →
          </AppLink>
        }
      />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Card>
            <Stack gap="md">
              <Title order={4} fz="md">
                Новая рассылка
              </Title>
              <Group gap={4} mb={-8}>
                {(
                  [
                    ['Жирный', IconBold, '**', '**', 'жирный'],
                    ['Курсив', IconItalic, '*', '*', 'курсив'],
                    ['Подчёркнутый', IconUnderline, '__', '__', 'подчёркнутый'],
                    ['Зачёркнутый', IconStrikethrough, '~~', '~~', 'зачёркнутый'],
                  ] as const
                ).map(([label, Icon, before, after, sample]) => (
                  <Tooltip key={label} label={`${label}: выделите текст и нажмите`} withArrow>
                    <ActionIcon variant="default" size="md" aria-label={label} onClick={() => wrap(before, after, sample)}>
                      <Icon size={16} />
                    </ActionIcon>
                  </Tooltip>
                ))}
                <Tooltip label="Ссылка: выделите слова и нажмите, потом вставьте адрес" withArrow>
                  <ActionIcon variant="default" size="md" aria-label="Ссылка" onClick={addLink}>
                    <IconLink size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
              <Textarea
                ref={textRef}
                label="Текст сообщения"
                description="Выделите слова и нажмите кнопку выше: **жирный**, *курсив*, __подчёркнутый__, ~~зачёркнутый~~, [ссылка](https://…). Если опубликовать в ленте, первая строка станет заголовком."
                placeholder="Например: Друзья, обед сегодня переносится на 14:00 - столовая, 2 этаж."
                autosize
                minRows={6}
                maxRows={18}
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                onBlur={() => {
                  if (!trimmed) setTouched(true);
                }}
                error={textError}
                data-autofocus
              />
              <Text size="xs" c={text.length > MAX_TEXT ? 'red' : 'dimmed'} ta="right" mt={-10}>
                {formatNumber(text.length)} / {formatNumber(MAX_TEXT)}
              </Text>

              <Grid gap="sm">
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Select
                    label="Кому"
                    data={kindData}
                    value={kindValue}
                    onChange={(v) => {
                      if (!v) return;
                      if (v.startsWith('list:')) {
                        setKind('list');
                        setListId(Number(v.slice(5)));
                      } else setKind(v as Segment['kind']);
                    }}
                    allowDeselect={false}
                    maxDropdownHeight={360}
                    error={kind === 'list' ? segmentError : null}
                    description={SEGMENT_KIND_HINTS[kind]}
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  {kind === 'category' && (
                    <Select
                      label="Категория"
                      data={CATEGORY_OPTIONS}
                      value={category}
                      onChange={(v) => setCategory(v)}
                      placeholder="Выберите категорию"
                      error={segmentError}
                    />
                  )}
                  {kind === 'activity' && (
                    <Select
                      label="Активность"
                      data={activityOptions}
                      value={activityId}
                      onChange={setActivityId}
                      placeholder={activities.isPending ? 'Загрузка…' : 'Выберите активность'}
                      searchable
                      nothingFoundMessage="Нет активностей с записью"
                      error={segmentError}
                    />
                  )}
                </Grid.Col>
              </Grid>

              <Card padding="sm" radius="md" bg="var(--mantine-color-default-hover)" withBorder={false}>
                <Group gap="xs">
                  <IconUsers size={18} />
                  <Text size="sm">
                    Получателей:{' '}
                    {!segment ? (
                      <Text span c="dimmed">
                        выберите группу
                      </Text>
                    ) : preview.isFetching && preview.data === undefined ? (
                      <Loader size="xs" type="dots" />
                    ) : preview.isError ? (
                      <Text span c="red">
                        не удалось посчитать
                      </Text>
                    ) : (
                      <b>{formatNumber(preview.data ?? 0)}</b>
                    )}
                  </Text>
                  {segment && preview.isFetching && preview.data !== undefined && <Loader size="xs" type="dots" />}
                </Group>
              </Card>

              <Switch label="Отложенная отправка" checked={scheduled} onChange={(e) => setScheduled(e.currentTarget.checked)} />
              {scheduled && (
                <Stack gap={4} maw={360}>
                  <EventDateTimeInput
                    label="Когда отправить"
                    value={scheduledAt}
                    onChange={setScheduledAt}
                    minDate={new Date()}
                    error={scheduleError}
                  />
                  <TzHint />
                </Stack>
              )}
              <Checkbox
                label="Также опубликовать в ленте объявлений"
                description="Объявление появится в мини-приложении. Первая строка - заголовок, остальное - текст."
                checked={alsoAnnouncement}
                onChange={(e) => setAlsoAnnouncement(e.currentTarget.checked)}
              />

              <Group justify="space-between" gap="sm" wrap="wrap">
                <Tooltip
                  label={session.user.tgId ? 'Придёт только вам - посмотреть, как выглядит' : 'Нужен вход через Telegram: у вас его нет'}
                >
                  <Button
                    variant="default"
                    leftSection={<IconTestPipe size={16} />}
                    onClick={sendTest}
                    disabled={!session.user.tgId}
                    loading={create.isPending && create.variables?.test === true}
                  >
                    Отправить себе (тест)
                  </Button>
                </Tooltip>
                <Button
                  leftSection={scheduled ? <IconClock size={16} /> : <IconSend size={16} />}
                  onClick={() => void send()}
                  loading={create.isPending && create.variables?.test === false}
                >
                  {scheduled ? 'Запланировать' : 'Отправить'}
                </Button>
              </Group>
            </Stack>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Card h="100%">
            <Stack gap="sm">
              <Title order={4} fz="md">
                Как увидят участники
              </Title>
              <div className="sof-chat-bg" style={{ minHeight: 160 }}>
                {trimmed ? (
                  // tgHtml экранирует весь текст: теги - только форматирование и ссылки http(s)/tg.
                  <div className="sof-broadcast-preview" dangerouslySetInnerHTML={{ __html: tgHtml(trimmed) }} />
                ) : (
                  <Text size="sm" c="dimmed" ta="center" py="xl">
                    Здесь появится предпросмотр сообщения
                  </Text>
                )}
              </div>
              <Text size="xs" c="dimmed">
                Бот отправляет примерно 25 сообщений в секунду - тысяча человек получит сообщение где-то за минуту. Ссылки в
                тексте работают.
              </Text>
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>

      <History broadcasts={broadcasts} activityTitle={activityTitle} listName={listName} tz={tz} />
    </Stack>
  );
}

function History({
  broadcasts,
  activityTitle,
  listName,
  tz,
}: {
  broadcasts: ReturnType<typeof useBroadcasts>;
  activityTitle: (id: number) => string | undefined;
  listName: (id: number) => string | undefined;
  tz: string;
}) {
  const cancel = useCancelBroadcast();
  const confirm = useConfirm();
  const list = broadcasts.data ?? [];

  const doCancel = async (b: BroadcastView) => {
    const ok = await confirm({
      title: 'Остановить рассылку?',
      message:
        b.status === 'sending'
          ? `Уже доставили ${b.sent} из ${b.total}. Остальным сообщение не придёт.`
          : 'Рассылка не уйдёт в назначенное время.',
      confirmLabel: 'Остановить',
      danger: true,
    });
    if (ok) cancel.mutate(b.id, { onSuccess: () => notifySuccess('Остановили рассылку') });
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>История</Title>
        {list.some((b) => b.status === 'sending') && (
          <Badge color="yellow" variant="light" leftSection={<Loader size={10} type="oval" color="yellow" />}>
            идёт отправка
          </Badge>
        )}
      </Group>
      {broadcasts.isPending ? (
        <BlockSkeleton rows={3} height={110} />
      ) : broadcasts.isError ? (
        <ErrorState error={broadcasts.error} onRetry={() => void broadcasts.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyBlock icon={<IconSpeakerphone size={28} />} title="Рассылок пока не было" description="Первая появится здесь сразу после отправки." />
        </Card>
      ) : (
        <Stack gap="sm">
          {list.map((b) => {
            const done = b.sent + b.failed + b.blocked;
            const pct = (n: number) => (b.total ? (n / b.total) * 100 : 0);
            return (
              <Card key={b.id} padding="md">
                <Stack gap="xs">
                  <Group justify="space-between" gap="xs" wrap="wrap">
                    <Group gap="xs">
                      <Badge color={BROADCAST_STATUS_COLORS[b.status]} variant={b.status === 'sending' ? 'filled' : 'light'}>
                        {BROADCAST_STATUS_LABELS[b.status]}
                      </Badge>
                      {b.isTest ? (
                        <Badge color="grape" variant="outline">
                          Тест - только себе
                        </Badge>
                      ) : (
                        <Badge color="gray" variant="outline">
                          {segmentLabel(b.segment, activityTitle, listName)}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {formatDateTime(b.createdAt, tz)} ({formatRelative(b.createdAt)}) · {b.createdByName ?? '-'}
                    </Text>
                  </Group>
                  {b.scheduledAt && (
                    <Text size="xs" c="blue">
                      <IconClock size={12} style={{ verticalAlign: -2 }} /> отправка {formatDateTime(b.scheduledAt, tz)}
                    </Text>
                  )}
                  <Spoiler maxHeight={66} showLabel="Показать полностью" hideLabel="Свернуть">
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} dangerouslySetInnerHTML={{ __html: tgHtml(b.text) }} />
                  </Spoiler>
                  <Progress.Root size="lg" radius="xl">
                    <Tooltip label={`Доставлено: ${b.sent}`}>
                      <Progress.Section value={pct(b.sent)} color="green" />
                    </Tooltip>
                    <Tooltip label={`Заблокировали бота: ${b.blocked}`}>
                      <Progress.Section value={pct(b.blocked)} color="gray" />
                    </Tooltip>
                    <Tooltip label={`Ошибки: ${b.failed}`}>
                      <Progress.Section value={pct(b.failed)} color="red" />
                    </Tooltip>
                  </Progress.Root>
                  <Group justify="space-between" gap="xs" wrap="wrap">
                    <Group gap="md">
                      <Text size="xs">
                        Доставлено <b>{formatNumber(b.sent)}</b> из {formatNumber(b.total)}
                      </Text>
                      {b.blocked > 0 && (
                        <Text size="xs" c="dimmed">
                          заблокировали бота: {formatNumber(b.blocked)}
                        </Text>
                      )}
                      {b.failed > 0 && (
                        <Text size="xs" c="red">
                          ошибки: {formatNumber(b.failed)}
                        </Text>
                      )}
                      {b.status === 'sending' && (
                        <Text size="xs" c="dimmed">
                          осталось {formatNumber(Math.max(0, b.total - done))}
                        </Text>
                      )}
                    </Group>
                    {(b.status === 'scheduled' || b.status === 'sending') && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconPlayerStop size={12} />}
                        loading={cancel.isPending && cancel.variables === b.id}
                        onClick={() => void doCancel(b)}
                      >
                        Остановить
                      </Button>
                    )}
                  </Group>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

