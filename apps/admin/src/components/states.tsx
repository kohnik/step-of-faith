import { Alert, Button, Center, EmptyState, Group, Loader, Skeleton, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconLock, IconMoodEmpty, IconRefresh } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '../api/client.ts';

export function PageLoader({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <Center mih="50vh">
      <Stack align="center" gap="xs">
        <Loader size="lg" />
        <Text c="dimmed" size="sm">
          {label}
        </Text>
      </Stack>
    </Center>
  );
}

/** Скелет таблицы или списка, пока грузятся данные. */
export function BlockSkeleton({ rows = 6, height = 36 }: { rows?: number; height?: number }) {
  return (
    <Stack gap="xs" aria-busy="true" aria-label="Загрузка">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} radius="md" />
      ))}
    </Stack>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Не получилось загрузить',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: ReactNode;
}) {
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <Alert
      color={forbidden ? 'gray' : 'red'}
      variant="light"
      radius="lg"
      icon={forbidden ? <IconLock size={20} /> : <IconAlertTriangle size={20} />}
      title={forbidden ? 'Нет доступа' : title}
    >
      <Stack gap="sm">
        <Text size="sm">{errorMessage(error)}</Text>
        {onRetry && !forbidden && (
          <Group>
            <Button size="xs" variant="white" color="red" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
              Повторить
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

export function EmptyBlock({
  title,
  description,
  icon,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      py="xl"
      title={title}
      description={description}
      icon={icon ?? <IconMoodEmpty size={28} />}
      withIndicatorBackground
    >
      {action && <EmptyState.Actions>{action}</EmptyState.Actions>}
    </EmptyState>
  );
}

export function NoAccess({ description }: { description?: ReactNode }) {
  return (
    <EmptyBlock
      icon={<IconLock size={28} />}
      title="Нет доступа"
      description={description ?? 'Этот раздел недоступен для вашей роли. Если он нужен вам для работы - напишите организаторам.'}
    />
  );
}
