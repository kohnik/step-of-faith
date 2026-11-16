ALTER TABLE "participants" ALTER COLUMN "birth_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "city" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "on_site" boolean DEFAULT false NOT NULL;