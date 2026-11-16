-- Отзывы о конференции из приложения: свидетельство, отзыв или пожелание.
CREATE TABLE "feedback" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"signature" text,
	"starred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_category_ck" CHECK ("category" in ('testimony', 'review', 'suggestion'))
);
--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "feedback" USING btree ("user_id");
