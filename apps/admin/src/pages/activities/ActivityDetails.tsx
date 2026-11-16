import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import type { ActivityView } from '@sof/shared';
import { IconClock, IconMapPin, IconPencil, IconUser, IconUsers } from '@tabler/icons-react';
import { ActivityKindBadge, ActivityStatusBadge } from '../../components/badges.tsx';
import { formatTime } from '../../lib/format.ts';
import { dayKey } from '../../lib/tz.ts';

export function ageLabel(a: ActivityView): string | null {
  if (a.minAge !== null && a.maxAge !== null) return `${a.minAge}–${a.maxAge} лет`;
  if (a.minAge !== null) return `от ${a.minAge} лет`;
  if (a.maxAge !== null) return `до ${a.maxAge} лет`;
  return null;
}

/** «записано 12 из 20», «записано 5», «свободный вход». */
export function registrationLabel(a: ActivityView): string {
  if (a.registrationMode !== 'required') return 'Свободный вход';
  return a.capacity !== null ? `Записано ${a.registeredCount} из ${a.capacity}` : `Записано ${a.registeredCount}`;
}

/** Подробности активности - во всплывающем окне таймлайна. */
export function ActivityDetails({
  activity: a,
  tz,
  editable,
  onEdit,
  onRegs,
}: {
  activity: ActivityView;
  tz: string;
  editable: boolean;
  onEdit: () => void;
  onRegs: () => void;
}) {
  const age = ageLabel(a);
  const nextDay = dayKey(a.endsAt, tz) !== dayKey(a.startsAt, tz);
  return (
    <Stack gap={8}>
      <div>
        <Text fw={700} td={a.status === 'cancelled' ? 'line-through' : undefined}>
          {a.title}
        </Text>
        <Group gap={6} mt={4} wrap="wrap">
          <ActivityKindBadge kind={a.kind} size="xs" />
          {a.status !== 'published' && <ActivityStatusBadge status={a.status} size="xs" />}
          {age && (
            <Badge size="xs" variant="outline" color="gray">
              {age}
            </Badge>
          )}
        </Group>
      </div>
      <Stack gap={4}>
        <Group gap={6} wrap="nowrap">
          <IconClock size={14} color="var(--mantine-color-dimmed)" />
          <Text size="sm" className="sof-tabular">
            {formatTime(a.startsAt, tz)}–{formatTime(a.endsAt, tz)}
            {nextDay ? ' (до следующего дня)' : ''}
          </Text>
        </Group>
        {a.location && (
          <Group gap={6} wrap="nowrap">
            <IconMapPin size={14} color="var(--mantine-color-dimmed)" />
            <Text size="sm">{a.location}</Text>
          </Group>
        )}
        {a.host && (
          <Group gap={6} wrap="nowrap">
            <IconUser size={14} color="var(--mantine-color-dimmed)" />
            <Text size="sm">{a.host}</Text>
          </Group>
        )}
        <Group gap={6} wrap="nowrap">
          <IconUsers size={14} color="var(--mantine-color-dimmed)" />
          <Text size="sm">
            {registrationLabel(a)}
            {a.waitlistCount > 0 ? ` · ожидают ${a.waitlistCount}` : ''}
          </Text>
        </Group>
      </Stack>
      {a.description && (
        <Text size="xs" c="dimmed" lineClamp={4}>
          {a.description}
        </Text>
      )}
      {editable && (
        <Group gap="xs" grow>
          <Button size="xs" variant="default" leftSection={<IconUsers size={14} />} onClick={onRegs}>
            Кто записан
          </Button>
          <Button size="xs" leftSection={<IconPencil size={14} />} onClick={onEdit}>
            Изменить
          </Button>
        </Group>
      )}
    </Stack>
  );
}
