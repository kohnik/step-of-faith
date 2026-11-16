import { Anchor, Text } from '@mantine/core';

/** Кто из команды: имя и ник в Telegram - ник ссылкой, сразу написать или открыть профиль. */
export function StaffName({ name, username, size = 'sm' }: { name: string | null | undefined; username: string | null | undefined; size?: 'xs' | 'sm' }) {
  if (!name && !username) return <Text size={size} c="dimmed">-</Text>;
  return (
    <Text size={size} span>
      {name ?? ''}
      {username && (
        <>
          {name ? ' · ' : ''}
          <Anchor href={`https://t.me/${username}`} target="_blank" rel="noopener noreferrer" size={size} onClick={(e) => e.stopPropagation()}>
            @{username}
          </Anchor>
        </>
      )}
    </Text>
  );
}
