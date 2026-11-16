import { Badge, Button, Card, Group, SegmentedControl, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import type { GameAdminView } from '@sof/shared';
import { IconSearch, IconUserPlus } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useGameMove } from '../../api/game.ts';
import { useEventTz } from '../../components/EventProvider.tsx';
import { formatTime } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { PersonPicker } from './common.tsx';

type Filter = 'yes' | 'no' | 'noteam' | 'all';

/** Кто ответил на приглашение и в какой он команде; перенос - выбором команды. */
export function PlayersPanel({ view }: { view: GameAdminView }) {
  const tz = useEventTz();
  const move = useGameMove();
  const [filter, setFilter] = useState<Filter>('yes');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<number | null>(null);
  const [addTeam, setAddTeam] = useState<string>('none');
  const add = () =>
    adding &&
    move.mutate(
      { participantId: adding, teamId: addTeam === 'none' ? null : Number(addTeam) },
      {
        onSuccess: () => {
          notifySuccess('Записали в игру');
          setAdding(null);
        },
        onError: (e) => notifyError(e),
      },
    );
  const teamOptions = [{ value: 'none', label: 'Без команды' }, ...view.teams.map((t) => ({ value: String(t.id), label: t.title }))];
  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      view.players.filter(
        (p) =>
          (filter === 'all' || (filter === 'noteam' ? p.answer === 'yes' && !p.teamId : p.answer === filter)) &&
          (!q || p.fullName.toLowerCase().includes(q)),
      ),
    [view.players, filter, q],
  );
  const yes = view.players.filter((p) => p.answer === 'yes').length;
  const noTeam = view.players.filter((p) => p.answer === 'yes' && !p.teamId).length;

  return (
    <Stack gap="md">
      <Card>
        <Text fw={700} mb={4}>
          Записать игрока самому
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          Для тех, у кого нет телефона или кто не успел ответить в боте. Найдите по фамилии и выберите команду.
        </Text>
        <Group align="flex-end" gap="sm" wrap="wrap">
          <PersonPicker view={view} value={adding} onChange={setAdding} placeholder="Фамилия участника" w={320} leftSection={<IconSearch size={16} />} />
          <Select w={220} data={teamOptions} value={addTeam} allowDeselect={false} onChange={(v) => setAddTeam(v ?? 'none')} aria-label="Команда" />
          <Button leftSection={<IconUserPlus size={16} />} disabled={!adding} loading={move.isPending} onClick={add}>
            Записать
          </Button>
        </Group>
      </Card>
      <Group gap="sm" wrap="wrap">
        <TextInput placeholder="Поиск по имени" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} w={260} />
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: 'yes', label: `Участвуют (${yes})` },
            { value: 'noteam', label: `Без команды (${noTeam})` },
            { value: 'no', label: `Не участвуют (${view.players.length - yes})` },
            { value: 'all', label: 'Все' },
          ]}
        />
      </Group>
      <Card padding={0}>
        <Table.ScrollContainer minWidth={620}>
          <Table verticalSpacing={6} highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Игрок</Table.Th>
                <Table.Th w={60}>Пол</Table.Th>
                <Table.Th w={120}>Ответ</Table.Th>
                <Table.Th w={240}>Команда</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((p) => (
                <Table.Tr key={p.participantId}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {p.captain && '👑 '}
                      {p.fullName}
                    </Text>
                  </Table.Td>
                  <Table.Td>{p.gender === 'm' ? 'М' : 'Ж'}</Table.Td>
                  <Table.Td>
                    <Badge color={p.answer === 'yes' ? 'green' : 'gray'} variant="light">
                      {p.answer === 'yes' ? 'участвует' : 'нет'}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      {formatTime(p.answeredAt, tz)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Select
                      size="xs"
                      data={teamOptions}
                      value={p.teamId ? String(p.teamId) : 'none'}
                      allowDeselect={false}
                      aria-label="Команда"
                      onChange={(v) => move.mutate({ participantId: p.participantId, teamId: !v || v === 'none' ? null : Number(v) }, { onError: (e) => notifyError(e) })}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {rows.length === 0 && (
          <Text c="dimmed" ta="center" py="lg">
            Пока никого
          </Text>
        )}
      </Card>
    </Stack>
  );
}
