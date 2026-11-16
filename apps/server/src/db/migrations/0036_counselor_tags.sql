-- Душепопечение: кого принимает служитель (все, только девушки, только парни - проверяется при записи) и свои метки (просто подпись).
ALTER TABLE "counselors" ADD COLUMN "audience" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "counselors" ADD CONSTRAINT "counselors_audience_ck" CHECK ("audience" in ('all', 'f', 'm'));--> statement-breakpoint
ALTER TABLE "counselors" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;
