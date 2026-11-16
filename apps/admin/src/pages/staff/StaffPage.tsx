import {
  Anchor,
  Avatar,
  Badge,
  Button,
  Card,
  Collapse,
  Divider,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { canUseAdminWeb, type Role, type StaffMember } from '@sof/shared';
import { IconChevronDown, IconId, IconKey, IconSearch, IconShieldLock, IconUserPlus, IconUsersGroup } from '@tabler/icons-react';
import { Fragment, useMemo, useState } from 'react';
import { useSetRoles, useStaff } from '../../api/staff.ts';
import { useIsMobile } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { useCan, useSession } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { countLabel, formatDateTime, formatRelative, initials, telegramUrl } from '../../lib/format.ts';
import { assignableRoles, primaryRole, ROLE_COLORS, TEAM_ROLE_HINTS, TEAM_ROLE_LABELS } from '../../lib/labels.ts';
import { notifySuccess } from '../../lib/notify.tsx';
import { InviteModal } from './InviteModal.tsx';
import { PasswordModal } from './PasswordModal.tsx';
import { ScannerCardsModal, type GeneratedCard } from './ScannerCardsModal.tsx';

/** Поиск нужен, только когда команда большая. */
const SEARCH_FROM = 9;
const NO_ROLE = 'none';

export default function StaffPage() {
  const tz = useEventTz();
  const staff = useStaff();
  // Банкир (без управления командой) видит только кассиров и может пригласить кассира.
  const full = useCan()('staff:manage');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim().toLowerCase(), 200);
  const [inviteOpened, invite] = useDisclosure(false);
  const [cardsOpened, cardsModal] = useDisclosure(false);
  const [cards, setCards] = useState<GeneratedCard[]>([]);
  const [password, setPassword] = useState<{ opened: boolean; member: StaffMember | null }>({ opened: false, member: null });

  const all = staff.data ?? [];
  const list = useMemo(() => {
    if (!q) return all;
    return all.filter((m) => `${m.name} ${m.username ?? ''} ${m.roles.map((r) => TEAM_ROLE_LABELS[r]).join(' ')}`.toLowerCase().includes(q));
  }, [all, q]);

  return (
    <Stack gap="md">
      <PageHeader
        title={full ? 'Команда' : 'Кассиры'}
        description={
          full
            ? 'Кто помогает с конференцией. Пригласите человека ссылкой - он откроет бота и сразу получит доступ.'
            : 'Кто принимает деньги на кассе. Пригласите кассира ссылкой - он откроет бота и сразу получит доступ.'
        }
        actions={
          <Button leftSection={<IconUserPlus size={16} />} onClick={invite.open}>
            {full ? 'Пригласить' : 'Пригласить кассира'}
          </Button>
        }
      />

      {all.length >= SEARCH_FROM && (
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Имя или @username"
          leftSection={<IconSearch size={16} />}
          maw={420}
          aria-label="Поиск по команде"
        />
      )}

      {staff.isPending ? (
        <BlockSkeleton rows={5} height={56} />
      ) : staff.isError ? (
        <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyBlock icon={<IconUsersGroup size={28} />} title={q ? 'Никого не нашли' : full ? 'В команде пока никого' : 'Кассиров пока нет'} />
        </Card>
      ) : (
        <Card padding={0}>
          {list.map((m, i) => (
            <Fragment key={m.userId}>
              {i > 0 && <Divider />}
              <MemberRow member={m} tz={tz} canEdit={full} />
            </Fragment>
          ))}
        </Card>
      )}
      {staff.data && (
        <Text size="xs" c="dimmed">
          Всего: {countLabel(staff.data.length, ['человек', 'человека', 'человек'])}
        </Text>
      )}

      {full && <RolesReference />}

      {full && (
        <Extras
          members={all}
          cardsCount={cards.length}
          onOpenCards={cardsModal.open}
          onSetPassword={(member) => setPassword({ opened: true, member })}
        />
      )}

      <InviteModal opened={inviteOpened} onClose={invite.close} onlyCashier={!full} />
      <ScannerCardsModal
        opened={cardsOpened}
        onClose={cardsModal.close}
        cards={cards}
        tz={tz}
        onCreated={(c) => setCards((list) => [...list, c])}
        onClear={() => setCards([])}
        onRemove={(id) => setCards((list) => list.filter((c) => c.userId !== id))}
      />
      <PasswordModal member={password.member} opened={password.opened} onClose={() => setPassword((p) => ({ ...p, opened: false }))} />
    </Stack>
  );
}

