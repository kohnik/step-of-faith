import { ActionIcon, CopyButton, Group, Text, Tooltip, type TextProps } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export function CopyIconButton({
  value,
  label = 'Скопировать',
  size = 'sm',
  variant = 'subtle',
}: {
  value: string;
  label?: string;
  size?: 'xs' | 'sm' | 'md';
  variant?: 'subtle' | 'default';
}) {
  return (
    <CopyButton value={value} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Скопировано' : label}>
          <ActionIcon size={size} color={copied ? 'teal' : 'gray'} variant={variant} onClick={copy} aria-label={label}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

/** Значение + кнопка копирования. */
export function CopyValue({
  value,
  display,
  mono,
  ...textProps
}: { value: string; display?: ReactNode; mono?: boolean } & TextProps) {
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      <Text size="sm" className={mono ? 'sof-mono' : undefined} truncate {...textProps}>
        {display ?? value}
      </Text>
      <CopyIconButton value={value} />
    </Group>
  );
}
