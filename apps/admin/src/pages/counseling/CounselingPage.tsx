import { ActionIcon, Badge, Button, Group, Menu, SimpleGrid, Stack } from '@mantine/core';
import type { CounselorAdminView } from '@sof/shared';
import { IconBellRinging, IconDots, IconHeartHandshake, IconPlus, IconPrinter, IconUsersPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { useCounseling } from '../../api/counseling.ts';
import { useSettingsQuery } from '../../api/settings.ts';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { CounselingTitleField } from '../../components/CounselingTitleField.tsx';
import { ProgramSwitches } from '../../components/ProgramSwitches.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import {
  CounselingSetupModal,
  CounselorCard,
  CounselorModal,
  DEFAULT_WINDOW,
  LAST_YEAR,
  usePrintLists,
  windowOf,
} from './CounselingParts.tsx';
import { AnnounceModal } from './AnnounceModal.tsx';

export default function CounselingPage() {
  const tz = useEventTz();
  const q = useCounseling();
  const { print, sheet } = usePrintLists();
  const [modal, setModal] = useState<{ opened: boolean; counselor: CounselorAdminView | null; key: number }>({
    opened: false,
    counselor: null,
    key: 0,
  });
  const [setup, setSetup] = useState({ opened: false, key: 0 });
  const [announce, setAnnounce] = useState({ opened: false, key: 0 });
  const settings = useSettingsQuery();
  const open = (counselor: CounselorAdminView | null) => setModal((m) => ({ opened: true, counselor, key: m.key + 1 }));
  const openSetup = () => setSetup((m) => ({ opened: true, key: m.key + 1 }));

  const counselors = q.data?.counselors ?? [];
  const booked = counselors.reduce((s, c) => s + c.bookings.length, 0);
  const total = counselors.reduce((s, c) => s + c.slots.length, 0);
  // Новый служитель - по умолчанию в то же окно, что последний добавленный.
  const last = counselors.at(-1);
  const defaults = last ? windowOf(last, tz) : DEFAULT_WINDOW;
  const missingLastYear = LAST_YEAR.some((c) => !counselors.some((x) => x.name === c.name));

  return (
    <Stack gap={0}>
      <PageHeader
        title="Душепопечение"
        description="Служители принимают по записи: время делится на окошки, у человека одна запись. Служители в приложение не заходят - скопируйте или распечатайте список и передайте им. В расписании душепопечение видно одной строкой - под названием, которое задано ниже."
        actions={
          <Group gap="sm" wrap="nowrap">
            <Button
              variant="light"
              leftSection={<IconBellRinging size={16} />}
              disabled={booked === 0}
              onClick={() => setAnnounce((m) => ({ opened: true, key: m.key + 1 }))}
            >
              Напомнить всем
            </Button>
            <Button leftSection={<IconPlus size={16} />} onClick={() => open(null)}>
              Служитель
            </Button>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="default" size="lg" aria-label="Ещё">
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconUsersPlus size={16} />} onClick={openSetup} disabled={!missingLastYear}>
                  Служители прошлого года
                </Menu.Item>
                <Menu.Item leftSection={<IconPrinter size={16} />} onClick={() => print(counselors)} disabled={counselors.length === 0}>
                  Печать всех списков
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        }
      />
      <Stack gap="md" mb="md">
        <CounselingTitleField />
      </Stack>
      {q.isPending ? (
        <BlockSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : counselors.length === 0 ? (
        <EmptyBlock
          icon={<IconHeartHandshake size={28} />}
          title="Служителей пока нет"
          description="Добавьте служителей по одному или сразу всех из прошлого года - останется выбрать день и время."
          action={
            <Button variant="light" leftSection={<IconUsersPlus size={16} />} onClick={openSetup}>
              Служители прошлого года
            </Button>
          }
        />
      ) : (
        <Stack gap="md">
          <ProgramSwitches only={['counseling']} />
          <Group gap="sm" justify="flex-end" wrap="wrap">
            <Badge color="blue" variant="light" size="lg">
              Записано {booked} из {total}
            </Badge>
          </Group>
          <SimpleGrid cols={{ base: 1, lg: 2, xl: 3 }} spacing="md">
            {counselors.map((c) => (
              <CounselorCard key={c.id} c={c} onEdit={() => open(c)} onPrint={() => print([c])} />
            ))}
          </SimpleGrid>
        </Stack>
      )}
      <CounselorModal
        key={modal.key}
        counselor={modal.counselor}
        defaults={defaults}
        opened={modal.opened}
        onClose={() => setModal((m) => ({ ...m, opened: false }))}
      />
      <CounselingSetupModal
        key={`s-${setup.key}`}
        existing={counselors.map((c) => c.name)}
        defaults={defaults}
        opened={setup.opened}
        onClose={() => setSetup((m) => ({ ...m, opened: false }))}
      />
      <AnnounceModal
        key={`a-${announce.key}`}
        opened={announce.opened}
        onClose={() => setAnnounce((m) => ({ ...m, opened: false }))}
        counselors={counselors}
        title={settings.data?.counselingTitle ?? 'Душепопечение'}
      />
      {sheet}
    </Stack>
  );
}
