-- Роль «Участник команды»: только посмотреть сводку, отзывы и статистику мерча.
ALTER TABLE "staff_roles" DROP CONSTRAINT "staff_roles_role_ck";--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_role_ck" CHECK ("staff_roles"."role" in ('superadmin', 'admin', 'banker', 'cashier', 'seller', 'scanner', 'organizer', 'host', 'member'));
