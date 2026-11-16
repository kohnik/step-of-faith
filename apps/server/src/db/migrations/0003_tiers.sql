ALTER TABLE "participants" ADD COLUMN "church" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "telegram_username" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "payment_method" text;--> statement-breakpoint
CREATE INDEX "participants_tg_username_idx" ON "participants" USING btree (lower("telegram_username"));--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_tier_ck" CHECK ("participants"."tier" is null or "participants"."tier" in ('fee10', 'fee35', 'fee45', 'nofee'));--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_pay_method_ck" CHECK ("participants"."payment_method" is null or "participants"."payment_method" in ('transfer', 'cash'));