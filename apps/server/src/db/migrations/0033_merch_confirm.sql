-- Мерч: в среду-пятницу перед конференцией спрашиваем «точно заберёте?»; не ответили за 2 часа - бронь снимается.
ALTER TABLE "merch_orders" ADD COLUMN "confirm_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merch_orders" ADD COLUMN "confirmed_at" timestamp with time zone;
