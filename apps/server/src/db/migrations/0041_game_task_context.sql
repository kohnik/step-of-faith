-- Задание делится на «Контекст» (ситуация, в которой оказалась церковь) и само «Задание».
ALTER TABLE "game_tasks" ADD COLUMN "context" text DEFAULT '' NOT NULL;
