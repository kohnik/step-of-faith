import { Alert, Button, Select, Stack, Text } from '@mantine/core';
import type { CounselorAdminView } from '@sof/shared';
import { IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { useAnnounceCounseling } from '../../api/counseling.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { countLabel } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';

const BOOKINGS = ['запись', 'записи', 'записей'] as const;

/**
 * «Напомнить всем»: каждому записанному (у кого окошко ещё впереди) - сообщение в бот: время, служитель и место, если указано.
 * Можно всем сразу или только записанным к одному служителю (например, когда ему дали аудиторию).
 */
export function AnnounceModal({ opened, onClose, counselors, title }: { opened: boolean; onClose: () => void; counselors: CounselorAdminView[]; title: string }) {
  const [who, setWho] = useState<string>('all');
  const announce = useAnnounceCounseling();
  const upcoming = (c: CounselorAdminView) => c.bookings.filter((b) => new Date(b.slotStart).getTime() > Date.now()).length;
  const picked = who === 'all' ? null : counselors.find((c) => String(c.id) === who) ?? null;
  const count = picked ? upcoming(picked) : counselors.reduce((s, c) => s + upcoming(c), 0);
  const sample = picked ?? counselors.find((c) => upcoming(c) > 0) ?? counselors[0];
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>Напомнить записанным</Text>} size="md">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Сейчас бот сам присылает подтверждение при записи и напоминание за 15 минут до окошка, а если служителю поменяли место - новое место. Эта
          кнопка - чтобы напомнить всем сразу.
        </Text>
        <Select
          label="Кому"
          allowDeselect={false}
          value={who}
          onChange={(v) => setWho(v ?? 'all')}
          comboboxProps={{ withinPortal: true }}
          data={[
            { value: 'all', label: `Всем записанным · ${counselors.reduce((s, c) => s + upcoming(c), 0)}` },
            ...counselors.map((c) => ({ value: String(c.id), label: `${c.name}${c.place ? ` - ${c.place}` : ''} · ${upcoming(c)}`, disabled: upcoming(c) === 0 })),
          ]}
        />
        {sample && (
          <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} title="Что придёт">
            <Text size="sm">
              🙏 <b>{title}</b> - напоминаем о записи
              <br />
              <b>время</b> · {sample.name}
              {sample.place ? ` · ${sample.place}` : ''}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              Место - если указано. Записи уже прошедших окошек не напоминаем. На аккаунте несколько записей - одно сообщение со всеми.
            </Text>
          </Alert>
        )}
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={count === 0}
            loading={announce.isPending}
            onClick={() =>
              announce.mutate(picked?.id ?? null, {
                onSuccess: ({ bookings }) => {
                  notifySuccess('Напоминание отправляется', `${countLabel(bookings, BOOKINGS)} - сообщения уйдут в бот за минуту`);
                  onClose();
                },
                onError: (e) => notifyError(e),
              })
            }
          >
            {count > 0 ? `Напомнить · ${countLabel(count, BOOKINGS)}` : 'Некому напоминать'}
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}
