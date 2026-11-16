-- Семинары по голосованию: темы общие для всех потоков, участник выбирает темы, а распределение
-- раскладывает темы по потокам и залам и людей - по сеансам. Сеанс - мероприятие с block_id и topic_id.
CREATE TABLE "seminar_topics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seminar_topics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"host" text,
	"description" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seminar_votes" (
	"participant_id" bigint NOT NULL,
	"topic_id" bigint NOT NULL,
	"user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seminar_votes_participant_id_topic_id_pk" PRIMARY KEY("participant_id","topic_id")
);
--> statement-breakpoint
ALTER TABLE "seminar_votes" ADD CONSTRAINT "seminar_votes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seminar_votes" ADD CONSTRAINT "seminar_votes_topic_id_seminar_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."seminar_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seminar_votes" ADD CONSTRAINT "seminar_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seminar_votes_topic_idx" ON "seminar_votes" USING btree ("topic_id");--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "topic_id" bigint;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_topic_id_seminar_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."seminar_topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_topic_idx" ON "activities" USING btree ("topic_id");--> statement-breakpoint
-- Запись на сеанс поставило распределение (true) или админ вручную (false): «Распределить заново» трогает только первые.
ALTER TABLE "activity_registrations" ADD COLUMN "planned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Темы из уже заведённых блоков: одна тема на название, порядок - как темы заводили.
INSERT INTO "seminar_topics" ("title", "host", "description", "sort")
SELECT DISTINCT ON (lower(btrim(a."title"))) btrim(a."title"), a."host", a."description", 0
  FROM "activities" a
 WHERE a."block_id" IS NOT NULL AND a."status" <> 'cancelled'
 ORDER BY lower(btrim(a."title")), a."id";--> statement-breakpoint
UPDATE "seminar_topics" t SET "sort" = s.rn
  FROM (SELECT t2."id", row_number() OVER (ORDER BY min(a."id")) AS rn
          FROM "seminar_topics" t2
          JOIN "activities" a ON lower(btrim(a."title")) = lower(t2."title") AND a."block_id" IS NOT NULL
         GROUP BY t2."id") s
 WHERE s."id" = t."id";--> statement-breakpoint
UPDATE "activities" a SET "topic_id" = t."id"
  FROM "seminar_topics" t
 WHERE a."block_id" IS NOT NULL AND lower(btrim(a."title")) = lower(t."title");--> statement-breakpoint
-- Выбор тем включает админ, когда потоки и темы готовы: по-старому открытая запись не открывает выбор сама.
UPDATE "seminar_blocks" SET "registration_open" = false;--> statement-breakpoint
-- Живые обновления: темы - всем, голос - только семье участника.
CREATE OR REPLACE FUNCTION sof_seminar_votes_trg()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pid bigint;
  users bigint[];
BEGIN
  pid := CASE WHEN TG_OP = 'DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  SELECT ARRAY[owner_user_id, holder_user_id] INTO users FROM participants WHERE id = pid;
  IF users IS NOT NULL THEN
    PERFORM sof_notify('seminars', users);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER sof_seminar_votes_notify AFTER INSERT OR UPDATE OR DELETE ON seminar_votes
  FOR EACH ROW EXECUTE FUNCTION sof_seminar_votes_trg();
--> statement-breakpoint
CREATE TRIGGER sof_seminar_topics_notify AFTER INSERT OR UPDATE OR DELETE ON seminar_topics
  FOR EACH STATEMENT EXECUTE FUNCTION sof_broadcast_trg('seminars');
