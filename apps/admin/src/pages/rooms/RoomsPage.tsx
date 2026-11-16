import { ActionIcon, Button, Card, Group, NumberInput, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import type { RoomView } from '@sof/shared';
import { IconDoor, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { useDeleteRoom, useRooms, useSaveRoom } from '../../api/seminars.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useCan } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatNumber } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

function RoomModal({ room, opened, onClose }: { room: RoomView | null; opened: boolean; onClose: () => void }) {
  const save = useSaveRoom();
  const [name, setName] = useState(room?.name ?? '');
  const [capacity, setCapacity] = useState<number | string>(room?.capacity ?? '');
  const [note, setNote] = useState(room?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const cap = Number(capacity);
    if (!name.trim()) return setError('Как называется зал?');
    if (!Number.isInteger(cap) || cap < 1) return setError('Вместимость - целое число больше нуля');
    save.mutate(
      { id: room?.id ?? null, input: { name: name.trim(), capacity: cap, note: note.trim() || null, sort: room?.sort ?? 0 } },
      {
        onSuccess: (r) => {
          notifySuccess(room ? 'Зал сохранён' : 'Зал добавлен', r.name);
          onClose();
        },
        onError: (err) => notifyError(err),
      },
    );
  };
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>{room ? 'Изменить зал' : 'Новый зал'}</Text>}>
      <Stack gap="sm">
        <TextInput label="Название" placeholder="324 ауд. ТИ" required value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <NumberInput label="Вместимость, человек" required min={1} allowDecimal={false} value={capacity} onChange={setCapacity} />
        <TextInput label="Подсказка" placeholder="2-й этаж, направо от лестницы" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Сохранить
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

export default function RoomsPage() {
  const rooms = useRooms();
  const remove = useDeleteRoom();
  const confirm = useConfirm();
  const can = useCan();
  const editable = can('activities:all');
  const [modal, setModal] = useState<{ opened: boolean; room: RoomView | null; key: number }>({ opened: false, room: null, key: 0 });
  const open = (room: RoomView | null) => setModal((m) => ({ opened: true, room, key: m.key + 1 }));

  const del = async (r: RoomView) => {
    const ok = await confirm({
      title: 'Удалить зал?',
      message: `«${r.name}» пропадёт из справочника и из блоков семинаров. У мероприятий останется подпись места.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(r.id, { onSuccess: () => notifySuccess('Зал удалён', r.name), onError: (err) => notifyError(err) });
  };

  return (
    <Stack gap={0}>
      <PageHeader
        title="Залы"
        description="Залы с вместимостью - для расписания и распределения семинаров."
        actions={
          editable && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => open(null)}>
              Добавить зал
            </Button>
          )
        }
      />
      {rooms.isPending ? (
        <BlockSkeleton />
      ) : rooms.isError ? (
        <ErrorState error={rooms.error} onRetry={() => void rooms.refetch()} />
      ) : rooms.data.length === 0 ? (
        <EmptyBlock icon={<IconDoor size={28} />} title="Залов пока нет" description="Добавьте залы, чтобы выбирать их в мероприятиях и семинарах." />
      ) : (
        <Card withBorder radius="md" p={0}>
          <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Зал</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Мест</Table.Th>
                <Table.Th w={96} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rooms.data.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Text fw={600} size="sm">
                      {r.name}
                    </Text>
                    {r.note && (
                      <Text size="xs" c="dimmed">
                        {r.note}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ textAlign: 'right' }} className="sof-tabular">
                    {formatNumber(r.capacity)}
                  </Table.Td>
                  <Table.Td>
                    {editable && (
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label="Изменить">
                          <ActionIcon onClick={() => open(r)} aria-label={`Изменить: ${r.name}`}>
                            <IconPencil size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Удалить">
                          <ActionIcon color="red" onClick={() => void del(r)} aria-label={`Удалить: ${r.name}`}>
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}
      <RoomModal key={modal.key} room={modal.room} opened={modal.opened} onClose={() => setModal((m) => ({ ...m, opened: false }))} />
    </Stack>
  );
}
