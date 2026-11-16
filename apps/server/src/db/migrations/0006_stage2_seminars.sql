CREATE TABLE "rooms" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rooms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"note" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_capacity_ck" CHECK ("rooms"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "seminar_block_rooms" (
	"block_id" bigint NOT NULL,
	"room_id" bigint NOT NULL,
	CONSTRAINT "seminar_block_rooms_block_id_room_id_pk" PRIMARY KEY("block_id","room_id")
);
--> statement-breakpoint
CREATE TABLE "seminar_blocks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seminar_blocks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"registration_open" boolean DEFAULT false NOT NULL,
	"rooms_published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seminar_blocks_time_ck" CHECK ("seminar_blocks"."ends_at" >= "seminar_blocks"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "room_id" bigint;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "block_id" bigint;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "planned_room_id" bigint;--> statement-breakpoint
ALTER TABLE "seminar_block_rooms" ADD CONSTRAINT "seminar_block_rooms_block_id_seminar_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."seminar_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seminar_block_rooms" ADD CONSTRAINT "seminar_block_rooms_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_name_uq" ON "rooms" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_block_id_seminar_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."seminar_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_planned_room_id_rooms_id_fk" FOREIGN KEY ("planned_room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_block_idx" ON "activities" USING btree ("block_id");--> statement-breakpoint
INSERT INTO "rooms" ("name", "capacity", "sort") VALUES
  ('Основной зал церкви', 1000, 1),
  ('324 ауд. ТИ', 170, 2),
  ('Малый зал церкви', 120, 3),
  ('Столовая ТИ', 80, 4),
  ('325 ауд. ТИ', 70, 5),
  ('220 ауд. ТИ', 64, 6),
  ('221 ауд. ТИ', 60, 7)
ON CONFLICT DO NOTHING;
