CREATE TABLE "counseling_bookings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "counseling_bookings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"counselor_id" bigint NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"participant_id" bigint NOT NULL,
	"booked_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counseling_bookings_slot_uq" UNIQUE("counselor_id","slot_start"),
	CONSTRAINT "counseling_bookings_participant_uq" UNIQUE("participant_id")
);
--> statement-breakpoint
CREATE TABLE "counselors" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "counselors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"place" text,
	"room_id" bigint,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"slot_minutes" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counselors_time_ck" CHECK ("counselors"."ends_at" > "counselors"."starts_at"),
	CONSTRAINT "counselors_slot_ck" CHECK ("counselors"."slot_minutes" between 5 and 240)
);
--> statement-breakpoint
ALTER TABLE "counseling_bookings" ADD CONSTRAINT "counseling_bookings_counselor_id_counselors_id_fk" FOREIGN KEY ("counselor_id") REFERENCES "public"."counselors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counseling_bookings" ADD CONSTRAINT "counseling_bookings_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counseling_bookings" ADD CONSTRAINT "counseling_bookings_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counselors" ADD CONSTRAINT "counselors_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;