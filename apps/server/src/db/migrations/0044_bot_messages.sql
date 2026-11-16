-- Журнал сообщений бота: что, кому и когда бот отправил сам и дошло ли (раздел «Сообщения бота» в админке).
CREATE TABLE "bot_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bot_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"campaign" text,
	"ref" text,
	"outcome" text NOT NULL,
	"error" text,
	"preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bot_messages_created_idx" ON "bot_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bot_messages_campaign_idx" ON "bot_messages" USING btree ("campaign");--> statement-breakpoint
CREATE INDEX "bot_messages_user_idx" ON "bot_messages" USING btree ("user_id", "created_at");
