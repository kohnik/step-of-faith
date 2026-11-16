-- Питание в расписании: тем, у кого есть завтрак, обед или ужин, - личное напоминание за 15 минут.
ALTER TABLE "activities" ADD COLUMN "meal" text;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_meal_ck" CHECK ("meal" is null or "meal" in ('breakfast', 'lunch', 'dinner'));--> statement-breakpoint
-- Уже созданные пункты «Завтрак», «Обед», «Ужин».
UPDATE "activities" SET "meal" = CASE lower(trim("title")) WHEN 'завтрак' THEN 'breakfast' WHEN 'обед' THEN 'lunch' WHEN 'ужин' THEN 'dinner' END
 WHERE lower(trim("title")) IN ('завтрак', 'обед', 'ужин') AND "block_id" IS NULL;
