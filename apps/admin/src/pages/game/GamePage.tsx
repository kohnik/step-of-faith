import { Badge, Tabs } from '@mantine/core';
import { IconAdjustments, IconFlag, IconListCheck, IconUsers, IconWorld } from '@tabler/icons-react';
import { useState } from 'react';
import { useGameAdmin } from '../../api/game.ts';
import { PageHeader } from '../../components/PageHeader.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { readStored, writeStored } from '../../lib/storage.ts';
import { ConsolePanel } from './ConsolePanel.tsx';
import { PlayersPanel } from './PlayersPanel.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { TasksPanel } from './TasksPanel.tsx';
import { TeamsPanel } from './TeamsPanel.tsx';

type Tab = 'console' | 'teams' | 'tasks' | 'players' | 'settings';
const TAB_KEY = 'game.tab';

/** Игра «Церкви»: пульт ведущего, команды, игроки и настройки. */
export default function GamePage() {
  const game = useGameAdmin();
  const [tab, setTabState] = useState<Tab>(() => readStored<Tab>(TAB_KEY, 'console'));
  const setTab = (v: Tab) => {
    setTabState(v);
    writeStored(TAB_KEY, v);
  };
  const view = game.data;
  const pending = view?.teams.filter((t) => t.proposal).length ?? 0;

  return (
    <>
      <PageHeader
        title="Игра «Церкви»"
        description="Команды открывают церковь в другой стране, а все, у кого есть телефон, «отправляют» в неё людей. Здесь - запись, распределение, голосование и большой экран."
        badge={
          view ? (
            <Badge color={view.launch === 'live' ? 'green' : view.launch === 'test' ? 'yellow' : 'gray'}>
              {view.launch === 'live' ? 'идёт для всех' : view.launch === 'test' ? `тестовый запуск · ${view.testers.length}` : 'не запущена'}
            </Badge>
          ) : undefined
        }
      />
      {game.isPending ? (
        <BlockSkeleton rows={3} height={160} />
      ) : game.isError || !view ? (
        <ErrorState error={game.error} onRetry={() => void game.refetch()} />
      ) : (
        <>
          <Tabs value={tab} onChange={(v) => v && setTab(v as Tab)} mb="md">
            <Tabs.List>
              <Tabs.Tab value="console" leftSection={<IconWorld size={16} />}>
                Пульт
              </Tabs.Tab>
              <Tabs.Tab value="teams" leftSection={<IconFlag size={16} />} rightSection={pending ? <Badge size="xs" color="yellow">{pending}</Badge> : undefined}>
                Команды ({view.teams.length})
              </Tabs.Tab>
              <Tabs.Tab value="tasks" leftSection={<IconListCheck size={16} />}>
                Задания ({view.tasks.length})
              </Tabs.Tab>
              <Tabs.Tab value="players" leftSection={<IconUsers size={16} />}>
                Игроки ({view.players.filter((p) => p.answer === 'yes').length})
              </Tabs.Tab>
              <Tabs.Tab value="settings" leftSection={<IconAdjustments size={16} />}>
                Настройки
              </Tabs.Tab>
            </Tabs.List>
          </Tabs>
          {tab === 'console' && <ConsolePanel view={view} />}
          {tab === 'teams' && <TeamsPanel view={view} />}
          {tab === 'tasks' && <TasksPanel view={view} />}
          {tab === 'players' && <PlayersPanel view={view} />}
          {tab === 'settings' && <SettingsPanel view={view} />}
        </>
      )}
    </>
  );
}
