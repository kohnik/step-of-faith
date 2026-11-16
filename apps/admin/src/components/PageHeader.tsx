import { Group, Stack, Text, Title } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { useEvent } from './EventProvider.tsx';

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  const { eventName } = useEvent();
  useDocumentTitle(`${title} · ${eventName}`);
  return (
    <Group justify="space-between" align="flex-end" gap="md" mb="lg" wrap="wrap">
      <Stack gap={4} style={{ minWidth: 0, flex: '1 1 320px' }}>
        <Group gap="sm" wrap="nowrap">
          <Title order={2} fz={{ base: 22, sm: 26 }}>
            {title}
          </Title>
          {badge}
        </Group>
        {description && (
          <Text c="dimmed" size="sm" maw={820}>
            {description}
          </Text>
        )}
      </Stack>
      {actions && (
        <Group gap="sm" wrap="wrap" justify="flex-end">
          {actions}
        </Group>
      )}
    </Group>
  );
}
