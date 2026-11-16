import type { Permission } from '@sof/shared';

/** Есть хотя бы одно из прав (пустой список - доступно всем). */
export function hasAny(permissions: readonly Permission[], anyOf: readonly Permission[]): boolean {
  return anyOf.length === 0 || anyOf.some((p) => permissions.includes(p));
}

/** Кто может читать `GET /api/admin/settings` (часовой пояс, название события). */
export const SETTINGS_READ: readonly Permission[] = ['dashboard:read', 'settings:write', 'payments:write'];

export const ACTIVITIES_ANY: readonly Permission[] = ['activities:own', 'activities:all'];

/** Массовые действия с оплатой - только с правом менять участников (у кассы права точечные). */
export const BULK_PAYMENT: readonly Permission[] = ['participants:write'];
