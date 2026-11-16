import { ActionIcon, Badge, Button, Card, ColorInput, Group, NumberInput, Select, SimpleGrid, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { GAME_TEAM_COLORS, countryName, flagEmoji, type GameAdminView, type GameTeamAdmin } from '@sof/shared';
import { IconArrowDown, IconArrowsShuffle, IconArrowUp, IconCheck, IconCrown, IconDice5, IconMicrophone2, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useGameMove, useGameOrder, useGameProposal, useGameRandomCaptain, useGameTeamCount, useGameTeamUpdate } from '../../api/game.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { CountrySelect, PersonPicker, TeamLabel } from './common.tsx';

const onError = { onError: (e: unknown) => notifyError(e) };

export function TeamsPanel({ view }: { view: GameAdminView }) {
  const setCount = useGameTeamCount();
  const order = useGameOrder();
  const confirm = useConfirm();
  const [count, setCountValue] = useState<number | string>(view.teams.length || 13);

  const applyCount = async () => {
    const n = Number(count);
    if (n < view.teams.length) {
      const ok = await confirm({
        title: `Оставить ${n} команд?`,
        message: `Удалятся команды с номерами ${n + 1}–${view.teams.length}${view.rounds.length ? ' вместе с голосами за них' : ''}; их игроки останутся без команды (их можно перераспределить).`,
        confirmLabel: 'Удалить лишние',
        danger: true,
      });
      if (!ok) return;
    }
    setCount.mutate(n, { onSuccess: () => notifySuccess('Готово'), ...onError });
  };

  const move = (i: number, dir: -1 | 1) => {
    const ids = view.teams.map((t) => t.id);
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    order.mutate({ ids }, onError);
  };

  return (
    <Stack gap="md">
      <Card>
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <Group align="flex-end" gap="sm">
            <NumberInput label="Сколько команд" min={1} max={60} allowDecimal={false} w={150} value={count} onChange={setCountValue} />
            <Button loading={setCount.isPending} disabled={Number(count) === view.teams.length} onClick={() => void applyCount()}>
              {view.teams.length ? 'Применить' : 'Создать команды'}
            </Button>
          </Group>
          <Button variant="light" leftSection={<IconArrowsShuffle size={16} />} loading={order.isPending} disabled={view.teams.length < 2} onClick={() => order.mutate({ shuffle: true }, onError)}>
            Случайный порядок выступлений
          </Button>
        </Group>
        <Text size="sm" c="dimmed" mt="xs">
          Сначала команды - заглушки «Команда 1…N» со своим цветом. Название церкви и страну придумывает капитан в мини-апке; вы можете поправить их здесь. Порядок в списке - порядок
          выступлений.
        </Text>
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {view.teams.map((t, i) => (
          <TeamCard key={t.id} team={t} view={view} order={i + 1} first={i === 0} last={i === view.teams.length - 1} onMove={(dir) => move(i, dir)} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

function TeamCard({ team, view, order, first, last, onMove }: { team: GameTeamAdmin; view: GameAdminView; order: number; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void }) {
  const update = useGameTeamUpdate();
  const proposal = useGameProposal();
  const random = useGameRandomCaptain();
  const movePlayer = useGameMove();
  const fromServer = () => ({ name: team.placeholder ? '' : team.title, countryCode: team.countryCode, color: team.color, captainId: team.captainId, taskId: team.taskId });
  const [draft, setDraft] = useState(fromServer);
  const server = fromServer();
  const dirty = JSON.stringify(draft) !== JSON.stringify(server);
  // Пока не правим - подтягиваем изменения капитана и других ведущих.
  const serverKey = JSON.stringify(server);
  useEffect(() => {
    if (!dirty) setDraft(JSON.parse(serverKey) as typeof server);
  }, [serverKey]);

  const members = view.players.filter((p) => p.answer === 'yes' && p.teamId === team.id);
  const teamOptions = [{ value: 'none', label: 'Без команды' }, ...view.teams.map((t) => ({ value: String(t.id), label: t.title }))];

  const save = () =>
    update.mutate(
      {
        id: team.id,
        patch: {
          name: draft.name.trim() || null,
          countryCode: draft.countryCode,
          color: draft.color,
          taskId: draft.taskId,
          ...(draft.captainId !== team.captainId ? { captainId: draft.captainId } : {}),
        },
      },
      { onSuccess: () => notifySuccess('Сохранено'), ...onError },
    );

  return (
    <Card style={{ borderTop: `4px solid ${team.color}` }}>
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <TeamLabel team={team} size="md" />
        </Group>
        <Group gap={4} wrap="nowrap">
          <Tooltip label={`Выступает ${order}-й`}>
            <Badge variant="light" color="gray" leftSection={<IconMicrophone2 size={12} />}>
              {order}
            </Badge>
          </Tooltip>
          <ActionIcon variant="subtle" disabled={first} onClick={() => onMove(-1)} aria-label="Выше">
            <IconArrowUp size={16} />
          </ActionIcon>
          <ActionIcon variant="subtle" disabled={last} onClick={() => onMove(1)} aria-label="Ниже">
            <IconArrowDown size={16} />
          </ActionIcon>
        </Group>
      </Group>

      <Text size="sm" c="dimmed" mt={-6} mb="sm">
        {team.size ? `${team.size} в команде · парней ${team.males}, девушек ${team.females}` : 'Пока в команде никого'}
      </Text>

      {team.proposal && (
        <Card withBorder padding="xs" mb="sm" bg="var(--mantine-color-yellow-light)">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              Капитан предлагает: <b>{team.proposal.name}</b>
              {team.proposal.countryCode ? ` · ${flagEmoji(team.proposal.countryCode)} ${countryName(team.proposal.countryCode)}` : ''}
            </Text>
            <Group gap={4} wrap="nowrap">
              <Tooltip label="Одобрить">
                <ActionIcon color="green" variant="light" onClick={() => proposal.mutate({ id: team.id, approve: true }, onError)}>
                  <IconCheck size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Отклонить">
                <ActionIcon color="red" variant="light" onClick={() => proposal.mutate({ id: team.id, approve: false }, onError)}>
                  <IconX size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        </Card>
      )}

      <Stack gap="xs">
        <TextInput label="Название церкви" placeholder={`Команда ${team.number}`} maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
        <Select
          label="Задание"
          placeholder="Без задания"
          clearable
          searchable
          value={draft.taskId ? String(draft.taskId) : null}
          data={view.tasks.map((t) => {
            const owner = t.teamId && t.teamId !== team.id ? view.teams.find((x) => x.id === t.teamId) : null;
            return { value: String(t.id), label: `${t.flag ? `${t.flag} ` : ''}${t.title}${owner ? ` (сейчас у «${owner.title}»)` : ''}` };
          })}
          description={view.tasks.length === 0 ? 'Задания пишут во вкладке «Задания»' : 'У задания со страной страна ставится сама'}
          onChange={(v) => {
            const task = view.tasks.find((t) => String(t.id) === v);
            setDraft({ ...draft, taskId: v ? Number(v) : null, ...(task?.countryCode ? { countryCode: task.countryCode } : {}) });
          }}
        />
        <Group grow align="flex-start">
          <CountrySelect
            label="Страна"
            value={draft.countryCode}
            disabled={!!view.tasks.find((t) => t.id === draft.taskId)?.countryCode}
            onChange={(v) => setDraft({ ...draft, countryCode: v })}
          />
          <ColorInput label="Цвет" format="hex" swatches={[...GAME_TEAM_COLORS]} value={draft.color} onChange={(v) => setDraft({ ...draft, color: v })} />
        </Group>
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <PersonPicker
            style={{ flex: 1 }}
            label="Капитан"
            placeholder="Игрок команды или поиск по фамилии"
            leftSection={<IconCrown size={16} />}
            view={view}
            preferred={members.map((m) => m.participantId)}
            value={draft.captainId}
            onChange={(id) => setDraft({ ...draft, captainId: id })}
          />
          <Tooltip label="Случайный капитан из команды">
            <ActionIcon size="lg" variant="light" disabled={members.length === 0} loading={random.isPending} onClick={() => random.mutate(team.id, onError)}>
              <IconDice5 size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {!view.distributedAt && (
          <Text size="xs" c="dimmed" mt={-4}>
            Капитана можно выбрать заранее - при распределении он останется в этой команде.
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          {dirty && (
            <Button variant="default" size="xs" onClick={() => setDraft(server)}>
              Отменить
            </Button>
          )}
          <Button size="xs" disabled={!dirty} loading={update.isPending} onClick={save}>
            Сохранить
          </Button>
        </Group>
        {members.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>Состав ({members.length})</summary>
            <Stack gap={4} mt="xs">
              {members.map((m) => (
                <Group key={m.participantId} justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" truncate>
                    {m.captain && '👑 '}
                    {m.fullName} <Text span c="dimmed" size="xs">{m.gender === 'm' ? 'м' : 'ж'}</Text>
                  </Text>
                  <Select
                    size="xs"
                    w={170}
                    data={teamOptions}
                    value={String(team.id)}
                    allowDeselect={false}
                    aria-label="Перенести в команду"
                    onChange={(v) => movePlayer.mutate({ participantId: m.participantId, teamId: !v || v === 'none' ? null : Number(v) }, onError)}
                  />
                </Group>
              ))}
            </Stack>
          </details>
        )}
      </Stack>
    </Card>
  );
}
