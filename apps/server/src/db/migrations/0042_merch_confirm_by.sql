-- «Точно заберёте?» в настраиваемое время: до какого времени ждём ответа и снимать ли бронь без ответа.
ALTER TABLE "merch_orders" ADD COLUMN "confirm_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD COLUMN "confirm_soft" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Уже заданные вопросы (раньше ждали 2 часа).
UPDATE "merch_orders" SET "confirm_by" = "confirm_asked_at" + interval '2 hours' WHERE "confirm_asked_at" IS NOT NULL;
