-- Аккаунты, восстановленные из выгрузки участников после сбоя хостинга: Telegram id ещё не известен.
-- Когда человек сам зайдёт в бот (по нику или подтверждённому номеру), аккаунт станет обычным.
ALTER TABLE "users" ADD COLUMN "restored_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_restored_username_idx" ON "users" (lower("username")) WHERE "restored_at" IS NOT NULL AND "tg_id" IS NULL;
