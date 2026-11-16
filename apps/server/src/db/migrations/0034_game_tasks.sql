-- Игра: задания командам (пишут заранее; у задания может быть страна), «Начать игру», «Показать задания», кто на сцене.
CREATE TABLE "game_tasks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"country_code" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_teams" ADD COLUMN "task_id" bigint REFERENCES "game_tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "game_teams_task_uq" ON "game_teams" USING btree ("task_id") WHERE "game_teams"."task_id" is not null;--> statement-breakpoint
ALTER TABLE "game_state" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_state" ADD COLUMN "tasks_revealed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_state" ADD COLUMN "stage_team_id" bigint REFERENCES "game_teams"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE TRIGGER sof_game_tasks_notify AFTER INSERT OR UPDATE OR DELETE ON game_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('game');
