import type { Permission } from '@sof/shared';
import {
  IconArticle,
  IconBuildingBank,
  IconDoor,
  IconHeartHandshake,
  IconSchool,
  IconMessageQuestion,
  IconMessageHeart,
  IconCalendarEvent,
  IconCopy,
  IconDoorEnter,
  IconHistory,
  IconLayoutDashboard,
  IconListDetails,
  IconReceipt2,
  IconSettings,
  IconShirt,
  IconWorld,
  IconSpeakerphone,
  IconRobot,
  IconUserCheck,
  IconUsers,
  IconUsersGroup,
  type TablerIcon,
} from '@tabler/icons-react';
import { ACTIVITIES_ANY, SETTINGS_READ } from '../lib/permissions.ts';

export interface NavItem {
  href: string;
  label: string;
  icon: TablerIcon;
  /** Нужно хотя бы одно из прав. */
  anyOf: readonly Permission[];
  /** Активна только при точном совпадении адреса. */
  exact?: boolean;
  badge?: 'pendingReceipts' | 'participants' | 'confirmed' | 'unreadChats';
  /** Раздел виден, только когда включена эта возможность (оплата сейчас выключена). */
  feature?: 'payments';
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Обзор',
    items: [{ href: '/', label: 'Сводка', icon: IconLayoutDashboard, anyOf: ['dashboard:read'], exact: true }],
  },
  {
    title: 'Люди',
    items: [
      { href: '/participants', label: 'Участники', icon: IconUsers, anyOf: ['participants:read'], exact: true, badge: 'participants' },
      { href: '/participants/lists', label: 'Списки', icon: IconListDetails, anyOf: ['participants:read'] },
      {
        href: '/participants/confirmed',
        label: 'Подтверждённые',
        icon: IconUserCheck,
        anyOf: ['participants:read'],
        badge: 'confirmed',
      },
      { href: '/participants/duplicates', label: 'Возможные дубли', icon: IconCopy, anyOf: ['participants:read'] },
      {
        href: '/payments',
        label: 'Оплаты и чеки',
        icon: IconReceipt2,
        anyOf: ['payments:write'],
        badge: 'pendingReceipts',
        feature: 'payments',
      },
      { href: '/money', label: 'Деньги', icon: IconBuildingBank, anyOf: ['money:manage'] },
      { href: '/checkin', label: 'Вход и отметки', icon: IconDoorEnter, anyOf: ['participants:read'] },
    ],
  },
  {
    title: 'Программа',
    items: [
      { href: '/activities', label: 'Расписание', icon: IconCalendarEvent, anyOf: ACTIVITIES_ANY },
      { href: '/seminars', label: 'Семинары', icon: IconSchool, anyOf: ['activities:all'] },
      { href: '/counseling', label: 'Душепопечение', icon: IconHeartHandshake, anyOf: ['activities:all'] },
      { href: '/rooms', label: 'Залы', icon: IconDoor, anyOf: ACTIVITIES_ANY },
      { href: '/game', label: 'Игра «Церкви»', icon: IconWorld, anyOf: ['game:manage'] },
    ],
  },
  {
    title: 'Общение',
    items: [
      { href: '/broadcasts', label: 'Рассылки', icon: IconSpeakerphone, anyOf: ['broadcasts:send'] },
      // Кому что ушло - с именами и телефонами недоступных: только тем, кто делает рассылки.
      { href: '/bot-log', label: 'Сообщения бота', icon: IconRobot, anyOf: ['broadcasts:send'] },
      { href: '/messages', label: 'Сообщения', icon: IconMessageQuestion, anyOf: ['content:write', 'merch:sell'], badge: 'unreadChats' },
      { href: '/feedback', label: 'Отзывы', icon: IconMessageHeart, anyOf: ['feedback:read'] },
      { href: '/content', label: 'Страницы и объявления', icon: IconArticle, anyOf: ['content:write'] },
      { href: '/merch', label: 'Мерч', icon: IconShirt, anyOf: ['merch:stock', 'merch:sell', 'merch:stats'] },
    ],
  },
  {
    title: 'Управление',
    items: [
      { href: '/staff', label: 'Команда', icon: IconUsersGroup, anyOf: ['staff:manage', 'staff:invite_cashier'] },
      { href: '/settings', label: 'Настройки', icon: IconSettings, anyOf: SETTINGS_READ },
      { href: '/audit', label: 'История изменений', icon: IconHistory, anyOf: ['audit:read'] },
    ],
  },
];

export interface NavAccess {
  can: (...anyOf: Permission[]) => boolean;
  paymentsEnabled: boolean;
}

export function isNavItemVisible(item: NavItem, access: NavAccess): boolean {
  if (item.feature === 'payments' && !access.paymentsEnabled) return false;
  return access.can(...item.anyOf);
}

export function isNavActive(item: NavItem, location: string): boolean {
  if (item.exact) return location === item.href;
  return location === item.href || location.startsWith(`${item.href}/`);
}

/**
 * Куда вести с «/», если сводка недоступна. Настройки «только почитать» стартовой
 * страницей не делаем - это сбивает с толку (например, кассира при выключенной оплате).
 */
export function firstAllowedHref(access: NavAccess): string | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.href === '/settings' && !access.can('settings:write')) continue;
      if (isNavItemVisible(item, access)) return item.href;
    }
  }
  return null;
}
