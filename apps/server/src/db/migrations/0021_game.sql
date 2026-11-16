CREATE TABLE "game_players" (
	"participant_id" bigint PRIMARY KEY NOT NULL,
	"answer" text NOT NULL,
	"team_id" bigint,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_at" timestamp with time zone,
	CONSTRAINT "game_players_answer_ck" CHECK ("game_players"."answer" in ('yes', 'no'))
);
--> statement-breakpoint
CREATE TABLE "game_rounds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_rounds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" bigint,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"opened_by" bigint,
	CONSTRAINT "game_rounds_status_ck" CHECK ("game_rounds"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "game_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	"signup_open" boolean DEFAULT false NOT NULL,
	"distributed_at" timestamp with time zone,
	"design_locked" boolean DEFAULT false NOT NULL,
	"results_shown" boolean DEFAULT false NOT NULL,
	"screen_token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_teams" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_teams_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sort" integer DEFAULT 0 NOT NULL,
	"name" text,
	"country_code" text,
	"flag" text,
	"color" text NOT NULL,
	"captain_id" bigint,
	"proposal" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_votes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_votes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"round_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"team_id" bigint NOT NULL,
	"points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_votes_uq" UNIQUE("round_id","user_id","team_id"),
	CONSTRAINT "game_votes_points_ck" CHECK ("game_votes"."points" > 0)
);
--> statement-breakpoint
ALTER TABLE "staff_roles" DROP CONSTRAINT "staff_roles_role_ck";--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_team_id_game_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."game_teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_team_id_game_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."game_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_teams" ADD CONSTRAINT "game_teams_captain_id_participants_id_fk" FOREIGN KEY ("captain_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_round_id_game_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."game_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_team_id_game_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."game_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_players_team_idx" ON "game_players" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_rounds_one_open_uq" ON "game_rounds" USING btree ("status") WHERE "game_rounds"."status" = 'open';--> statement-breakpoint
CREATE INDEX "game_teams_sort_idx" ON "game_teams" USING btree ("sort");--> statement-breakpoint
CREATE INDEX "game_votes_team_idx" ON "game_votes" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_role_ck" CHECK ("staff_roles"."role" in ('superadmin', 'admin', 'cashier', 'scanner', 'organizer', 'host'));--> statement-breakpoint
-- Живые обновления «Игры» в мини-апке. Голоса (game_votes) не шлём: их сотни в минуту - экран и пульт опрашивают сами.
CREATE TRIGGER sof_game_state_notify AFTER INSERT OR UPDATE OR DELETE ON game_state
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('game');--> statement-breakpoint
CREATE TRIGGER sof_game_teams_notify AFTER INSERT OR UPDATE OR DELETE ON game_teams
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('game');--> statement-breakpoint
CREATE TRIGGER sof_game_players_notify AFTER INSERT OR UPDATE OR DELETE ON game_players
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('game');--> statement-breakpoint
CREATE TRIGGER sof_game_rounds_notify AFTER INSERT OR UPDATE OR DELETE ON game_rounds
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('game');
