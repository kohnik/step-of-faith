import {
  Badge,
  Button,
  Drawer,
  Group,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { ActivityRegistrationRow, ActivityView } from '@sof/shared';
import { IconDownload, IconUsers } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useRegistrations } from '../../api/activities.ts';
import { downloadFile } from '../../api/client.ts';
import { ActivityKindBadge, CategoryBadge } from '../../components/badges.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatDateTime, formatDateTimeShort, formatNumber, formatTime } from '../../lib/format.ts';
import { REGISTRATION_STATUS_COLORS, REGISTRATION_STATUS_LABELS } from '../../lib/labels.ts';
import { notifyError } from '../../lib/notify.tsx';

type Filter = 'all' | ActivityRegistrationRow['status'];

/** Что нужно шторке о мероприятии - подходит и тема семинара (это тоже мероприятие). */
export type RegistrationsTarget = Pick<ActivityView, 'id' | 'title' | 'kind' | 'startsAt' | 'endsAt' | 'location' | 'capacity' | 'registrationMode'>;

export function RegistrationsDrawer({
  activity,
  opened,
  onClose,
}: {
  activity: RegistrationsTarget | null;
  opened: boolean;
  onClose: () => void;
}) {
  const tz = useEventTz();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const registrations = useRegistrations(activity?.id ?? null);
  const [filter, setFilter] = useState<Filter>('all');
  const [downloading, setDownloading] = useState(false);

  const rows = registrations.data ?? [];
  const counts = useMemo(
    () => ({
      registered: rows.filter((r) => r.status === 'registered').length,
      waitlist: rows.filter((r) => r.status === 'waitlist').length,
      cancelled: rows.filter((r) => r.status === 'cancelled').length,
    }),
    [rows],
  );
  const visible = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  const download = async () => {
    if (!activity) return;
    setDownloading(true);
    try {
      await downloadFile(`/api/admin/activities/${activity.id}/registrations.xlsx`, `${activity.title}.xlsx`);
    } catch (err) {
      notifyError(err, 'Не удалось скачать список');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Drawer
      opened={opened && activity !== null}
      onClose={onClose}
      position="right"
      size={isMobile ? '100%' : 720}
      title={
        <Group gap="xs">
          <IconUsers size={18} />
          <Text fw={700}>Записавшиеся</Text>
        </Group>
      }
    >
      {activity && (
        <Stack gap="md">
          <Stack gap={4}>
            <Title order={3} lh={1.2}>
              {activity.title}
            </Title>
            <Group gap="xs">
              <ActivityKindBadge kind={activity.kind} />
              <Text size="sm" c="dimmed">
                {formatDateTimeShort(activity.startsAt, tz)}–{formatTime(activity.endsAt, tz)}
                {activity.location ? ` · ${activity.location}` : ''}
              </Text>
            </Group>
          </Stack>

          <SimpleGrid cols={{ base: 3 }} spacing="sm">
            <Stat label="Записаны" value={counts.registered} extra={activity.capacity ? `из ${activity.capacity}` : undefined} />
            <Stat label="Лист ожидания" value={counts.waitlist} />
            <Stat label="Отменили" value={counts.cancelled} />
          </SimpleGrid>
          {activity.capacity !== null && (
            <Progress
              value={Math.min(100, (counts.registered / activity.capacity) * 100)}
              color={counts.registered >= activity.capacity ? 'red' : 'indigo'}
              size="md"
              radius="xl"
            />
          )}

          <Group justify="space-between" gap="sm" wrap="wrap">
            <SegmentedControl
              size="xs"
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              data={[
                { value: 'all', label: `Все (${rows.length})` },
                { value: 'registered', label: 'Записаны' },
                { value: 'waitlist', label: 'Ожидают' },
                { value: 'cancelled', label: 'Отменили' },
              ]}
            />
            <Button variant="default" size="xs" leftSection={<IconDownload size={14} />} loading={downloading} onClick={() => void download()}>
              Скачать .xlsx
            </Button>
          </Group>

          {registrations.isPending ? (
            <BlockSkeleton rows={6} height={32} />
          ) : registrations.isError ? (
            <ErrorState error={registrations.error} onRetry={() => void registrations.refetch()} />
          ) : visible.length === 0 ? (
            <EmptyBlock icon={<IconUsers size={28} />} title="Никого нет" description={activity.registrationMode === 'none' ? 'На эту активность вход свободный, без записи.' : undefined} />
          ) : (
            <Table.ScrollContainer minWidth={600} type="native">
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={40}>№</Table.Th>
                    <Table.Th>ФИО</Table.Th>
                    <Table.Th>Возраст</Table.Th>
                    <Table.Th>Категория</Table.Th>
                    <Table.Th>Статус</Table.Th>
                    <Table.Th>Записан(а)</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {visible.map((r, i) => (
                    <Table.Tr key={`${r.participantId}-${r.status}`}>
                      <Table.Td c="dimmed">{i + 1}</Table.Td>
                      <Table.Td>
                        <ParticipantLink id={r.participantId} name={r.fullName} />
                      </Table.Td>
                      <Table.Td>{r.age}</Table.Td>
                      <Table.Td>
                        <CategoryBadge category={r.category} size="xs" />
                      </Table.Td>
                      <Table.Td>
                        <Badge size="xs" color={REGISTRATION_STATUS_COLORS[r.status]}>
                          {REGISTRATION_STATUS_LABELS[r.status]}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {formatDateTime(r.queuedAt, tz)}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

function Stat({ label, value, extra }: { label: string; value: number; extra?: string }) {
  return (
    <Stack gap={0} p="xs" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-md)' }}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={800} fz="lg" className="sof-tabular">
        {formatNumber(value)}{' '}
        {extra && (
          <Text span size="xs" c="dimmed" fw={500}>
            {extra}
          </Text>
        )}
      </Text>
    </Stack>
  );
}
