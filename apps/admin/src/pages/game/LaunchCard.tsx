import { ActionIcon, Badge, Button, Card, Checkbox, Group, Modal, Select, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { GameAdminView, GameBotUser, GameLaunch } from '@sof/shared';
import { IconAt, IconFlask, IconPlayerStop, IconRefresh, IconRocket, IconUserCheck, IconUserPlus, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useGameAddTester, useGameBotUsers, useGameEnrollTesters, useGameLaunch, useGameRemoveTester } from '../../api/game.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useSession } from '../../components/SessionProvider.tsx';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const onError = { onError: (e: unknown) => notifyError(e) };

const LABEL: Record<GameLaunch, { badge: string; color: string; text: string }> = {
  off: {
    badge: 'не запущена',
    color: 'gray',
    text: 'Участники игру не видят. Сначала прогоните её с тест-листом - игру увидят только они (и админы с ведущими), отметка на входе не нужна. Когда всё готово - запустите для всех.',
  },
  test: {
    badge: 'тестовый запуск',
    color: 'yellow',
    text: 'Игру видят только админы, ведущие и тест-лист. Приглашения приходят только тест-листу, отметка на входе не нужна. Остальные участники ничего не замечают.',
  },
  live: {
    badge: 'идёт для всех',
    color: 'green',
    text: 'Игру видят все участники. Голосовать может любой, кто открыл бота.',
  },
};

/** Ход прошлого прогона: ответы, голоса, оформленные команды. */
const hasData = (v: GameAdminView) => v.players.length > 0 || v.rounds.length > 0 || v.teams.some((t) => !t.placeholder || t.captainId);

/**
 * Запуск игры: выключена → тестовый (только тест-лист) → настоящий (для всех).
 * Переход к настоящему запуску стирает тестовые ответы, названия и голоса - в настоящую игру они не попадут.
 */
export function LaunchCard({ view }: { view: GameAdminView }) {
  const confirm = useConfirm();
  const launch = useGameLaunch();
  const [ask, setAsk] = useState<GameLaunch | null>(null);
  const [invite, setInvite] = useState(true);
  const [wipe, setWipe] = useState(false);
  const mode = view.launch;
  const info = LABEL[mode];
  // Из теста в настоящий запуск - тестовые голоса и названия стираем всегда.
  const forceWipe = mode === 'test' && ask === 'live';

  const go = (target: GameLaunch, opts: { wipe: boolean; invite: boolean }) =>
    launch.mutate(
      { mode: target, ...opts },
      {
        onSuccess: () => {
          setAsk(null);
          notifySuccess(
            target === 'off'
              ? 'Игра скрыта'
              : opts.invite
                ? target === 'test'
                  ? 'Тестовый запуск: приглашения уходят тест-листу'
                  : 'Игра запущена - приглашения уходят участникам'
                : target === 'test'
                  ? 'Тестовый запуск: игра видна тест-листу'
                  : 'Игра запущена для всех',
          );
        },
        ...onError,
      },
    );

  const start = (target: 'test' | 'live') => {
    setInvite(true);
    // Остались данные прошлого прогона - по умолчанию стираем, если это переход из теста или повтор теста.
    setWipe(mode === 'test' || (hasData(view) && mode === 'off'));
    setAsk(target);
  };

  /** Начать тест заново одной кнопкой: стереть всё тестовое и снова разослать приглашения тест-листу. */
  const restartTest = async () => {
    const ok = await confirm({
      title: 'Сбросить тест и начать заново?',
      message:
        'Сотрутся ответы «участвую», распределение, капитаны, названия команд и голоса. Тест-лист и настройки останутся. Людям из тест-листа сразу придёт новое приглашение «Будешь участвовать?».',
      confirmLabel: 'Сбросить и пригласить заново',
      danger: true,
    });
    if (ok)
      launch.mutate(
        { mode: 'test', wipe: true, invite: true },
        { onSuccess: () => notifySuccess('Тест сброшен - приглашения уходят тест-листу'), ...onError },
      );
  };

  const stop = async () => {
    const ok = await confirm({
      title: mode === 'live' ? 'Скрыть игру у всех?' : 'Остановить тестовый запуск?',
      message: 'Вкладка «Игра» пропадёт, запись закроется. Команды, ответы и голоса сохранятся - можно запустить снова.',
      confirmLabel: mode === 'live' ? 'Скрыть игру' : 'Остановить',
      danger: mode === 'live',
    });
    if (ok) go('off', { wipe: false, invite: false });
  };

  const testers = view.testers;
  return (
    <Card withBorder style={{ borderColor: mode === 'off' ? undefined : `var(--mantine-color-${info.color}-filled)`, borderWidth: mode === 'off' ? undefined : 2 }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <Group gap="xs" mb={4}>
            <Title order={3} fz="lg">
              Запуск игры
            </Title>
            <Badge color={info.color} variant={mode === 'off' ? 'light' : 'filled'}>
              {info.badge}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {info.text}
          </Text>
        </div>
        <Group gap="xs">
          {mode === 'off' && (
            <>
              <Tooltip label="Тест-лист пуст - игру увидят только админы и ведущие" disabled={testers.length > 0}>
                <Button color="yellow" leftSection={<IconFlask size={16} />} loading={launch.isPending && launch.variables?.mode === 'test'} onClick={() => start('test')}>
                  Тестовый запуск
                </Button>
              </Tooltip>
              <Button color="green" leftSection={<IconRocket size={16} />} loading={launch.isPending && launch.variables?.mode === 'live'} onClick={() => start('live')}>
                Запустить для всех
              </Button>
            </>
          )}
          {mode === 'test' && (
            <>
              <Button color="green" leftSection={<IconRocket size={16} />} loading={launch.isPending && launch.variables?.mode === 'live'} onClick={() => start('live')}>
                Перейти к настоящему запуску
              </Button>
              <Button variant="light" color="red" leftSection={<IconRefresh size={16} />} loading={launch.isPending && launch.variables?.mode === 'test'} onClick={() => void restartTest()}>
                Сбросить тест
              </Button>
              <Button variant="default" leftSection={<IconPlayerStop size={16} />} loading={launch.isPending && launch.variables?.mode === 'off'} onClick={() => void stop()}>
                Остановить тест
              </Button>
            </>
          )}
          {mode === 'live' && (
            <>
              <Button variant="default" leftSection={<IconFlask size={16} />} onClick={() => start('test')}>
                Вернуться к тесту
              </Button>
              <Button variant="light" color="red" leftSection={<IconPlayerStop size={16} />} loading={launch.isPending && launch.variables?.mode === 'off'} onClick={() => void stop()}>
                Скрыть игру
              </Button>
            </>
          )}
        </Group>
      </Group>

      {mode !== 'live' && <Testers view={view} />}

      <Modal
        opened={ask !== null}
        onClose={() => setAsk(null)}
        title={ask === 'live' ? (mode === 'test' ? 'Перейти к настоящему запуску' : 'Запустить для всех') : mode === 'live' ? 'Вернуться к тесту' : 'Тестовый запуск'}
        centered
      >
        <Text size="sm">
          {ask === 'test'
            ? `Игру увидят только админы, ведущие и тест-лист (${view.testers.length}). ${mode === 'live' ? 'У остальных участников вкладка «Игра» пропадёт.' : 'Остальные участники ничего не заметят.'}`
            : 'Игру увидят все участники конференции.'}
        </Text>
        <Stack gap="sm" mt="md">
          <Checkbox
            checked={invite}
            onChange={(e) => setInvite(e.currentTarget.checked)}
            label="Сразу открыть запись и разослать приглашения «Будешь участвовать?»"
            description={
              ask === 'test'
                ? 'Придёт людям из тест-листа: кнопки «Участвую» / «Не участвую» прямо в боте. Кто без регистрации - получит сообщение, что может голосовать.'
                : view.config.audience === 'arrived_today'
                  ? 'Придёт всем, кто сегодня отметился на входе и ещё не ответил.'
                  : 'Придёт всем зарегистрированным, кто ещё не ответил.'
            }
          />
          {(forceWipe || hasData(view)) && (
            <Checkbox
              checked={forceWipe || wipe}
              disabled={forceWipe}
              onChange={(e) => setWipe(e.currentTarget.checked)}
              label="Стереть данные прошлого прогона"
              description={
                forceWipe
                  ? 'Обязательно: тестовые ответы, распределение, названия команд и голоса не должны попасть в настоящую игру. Команды останутся заглушками «Команда 1…N».'
                  : 'Ответы, распределение, капитаны, названия команд и голоса. Команды останутся заглушками «Команда 1…N».'
              }
            />
          )}
        </Stack>
        <Group justify="flex-end" gap="sm" mt="lg">
          <Button variant="default" onClick={() => setAsk(null)}>
            Отмена
          </Button>
          <Button
            color={ask === 'live' ? 'green' : 'yellow'}
            leftSection={ask === 'live' ? <IconRocket size={16} /> : <IconFlask size={16} />}
            loading={launch.isPending}
            onClick={() => ask && go(ask, { wipe: forceWipe || wipe, invite })}
          >
            {ask === 'live' ? 'Запустить для всех' : 'Запустить тест'}
          </Button>
        </Group>
      </Modal>
    </Card>
  );
}

/** Тест-лист: кто прогоняет игру в тестовом запуске. Добавление и удаление - сразу, это действия, а не форма. */
function Testers({ view }: { view: GameAdminView }) {
  const { session } = useSession();
  const add = useGameAddTester();
  const remove = useGameRemoveTester();
  const enroll = useGameEnrollTesters();
  const testers = view.testers;
  const me = session.user.id;
  const registered = testers.filter((t) => t.participants > 0);
  const waiting = registered.reduce((s, t) => s + Math.max(0, t.participants - t.inGame), 0);

  return (
    <Stack gap="sm" mt="md" pt="md" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <div>
          <Text fw={700}>Тест-лист ({testers.length})</Text>
          <Text size="xs" c="dimmed">
            Ищите по @нику в Telegram или по имени - человек должен хотя бы раз открыть бота. В команду можно записать только зарегистрированных, голосовать могут все из списка.
          </Text>
        </div>
        <Group gap="xs" wrap="wrap">
          <TesterSearch exclude={testers.map((t) => t.userId)} onAdd={(u) => add.mutate(u.userId, { onSuccess: () => notifySuccess(`${u.name} - в тест-листе`), ...onError })} />
          {!testers.some((t) => t.userId === me) && (
            <Button variant="light" leftSection={<IconUserPlus size={16} />} loading={add.isPending && add.variables === me} onClick={() => add.mutate(me, onError)}>
              Добавить себя
            </Button>
          )}
        </Group>
      </Group>

      {testers.length > 0 && (
        <Table.ScrollContainer minWidth={520}>
          <Table verticalSpacing={6}>
            <Table.Tbody>
              {testers.map((t) => (
                <Table.Tr key={t.userId}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {t.name}
                      {t.userId === me && (
                        <Text span size="xs" c="dimmed">
                          {' '}
                          (вы)
                        </Text>
                      )}
                    </Text>
                    {t.username && (
                      <Text size="xs" c="dimmed">
                        @{t.username}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {t.participants === 0 ? (
                      <Badge color="yellow" variant="light">
                        не зарегистрирован - только голосует
                      </Badge>
                    ) : t.inGame >= t.participants ? (
                      <Badge color="green" variant="light">
                        в игре{t.participants > 1 ? ` · ${t.inGame} чел.` : ''}
                      </Badge>
                    ) : (
                      <Badge color="gray" variant="light">
                        {t.inGame > 0 ? `в игре ${t.inGame} из ${t.participants}` : t.participants > 1 ? `${t.participants} регистрации, ещё не в игре` : 'ещё не в игре'}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td w={40}>
                    <Tooltip label="Убрать из тест-листа">
                      <ActionIcon variant="subtle" color="red" loading={remove.isPending && remove.variables === t.userId} onClick={() => remove.mutate(t.userId, onError)} aria-label="Убрать">
                        <IconX size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {view.launch === 'test' && registered.length > 0 && (
        <Group gap="sm" wrap="wrap">
          <Button
            leftSection={<IconUserCheck size={16} />}
            disabled={waiting === 0}
            loading={enroll.isPending}
            onClick={() =>
              enroll.mutate(undefined, {
                onSuccess: (r) => notifySuccess(r.enrolled ? `Записали в игру: ${r.enrolled}` : 'Все уже в игре'),
                ...onError,
              })
            }
          >
            Записать всех в игру
          </Button>
          <Text size="xs" c="dimmed" style={{ flex: '1 1 260px' }}>
            {waiting === 0
              ? 'Все зарегистрированные из тест-листа уже в игре - можно распределять по командам.'
              : 'Не ждать ответа в боте: все зарегистрированные из тест-листа сразу станут игроками (приглашение с кнопками им уже не придёт).'}
          </Text>
        </Group>
      )}
    </Stack>
  );
}

/** Поиск аккаунта бота по @нику или имени. */
function TesterSearch({ exclude, onAdd }: { exclude: number[]; onAdd: (u: GameBotUser) => void }) {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const found = useGameBotUsers(q);
  const list = useMemo(() => (found.data ?? []).filter((u) => !exclude.includes(u.userId)), [found.data, exclude]);
  return (
    <Select
      searchable
      w={340}
      maw="100%"
      leftSection={<IconAt size={16} />}
      placeholder="@ник или имя - добавить"
      searchValue={search}
      onSearchChange={setSearch}
      value={null}
      filter={({ options }) => options}
      data={list.map((u) => ({ value: String(u.userId), label: `${u.name}${u.username ? ` · @${u.username}` : ''}${u.participants ? '' : ' · не зарегистрирован'}` }))}
      nothingFoundMessage={q.replace(/^@/, '').length < 2 ? 'Введите хотя бы 2 буквы' : found.isFetching ? 'Ищем…' : 'Никого - человек должен открыть бота'}
      onChange={(v) => {
        const u = list.find((x) => String(x.userId) === v);
        if (u) {
          onAdd(u);
          setSearch('');
        }
      }}
    />
  );
}
