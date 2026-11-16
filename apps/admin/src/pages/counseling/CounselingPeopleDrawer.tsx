import { Drawer, Group, Stack, Text } from '@mantine/core';
import type { CounselorAdminView } from '@sof/shared';
import { IconHeartHandshake } from '@tabler/icons-react';
import { useState } from 'react';
import { useCounseling } from '../../api/counseling.ts';
import { useIsMobile } from '../../components/AppModal.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { BlockSkeleton } from '../../components/states.tsx';
import { capitalizeFirst, formatDayLong } from '../../lib/format.ts';
import { dayKey } from '../../lib/tz.ts';
import { CounselorCard, CounselorModal, usePrintLists, windowOf } from './CounselingParts.tsx';

/** «Кто записан» на душепопечение дня: служители этого дня с записями (время, телефон, отмена) и печатью. */
export function CounselingPeopleDrawer({ day, opened, onClose }: { day: string | null; opened: boolean; onClose: () => void }) {
  const tz = useEventTz();
  const mobile = useIsMobile();
  const q = useCounseling(opened);
  const { print, sheet } = usePrintLists();
  const [edit, setEdit] = useState<{ counselor: CounselorAdminView | null; key: number }>({ counselor: null, key: 0 });
  const list = (q.data?.counselors ?? []).filter((c) => day !== null && dayKey(c.startsAt, tz) === day);
  const booked = list.reduce((s, c) => s + c.bookings.length, 0);
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={mobile ? '100%' : 560}
      title={
        <Group gap="xs">
          <IconHeartHandshake size={18} />
          <Text fw={700}>Записи на душепопечение</Text>
        </Group>
      }
    >
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : (
        <Stack gap="md">
          <div>
            <Text fw={700} size="lg">
              {day ? capitalizeFirst(formatDayLong(day)) : ''}
            </Text>
            <Text size="sm" c="dimmed">
              Служителей: {list.length} · записано {booked}
            </Text>
          </div>
          {list.length === 0 ? (
            <Text c="dimmed">В этот день служителей нет.</Text>
          ) : (
            list.map((c) => (
              <CounselorCard key={c.id} c={c} onEdit={() => setEdit((e) => ({ counselor: c, key: e.key + 1 }))} onPrint={() => print([c])} />
            ))
          )}
        </Stack>
      )}
      {edit.counselor && (
        <CounselorModal
          key={edit.key}
          counselor={edit.counselor}
          defaults={windowOf(edit.counselor, tz)}
          opened
          onClose={() => setEdit((e) => ({ ...e, counselor: null }))}
        />
      )}
      {sheet}
    </Drawer>
  );
}
