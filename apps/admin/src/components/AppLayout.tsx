import {
  ActionIcon,
  AppShell,
  Avatar,
  Box,
  Badge,
  Burger,
  Group,
  Menu,
  NavLink,
  RemoveScroll,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
  type MantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { ROLE_LABELS } from '@sof/shared';
import { IconCheck, IconChevronDown, IconDeviceDesktop, IconLogout, IconMoon, IconStairsUp, IconSun } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useLocation } from 'wouter';
import { usePeopleCounts } from '../api/participants.ts';
import { useChatUnreadCount } from '../api/chat.ts';
import { useReceipts } from '../api/receipts.ts';
import { formatNumber, initials, telegramUrl } from '../lib/format.ts';
import { offsetLabel } from '../lib/tz.ts';
import { useInternalLink } from './AppLink.tsx';
import { RoleBadges } from './badges.tsx';
import { useEvent } from './EventProvider.tsx';
import { isNavActive, isNavItemVisible, NAV_SECTIONS, type NavItem } from './nav.ts';
import { useSession } from './SessionProvider.tsx';

export function ColorSchemeControl() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const item = (value: MantineColorScheme, label: string, icon: ReactNode) => ({
    value,
    label: (
      <Tooltip label={label} withinPortal>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-label={label}>
          {icon}
        </span>
      </Tooltip>
    ),
  });
  return (
    <SegmentedControl
      size="xs"
      value={colorScheme}
      onChange={(v) => setColorScheme(v as MantineColorScheme)}
      aria-label="Тема оформления"
      data={[
        item('light', 'Светлая тема', <IconSun size={15} />),
        item('dark', 'Тёмная тема', <IconMoon size={15} />),
        item('auto', 'Как в системе', <IconDeviceDesktop size={15} />),
      ]}
    />
  );
}

