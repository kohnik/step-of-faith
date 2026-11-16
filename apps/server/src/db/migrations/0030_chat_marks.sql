-- Переписки: «Отметить непрочитанным» и отметка-смайлик (важно, ждёт, оплата, позже, решено).
ALTER TABLE "support_threads" ADD COLUMN "marked_unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_threads" ADD COLUMN "mark" text;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_mark_ck" CHECK ("support_threads"."mark" is null or "support_threads"."mark" in ('important', 'wait', 'money', 'later', 'done'));
