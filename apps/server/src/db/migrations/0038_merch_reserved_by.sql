-- Бронь мерча сделал кто-то из команды (по заявке в переписке): такую бронь бот не переспрашивает «Точно заберёте?».
ALTER TABLE "merch_orders" ADD COLUMN "reserved_by" bigint;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD CONSTRAINT "merch_orders_reserved_by_users_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
