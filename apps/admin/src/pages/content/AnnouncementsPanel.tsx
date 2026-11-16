import { ActionIcon, Badge, Button, Card, Group, Spoiler, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { announcementInputSchema, type AnnouncementInput, type AnnouncementView } from '@sof/shared';
import { IconEye, IconEyeOff, IconPencil, IconPin, IconPinnedOff, IconPlus, IconSpeakerphone, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { useCreateAnnouncement, useDeleteAnnouncement, useUpdateAnnouncement } from '../../api/content.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { EmptyBlock } from '../../components/states.tsx';
import { formatDateTime } from '../../lib/format.ts';
import { notifySuccess } from '../../lib/notify.tsx';
import { schemaErrors } from '../../lib/validation.ts';
import { MarkdownEditor } from './MarkdownEditor.tsx';

export function AnnouncementsPanel({ announcements }: { announcements: AnnouncementView[] }) {
  const tz = useEventTz();
  const confirm = useConfirm();
  const update = useUpdateAnnouncement();
  const remove = useDeleteAnnouncement();
  const [editor, setEditor] = useState<{ opened: boolean; item: AnnouncementView | null }>({ opened: false, item: null });

  const toggle = (a: AnnouncementView, patch: Partial<AnnouncementInput>, message: string) =>
    update.mutate({ id: a.id, patch }, { onSuccess: () => notifySuccess(message, a.title) });

  const doDelete = async (a: AnnouncementView) => {
    const ok = await confirm({
      title: `Удалить объявление «${a.title}»?`,
      message: 'Оно пропадёт из ленты. Если нужно временно убрать - лучше скройте его.',
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (ok) remove.mutate(a.id, { onSuccess: () => notifySuccess('Объявление удалено') });
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Закреплённые показываются первыми. Рассылка с галочкой «в ленту» тоже создаёт объявление.
        </Text>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ opened: true, item: null })}>
          Новое объявление
        </Button>
      </Group>

      {announcements.length === 0 ? (
        <Card>
          <EmptyBlock icon={<IconSpeakerphone size={28} />} title="Объявлений пока нет" description="Напишите первое - участники увидят его в мини-приложении." />
        </Card>
      ) : (
        <Stack gap="sm">
          {announcements.map((a) => (
            <Card key={a.id} padding="md" style={{ opacity: a.published ? 1 : 0.7 }}>
              <Stack gap="xs">
                <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Group gap="xs">
                      <Text fw={700}>{a.title}</Text>
                      {a.pinned && (
                        <Badge size="xs" color="indigo" leftSection={<IconPin size={10} />}>
                          закреплено
                        </Badge>
                      )}
                      {!a.published && (
                        <Badge size="xs" color="gray" variant="outline" leftSection={<IconEyeOff size={10} />}>
                          скрыто
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {formatDateTime(a.createdAt, tz)}
                    </Text>
                  </Stack>
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label={a.pinned ? 'Открепить' : 'Закрепить'}>
                      <ActionIcon
                        onClick={() => toggle(a, { pinned: !a.pinned }, a.pinned ? 'Откреплено' : 'Закреплено')}
                        aria-label={a.pinned ? 'Открепить' : 'Закрепить'}
                      >
                        {a.pinned ? <IconPinnedOff size={16} /> : <IconPin size={16} />}
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={a.published ? 'Скрыть' : 'Опубликовать'}>
                      <ActionIcon
                        onClick={() => toggle(a, { published: !a.published }, a.published ? 'Скрыто из ленты' : 'Опубликовано')}
                        aria-label={a.published ? 'Скрыть' : 'Опубликовать'}
                      >
                        {a.published ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Изменить">
                      <ActionIcon onClick={() => setEditor({ opened: true, item: a })} aria-label="Изменить">
                        <IconPencil size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Удалить">
                      <ActionIcon color="red" onClick={() => void doDelete(a)} aria-label="Удалить">
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
                {a.bodyMd.trim() && (
                  <Spoiler maxHeight={96} showLabel="Показать полностью" hideLabel="Свернуть">
                    <Markdown source={a.bodyMd} />
                  </Spoiler>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      )}

      <AppModal
        opened={editor.opened}
        onClose={() => setEditor((e) => ({ ...e, opened: false }))}
        title={<Text fw={700}>{editor.item ? 'Изменить объявление' : 'Новое объявление'}</Text>}
        size="xl"
      >
        <AnnouncementForm key={editor.item?.id ?? 'new'} item={editor.item} onDone={() => setEditor((e) => ({ ...e, opened: false }))} />
      </AppModal>
    </Stack>
  );
}

function AnnouncementForm({ item, onDone }: { item: AnnouncementView | null; onDone: () => void }) {
  const create = useCreateAnnouncement();
  const update = useUpdateAnnouncement();
  const form = useForm<AnnouncementInput>({
    mode: 'controlled',
    initialValues: item
      ? { title: item.title, bodyMd: item.bodyMd, pinned: item.pinned, published: item.published }
      : { title: '', bodyMd: '', pinned: false, published: true },
    validate: (v) => schemaErrors(announcementInputSchema, { ...v, title: v.title.trim() }),
  });

  const submit = form.onSubmit((values) => {
    const input = { ...values, title: values.title.trim() };
    if (item) {
      update.mutate(
        { id: item.id, patch: input },
        {
          onSuccess: () => {
            notifySuccess('Объявление сохранено');
            onDone();
          },
        },
      );
    } else {
      create.mutate(input, {
        onSuccess: () => {
          notifySuccess('Объявление опубликовано');
          onDone();
        },
      });
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        <TextInput label="Заголовок" required data-autofocus maxLength={160} {...form.getInputProps('title')} />
        <MarkdownEditor
          label="Текст"
          value={form.values.bodyMd}
          onChange={(v) => form.setFieldValue('bodyMd', v)}
          error={form.errors.bodyMd}
          maxLength={10000}
          minRows={8}
        />
        <Group gap="xl">
          <Switch label="Закрепить наверху" {...form.getInputProps('pinned', { type: 'checkbox' })} />
          <Switch label="Опубликовано" {...form.getInputProps('published', { type: 'checkbox' })} />
        </Group>
        <ModalActions>
          <Button variant="default" onClick={onDone}>
            Отмена
          </Button>
          <Button type="submit" loading={create.isPending || update.isPending}>
            {item ? 'Сохранить' : 'Опубликовать'}
          </Button>
        </ModalActions>
      </Stack>
    </form>
  );
}
