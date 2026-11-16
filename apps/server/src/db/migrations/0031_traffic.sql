-- Нагрузка: сколько запросов пришло в бота (сообщения и кнопки) и в Mini App - по часам.
CREATE TABLE "traffic_hourly" (
	"hour" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "traffic_hourly_pk" PRIMARY KEY("hour","source"),
	CONSTRAINT "traffic_hourly_source_ck" CHECK ("traffic_hourly"."source" in ('bot', 'app'))
);