function MemberRow({ member: m, tz, canEdit }: { member: StaffMember; tz: string; canEdit: boolean }) {
  const main = primaryRole(m.roles);
  return (
    <Group justify="space-between" gap="sm" wrap="wrap" px="md" py="sm">
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: '1 1 220px' }}>
        <Avatar radius="xl" color={main ? ROLE_COLORS[main] : 'gray'}>
          {initials(m.name)}
        </Avatar>
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} truncate>
              {m.name}
            </Text>
            {m.permanent && (
              <Tooltip label="Главный администратор: задан в настройках сервера, роль у него не снимается">
                <Badge size="xs" variant="light" color="grape" style={{ flexShrink: 0 }}>
                  главный
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Group gap={6} wrap="wrap">
            {m.username ? (
              <Anchor href={telegramUrl(m.username) ?? undefined} target="_blank" rel="noopener noreferrer" size="xs">
                @{m.username}
              </Anchor>
            ) : (
              <Text size="xs" c="dimmed">
                {m.tgId ? 'Telegram без username' : 'без Telegram'}
              </Text>
            )}
            {m.lastSeenAt && (
              <Tooltip label={formatDateTime(m.lastSeenAt, tz)}>
                <Text size="xs" c="dimmed">
                  · был(а) {formatRelative(m.lastSeenAt)}
                </Text>
              </Tooltip>
            )}
          </Group>
        </div>
      </Group>
      {canEdit ? (
        <RoleSelect member={m} />
      ) : (
        <Badge color={main ? ROLE_COLORS[main] : 'gray'} variant="light" tt="none">
          {main ? TEAM_ROLE_LABELS[main] : 'Без роли'}
        </Badge>
      )}
    </Group>
  );
}

/** Одна роль на человека: «Админ», «Кассир» или «Сканер (волонтёр)». Выбор сохраняется сразу. */
function RoleSelect({ member }: { member: StaffMember }) {
  const { session } = useSession();
  const confirm = useConfirm();
  const setRoles = useSetRoles();
  const mobile = useIsMobile();
  const viewerIsSuper = session.roles.includes('superadmin');
  const current = primaryRole(member.roles);
  const isSelf = member.userId === session.user.id;

  const options = useMemo(() => {
    const roles: Role[] = assignableRoles(viewerIsSuper);
    // Уже выданную роль (например, кассира) показываем, чтобы не потерять её молча.
    if (current && !roles.includes(current)) roles.push(current);
    return [
      ...roles.map((r) => ({ value: r, label: TEAM_ROLE_LABELS[r] })),
      { value: NO_ROLE, label: 'Убрать из команды' },
    ];
  }, [viewerIsSuper, current]);

  const change = async (value: string | null) => {
    if (!value || value === (current ?? NO_ROLE)) return;
    const roles: Role[] = value === NO_ROLE ? [] : [value as Role];
    if (roles.length === 0) {
      const ok = await confirm({
        title: 'Убрать из команды?',
        message: `${member.name} потеряет доступ к админке и сканеру - сразу, без предупреждения.`,
        confirmLabel: 'Убрать',
        danger: true,
      });
      if (!ok) return;
    }
    setRoles.mutate(
      { userId: member.userId, roles },
      { onSuccess: (m) => notifySuccess(roles.length ? `Теперь ${TEAM_ROLE_LABELS[roles[0]!]}` : 'Убрали из команды', m.name) },
    );
  };

  // Себе роль не меняем - иначе легко потерять доступ к «Команде».
  const select = (
    <Select
      data={options}
      value={current ?? NO_ROLE}
      onChange={(v) => void change(v)}
      allowDeselect={false}
      disabled={isSelf || member.permanent || setRoles.isPending}
      aria-label={`Роль: ${member.name}`}
      w={mobile ? '100%' : 230}
      maw="100%"
      comboboxProps={{ withinPortal: true }}
    />
  );
  return isSelf || member.permanent ? (
    <Tooltip label={isSelf ? 'Свою роль поменять нельзя' : 'Главного администратора снять нельзя'}>
      <div style={{ width: mobile ? '100%' : undefined }}>{select}</div>
    </Tooltip>
  ) : (
    select
  );
}

