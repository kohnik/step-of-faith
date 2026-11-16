import { ActionIcon, Alert, Badge, Button, Card, Group, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core';
import type { CheckpointView } from '@sof/shared';
import { IconCalendarPlus, IconInfoCircle, IconMapPin, IconPencil } from '@tabler/icons-react';
import { useState } from 'react';
import { useCheckpoints, useCreateDailyEntrances, useUpdateCheckpoint } from '../../api/checkin.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useCan } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { capitalizeFirst, formatDayShort } from '../../lib/format.ts';
import { CHECKPOINT_KIND_LABELS } from '../../lib/labels.ts';
import { notifyError, notifyInfo, notifySuccess } from '../../lib/notify.tsx';

function RenameModal({ point, onClose }: { point: CheckpointView; onClose: () => void }) {
  const update = useUpdateCheckpoint();
  const [name, setName] = useState(point.name);
  const submit = () => {
    const value = name.trim();
    if (!value || value === point.name) return onClose();
    update.mutate(
      { id: point.id, patch: { name: value } },
      {
        onSuccess: () => {
          notifySuccess('Точка переименована', value);
          onClose();
        },
        onError: (err) => notifyError(err),
      },
    );
  };
  return (
    <AppModal opened onClose={onClose} title={<Text fw={700}>Переименовать точку</Text>}>
      <Stack gap="sm">
        <TextInput
          label="Название"
          description="Его видят волонтёры в сканере"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          data-autofocus
        />
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} loading={update.isPending}>
            Сохранить
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

/**
 * Точки отметки. Главное здесь - входы по дням: отметка на точке одна на человека, поэтому
 * с одним «Входом» на все дни на 2-й и 3-й день сканер показывал бы всем «Уже отмечен».
 */
export function CheckpointsPanel() {
  const points = useCheckpoints();
  const update = useUpdateCheckpoint();
  const daily = useCreateDailyEntrances();
  const confirm = useConfirm();
  const can = useCan();
  const editable = can('activities:all');
  const [renaming, setRenaming] = useState<CheckpointView | null>(null);

  if (points.isPending) return <BlockSkeleton />;
  if (points.isError) return <ErrorState error={points.error} onRetry={() => void points.refetch()} />;

  const list = [...points.data].sort(
    (a, b) =>
      Number(b.kind === 'entrance') - Number(a.kind === 'entrance') ||
      (a.day ?? '').localeCompare(b.day ?? '') ||
      a.name.localeCompare(b.name, 'ru'),
  );
  const entrances = list.filter((c) => c.kind === 'entrance');
  const byDay = entrances.filter((c) => c.day);
  const commonActive = entrances.some((c) => !c.day && c.isActive);

  const createDaily = () => {
    const before = byDay.length;
    daily.mutate(undefined, {
      onSuccess: (all) => {
        const added = all.filter((c) => c.kind === 'entrance' && c.day).length - before;
        if (added > 0) notifySuccess(`Добавлено входов: ${added}. Сканер в каждый день сам возьмёт вход этого дня.`, 'Входы по дням');
        else notifyInfo('Входы на все дни конференции уже есть.');
      },
      onError: (err) => notifyError(err),
    });
  };

  const toggle = async (c: CheckpointView, on: boolean) => {
    if (!on && c.kind === 'entrance') {
      const ok = await confirm({
        title: 'Выключить точку?',
        message: c.day
          ? `Сканер перестанет отмечать на «${c.name}». В этот день он возьмёт общий вход без дня, если он включён.`
          : `Сканер перестанет отмечать на «${c.name}» в дни, для которых нет своего входа.`,
        confirmLabel: 'Выключить',
        danger: true,
      });
      if (!ok) return;
    }
    update.mutate(
      { id: c.id, patch: { isActive: on } },
      { onSuccess: () => notifySuccess(on ? 'Точка включена' : 'Точка выключена', c.name), onError: (err) => notifyError(err) },
    );
  };

  return (
    <Stack gap="md">
      {byDay.length === 0 ? (
        <Alert color="yellow" icon={<IconInfoCircle size={18} />} title="Нет входов по дням">
          Отметка на точке у каждого одна. С одним «Входом» на все дни на 2-й и 3-й день сканер покажет всем «Уже
          отмечен». Создайте вход на каждый день - сканер сам будет брать вход сегодняшнего дня.
        </Alert>
      ) : (
        commonActive && (
          <Alert color="blue" icon={<IconInfoCircle size={18} />}>
            Общий вход без дня работает только в дни, для которых нет своего входа. Когда входы на все дни созданы, его
            можно выключить.
          </Alert>
        )
      )}
      {editable && (
        <Group>
          <Button leftSection={<IconCalendarPlus size={16} />} onClick={createDaily} loading={daily.isPending}>
            Создать вход на каждый день
          </Button>
          <Text size="sm" c="dimmed" maw={520}>
            По датам начала и конца конференции из «Настроек». Уже созданные дни не повторяются.
          </Text>
        </Group>
      )}
      {list.length === 0 ? (
        <EmptyBlock icon={<IconMapPin size={28} />} title="Точек пока нет" description="Создайте вход на каждый день конференции." />
      ) : (
        <Card withBorder radius="md" p={0}>
          <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Точка</Table.Th>
                <Table.Th>День</Table.Th>
                <Table.Th>Работает</Table.Th>
                <Table.Th w={56} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Text fw={600} size="sm">
                      {c.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {CHECKPOINT_KIND_LABELS[c.kind]}
                      {!c.countsInStats && ' · не в статистике'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {c.day ? (
                      <Text size="sm">{capitalizeFirst(formatDayShort(c.day))}</Text>
                    ) : (
                      <Badge variant="light" color="gray">
                        все дни
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={c.isActive}
                      disabled={!editable || update.isPending}
                      onChange={(e) => void toggle(c, e.currentTarget.checked)}
                      aria-label={c.isActive ? `Выключить: ${c.name}` : `Включить: ${c.name}`}
                    />
                  </Table.Td>
                  <Table.Td>
                    {editable && (
                      <Tooltip label="Переименовать">
                        <ActionIcon onClick={() => setRenaming(c)} aria-label={`Переименовать: ${c.name}`}>
                          <IconPencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}
      {renaming && <RenameModal point={renaming} onClose={() => setRenaming(null)} />}
    </Stack>
  );
}
