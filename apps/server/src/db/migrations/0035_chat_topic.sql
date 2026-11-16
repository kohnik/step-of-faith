-- Переписки: папка «Мерч» - писали через кнопку в разделе «Мерч» или про мерч; продавцы видят только её.
ALTER TABLE "support_threads" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_topic_ck" CHECK ("topic" is null or "topic" in ('merch'));
