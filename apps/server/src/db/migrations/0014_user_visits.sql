CREATE TABLE "user_visits" (
	"user_id" bigint NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "user_visits_day_source_user_id_pk" PRIMARY KEY("day","source","user_id"),
	CONSTRAINT "user_visits_source_ck" CHECK ("user_visits"."source" in ('bot', 'app'))
);
--> statement-breakpoint
ALTER TABLE "user_visits" ADD CONSTRAINT "user_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;