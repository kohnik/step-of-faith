import { Badge, Button, Card, Drawer, Group, Stack, Table, Text } from '@mantine/core';
import type { SeminarBlockView, SeminarTopicRow } from '@sof/shared';
import { IconDownload, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';
import { useRegistrations } from '../../api/activities.ts';
import { downloadFile } from '../../api/client.ts';
import { useIsMobile } from '../../components/AppModal.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { ParticipantLink } from '../../components/ParticipantLink.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { capitalizeFirst, formatDayLong, formatTime } from '../../lib/format.ts';
import { REGISTRATION_STATUS_COLORS, REGISTRATION_STATUS_LABELS } from '../../lib/labels.ts';
import { notifyError } from '../../lib/notify.tsx';
import { dayKey } from '../../lib/tz.ts';

/** Одна тема: кто записан (по порядку записи), очередь - отдельной пометкой. */
function TopicPeople({ block, t }: { block: SeminarBlockView; t: SeminarTopicRow }) {
  const q = useRegistrations(t.id);
  const room = block.rooms.find((r) => r.id === (t.publishedRoomId ?? t.roomId))?.name;
  const rows = (q.data ?? []).filter((r) => r.status !== 'cancelled');
  return (
    <Card withBorder radius="md" p="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <div style={{ minWidth: 0 }}>
          <Text fw={700} size="sm">
            {t.title}
          </Text>
          <Text size="xs" c="dimmed">
            {[t.host, room ?? 'без зала', t.hidden ? 'тема скрыта' : null].filter(Boolean).join(' · ')}
          </Text>
        </div>
        <Badge variant="light" size="lg" style={{ flexShrink: 0 }}>
          {q.data ? rows.length : t.registered}
        </Badge>
      </Group>
      {q.isPending ? (
        <BlockSkeleton rows={2} height={20} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed" mt="xs">
          Пока никто не записался
        </Text>
      ) : (
        <Table mt="xs" verticalSpacing={4} horizontalSpacing="xs">
          <Table.Tbody>
            {rows.map((r, i) => (
              <Table.Tr key={r.participantId}>
                <Table.Td w={28} c="dimmed">
                  {i + 1}
                </Table.Td>
                <Table.Td>
                  <ParticipantLink id={r.participantId} name={r.fullName} />
                </Table.Td>
                <Table.Td w={50} c="dimmed">
                  {r.age}
                </Table.Td>
                <Table.Td w={110}>
                  {r.status !== 'registered' && (
                    <Badge size="xs" color={REGISTRATION_STATUS_COLORS[r.status]}>
                      {REGISTRATION_STATUS_LABELS[r.status]}
                    </Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}

/** «Кто записан» на весь блок семинаров: темы по очереди со списками и выгрузка всех списков. */
export function BlockPeopleDrawer({ block, opened, onClose }: { block: SeminarBlockView | null; opened: boolean; onClose: () => void }) {
  const tz = useEventTz();
  const mobile = useIsMobile();
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (!block) return;
    setDownloading(true);
    try {
      await downloadFile(`/api/admin/seminars/${block.id}/registrations.xlsx`, `${block.title}.xlsx`);
    } catch (err) {
      notifyError(err, 'Не удалось скачать списки');
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Drawer
      opened={opened && block !== null}
      onClose={onClose}
      position="right"
      size={mobile ? '100%' : 560}
      title={
        <Group gap="xs">
          <IconUsers size={18} />
          <Text fw={700}>Кто записан</Text>
        </Group>
      }
    >
      {block && (
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <div>
              <Text fw={700} size="lg">
                {block.title}
              </Text>
              <Text size="sm" c="dimmed">
                {capitalizeFirst(formatDayLong(dayKey(block.startsAt, tz)))}, {formatTime(block.startsAt, tz)}–{formatTime(block.endsAt, tz)}
                {block.hidden ? ' · скрыт от участников' : ''}
              </Text>
            </div>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconDownload size={14} />}
              loading={downloading}
              disabled={block.topics.length === 0}
              onClick={() => void download()}
            >
              Скачать списки (.xlsx)
            </Button>
          </Group>
          {block.topics.length === 0 ? (
            <Text c="dimmed">В блоке пока нет тем.</Text>
          ) : (
            block.topics.map((t) => <TopicPeople key={t.id} block={block} t={t} />)
          )}
        </Stack>
      )}
    </Drawer>
  );
}
