import { Group, Select, Stack, Switch, Tabs, Text } from '@mantine/core';
import { IconDoorEnter, IconListDetails, IconMapPin, IconScan } from '@tabler/icons-react';
import { useState } from 'react';
import { useSearch } from 'wouter';
import { useCheckpoints } from '../../api/checkin.ts';
import { PageHeader } from '../../components/PageHeader.tsx';
import { checkpointLabel } from '../../lib/labels.ts';
import { readStored, writeStored } from '../../lib/storage.ts';
import { CheckInsLog } from './CheckInsLog.tsx';
import { CheckpointsPanel } from './CheckpointsPanel.tsx';
import { ScanLog } from './ScanLog.tsx';

type Tab = 'checkins' | 'scans' | 'points';
const TABS: Tab[] = ['checkins', 'scans', 'points'];

export default function CheckInPage() {
  const params = new URLSearchParams(useSearch());
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get('tab') as Tab | null;
    return t && TABS.includes(t) ? t : 'checkins';
  });
  const checkpoints = useCheckpoints();
  const [checkpointId, setCheckpointIdState] = useState<number | null>(() => {
    const stored = readStored<unknown>('checkin.checkpoint', null);
    return typeof stored === 'number' ? stored : null;
  });
  const [live, setLive] = useState(true);

  const setCheckpointId = (id: number | null) => {
    setCheckpointIdState(id);
    writeStored('checkin.checkpoint', id);
  };

  const list = checkpoints.data ?? [];
  const validId = checkpointId !== null && list.some((c) => c.id === checkpointId) ? checkpointId : null;
  // Сканер отмечает на «Входе». Выбор точки нужен, только если их несколько (например, отметки на активностях).
  const showCheckpointFilter = list.length > 1;

  return (
    <Stack gap="md">
      <PageHeader
        title="Вход и отметки"
        description="Кто и когда пришёл. Отмечают волонтёры в сканере в мини-приложении бота, а здесь можно посмотреть отметки и отменить ошибочную."
      />

      <Tabs value={tab} onChange={(v) => v && setTab(v as Tab)}>
        <Tabs.List>
          <Tabs.Tab value="checkins" leftSection={<IconDoorEnter size={16} />}>
            Отметки
          </Tabs.Tab>
          <Tabs.Tab value="scans" leftSection={<IconScan size={16} />}>
            Все сканы
          </Tabs.Tab>
          <Tabs.Tab value="points" leftSection={<IconMapPin size={16} />}>
            Точки
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {tab !== 'points' && (
        <Group justify="space-between" gap="sm" wrap="wrap">
          {tab === 'checkins' ? (
            showCheckpointFilter ? (
              <Select
                label="Где отмечали"
                data={[{ value: '', label: 'Везде' }, ...list.map((c) => ({ value: String(c.id), label: checkpointLabel(c) }))]}
                value={validId === null ? '' : String(validId)}
                onChange={(v) => setCheckpointId(v ? Number(v) : null)}
                allowDeselect={false}
                w={360}
                maw="100%"
                leftSection={<IconListDetails size={16} />}
                disabled={checkpoints.isPending}
              />
            ) : (
              <span />
            )
          ) : (
            <Text size="sm" c="dimmed" maw={640}>
              Все сканы подряд - и удачные, и нет. Пригодится, если кто-то говорит «меня не пускают».
            </Text>
          )}
          <Switch label="Обновлять каждые 15 с" checked={live} onChange={(e) => setLive(e.currentTarget.checked)} />
        </Group>
      )}

      {tab === 'checkins' && <CheckInsLog checkpointId={showCheckpointFilter ? validId : null} live={live} />}
      {tab === 'scans' && <ScanLog live={live} />}
      {tab === 'points' && <CheckpointsPanel />}
    </Stack>
  );
}
