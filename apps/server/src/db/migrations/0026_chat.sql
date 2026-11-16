-- Переписка с участниками вместо «вопрос + один ответ»: вся история сообщений, админ может написать
-- первым и прислать картинку. Прочитанное - по номеру последнего прочитанного сообщения с каждой стороны.
CREATE TABLE "support_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"from_staff" boolean NOT NULL,
	"author_id" bigint,
	"text" text,
	"photo" text,
	"delivery" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_body_ck" CHECK ("support_messages"."text" is not null or "support_messages"."photo" is not null),
	CONSTRAINT "support_messages_delivery_ck" CHECK ("support_messages"."delivery" is null or "support_messages"."delivery" in ('sent', 'blocked', 'unreachable', 'no_telegram'))
);
--> statement-breakpoint
CREATE TABLE "support_threads" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"staff_read_id" bigint DEFAULT 0 NOT NULL,
	"user_read_id" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_messages_user_idx" ON "support_messages" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_checked_at" timestamp with time zone;--> statement-breakpoint
-- Старые вопросы и ответы - в историю, по времени. Таблица questions остаётся архивом.
INSERT INTO "support_messages" ("user_id", "from_staff", "author_id", "text", "delivery", "created_at")
SELECT x."user_id", x."from_staff", x."author_id", x."text", x."delivery", x."at"
  FROM (
    SELECT q."user_id", false AS "from_staff", NULL::bigint AS "author_id", q."text", NULL::text AS "delivery", q."created_at" AS "at", q."id" AS "qid", 0 AS "k"
      FROM "questions" q
    UNION ALL
    SELECT q."user_id", true, q."answered_by", q."answer", 'sent', q."answered_at", q."id", 1
      FROM "questions" q
     WHERE q."answer" IS NOT NULL AND q."answered_at" IS NOT NULL
  ) x
 ORDER BY x."at", x."qid", x."k";--> statement-breakpoint
-- Прочитано командой всё до последнего ответа (неотвеченное после него - непрочитанное); участником - всё.
INSERT INTO "support_threads" ("user_id", "staff_read_id", "user_read_id")
SELECT "user_id", coalesce(max("id") FILTER (WHERE "from_staff"), 0), max("id")
  FROM "support_messages"
 GROUP BY "user_id";--> statement-breakpoint
-- Живые обновления: новое сообщение или отметка доставки - самому участнику.
CREATE OR REPLACE FUNCTION sof_support_messages_trg()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sof_notify('questions', ARRAY[NEW.user_id]);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER sof_support_messages_notify AFTER INSERT OR UPDATE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION sof_support_messages_trg();