function RolesReference() {
  const { session } = useSession();
  const roles = assignableRoles(session.roles.includes('superadmin'));
  return (
    <Card>
      <Title order={4} fz="md" mb="sm">
        Какие бывают роли
      </Title>
      <Stack gap="md">
        {roles.map((r) => (
          <div key={r}>
            <Badge color={ROLE_COLORS[r]} tt="none">
              {TEAM_ROLE_LABELS[r]}
            </Badge>
            <Text size="sm" mt={4}>
              {TEAM_ROLE_HINTS[r]}
            </Text>
          </div>
        ))}
      </Stack>
    </Card>
  );
}

/** Редко нужное: карточки для волонтёров без Telegram и вход в админку по паролю. */
function Extras({
  members,
  cardsCount,
  onOpenCards,
  onSetPassword,
}: {
  members: StaffMember[];
  cardsCount: number;
  onOpenCards: () => void;
  onSetPassword: (member: StaffMember) => void;
}) {
  const [opened, { toggle }] = useDisclosure(false);
  const [memberId, setMemberId] = useState<string | null>(null);
  // Пароль нужен только тем, кто работает в админке (сканеру она не нужна).
  const adminMembers = members.filter((m) => canUseAdminWeb(m.roles));
  const selected = adminMembers.find((m) => String(m.userId) === memberId) ?? null;

  return (
    <Card padding={0}>
      <UnstyledButton onClick={toggle} px="lg" py="md" w="100%" aria-expanded={opened}>
        <Group justify="space-between" wrap="nowrap">
          <div>
            <Text fw={700}>Дополнительно</Text>
            <Text size="xs" c="dimmed">
              Карточка волонтёра и пароль для входа без Telegram
            </Text>
          </div>
          <IconChevronDown size={18} style={{ transform: opened ? 'rotate(180deg)' : undefined, transition: 'transform 150ms' }} />
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <Divider />
        <Stack gap="lg" p="lg">
          <Stack gap="xs">
            <Group gap="xs">
              <IconId size={18} />
              <Text fw={600}>Карточка волонтёра</Text>
            </Group>
            <Text size="sm" c="dimmed">
              Для волонтёров без Telegram: распечатанная карточка с QR-кодом, по которому сканер открывается прямо в браузере
              телефона.
            </Text>
            <Button variant="default" leftSection={<IconId size={16} />} onClick={onOpenCards} style={{ alignSelf: 'flex-start' }}>
              Сделать карточки{cardsCount ? ` (${cardsCount})` : ''}
            </Button>
          </Stack>
          <Divider />
          <Stack gap="xs">
            <Group gap="xs">
              <IconKey size={18} />
              <Text fw={600}>Пароль для входа без Telegram</Text>
            </Group>
            <Text size="sm" c="dimmed">
              Запасной вход в админку: логин, пароль и код из приложения-аутентификатора. Обычно не нужен - админка открывается
              из бота: «Команда» → «Админка».
            </Text>
            <Group gap="sm" align="flex-end" wrap="wrap">
              <Select
                label="Кому"
                placeholder="Выберите человека"
                data={adminMembers.map((m) => ({ value: String(m.userId), label: m.hasPassword ? `${m.name} · пароль задан` : m.name }))}
                value={memberId}
                onChange={setMemberId}
                w={300}
                maw="100%"
                nothingFoundMessage="Никого"
              />
              <Button
                variant="default"
                leftSection={<IconShieldLock size={16} />}
                disabled={!selected}
                onClick={() => selected && onSetPassword(selected)}
              >
                {selected?.hasPassword ? 'Сменить пароль' : 'Задать пароль'}
              </Button>
            </Group>
          </Stack>
        </Stack>
      </Collapse>
    </Card>
  );
}
