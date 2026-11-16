import { Card, Group, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  hint,
  icon,
  color = 'indigo',
  side,
  loading,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  color?: string;
  /** Что-то справа вместо иконки (например, кольцо прогресса). */
  side?: ReactNode;
  loading?: boolean;
}) {
  return (
    <Card padding="lg" h="100%">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm" h="100%">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} lts="0.04em">
            {label}
          </Text>
          {loading ? <Skeleton height={30} width={90} radius="sm" /> : <Text className="sof-stat-value">{value}</Text>}
          {hint && (
            <Text size="sm" c="dimmed" lh={1.35}>
              {hint}
            </Text>
          )}
        </Stack>
        {side ??
          (icon && (
            <ThemeIcon variant="light" color={color} radius="md" className="sof-stat-icon">
              {icon}
            </ThemeIcon>
          ))}
      </Group>
    </Card>
  );
}
