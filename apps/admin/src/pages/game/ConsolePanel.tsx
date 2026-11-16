import { ActionIcon, Badge, Button, Card, CopyButton, Group, NumberInput, SimpleGrid, Stack, Switch, Table, Text, Title, Tooltip } from '@mantine/core';
import type { GameAdminView } from '@sof/shared';
import {
  IconCheck,
  IconCopy,
  IconDeviceTv,
  IconExternalLink,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSend,
  IconTrash,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import {
  useGameCloseRound,
  useGameDistribute,
  useGameExtendRound,
  useGameFlags,
  useGameOpenRound,
  useGameReinvite,
  useGameResetDistribution,
  useGameResetVotes,
  useGameScreenToken,
  useGameReveal,
  useGameSignup,
  useGameStage,
  useGameStart,
  useGameTeamCount,
} from '../../api/game.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { countLabel, formatDateTime } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { mmss, TeamLabel, useCountdown } from './common.tsx';
import { LaunchCard } from './LaunchCard.tsx';

const onError = { onError: (e: unknown) => notifyError(e) };
const PLAYERS = ['игрок', 'игрока', 'игроков'] as const;
const TEAMS = ['команде', 'командам', 'командам'] as const;

/** Пульт: запись, распределение, голосование по раундам, итоги и большой экран. С телефона тоже удобно. */
export function ConsolePanel({ view }: { view: GameAdminView }) {
  const tz = useEventTz();
  const confirm = useConfirm();
  const signup = useGameSignup();
  const reinvite = useGameReinvite();
  const distribute = useGameDistribute();
  const resetDistribution = useGameResetDistribution();
  const flags = useGameFlags();
  const token = useGameScreenToken();
  const resetVotes = useGameResetVotes();

  const yes = view.players.filter((p) => p.answer === 'yes');
  const no = view.players.length - yes.length;
  const men = yes.filter((p) => p.gender === 'm').length;
  const unassigned = view.distributedAt ? yes.filter((p) => !p.teamId).length : 0;
  const screenUrl = `${window.location.origin}/screen/${view.screenToken}`;

  const doDistribute = async () => {
    const ok = await confirm({
      title: view.distributedAt ? 'Распределить заново?' : 'Распределить по командам?',
      message: `${countLabel(yes.length, PLAYERS)} разойдутся по ${countLabel(view.teams.length, TEAMS)} поровну (парни и девушки - тоже). Каждому придёт сообщение с командой.${view.distributedAt ? ' Прежнее распределение заменится.' : ''}${
        view.rounds.length ? ' Внимание: голосование уже было - люди окажутся в других командах, а голоса останутся за командами.' : ''
      }`,
      confirmLabel: 'Распределить',
      danger: view.rounds.length > 0,
    });
    if (ok) distribute.mutate(undefined, { onSuccess: () => notifySuccess('Распределили, сообщения уходят игрокам'), ...onError });
  };

  return (
    <Stack gap="md">
      <LaunchCard view={view} />
      {view.teams.length === 0 && <CreateTeams />}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <Step
          title="1. Запись"
          status={view.signupOpen ? <Badge color="green">открыта</Badge> : <Badge color="gray">закрыта</Badge>}
          text={
            view.launch === 'off'
              ? 'Сначала запустите игру - блок «Запуск игры» выше.'
              : `Участвуют ${yes.length} (парней ${men}, девушек ${yes.length - men}) · нет - ${no}. ${
                  view.launch === 'test'
                    ? `Тестовый запуск: приглашение придёт только тест-листу${view.audience ? ` (ещё не ответили: ${Math.max(0, view.audience - view.players.length)})` : ''}.`
                    : `Ещё не ответили: ${Math.max(0, view.audience - view.players.length)}.`
                }`
          }
        >
          <Button
            size="xs"
            color={view.signupOpen ? 'gray' : 'green'}
            loading={signup.isPending}
            disabled={!view.signupOpen && view.launch === 'off'}
            onClick={() => signup.mutate(!view.signupOpen, { onSuccess: () => notifySuccess(view.signupOpen ? 'Запись закрыта' : 'Запись открыта - приглашения уходят'), ...onError })}
          >
            {view.signupOpen ? 'Закрыть запись' : 'Открыть запись и пригласить'}
          </Button>
          {view.signupOpen && (
            <Button size="xs" variant="subtle" leftSection={<IconSend size={14} />} loading={reinvite.isPending} onClick={() => reinvite.mutate(undefined, { onSuccess: () => notifySuccess('Пригласили тех, кто ещё не ответил'), ...onError })}>
              Пригласить ещё раз
            </Button>
          )}
        </Step>

        <Step
          title="2. Распределение"
          status={view.distributedAt ? <Badge color="green">готово</Badge> : <Badge color="gray">не было</Badge>}
          text={
            view.distributedAt
              ? `${formatDateTime(view.distributedAt, tz)}. Новые «участвую» сразу попадают в самые маленькие команды.${unassigned ? ` Без команды: ${unassigned}.` : ''}`
              : view.teams.length === 0
                ? 'Сначала создайте команды - блок выше.'
                : yes.length === 0
                  ? view.launch === 'test'
                    ? 'Пока никто не записан: нажмите «Записать всех в игру» в тест-листе или откройте запись.'
                    : 'Пока никто не записан - откройте запись.'
                  : view.config.distributeAt
                    ? `Автоматически: ${formatDateTime(view.config.distributeAt, tz)}`
                    : 'Нажмите, когда запись закончится (обычно за 15 минут до начала)'
          }
        >
          <Button size="xs" leftSection={<IconUsersGroup size={14} />} loading={distribute.isPending} disabled={view.teams.length === 0 || yes.length === 0} onClick={() => void doDistribute()}>
            {view.distributedAt ? 'Распределить заново' : 'Распределить сейчас'}
          </Button>
          {view.distributedAt && (
            <Button
              size="xs"
              variant="subtle"
              color="red"
              onClick={async () => {
                if (await confirm({ title: 'Сбросить распределение?', message: 'Все игроки останутся без команд, капитаны снимутся. Ответы «участвую» сохранятся.', confirmLabel: 'Сбросить', danger: true })) {
                  resetDistribution.mutate(undefined, onError);
                }
              }}
            >
              Сбросить
            </Button>
          )}
        </Step>

        <Step
          title="3. Оформление команд"
          status={view.designLocked ? <Badge color="gray">закрыто</Badge> : <Badge color="green">открыто</Badge>}
          text={`Названия придумали ${view.teams.filter((t) => !t.placeholder).length} из ${view.teams.length}.${view.teams.some((t) => t.proposal) ? ' Есть названия на одобрение - вкладка «Команды».' : ''}`}
        >
          <Switch
            label="Закрыть оформление"
            checked={view.designLocked}
            onChange={(e) => flags.mutate({ designLocked: e.currentTarget.checked }, onError)}
          />
        </Step>

        <Step title="Большой экран" status={<IconDeviceTv size={18} />} text="Откройте на ноутбуке у проектора - вход не нужен. Обновляется сам, раз в секунду.">
          <Group gap={6}>
            <Button size="xs" component="a" href={screenUrl} target="_blank" leftSection={<IconExternalLink size={14} />}>
              Открыть
            </Button>
            <CopyButton value={screenUrl}>
              {({ copied, copy }) => (
                <Button size="xs" variant="light" onClick={copy} leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}>
                  {copied ? 'Скопировано' : 'Ссылка'}
                </Button>
              )}
            </CopyButton>
            <Tooltip label="Старая ссылка перестанет работать">
              <ActionIcon variant="subtle" onClick={async () => (await confirm({ title: 'Новая ссылка на экран?', message: 'Старая перестанет открываться.', confirmLabel: 'Сменить' })) && token.mutate(undefined, onError)}>
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Step>
      </SimpleGrid>

      <FlowCard view={view} />

      <RoundCard view={view} />

      <Card>
        <Group justify="space-between" mb="sm">
          <Title order={4} fz="md">
            Итоги - {view.config.mode === 'per_team' ? `по ${view.config.pointsPerTeam} после каждой команды` : `общий запас ${view.config.budget}`}
          </Title>
          <Group gap="sm">
            <Switch label="Показать итоги на экране" checked={view.resultsShown} onChange={(e) => flags.mutate({ resultsShown: e.currentTarget.checked }, onError)} />
            <Button
              size="xs"
              variant="subtle"
              color="red"
              leftSection={<IconTrash size={14} />}
              onClick={async () => {
                if (await confirm({ title: 'Стереть все голоса?', message: 'Для репетиции: все раунды и голоса удалятся, итоги обнулятся.', confirmLabel: 'Стереть', danger: true })) {
                  resetVotes.mutate(undefined, { onSuccess: () => notifySuccess('Голоса стёрты'), ...onError });
                }
              }}
            >
              Стереть голоса
            </Button>
          </Group>
        </Group>
        <Table.ScrollContainer minWidth={480}>
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>#</Table.Th>
                <Table.Th>Команда</Table.Th>
                <Table.Th ta="right">Людей отправили</Table.Th>
                <Table.Th ta="right">Голосовали</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {[...view.teams]
                .sort((a, b) => b.points - a.points)
                .map((t, i) => (
                  <Table.Tr key={t.id}>
                    <Table.Td fw={700}>{i + 1}</Table.Td>
                    <Table.Td>
                      <TeamLabel team={t} />
                    </Table.Td>
                    <Table.Td ta="right" fw={800} fz="lg">
                      {t.points}
                    </Table.Td>
                    <Table.Td ta="right">{t.voters}</Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}

function Step({ title, status, text, children }: { title: string; status: ReactNode; text: string; children: ReactNode }) {
  return (
    <Card>
      <Group justify="space-between" mb={6} wrap="nowrap">
        <Text fw={700}>{title}</Text>
        {status}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {text}
      </Text>
      <Group gap={6}>{children}</Group>
    </Card>
  );
}

/** Ход игры: «Начать игру», «Показать задания», кто выступает (флаг и задание на большом экране). */
function FlowCard({ view }: { view: GameAdminView }) {
  const confirm = useConfirm();
  const start = useGameStart();
  const reveal = useGameReveal();
  const stage = useGameStage();
  const [notify, setNotify] = useState(view.config.notifyTasks);
  const noTask = view.teams.filter((t) => !t.taskId).length;
  return (
    <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
      <Step
        title="4. Начать игру"
        status={view.startedAt ? <Badge color="green">начата</Badge> : <Badge color="gray">не начата</Badge>}
        text="Запись и оформление команд закроются. На экране - заставка игры, флаги пока скрыты."
      >
        <Button
          size="xs"
          color={view.startedAt ? 'gray' : 'green'}
          loading={start.isPending}
          onClick={async () => {
            if (!view.startedAt && !(await confirm({ title: 'Начать игру?', message: 'Запись и оформление команд закроются.', confirmLabel: 'Начать' }))) return;
            start.mutate(!view.startedAt, onError);
          }}
        >
          {view.startedAt ? 'Отменить старт' : 'Начать игру'}
        </Button>
      </Step>
      <Step
        title="5. Показать задания"
        status={view.tasksRevealedAt ? <Badge color="green">открыты</Badge> : <Badge color="gray">скрыты</Badge>}
        text={`Команды увидят свой контекст и задание, страну и флаг.${noTask ? ` Без задания: ${noTask}.` : ''}`}
      >
        {!view.tasksRevealedAt && <Switch size="xs" label="Задание в бот" checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)} />}
        <Button
          size="xs"
          color={view.tasksRevealedAt ? 'gray' : 'green'}
          loading={reveal.isPending}
          onClick={async () => {
            if (!view.tasksRevealedAt && !(await confirm({ title: 'Показать задания?', message: 'Командам откроются задания и флаги.', confirmLabel: 'Показать' }))) return;
            reveal.mutate({ revealed: !view.tasksRevealedAt, notify }, onError);
          }}
        >
          {view.tasksRevealedAt ? 'Скрыть задания' : 'Показать задания'}
        </Button>
      </Step>
      <Card>
        <Group justify="space-between" mb={6} wrap="nowrap">
          <Text fw={700}>6. Выступает</Text>
          {view.stageTeamId ? <Badge color="red">на экране</Badge> : <Badge color="gray">заставка</Badge>}
        </Group>
        <Stack gap={4}>
          {view.teams.map((t) => (
            <Button
              key={t.id}
              size="xs"
              variant={t.id === view.stageTeamId ? 'filled' : 'light'}
              justify="space-between"
              loading={stage.isPending && stage.variables === t.id}
              onClick={() => stage.mutate(t.id, onError)}
            >
              <TeamLabel team={t} />
            </Button>
          ))}
          <Button size="xs" variant="subtle" color="gray" disabled={!view.stageTeamId} onClick={() => stage.mutate(null, onError)}>
            Скрыть с экрана
          </Button>
        </Stack>
      </Card>
    </SimpleGrid>
  );
}

/** Голосование сейчас: какая команда, сколько осталось, сколько проголосовало; запуск раундов по порядку. */
function RoundCard({ view }: { view: GameAdminView }) {
  const confirm = useConfirm();
  const open = useGameOpenRound();
  const close = useGameCloseRound();
  const extend = useGameExtendRound();
  const current = view.rounds.find((r) => r.status === 'open') ?? null;
  const left = useCountdown(current?.closesAt ?? null);
  const team = current?.teamId ? view.teams.find((t) => t.id === current.teamId) : null;
  const votedTeams = new Set(view.rounds.filter((r) => r.status === 'closed' && r.teamId).map((r) => r.teamId));
  const seconds = view.config.roundSeconds;

  return (
    <Card>
      <Title order={4} fz="md" mb="sm">
        Голосование
      </Title>
      {current ? (
        <Card withBorder bg="var(--mantine-color-default-hover)" mb="md">
          <Group justify="space-between" align="center" wrap="wrap">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Сейчас голосуем
              </Text>
              {team ? <TeamLabel team={team} size="lg" /> : <Text fw={800} fz="lg">За все команды - общий запас</Text>}
            </div>
            <Group gap="lg">
              <div style={{ textAlign: 'center' }}>
                <Text fz={34} fw={900} lh={1} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {left === null ? '∞' : mmss(left)}
                </Text>
                <Text size="xs" c="dimmed">
                  осталось
                </Text>
              </div>
              <div style={{ textAlign: 'center' }}>
                <Text fz={34} fw={900} lh={1}>
                  {current.voters}
                </Text>
                <Text size="xs" c="dimmed">
                  проголосовали
                </Text>
              </div>
            </Group>
            <Group gap={6}>
              <Button size="sm" variant="light" leftSection={<IconPlus size={14} />} loading={extend.isPending} onClick={() => extend.mutate(60, onError)}>
                1 мин
              </Button>
              <Button size="sm" color="red" leftSection={<IconPlayerStop size={14} />} loading={close.isPending} onClick={() => close.mutate(undefined, onError)}>
                Закрыть
              </Button>
            </Group>
          </Group>
        </Card>
      ) : (
        <Text size="sm" c="dimmed" mb="md">
          Сейчас никто не голосует. {view.config.mode === 'per_team' ? 'После выступления команды нажмите «Голосовать» напротив неё.' : 'Когда выступят все команды - откройте общее голосование.'}
          {seconds ? ` Раунд длится ${mmss(seconds)}, потом закрывается сам.` : ' Раунд идёт, пока его не закроете.'}
        </Text>
      )}

      {view.config.mode === 'budget' ? (
        <Button leftSection={<IconPlayerPlay size={16} />} loading={open.isPending} disabled={!!current} onClick={() => open.mutate({ teamId: null }, onError)}>
          Открыть общее голосование
        </Button>
      ) : (
        <Stack gap={6}>
          {view.teams.map((t, i) => {
            const isCurrent = current?.teamId === t.id;
            return (
              <Group key={t.id} justify="space-between" wrap="nowrap" p={6} style={{ borderRadius: 8, background: isCurrent ? 'var(--mantine-color-default-hover)' : undefined }}>
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Text fw={700} w={22} c="dimmed" title="Порядок выступления">
                    {i + 1}
                  </Text>
                  <TeamLabel team={t} />
                  {votedTeams.has(t.id) && !isCurrent && (
                    <Badge size="xs" color="green" variant="light">
                      голосовали · {t.points}
                    </Badge>
                  )}
                </Group>
                <Button
                  size="xs"
                  variant={isCurrent ? 'filled' : votedTeams.has(t.id) ? 'subtle' : 'light'}
                  leftSection={<IconPlayerPlay size={14} />}
                  disabled={isCurrent}
                  loading={open.isPending && open.variables?.teamId === t.id}
                  onClick={async () => {
                    // Случайный тап не должен оборвать идущее голосование за другую команду.
                    if (current && left !== 0) {
                      const ok = await confirm({
                        title: `Голосовать за «${t.title}»?`,
                        message: `Сейчас идёт голосование за «${team?.title ?? 'другую команду'}» - оно закроется.`,
                        confirmLabel: 'Закрыть и открыть новое',
                      });
                      if (!ok) return;
                    }
                    open.mutate({ teamId: t.id }, onError);
                  }}
                >
                  {isCurrent ? 'Идёт' : votedTeams.has(t.id) ? 'Открыть снова' : 'Голосовать'}
                </Button>
              </Group>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}

/** Команд ещё нет - создать прямо с пульта, не уходя во вкладку «Команды». */
function CreateTeams() {
  const setCount = useGameTeamCount();
  const [count, setCountValue] = useState<number | string>(13);
  return (
    <Card withBorder style={{ borderColor: 'var(--mantine-color-blue-filled)' }}>
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <div style={{ flex: '1 1 300px' }}>
          <Text fw={700}>Команд пока нет</Text>
          <Text size="sm" c="dimmed">
            Создайте заглушки «Команда 1…N» - названия и страны потом придумают капитаны.
          </Text>
        </div>
        <Group gap="xs" align="flex-end">
          <NumberInput label="Сколько команд" min={1} max={60} allowDecimal={false} w={140} value={count} onChange={setCountValue} />
          <Button loading={setCount.isPending} disabled={!Number(count)} onClick={() => setCount.mutate(Number(count), { onSuccess: () => notifySuccess('Команды созданы'), ...onError })}>
            Создать команды
          </Button>
        </Group>
      </Group>
    </Card>
  );
}
