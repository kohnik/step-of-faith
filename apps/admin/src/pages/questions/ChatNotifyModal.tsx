import { Badge, Button, Checkbox, Group, Stack, Text } from '@mantine/core';
import type { ChatNotifyView } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const KEY = ['chat-notify'] as const;
const ROLE_SHORT: Record<string, string> = { admin: 'Админ', superadmin: 'Суперадмин' };

/**
 * «Копии в Telegram»: кому из админов бот присылает копию каждого сообщения участника (кроме папки «Мерч» -
 * её копии настраиваются в «Мерч» → «Настройки»). По умолчанию - всем админам и суперадминам. Черновик и одна кнопка «Сохранить».
 */
export function ChatNotifyModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>Копии сообщений в Telegram</Text>} size="md">
      {opened && <ChatNotifyForm onDone={onClose} />}
    </AppModal>
  );
}

function ChatNotifyForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.get<ChatNotifyView>('/api/admin/chat-notify', { signal }) });
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const save = useMutation({
    mutationFn: (chatNotify: Record<string, boolean>) => api.patch<ChatNotifyView>('/api/admin/chat-notify', { chatNotify }),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  if (q.isPending) return <BlockSkeleton rows={3} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const on = (p: ChatNotifyView['people'][number]) => draft[String(p.userId)] ?? p.on;
  const dirty = q.data.people.some((p) => draft[String(p.userId)] !== undefined && draft[String(p.userId)] !== p.on);
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Участник написал организаторам - копия приходит в бот с кнопкой «Открыть переписку». Отвечают здесь, в «Сообщениях». Сообщения из папки «Мерч»
        приходят продавцам - это в «Мерч» → «Настройки».
      </Text>
      {q.data.people.length === 0 ? (
        <Text size="sm">Админов пока нет.</Text>
      ) : (
        <Stack gap={6}>
          {q.data.people.map((p) => (
            <Checkbox
              key={p.userId}
              checked={on(p)}
              onChange={(e) => setDraft((d) => ({ ...d, [String(p.userId)]: e.currentTarget.checked }))}
              label={
                <Group gap={4}>
                  <Text size="sm">{p.name}</Text>
                  {p.roles.map((r) => (
                    <Badge key={r} size="xs" variant="light" color={r === 'superadmin' ? 'violet' : 'gray'}>
                      {ROLE_SHORT[r] ?? r}
                    </Badge>
                  ))}
                </Group>
              }
            />
          ))}
        </Stack>
      )}
      <ModalActions>
        <Button variant="default" onClick={onDone}>
          Отмена
        </Button>
        <Button
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: () => {
                notifySuccess('Сохранили', 'Кому приходят копии сообщений');
                onDone();
              },
              onError: (e) => notifyError(e),
            })
          }
        >
          Сохранить
        </Button>
      </ModalActions>
    </Stack>
  );
}
