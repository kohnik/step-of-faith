import { Badge, Button, Card, CloseButton, Divider, Group, Skeleton, Stack, Table, Text, TextInput, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { AdminParticipantRow } from '@sof/shared';
import { IconArrowRight, IconCircleCheckFilled, IconSearch, IconUserCheck, IconUsers } from '@tabler/icons-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useParticipants } from '../../api/participants.ts';
import { useIsMobile } from '../../components/AppModal.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { EmptyBlock, ErrorState } from '../../components/states.tsx';
import { TierBadge } from '../../components/badges.tsx';
import { useTiers } from '../../components/SessionProvider.tsx';
import { countLabel, formatDateTime, formatRelative } from '../../lib/format.ts';

type Row = AdminParticipantRow;

const LIMIT = 10;

function matches(r: Row, q: string, digits: string): boolean {
  const text = `${r.fullName} ${r.city} ${r.ownerUsername ?? ''} ${r.ticketCode ?? ''}`.toLowerCase();
  if (text.includes(q)) return true;
  // Телефон ищем по цифрам: «+375 29…» и «37529…» - одно и то же.
  return digits.length >= 3 && !!r.phone && r.phone.replace(/\D/g, '').includes(digits);
}

const newestFirst = (a: Row, b: Row) => b.createdAt.localeCompare(a.createdAt);

/**
 * Сводка → «Участники»: 10 последних зарегистрированных и быстрый поиск.
 * `refreshKey` меняется, когда в сводке поменялись цифры (новые регистрации, приходы), - тогда обновляем список.
 */
export function RecentParticipantsCard({ tz, refreshKey }: { tz: string; refreshKey: string }) {
  const tiers = useTiers();
  const participants = useParticipants();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const { openParticipant } = useParticipantDrawer();
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim().toLowerCase(), 150);

  const { refetch } = participants;
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    void refetch();
  }, [refreshKey, refetch]);

  const { shown, found } = useMemo(() => {
    const rows = participants.data ?? [];
    if (!debounced) {
      const active = rows.filter((r) => r.status === 'active').sort(newestFirst);
      return { shown: active.slice(0, LIMIT), found: null };
    }
    const digits = debounced.replace(/\D/g, '');
    const hits = rows.filter((r) => matches(r, debounced, digits)).sort(newestFirst);
    return { shown: hits.slice(0, LIMIT), found: hits.length };
  }, [participants.data, debounced]);

  const allHref = debounced ? `/participants?q=${encodeURIComponent(search.trim())}` : '/participants';

  return (
    <Card>
      <Group justify="space-between" align="flex-start" gap="sm" mb="md">
        <div>
          <Title order={4} fz="md">
            Участники
          </Title>
          <Text size="xs" c="dimmed">
            {found === null ? 'Последние, кто зарегистрировался' : found ? `Нашлось: ${found}` : 'Никого не нашли'}
          </Text>
        </div>
        <Group gap="xs">
          <Button variant="default" size="sm" leftSection={<IconUserCheck size={16} />} onClick={() => navigate('/participants/confirmed')}>
            Подтверждённые
          </Button>
          <Button variant="light" size="sm" rightSection={<IconArrowRight size={16} />} onClick={() => navigate(allHref)}>
            Все участники
          </Button>
        </Group>
      </Group>

      <TextInput
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && found && found > LIMIT) navigate(allHref);
        }}
        placeholder="Фамилия, имя, город или телефон"
        leftSection={<IconSearch size={16} />}
        rightSection={search ? <CloseButton size="sm" onClick={() => setSearch('')} aria-label="Очистить поиск" /> : null}
        aria-label="Быстрый поиск участника"
        mb="sm"
        maw={mobile ? undefined : 420}
      />

      {participants.isPending ? (
        <Stack gap={6}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={mobile ? 44 : 32} radius="sm" />
          ))}
        </Stack>
      ) : participants.isError ? (
        <ErrorState error={participants.error} onRetry={() => void participants.refetch()} />
      ) : shown.length === 0 ? (
        <EmptyBlock
          icon={<IconUsers size={28} />}
          title={debounced ? 'Никого не нашли' : 'Пока никто не зарегистрировался'}
          description={debounced ? 'Проверьте написание или поищите по городу.' : undefined}
        />
      ) : mobile ? (
        <Stack gap={0}>
          {shown.map((r, i) => (
            <Fragment key={r.id}>
              {i > 0 && <Divider />}
              <UnstyledButton onClick={() => openParticipant(r.id)} py="xs" w="100%">
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <div style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600} truncate td={r.status === 'cancelled' ? 'line-through' : undefined}>
                        {r.fullName}
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {[r.age === null ? 'гость на месте' : countLabel(r.age, ['год', 'года', 'лет']), r.city, formatRelative(r.createdAt)].filter(Boolean).join(' · ')}
                    </Text>
                    <TierBadge tier={r.tier} tiers={tiers} breakfast={r.breakfast} size="xs" />
                  </div>
                  <Arrived row={r} tz={tz} />
                </Group>
              </UnstyledButton>
            </Fragment>
          ))}
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={560} type="native">
          <Table verticalSpacing={6} highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ФИО</Table.Th>
                <Table.Th w={90}>Возраст</Table.Th>
                <Table.Th>Нас. пункт</Table.Th>
                <Table.Th>Вариант</Table.Th>
                <Table.Th w={80} ta="center">
                  Пришёл
                </Table.Th>
                <Table.Th w={150}>Когда</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((r) => (
                <Table.Tr
                  key={r.id}
                  className="sof-row-link"
                  tabIndex={0}
                  onClick={() => openParticipant(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') openParticipant(r.id);
                  }}
                >
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600} td={r.status === 'cancelled' ? 'line-through' : undefined}>
                        {r.fullName}
                      </Text>
                      {r.status === 'cancelled' && (
                        <Badge size="xs" color="gray" variant="outline">
                          отменил(а)
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td className="sof-tabular">{r.age}</Table.Td>
                  <Table.Td>{r.city}</Table.Td>
                  <Table.Td>
                    <TierBadge tier={r.tier} tiers={tiers} breakfast={r.breakfast} size="xs" />
                  </Table.Td>
                  <Table.Td ta="center">
                    <Arrived row={r} tz={tz} />
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={formatDateTime(r.createdAt, tz)}>
                      <Text size="sm" c="dimmed" span>
                        {formatRelative(r.createdAt)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {found !== null && found > LIMIT && (
        <Button variant="subtle" size="xs" mt="xs" onClick={() => navigate(allHref)}>
          Ещё {found - LIMIT} - показать всех в таблице
        </Button>
      )}
    </Card>
  );
}

function Arrived({ row, tz }: { row: Row; tz: string }) {
  if (!row.arrivedAt) {
    return (
      <Text size="sm" c="dimmed" span aria-label="ещё не пришёл">
        -
      </Text>
    );
  }
  return (
    <Tooltip label={`Пришёл(ла) ${formatDateTime(row.arrivedAt, tz)}`}>
      <IconCircleCheckFilled size={20} color="var(--mantine-color-teal-6)" aria-label="пришёл" style={{ flexShrink: 0, verticalAlign: 'middle' }} />
    </Tooltip>
  );
}
