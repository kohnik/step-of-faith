-- Заявка на бронь мерча в переписке: какие вещи просят (остатки не трогает) и бронь, которую по ней сделал продавец.
ALTER TABLE "support_messages" ADD COLUMN "merch_items" jsonb;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "merch_order_id" bigint;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_merch_order_id_merch_orders_id_fk" FOREIGN KEY ("merch_order_id") REFERENCES "public"."merch_orders"("id") ON DELETE set null ON UPDATE no action;
