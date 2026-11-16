import {
  ActionIcon,
  Anchor,
  Badge,
  Card,
  Collapse,
  Group,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { AuditEntry } from '@sof/shared';
import { IconChevronRight, IconFilter, IconHash, IconHistory, IconRefresh, IconSearch } from '@tabler/icons-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useAudit } from '../../api/staff.ts';
import { useEventTz } from '../../components/EventProvider.tsx';
import { JsonDiff } from '../../components/JsonDiff.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatDateTime, formatNumber, formatRelative } from '../../lib/format.ts';
import { AUDIT_ENTITY_LABELS, auditActionLabel, auditEntityLabel } from '../../lib/labels.ts';

const PAGE_SIZE = 50;

const ENTITY_OPTIONS = [
  { value: '', label: 'Все объекты' },
  ...Object.entries(AUDIT_ENTITY_LABELS).map(([value, label]) => ({ value, label })),
];

function hasDetails(e: AuditEntry): boolean {
  return e.before != null || e.after != null;
}

export default function AuditPage() {
  const tz = useEventTz();
  const { openParticipant, canOpen } = useParticipantDrawer();
  const [entity, setEntity] = useState('');
  const [entityIdInput, setEntityIdInput] = useState('');
  const [entityId] = useDebouncedValue(entityIdInput.trim(), 350);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const audit = useAudit(entity, entityId);

  const rows = useMemo(() => {
    const list = audit.data ?? [];
    if (!q) return list;
    return list.filter((e) =>
      `${auditActionLabel(e.action)} ${e.action} ${e.actorName ?? ''} ${auditEntityLabel(e.entity)} ${e.entityId ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [audit.data, q]);

  useEffect(() => setPage(1), [entity, entityId, q]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visible = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Stack gap="md">
      <PageHeader
        title="История изменений"
        description="Кто, что и когда поменял: данные участников, роли, настройки, рассылки. Показываем последние 500 записей."
        actions={
          <Tooltip label="Обновить">
            <ActionIcon variant="default" size="lg" onClick={() => void audit.refetch()} loading={audit.isFetching} aria-label="Обновить">
              <IconRefresh size={18} />
            </ActionIcon>
          </Tooltip>
        }
      />

      <Card padding="md">
        <Group gap="sm" wrap="wrap" align="flex-end">
          <Select
            label="Объект"
            data={ENTITY_OPTIONS}
            value={entity}
            onChange={(v) => setEntity(v ?? '')}
            allowDeselect={false}
            leftSection={<IconFilter size={16} />}
            w={220}
          />
          <TextInput
            label="ID объекта"
            placeholder="например, 125"
            value={entityIdInput}
            onChange={(e) => setEntityIdInput(e.currentTarget.value)}
            leftSection={<IconHash size={16} />}
            w={180}
          />
          <TextInput
            label="Поиск"
            placeholder="Действие, кто сделал"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            leftSection={<IconSearch size={16} />}
            style={{ flex: '1 1 240px' }}
            maw={420}
          />
        </Group>
      </Card>

      {audit.isPending ? (
        <BlockSkeleton rows={8} height={40} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyBlock icon={<IconHistory size={28} />} title="Ничего не нашлось" description="Попробуйте изменить фильтры." />
        </Card>
      ) : (
        <Card padding={0}>
          <Table.ScrollContainer minWidth={760} type="native">
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover={false}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40} />
                  <Table.Th w={170}>Когда</Table.Th>
                  <Table.Th>Кто</Table.Th>
                  <Table.Th>Действие</Table.Th>
                  <Table.Th>Объект</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visible.map((e) => {
                  const open = expanded.has(e.id);
                  const details = hasDetails(e);
                  return (
                    <Fragment key={e.id}>
                      <Table.Tr
                        className={details ? 'sof-row-link' : undefined}
                        onClick={details ? () => toggle(e.id) : undefined}
                        tabIndex={details ? 0 : undefined}
                        onKeyDown={
                          details
                            ? (ev) => {
                                if (ev.key === 'Enter' || ev.key === ' ') {
                                  ev.preventDefault();
                                  toggle(e.id);
                                }
                              }
                            : undefined
                        }
                        aria-expanded={details ? open : undefined}
                      >
                        <Table.Td>
                          {details && (
                            <IconChevronRight
                              size={16}
                              style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 150ms' }}
                            />
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label={formatRelative(e.createdAt)}>
                            <Text size="sm" className="sof-tabular">
                              {formatDateTime(e.createdAt, tz)}
                            </Text>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{e.actorName ?? <Text span c="dimmed">система</Text>}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {auditActionLabel(e.action)}
                          </Text>
                          <Text size="xs" c="dimmed" ff="monospace">
                            {e.action}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            <Badge variant="light" color="gray" size="sm">
                              {auditEntityLabel(e.entity)}
                            </Badge>
                            {e.entityId &&
                              (e.entity === 'participant' && canOpen ? (
                                <Anchor
                                  component="button"
                                  type="button"
                                  size="sm"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    openParticipant(Number(e.entityId));
                                  }}
                                >
                                  #{e.entityId}
                                </Anchor>
                              ) : (
                                <Text size="sm" c="dimmed">
                                  #{e.entityId}
                                </Text>
                              ))}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                      {details && (
                        <Table.Tr style={{ display: open ? undefined : 'none' }}>
                          <Table.Td colSpan={5} bg="var(--mantine-color-default-hover)">
                            <Collapse expanded={open}>{open && <JsonDiff before={e.before} after={e.after} />}</Collapse>
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </Fragment>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      {rows.length > 0 && (
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            Записей: {formatNumber(rows.length)}
            {audit.data && audit.data.length >= 500 ? ' (последние 500 - уточните фильтр)' : ''}
          </Text>
          {pages > 1 && <Pagination total={pages} value={page} onChange={setPage} size="sm" />}
        </Group>
      )}
    </Stack>
  );
}