function UserMenu() {
  const { session, logout, loggingOut } = useSession();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const tg = telegramUrl(session.user.username);
  const themeItem = (value: MantineColorScheme, label: string, icon: ReactNode) => (
    <Menu.Item
      leftSection={icon}
      rightSection={colorScheme === value ? <IconCheck size={14} /> : undefined}
      onClick={() => setColorScheme(value)}
    >
      {label}
    </Menu.Item>
  );
  return (
    <Menu position="bottom-end" width={260}>
      <Menu.Target>
        <UnstyledButton aria-label="Профиль">
          <Group gap={8} wrap="nowrap">
            <Avatar color="indigo" radius="xl" size={34}>
              {initials(session.user.name)}
            </Avatar>
            <Stack gap={0} visibleFrom="md" style={{ maxWidth: 200 }}>
              <Text size="sm" fw={600} truncate>
                {session.user.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {session.roles.map((r) => ROLE_LABELS[r]).join(', ') || 'без роли'}
              </Text>
            </Stack>
            <IconChevronDown size={14} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Вы вошли как</Menu.Label>
        <Stack gap={6} px="sm" pb="xs">
          <Text size="sm" fw={600}>
            {session.user.name}
          </Text>
          {session.user.username && (
            <Text size="xs" c="dimmed" component="a" href={tg ?? undefined} target="_blank" rel="noopener noreferrer">
              @{session.user.username}
            </Text>
          )}
          <RoleBadges roles={session.roles} size="xs" />
        </Stack>
        <Menu.Divider />
        <Menu.Label>Тема</Menu.Label>
        {themeItem('light', 'Светлая', <IconSun size={16} />)}
        {themeItem('dark', 'Тёмная', <IconMoon size={16} />)}
        {themeItem('auto', 'Как в системе', <IconDeviceDesktop size={16} />)}
        <Menu.Divider />
        <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={() => void logout()} disabled={loggingOut}>
          Выйти
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function NavItemLink({
  item,
  active,
  badge,
  count,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  /** Живой счётчик людей справа (показываем и ноль). */
  count?: number;
  onNavigate: () => void;
}) {
  const link = useInternalLink(item.href, onNavigate);
  const Icon = item.icon;
  return (
    <NavLink
      className="sof-nav-link"
      href={link.href}
      onClick={link.onClick}
      active={active}
      label={item.label}
      leftSection={<Icon size={18} stroke={1.7} />}
      rightSection={
        badge ? (
          <Badge size="sm" color="yellow" variant="filled" circle={badge < 10}>
            {badge > 99 ? '99+' : badge}
          </Badge>
        ) : count !== undefined ? (
          <Badge size="sm" color={item.badge === 'confirmed' ? 'teal' : 'gray'} variant="light" className="sof-tabular">
            {formatNumber(count)}
          </Badge>
        ) : undefined
      }
      variant="light"
      aria-current={active ? 'page' : undefined}
    />
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [opened, { toggle, close }] = useDisclosure(false);
  // На телефоне меню открывается поверх страницы: пока оно открыто, страница под ним не прокручивается.
  const mobile = useMediaQuery('(max-width: 48em)') ?? false;
  const lockScroll = opened && mobile;
  const { can, paymentsEnabled, logout, loggingOut } = useSession();
  const { eventName, tz } = useEvent();
  const [location] = useLocation();
  // Счётчик чеков в меню - только когда приём оплаты включён.
  const pending = useReceipts('pending', paymentsEnabled && can('payments:write'));
  const pendingCount = pending.data?.length ?? 0;
  // Сколько зарегистрировано и сколько пришло - обновляется каждые 10 секунд, даже когда меню свёрнуто.
  const counts = usePeopleCounts(can('participants:read'));
  // Переписки с непрочитанными сообщениями участников - счётчик, как у чеков.
  const unreadChats = useChatUnreadCount(can('content:write') || can('merch:sell'));

  const access = { can, paymentsEnabled };
  const sections = NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => isNavItemVisible(i, access)) })).filter(
    (s) => s.items.length > 0,
  );

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 264, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={{ base: 'md', md: 'xl' }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Открыть меню" />
            <div className="sof-brand-mark" aria-hidden>
              <IconStairsUp size={20} />
            </div>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={800} lh={1.15} truncate>
                {eventName}
              </Text>
              <Text size="xs" c="dimmed" lh={1.15}>
                Админка
              </Text>
            </Stack>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Box visibleFrom="sm">
              <ColorSchemeControl />
            </Box>
            <UserMenu />
            <Tooltip label="Выйти">
              <ActionIcon variant="default" size="lg" onClick={() => void logout()} loading={loggingOut} aria-label="Выйти" visibleFrom="xs">
                <IconLogout size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm" aria-label="Разделы">
        <RemoveScroll enabled={lockScroll} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <AppShell.Section grow component={ScrollArea} type="scroll" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
          <Stack gap="sm">
            {sections.map((section) => (
              <div key={section.title}>
                <div className="sof-nav-section">{section.title}</div>
                {section.items.map((item) => (
                  <NavItemLink
                    key={item.href}
                    item={item}
                    active={isNavActive(item, location)}
                    badge={
                      item.badge === 'pendingReceipts'
                        ? pendingCount
                        : item.badge === 'unreadChats'
                          ? unreadChats.data?.unread
                          : undefined
                    }
                    count={
                      item.badge === 'participants'
                        ? counts.data?.participants
                        : item.badge === 'confirmed'
                          ? counts.data?.confirmed
                          : undefined
                    }
                    onNavigate={close}
                  />
                ))}
              </div>
            ))}
          </Stack>
        </AppShell.Section>
        <AppShell.Section pt="sm">
          <Text size="xs" c="dimmed" ta="center">
            Время везде - по часам конференции: {tz} ({offsetLabel(tz)})
          </Text>
        </AppShell.Section>
        </RemoveScroll>
      </AppShell.Navbar>

      <AppShell.Main className="sof-main">
        <div className="sof-page">{children}</div>
      </AppShell.Main>
    </AppShell>
  );
}
