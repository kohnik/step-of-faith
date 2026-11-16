CREATE TABLE "activities" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"host" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"registration_mode" text DEFAULT 'none' NOT NULL,
	"capacity" integer,
	"waitlist_enabled" boolean DEFAULT true NOT NULL,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone,
	"min_age" integer,
	"max_age" integer,
	"status" text DEFAULT 'published' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_mode_ck" CHECK ("activities"."registration_mode" in ('none', 'required')),
	CONSTRAINT "activities_status_ck" CHECK ("activities"."status" in ('draft', 'published', 'cancelled')),
	CONSTRAINT "activities_capacity_ck" CHECK ("activities"."capacity" is null or "activities"."capacity" > 0),
	CONSTRAINT "activities_time_ck" CHECK ("activities"."ends_at" >= "activities"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "activity_interest" (
	"activity_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_interest_activity_id_user_id_pk" PRIMARY KEY("activity_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "activity_registrations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_registrations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"activity_id" bigint NOT NULL,
	"participant_id" bigint NOT NULL,
	"status" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_by" bigint,
	CONSTRAINT "activity_registrations_uq" UNIQUE("activity_id","participant_id"),
	CONSTRAINT "activity_registrations_status_ck" CHECK ("activity_registrations"."status" in ('registered', 'waitlist', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "admin_credentials" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_credentials_login_unique" UNIQUE("login")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "announcements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" bigint,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_deliveries" (
	"broadcast_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "broadcast_deliveries_broadcast_id_user_id_pk" PRIMARY KEY("broadcast_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "broadcasts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"text" text NOT NULL,
	"segment" jsonb NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"scheduled_at" timestamp with time zone,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"total" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "broadcasts_status_ck" CHECK ("broadcasts"."status" in ('scheduled', 'sending', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "check_ins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"checkpoint_id" integer NOT NULL,
	"participant_id" bigint NOT NULL,
	"client_event_id" uuid NOT NULL,
	"scanned_by" bigint NOT NULL,
	"device_id" text,
	"client_ts" timestamp with time zone,
	"method" text DEFAULT 'scan' NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" bigint,
	CONSTRAINT "check_ins_client_event_id_unique" UNIQUE("client_event_id")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoints_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"activity_id" bigint,
	"day" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"counts_in_stats" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_kind_ck" CHECK ("checkpoints"."kind" in ('entrance', 'activity', 'meal', 'training'))
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "consents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"participant_id" bigint NOT NULL,
	"given_by_user_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"document_version" text NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "info_pages" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint
);
--> statement-breakpoint
CREATE TABLE "one_time_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_id" bigint,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_by" bigint,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "one_time_tokens_purpose_ck" CHECK ("one_time_tokens"."purpose" in ('staff_invite', 'ticket_claim', 'admin_login', 'scanner_card'))
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "participants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_user_id" bigint NOT NULL,
	"holder_user_id" bigint,
	"last_name" text NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"birth_date" date NOT NULL,
	"gender" text NOT NULL,
	"city" text NOT NULL,
	"phone" text,
	"relation" text DEFAULT 'self' NOT NULL,
	"category" text DEFAULT 'participant' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"person_key" text NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"amount_due" numeric(10, 2),
	"amount_paid" numeric(10, 2) DEFAULT '0' NOT NULL,
	"paid_at" timestamp with time zone,
	"payment_note" text,
	"arrived_at" timestamp with time zone,
	"registered_by_staff" boolean DEFAULT false NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_gender_ck" CHECK ("participants"."gender" in ('m', 'f')),
	CONSTRAINT "participants_status_ck" CHECK ("participants"."status" in ('active', 'cancelled')),
	CONSTRAINT "participants_category_ck" CHECK ("participants"."category" in ('participant', 'child', 'volunteer', 'speaker', 'organizer', 'guest')),
	CONSTRAINT "participants_payment_ck" CHECK ("participants"."payment_status" in ('unpaid', 'pending', 'paid', 'partial', 'exempt'))
);
--> statement-breakpoint
CREATE TABLE "payment_receipts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"participant_ids" bigint[] NOT NULL,
	"file_id" text NOT NULL,
	"file_unique_id" text NOT NULL,
	"file_kind" text NOT NULL,
	"mime_type" text,
	"comment" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_receipts_file_uq" UNIQUE("user_id","file_unique_id"),
	CONSTRAINT "payment_receipts_status_ck" CHECK ("payment_receipts"."status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "registration_requests" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"payload_sha256" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scan_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_event_id" uuid,
	"checkpoint_id" integer,
	"raw_code" text,
	"participant_id" bigint,
	"outcome" text NOT NULL,
	"staff_user_id" bigint,
	"device_id" text,
	"client_ts" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint
);
--> statement-breakpoint
CREATE TABLE "staff_roles" (
	"user_id" bigint NOT NULL,
	"role" text NOT NULL,
	"granted_by" bigint,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_roles_user_id_role_pk" PRIMARY KEY("user_id","role"),
	CONSTRAINT "staff_roles_role_ck" CHECK ("staff_roles"."role" in ('superadmin', 'admin', 'cashier', 'scanner', 'organizer'))
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "staff_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_hash" text NOT NULL,
	"user_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	CONSTRAINT "staff_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"participant_id" bigint NOT NULL,
	"code" text NOT NULL,
	"web_token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_reason" text,
	"image_file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "tickets_code_unique" UNIQUE("code"),
	CONSTRAINT "tickets_web_token_unique" UNIQUE("web_token"),
	CONSTRAINT "tickets_status_ck" CHECK ("tickets"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tg_id" bigint,
	"username" text,
	"first_name" text,
	"last_name" text,
	"display_name" text,
	"language_code" text,
	"phone" text,
	"payment_ref" text NOT NULL,
	"allows_write" boolean DEFAULT false NOT NULL,
	"bot_blocked" boolean DEFAULT false NOT NULL,
	"awaiting_receipt_until" timestamp with time zone,
	"last_tickets_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_tg_id_unique" UNIQUE("tg_id"),
	CONSTRAINT "users_payment_ref_unique" UNIQUE("payment_ref")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_interest" ADD CONSTRAINT "activity_interest_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_interest" ADD CONSTRAINT "activity_interest_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_registrations" ADD CONSTRAINT "activity_registrations_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_registrations" ADD CONSTRAINT "activity_registrations_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_registrations" ADD CONSTRAINT "activity_registrations_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD CONSTRAINT "admin_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_checkpoint_id_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_given_by_user_id_users_id_fk" FOREIGN KEY ("given_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "info_pages" ADD CONSTRAINT "info_pages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_last_used_by_users_id_fk" FOREIGN KEY ("last_used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_requests" ADD CONSTRAINT "registration_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_log" ADD CONSTRAINT "scan_log_checkpoint_id_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_log" ADD CONSTRAINT "scan_log_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_log" ADD CONSTRAINT "scan_log_staff_user_id_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_starts_idx" ON "activities" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "activity_registrations_queue_idx" ON "activity_registrations" USING btree ("activity_id","status","queued_at","id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "broadcast_deliveries_pending_idx" ON "broadcast_deliveries" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "check_ins_once" ON "check_ins" USING btree ("checkpoint_id","participant_id") WHERE "check_ins"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "check_ins_participant_idx" ON "check_ins" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "check_ins_created_idx" ON "check_ins" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_person_uq" ON "participants" USING btree ("owner_user_id","person_key") WHERE "participants"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "participants_owner_idx" ON "participants" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "participants_holder_idx" ON "participants" USING btree ("holder_user_id");--> statement-breakpoint
CREATE INDEX "participants_person_key_idx" ON "participants" USING btree ("person_key");--> statement-breakpoint
CREATE INDEX "payment_receipts_status_idx" ON "payment_receipts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scan_log_created_idx" ON "scan_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scan_log_outcome_idx" ON "scan_log" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "staff_sessions_user_idx" ON "staff_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_one_active_uq" ON "tickets" USING btree ("participant_id") WHERE "tickets"."status" = 'active';