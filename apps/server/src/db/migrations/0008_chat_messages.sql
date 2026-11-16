CREATE TABLE "chat_messages" (
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
CREATE INDEX "chat_messages_at_idx" ON "chat_messages" USING btree ("at");