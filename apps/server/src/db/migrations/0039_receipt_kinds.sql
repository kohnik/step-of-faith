-- Виды чеков: взнос (как раньше), пожертвование и мерч (к брони). Копия файла чека у нас на сервере,
-- а не только в Telegram; чек из приложения - только у нас (без файла Telegram).
ALTER TABLE "payment_receipts" ADD COLUMN "kind" text DEFAULT 'fee' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_kind_ck" CHECK ("payment_receipts"."kind" in ('fee', 'donation', 'merch'));--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD COLUMN "merch_order_id" bigint;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_merch_order_id_merch_orders_id_fk" FOREIGN KEY ("merch_order_id") REFERENCES "public"."merch_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD COLUMN "stored_file" text;--> statement-breakpoint
ALTER TABLE "payment_receipts" ALTER COLUMN "file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_receipts" ALTER COLUMN "file_unique_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "awaiting_receipt_for" text;
