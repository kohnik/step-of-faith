import { Text, Typography } from '@mantine/core';
import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown.tsx';

export function Markdown({ source, empty = 'Пока пусто' }: { source: string; empty?: string }) {
  const nodes = useMemo(() => renderMarkdown(source), [source]);
  if (nodes.length === 0) {
    return (
      <Text c="dimmed" size="sm" fs="italic">
        {empty}
      </Text>
    );
  }
  return <Typography className="sof-markdown">{nodes}</Typography>;
}
