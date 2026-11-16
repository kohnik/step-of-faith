-- Нагрузка по людям: сколько запросов от каждого в бота и в Mini App - по часам (видно, кто «флудит»).
CREATE TABLE "traffic_users" (
	"hour" timestamp with time zone NOT NULL,
	"user_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"source" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "traffic_users_pk" PRIMARY KEY("hour","user_id","source"),
	CONSTRAINT "traffic_users_source_ck" CHECK ("traffic_users"."source" in ('bot', 'app'))
);
