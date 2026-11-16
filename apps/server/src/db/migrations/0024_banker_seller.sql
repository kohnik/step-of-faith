-- Роли «Банкир» и «Продавец».
ALTER TABLE "staff_roles" DROP CONSTRAINT "staff_roles_role_ck";--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_role_ck" CHECK ("staff_roles"."role" in ('superadmin', 'admin', 'banker', 'cashier', 'seller', 'scanner', 'organizer', 'host'));--> statement-breakpoint
-- Журнал денег: кроме взносов и пожертвований - оплаты мерча, прочий приход и выдачи (расход).
ALTER TABLE "payments" DROP CONSTRAINT "payments_kind_ck";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_ck" CHECK ("payments"."kind" in ('fee', 'donation', 'merch', 'income', 'payout'));--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_source_ck";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_ck" CHECK ("payments"."source" in ('desk', 'receipt', 'manual', 'money', 'merch'));--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_fee_person_ck";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fee_person_ck" CHECK ("payments"."kind" <> 'fee' or "payments"."participant_id" is not null);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "merch_order_id" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "undo_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merch_order_id_merch_orders_id_fk" FOREIGN KEY ("merch_order_id") REFERENCES "public"."merch_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_merch_order_idx" ON "payments" USING btree ("merch_order_id");--> statement-breakpoint
-- Мерч в долг: сколько внесено, кто покупатель.
ALTER TABLE "merch_orders" DROP CONSTRAINT "merch_orders_status_ck";--> statement-breakpoint
ALTER TABLE "merch_orders" ADD CONSTRAINT "merch_orders_status_ck" CHECK ("merch_orders"."status" in ('reserved', 'paid', 'issued', 'owed', 'cancelled', 'expired'));--> statement-breakpoint
ALTER TABLE "merch_orders" ADD COLUMN "paid_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD COLUMN "buyer_participant_id" bigint;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD COLUMN "buyer_phone" text;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD CONSTRAINT "merch_orders_buyer_participant_id_participants_id_fk" FOREIGN KEY ("buyer_participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Уже оплаченные заказы: внесена вся сумма, деньги - в общий журнал.
UPDATE "merch_orders" SET "paid_amount" = "total" WHERE "status" in ('paid', 'issued');--> statement-breakpoint
INSERT INTO "payments" ("kind", "amount", "method", "source", "merch_order_id", "accepted_by", "created_at", "comment")
SELECT 'merch', o."total", coalesce(o."payment_method", 'cash'), 'merch', o."id", o."paid_by", coalesce(o."paid_at", o."issued_at", o."created_at"), 'Заказ ' || o."code"
  FROM "merch_orders" o
 WHERE o."status" in ('paid', 'issued') AND o."total" > 0;
