import { Card, SegmentedControl, SimpleGrid, Stack, Text, Textarea, type TextareaProps } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useState } from 'react';
import { useIsMobile } from '../../components/AppModal.tsx';
import { Markdown } from '../../components/Markdown.tsx';

/** Поле Markdown с живым предпросмотром: рядом на широком экране, вкладками на узком. */
export function MarkdownEditor({
  value,
  onChange,
  maxLength,
  minRows = 12,
  ...rest
}: Omit<TextareaProps, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void; maxLength: number; minRows?: number }) {
  const wide = useMediaQuery('(min-width: 75em)');
  const mobile = useIsMobile();
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  const editor = (
    <Stack gap={4}>
      <Textarea
        description="Markdown: **жирный**, *курсив*, [ссылка](https://…), «- » - список, «## » - заголовок"
        {...rest}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        autosize
        minRows={minRows}
        maxRows={28}
        // На телефоне 16px - иначе iOS зумит страницу при фокусе.
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: mobile ? 16 : 13 } }}
      />
      <Text size="xs" c={value.length > maxLength ? 'red' : 'dimmed'} ta="right">
        {value.length} / {maxLength}
      </Text>
    </Stack>
  );
  const preview = (
    <Card padding="md" radius="md" withBorder mih={200}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700} mb="xs">
        Предпросмотр
      </Text>
      <Markdown source={value} />
    </Card>
  );

  if (wide) {
    return (
      <SimpleGrid cols={2} spacing="md">
        {editor}
        <div style={{ paddingTop: rest.label ? 44 : 0 }}>{preview}</div>
      </SimpleGrid>
    );
  }
  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        value={mode}
        onChange={(v) => setMode(v as 'edit' | 'preview')}
        data={[
          { value: 'edit', label: 'Текст' },
          { value: 'preview', label: 'Предпросмотр' },
        ]}
        style={{ alignSelf: 'flex-start' }}
      />
      {mode === 'edit' ? editor : preview}
    </Stack>
  );
}
