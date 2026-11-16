import { ActionIcon, Button, Card, Group, Menu, SimpleGrid, Stack, Text, TextInput, ThemeIcon } from '@mantine/core';
import type { ParticipantListView } from '@sof/shared';
import { IconDots, IconEye, IconListDetails, IconPencil, IconPlaylistAdd, IconPlus, IconSpeakerphone, IconTrash, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { useCreateList, useDeleteList, useParticipantLists, useRenameList } from '../../api/lists.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useSession } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatNumber, formatRelative, plural } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const PEOPLE: [string, string, string] = ['участник', 'участника', 'участников'];

/** Окно названия: новый список или переименование. */
function NameModal({
  opened,
  initial,
  title,
  submitLabel,
  loading,
  onClose,
  onSubmit,
}: {
  opened: boolean;
  initial: string;
  title: string;
  submitLabel: string;
  loading: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [prevOpened, setPrevOpened] = useState(opened);
  // Открыли заново - поле с начальным названием.
  if (opened !== prevOpened) {
    setPrevOpened(opened);
    if (opened) setName(initial);
  }
  const submit = () => name.trim() && onSubmit(name.trim());
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>{title}</Text>} size="sm">
      <Stack gap="md">
        <TextInput
          label="Название"
          placeholder="Например: Россияне"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          maxLength={80}
          data-autofocus
        />
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!name.trim()} loading={loading} onClick={submit}>
            {submitLabel}
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

function ListCard({ list, canEdit, canSend, onRename }: { list: ParticipantListView; canEdit: boolean; canSend: boolean; onRename: () => void }) {
  const [, navigate] = useLocation();
  const confirm = useConfirm();
  const remove = useDeleteList();
  const doDelete = async () => {
    const ok = await confirm({
      title: `Удалить список «${list.name}»?`,
      message: 'Удалим только список. Сами участники останутся в базе, отправленные рассылки тоже не пропадут.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (ok) remove.mutate(list.id, { onSuccess: () => notifySuccess(`Список «${list.name}» удалён`), onError: (err) => notifyError(err) });
  };
  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap="sm" h="100%">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <ThemeIcon variant="light" color="indigo" size="lg" radius="md">
              <IconListDetails size={20} />
            </ThemeIcon>
            <div style={{ minWidth: 0 }}>
              <Text fw={700} truncate>
                {list.name}
              </Text>
              <Text size="xs" c="dimmed">
                {list.createdByName ? `${list.createdByName} · ` : ''}изменён {formatRelative(list.updatedAt)}
              </Text>
            </div>
          </Group>
          {canEdit && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label="Ещё">
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconPencil size={16} />} onClick={onRename}>
                  Переименовать
                </Menu.Item>
                <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => void doDelete()}>
                  Удалить список
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
        <Group gap="lg">
          <div>
            <Text fz={26} fw={700} lh={1.1}>
              {formatNumber(list.count)}
            </Text>
            <Text size="xs" c="dimmed">
              {plural(list.count, PEOPLE)}
            </Text>
          </div>
          <div>
            <Text fz={26} fw={700} lh={1.1} c="dimmed">
              {formatNumber(list.recipients)}
            </Text>
            <Text size="xs" c="dimmed">
              получат рассылку в Telegram
            </Text>
          </div>
        </Group>
        <Group gap="xs" mt="auto">
          {canEdit && (
            <Button size="xs" leftSection={<IconPlaylistAdd size={14} />} onClick={() => navigate(`/participants?add=${list.id}`)}>
              Добавить людей
            </Button>
          )}
          <Button size="xs" variant="light" leftSection={<IconEye size={14} />} onClick={() => navigate(`/participants?list=${list.id}`)}>
            Кто в списке
          </Button>
          {canSend && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconSpeakerphone size={14} />}
              disabled={list.recipients === 0}
              onClick={() => navigate(`/broadcasts?list=${list.id}`)}
            >
              Рассылка
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

/** Свои списки участников («Россияне», «Хор»): собираем галочками в таблице участников, шлём по ним рассылки. */
export default function ListsPage() {
  const { can } = useSession();
  const [, navigate] = useLocation();
  const lists = useParticipantLists();
  const create = useCreateList();
  const rename = useRenameList();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<ParticipantListView | null>(null);
  const canEdit = can('participants:write');
  const canSend = can('broadcasts:send');

  return (
    <Stack gap="md">
      <PageHeader
        title="Списки"
        description="Свои группы участников, например «Россияне» или «Хор». Людей добавляют галочками в таблице участников, а по списку можно сделать рассылку: списки есть в «Рассылках» в самом конце поля «Кому»."
        actions={
          canEdit && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
              Создать список
            </Button>
          )
        }
      />
      {lists.isPending ? (
        <BlockSkeleton rows={3} height={120} />
      ) : lists.isError ? (
        <ErrorState error={lists.error} onRetry={() => void lists.refetch()} />
      ) : lists.data.length === 0 ? (
        <Card>
          <EmptyBlock
            icon={<IconUsers size={28} />}
            title="Списков пока нет"
            description={canEdit ? 'Нажмите «Создать список», дайте название и отметьте людей галочками.' : 'Списки создают те, кто правит участников.'}
          />
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {lists.data.map((l) => (
            <ListCard key={l.id} list={l} canEdit={canEdit} canSend={canSend} onRename={() => setRenaming(l)} />
          ))}
        </SimpleGrid>
      )}

      <NameModal
        opened={creating}
        initial=""
        title="Новый список"
        submitLabel="Создать и выбрать людей"
        loading={create.isPending}
        onClose={() => setCreating(false)}
        onSubmit={(name) =>
          create.mutate(name, {
            onSuccess: (list) => {
              setCreating(false);
              navigate(`/participants?add=${list.id}`);
            },
            onError: (err) => notifyError(err),
          })
        }
      />
      <NameModal
        opened={renaming !== null}
        initial={renaming?.name ?? ''}
        title="Переименовать список"
        submitLabel="Сохранить"
        loading={rename.isPending}
        onClose={() => setRenaming(null)}
        onSubmit={(name) =>
          renaming &&
          rename.mutate(
            { id: renaming.id, name },
            {
              onSuccess: () => {
                setRenaming(null);
                notifySuccess('Список переименован');
              },
              onError: (err) => notifyError(err),
            },
          )
        }
      />
    </Stack>
  );
}
