-- Списки участников: команда собирает людей вручную (например, «Россияне») и шлёт им рассылки.
CREATE TABLE "participant_lists" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "participant_lists_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant_list_members" (
	"list_id" bigint NOT NULL,
	"participant_id" bigint NOT NULL,
	"added_by" bigint,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_list_members_list_id_participant_id_pk" PRIMARY KEY("list_id","participant_id")
);
--> statement-breakpoint
ALTER TABLE "participant_lists" ADD CONSTRAINT "participant_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_list_members" ADD CONSTRAINT "participant_list_members_list_id_participant_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."participant_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_list_members" ADD CONSTRAINT "participant_list_members_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_list_members" ADD CONSTRAINT "participant_list_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "participant_list_members_participant_idx" ON "participant_list_members" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_lists_name_uq" ON "participant_lists" USING btree (lower("name"));
