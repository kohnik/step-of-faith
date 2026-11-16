import { Badge, Code, Group, SegmentedControl, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMemo, useState } from 'react';

type Row = { key: string; before: unknown; after: unknown; status: 'changed' | 'added' | 'removed' | 'same' | 'kept' };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function Value({ value }: { value: unknown }) {
  if (value === undefined) return <Text span c="dimmed">-</Text>;
  if (value === null) return <Text span c="dimmed" fs="italic">пусто</Text>;
  if (typeof value === 'boolean') return <Badge size="xs" color={value ? 'green' : 'gray'}>{value ? 'да' : 'нет'}</Badge>;
  if (typeof value === 'string' || typeof value === 'number') return <Text span size="sm" style={{ wordBreak: 'break-word' }}>{String(value)}</Text>;
  return <pre className="sof-diff-json" style={{ margin: 0 }}>{JSON.stringify(value, null, 2)}</pre>;
}

/** Было / стало из журнала действий. Для объектов - построчно по полям. */
export function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  const [mode, setMode] = useState<'changes' | 'all' | 'raw'>('changes');

  const rows = useMemo<Row[] | null>(() => {
    const b = before ?? null;
    const a = after ?? null;
    if ((b !== null && !isPlainObject(b)) || (a !== null && !isPlainObject(a))) return null;
    const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])];
    return keys.map((key) => {
      const hasB = !!b && key in b;
      const hasA = !!a && key in a;
      const vb = hasB ? b![key] : undefined;
      const va = hasA ? a![key] : undefined;
      let status: Row['status'];
      if (hasA && hasB) status = same(vb, va) ? 'same' : 'changed';
      else if (hasA) status = 'added';
      // Поле есть только в «было»: при частичном изменении оно не трогалось.
      else status = a ? 'kept' : 'removed';
      return { key, before: vb, after: va, status };
    });
  }, [before, after]);

  if (before == null && after == null) {
    return (
      <Text size="sm" c="dimmed">
        Подробностей нет.
      </Text>
    );
  }

  if (!rows || mode === 'raw') {
    return (
      <Stack gap="xs">
        {rows && <ModeSwitch mode={mode} onChange={setMode} />}
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
          <Stack gap={4}>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase">Было</Text>
            <Code block className="sof-diff-json">{before == null ? '-' : JSON.stringify(before, null, 2)}</Code>
          </Stack>
          <Stack gap={4}>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase">Стало</Text>
            <Code block className="sof-diff-json">{after == null ? '-' : JSON.stringify(after, null, 2)}</Code>
          </Stack>
        </SimpleGrid>
      </Stack>
    );
  }

  const visible = mode === 'changes' ? rows.filter((r) => r.status === 'changed' || r.status === 'added' || r.status === 'removed') : rows;

  return (
    <Stack gap="xs">
      <ModeSwitch mode={mode} onChange={setMode} />
      {visible.length === 0 ? (
        <Text size="sm" c="dimmed">
          Значения не изменились.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={520} type="native">
          <Table withTableBorder withColumnBorders fz="sm" highlightOnHover={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="22%">Поле</Table.Th>
                <Table.Th>Было</Table.Th>
                <Table.Th>Стало</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((r) => (
                <Table.Tr key={r.key} className={r.status === 'same' || r.status === 'kept' ? undefined : 'sof-diff-changed'}>
                  <Table.Td>
                    <Text size="sm" ff="monospace">{r.key}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Value value={r.before} />
                  </Table.Td>
                  <Table.Td>{r.status === 'kept' ? <Text span size="xs" c="dimmed">без изменений</Text> : <Value value={r.after} />}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

function ModeSwitch({ mode, onChange }: { mode: 'changes' | 'all' | 'raw'; onChange: (m: 'changes' | 'all' | 'raw') => void }) {
  return (
    <Group justify="flex-end">
      <SegmentedControl
        size="xs"
        value={mode}
        onChange={onChange}
        data={[
          { value: 'changes', label: 'Изменения' },
          { value: 'all', label: 'Все поля' },
          { value: 'raw', label: 'JSON' },
        ]}
      />
    </Group>
  );
}
