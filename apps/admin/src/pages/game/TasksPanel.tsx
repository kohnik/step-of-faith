import { Badge, Button, Card, Group, SimpleGrid, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import type { GameAdminView, GameTaskView } from '@sof/shared';
import { IconDice5, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { useGameAssignTasks, useGameTaskDelete, useGameTaskSave } from '../../api/game.ts';
import { AppModal } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { CountrySelect } from './common.tsx';

const onError = { onError: (e: unknown) => notifyError(e) };

/**
 * Задания командам: пишут заранее. Задание со страной - выбрали страну (ведущий или капитан), получили это задание.
 * Командам видно после «Показать задания», на большом экране - во время выступления.
 */
export function TasksPanel({ view }: { view: GameAdminView }) {
  const [editing, setEditing] = useState<GameTaskView | 'new' | null>(null);
  const assign = useGameAssignTasks();
  const free = view.tasks.filter((t) => !t.teamId).length;
  const withoutTask = view.teams.filter((t) => !t.taskId).length;
  return (
    <Stack gap="md">
      <Card>
        <Group justify="space-between">
          <div>
            <Title order={4} fz="md">
              Задания · {view.tasks.length}
            </Title>
            <Text size="sm" c="dimmed">
              Свободно: {free} · команд без задания: {withoutTask}. Команды увидят своё задание после «Показать задания».
            </Text>
          </div>
          <Group gap="xs">
            <Button
              variant="light"
              leftSection={<IconDice5 size={16} />}
              loading={assign.isPending}
              disabled={free === 0 || withoutTask === 0}
              onClick={() =>
                assign.mutate(undefined, {
                  onSuccess: () => notifySuccess('Раздали свободные задания'),
                  ...onError,
                })
              }
            >
              Раздать случайно
            </Button>
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
              Добавить задание
            </Button>
          </Group>
        </Group>
      </Card>
      {view.tasks.length === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          Заданий пока нет. У задания может быть страна - тогда команда этой страны получает это задание.
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          {view.tasks.map((t) => {
            const owner = t.teamId ? view.teams.find((x) => x.id === t.teamId) : null;
            return (
              <Card key={t.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(t)}>
                <Group justify="space-between" wrap="nowrap" mb={6}>
                  <Text fw={700}>
                    {t.flag ? `${t.flag} ` : ''}
                    {t.title}
                  </Text>
                  {owner ? <Badge color={owner.color}>{owner.title}</Badge> : <Badge color="gray">свободно</Badge>}
                </Group>
                <Text size="xs" c="dimmed" mb={6}>
                  {t.countryName ?? 'Любая страна'}
                </Text>
                {t.context && (
                  <>
                    <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                      Контекст
                    </Text>
                    <Markdown source={t.context} />
                  </>
                )}
                {t.text ? (
                  <>
                    {t.context && (
                      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt={6}>
                        Задание
                      </Text>
                    )}
                    <Markdown source={t.text} />
                  </>
                ) : (
                  <Text size="sm" c="dimmed">
                    Без текста задания
                  </Text>
                )}
              </Card>
            );
          })}
        </SimpleGrid>
      )}
      <AppModal opened={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Новое задание' : 'Задание'} size="lg">
        {editing !== null && (
          <TaskForm key={editing === 'new' ? 'new' : editing.id} task={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        )}
      </AppModal>
    </Stack>
  );
}

function TaskForm({ task, onDone }: { task: GameTaskView | null; onDone: () => void }) {
  const save = useGameTaskSave();
  const remove = useGameTaskDelete();
  const confirm = useConfirm();
  const [title, setTitle] = useState(task?.title ?? '');
  const [context, setContext] = useState(task?.context ?? '');
  const [text, setText] = useState(task?.text ?? '');
  const [country, setCountry] = useState<string | null>(task?.countryCode ?? null);
  return (
    <Stack gap="sm">
      <TextInput
        label="Название"
        required
        maxLength={120}
        placeholder="Например: Церковь в горной деревне"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />
      <Textarea
        label="Контекст"
        description="Ситуация, в которой оказалась церковь. Команда видит вместе с заданием после «Показать задания»"
        placeholder="Например: в деревне 300 человек, ближайшая церковь - в 40 км…"
        autosize
        minRows={4}
        maxRows={12}
        maxLength={1500}
        value={context}
        onChange={(e) => setContext(e.currentTarget.value)}
      />
      <Textarea
        label="Задание"
        description="Что команде сделать. Видно после «Показать задания», на большом экране - во время выступления. **жирный**, *курсив*, списки через «- »"
        autosize
        minRows={6}
        maxRows={16}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <CountrySelect label="Страна" description="Необязательно: команда этой страны получит это задание" value={country} onChange={setCountry} />
      <Group justify="space-between" mt="sm">
        {task ? (
          <Button
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={16} />}
            loading={remove.isPending}
            onClick={async () => {
              if (
                !(await confirm({
                  title: 'Удалить задание?',
                  message: task.teamId ? 'Команда останется без задания.' : 'Задание удалится.',
                  confirmLabel: 'Удалить',
                  danger: true,
                }))
              )
                return;
              remove.mutate(task.id, { onSuccess: onDone, ...onError });
            }}
          >
            Удалить
          </Button>
        ) : (
          <span />
        )}
        <Button
          loading={save.isPending}
          disabled={!title.trim()}
          onClick={() =>
            save.mutate(
              {
                id: task?.id ?? null,
                body: {
                  title: title.trim(),
                  context: context.trim(),
                  text: text.trim(),
                  countryCode: country,
                },
              },
              {
                onSuccess: () => {
                  notifySuccess('Сохранено');
                  onDone();
                },
                ...onError,
              },
            )
          }
        >
          Сохранить
        </Button>
      </Group>
    </Stack>
  );
}
