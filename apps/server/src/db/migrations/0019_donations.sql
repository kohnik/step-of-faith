ALTER TABLE "payments" ALTER COLUMN "participant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "kind" text DEFAULT 'fee' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "donor_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_ck" CHECK ("payments"."kind" in ('fee', 'donation'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fee_person_ck" CHECK ("payments"."kind" = 'donation' or "payments"."participant_id" is not null);