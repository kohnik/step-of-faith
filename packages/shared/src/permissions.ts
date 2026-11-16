export const ROLES = ['superadmin', 'admin', 'banker', 'cashier', 'seller', 'scanner', 'organizer', 'host', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: 'Суперадмин',
  admin: 'Админ',
  banker: 'Банкир',
  cashier: 'Кассир',
  seller: 'Продавец',
  scanner: 'Сканер',
  organizer: 'Организатор',
  host: 'Ведущий',
  member: 'Участник команды',
};

export const PERMISSIONS = [
  'checkin:write', // сканер: поиск по коду, отметка, ручной поиск (минимум данных)
  'checkin:revoke', // отмена чужих отметок
  'payments:write', // чеки, отметка оплаты, в т.ч. на месте
  'receipts:delete', // удалить чек насовсем (дубли, присланное по ошибке) - только суперадмин
  'activities:own', // свои активности: создание, списки, отметка
  'activities:all', // всё расписание и все активности
  'participants:read', // вся база
  'participants:write', // редактирование участников
  'export',
  'broadcasts:send',
  'content:write', // инфо-страницы, объявления, тексты бота
  'dashboard:read',
  'staff:manage', // роли, инвайты, карточки входа, пароли
  'settings:write',
  'audit:read',
  'game:manage', // игра: команды, набор, распределение, голосование, большой экран
  'money:manage', // банкир: выдать и принять любые деньги, журнал всех денег, отмена записей с причиной
  'staff:invite_cashier', // банкир: приглашать только кассиров
  'merch:stock', // мерч: товары, цвета, размеры, количество, цены, фото
  'merch:sell', // мерч: продажа, выдача заказов, долги
  'merch:stats', // мерч: статистика продаж
  'feedback:read', // отзывы участников: читать, отмечать, выгружать
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ADMIN_PERMISSIONS: Permission[] = [
  'checkin:write',
  'checkin:revoke',
  'payments:write',
  'activities:own',
  'activities:all',
  'participants:read',
  'participants:write',
  'export',
  'broadcasts:send',
  'content:write',
  'dashboard:read',
  'settings:write', // настройки конференции: цены, тексты, сроки - ничего секретного
  'game:manage',
  // Админ умеет всё, что банкир и продавец.
  'money:manage',
  'staff:invite_cashier',
  'merch:stock',
  'merch:sell',
  'merch:stats',
  'feedback:read',
];

/**
 * «Участник команды» - только посмотреть: сводка, отзывы, статистика мерча (без имён и телефонов).
 * Это база: она есть у каждой роли, остальные роли добавляют к ней свою работу.
 */
const MEMBER_PERMISSIONS: Permission[] = ['dashboard:read', 'feedback:read', 'merch:stats'];
const withMember = (own: readonly Permission[]): Permission[] => [...new Set([...own, ...MEMBER_PERMISSIONS])];

const CASHIER_PERMISSIONS: Permission[] = ['checkin:write', 'payments:write', 'participants:read'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  superadmin: PERMISSIONS,
  admin: withMember(ADMIN_PERMISSIONS),
  // Банкир: всё, что кассир, плюс все деньги (выдача, журнал), приглашение кассиров и цифры мерча.
  banker: withMember([...CASHIER_PERMISSIONS, 'money:manage', 'staff:invite_cashier', 'merch:stats']),
  cashier: withMember(CASHIER_PERMISSIONS),
  // Продавец: мерч - склад, продажи, долги, статистика.
  seller: withMember(['merch:stock', 'merch:sell', 'merch:stats']),
  scanner: withMember(['checkin:write']),
  organizer: withMember(['activities:own']),
  host: withMember(['game:manage']),
  member: MEMBER_PERMISSIONS,
};

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role]) set.add(p);
  return PERMISSIONS.filter((p) => set.has(p));
}

export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

/** Сканерам веб-админка не нужна - они работают в сканере. */
export function canUseAdminWeb(roles: readonly Role[]): boolean {
  return roles.some((role) => role !== 'scanner');
}

export function isStaff(roles: readonly Role[]): boolean {
  return roles.length > 0;
}
