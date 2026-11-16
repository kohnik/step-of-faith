import { Badge, Button, Card, Group, SimpleGrid, Stack, Text, TextInput, ThemeIcon } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { CATEGORY_LABELS, type AdminParticipantRow, type DuplicateGroup } from '@sof/shared';
import { IconCopy, IconPhone, IconSearch, IconUser, IconUserOff, IconUsers } from '@tabler/icons-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useDuplicates, useUpdateParticipant } from '../../api/participants.ts';
import { PaymentBadge } from '../../components/badges.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { useSession } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { countLabel, formatDate, formatDateTime, formatTicket } from '../../lib/format.ts';
import { notifySuccess } from '../../lib/notify.tsx';

function groupReason(group: DuplicateGroup): { label: string; icon: typeof IconUser } {
  if (group.key.startsWith('phone:')) {
    const digits = group.key.slice('phone:'.length);
    return { label: `Совпадает телефон …${digits.slice(-4)}`, icon: IconPhone };
  }
  return { label: 'Совпадают ФИО и дата рождения', icon: IconUser };
}

/** Значение совпадает у всех в группе - подсвечиваем. */
function allSame(group: AdminParticipantRow[], pick: (r: AdminParticipantRow) => string | null | undefined): boolean {
  const values = group.map((r) => (pick(r) ?? '').toString().trim().toLowerCase());
  return values.every((v) => v && v === values[0]);
}

function Field({ label, value, same }: { label: string; value: ReactNode; same?: boolean }) {
  return (
    <Group gap={6} wrap="nowrap" align="baseline">
      <Text size="xs" c="dimmed" w={110} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm" fw={same ? 700 : 400} c={same ? 'orange.7' : undefined} style={{ wordBreak: 'break-word' }}>
        {value || '-'}
      </Text>
    </Group>
  );
}

export default function DuplicatesPage() {
  const tz = useEventTz();
  const { can, paymentsEnabled } = useSession();
  const confirm = useConfirm();
  const duplicates = useDuplicates();
  const update = useUpdateParticipant();
  const { openParticipant } = useParticipantDrawer();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);

  const groups = useMemo(() => {
    const list = duplicates.data ?? [];
    if (!q) return list;
    return list.filter((g) =>
      g.participants.some((p) => `${p.fullName} ${p.phone ?? ''} ${p.ownerName} ${p.city}`.toLowerCase().includes(q)),
    );
  }, [duplicates.data, q]);

  const cancelRecord = async (p: AdminParticipantRow) => {
    const ok = await confirm({
      title: `Отменить запись «${p.fullName}»?`,
      message: `Эту запись (регистрировал(а): ${p.ownerName}) отметим как «Отменён»: её QR-код перестанет работать, записи на активности отменятся. Другие записи не тронем.`,
      confirmLabel: 'Отменить запись',
      danger: true,
    });
    if (!ok) return;
    update.mutate(
      { id: p.id, patch: { status: 'cancelled' } },
      { onSuccess: () => notifySuccess('Лишнюю запись отменили', p.fullName) },
    );
  };

  return (
    <Stack gap="md">
      <PageHeader
        title="Возможные дубли"
        description="Бывает, что человека регистрируют дважды - например, сам и через родителей. Сравните записи и отмените лишнюю: у оставшейся QR-код продолжит работать."
        badge={duplicates.data ? <Badge size="lg" color="orange" variant="light">{duplicates.data.length}</Badge> : undefined}
      />

      <TextInput
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        placeholder="Найти по ФИО, телефону, городу, аккаунту"
        leftSection={<IconSearch size={16} />}
        maw={480}
        aria-label="Поиск по дублям"
      />

      {duplicates.isPending ? (
        <BlockSkeleton rows={4} height={160} />
      ) : duplicates.isError ? (
        <ErrorState error={duplicates.error} onRetry={() => void duplicates.refetch()} />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyBlock
            icon={<IconCopy size={28} />}
            title={q ? 'Ничего не нашлось' : 'Дублей нет'}
            description={q ? 'Попробуйте поискать иначе.' : 'Похожих записей из разных аккаунтов не нашлось - всё чисто.'}
          />
        </Card>
      ) : (
        <Stack gap="md">
          {groups.map((group) => {
            const reason = groupReason(group);
            const Icon = reason.icon;
            const people = group.participants;
            return (
              <Card key={group.key} padding="md">
                <Group justify="space-between" mb="sm" gap="sm">
                  <Group gap="xs">
                    <ThemeIcon variant="light" color="orange" radius="md">
                      <Icon size={16} />
                    </ThemeIcon>
                    <Text fw={700}>{reason.label}</Text>
                  </Group>
                  <Badge color="gray" variant="light" leftSection={<IconUsers size={12} />}>
                    {countLabel(people.length, ['запись', 'записи', 'записей'])}
                  </Badge>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2, xl: Math.min(3, people.length) }} spacing="sm">
                  {people.map((p) => (
                    <Card key={p.id} padding="sm" radius="md" withBorder>
                      <Stack gap={6}>
                        <Group justify="space-between" gap="xs" wrap="nowrap">
                          <Text fw={700} truncate>
                            {p.fullName}
                          </Text>
                          {paymentsEnabled && <PaymentBadge status={p.paymentStatus} size="xs" />}
                        </Group>
                        <Field label="Дата рождения" value={`${formatDate(p.birthDate)} (${p.age})`} same={allSame(people, (r) => r.birthDate)} />
                        <Field label="Телефон" value={p.phone} same={allSame(people, (r) => (r.phone ?? '').replace(/\D/g, '').slice(-10))} />
                        <Field label="Город" value={p.city} same={allSame(people, (r) => r.city)} />
                        <Field label="Категория" value={CATEGORY_LABELS[p.category]} />
                        <Field label="Регистрировал(а)" value={`${p.ownerName}${p.ownerUsername ? ` (@${p.ownerUsername})` : ''}`} />
                        <Field label="Семья" value={`${p.familySize} чел.`} />
                        <Field label="QR-код" value={formatTicket(p.ticketCode)} />
                        <Field label="Пришёл" value={p.arrivedAt ? formatDateTime(p.arrivedAt, tz) : 'нет'} />
                        <Field label="Создан" value={formatDateTime(p.createdAt, tz)} />
                        <Group gap="xs" mt="xs">
                          <Button size="xs" variant="light" leftSection={<IconUser size={14} />} onClick={() => openParticipant(p.id)}>
                            Открыть
                          </Button>
                          {can('participants:write') && (
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              leftSection={<IconUserOff size={14} />}
                              loading={update.isPending && update.variables?.id === p.id}
                              onClick={() => void cancelRecord(p)}
                            >
                              Отменить эту запись
                            </Button>
                          )}
                        </Group>
                      </Stack>
                    </Card>
                  ))}
                </SimpleGrid>
              </Card>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
