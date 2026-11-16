-- Завтрак - не вариант участия, а галочка к платному варианту. Вариант fee45 («с завтраком») убираем.
ALTER TABLE "participants" DROP CONSTRAINT "participants_tier_ck";--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "breakfast" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Записанные на fee45 → «Взнос и питание» с завтраком. Суммы и статус оплаты не пересчитываем: к оплате уже стоит
-- фактическая сумма (45 = 35 + 10 или ручная), внесённое - как было. updated_at - чтобы перерисовались QR-картинки
-- и сканеры забрали изменения в офлайн-базу.
UPDATE "participants" SET "tier" = 'fee35', "breakfast" = true, "updated_at" = now() WHERE "tier" = 'fee45';--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_tier_ck" CHECK ("participants"."tier" is null or "participants"."tier" in ('fee10', 'fee35', 'nofee'));--> statement-breakpoint
-- Настройки: убираем fee45. Подписи вариантов, которые не меняли руками, - без цены (сумму с завтраком показывает
-- «к оплате») и без «без питания» (завтрак теперь можно добавить и к «Только взнос»). Изменённые руками не трогаем.
UPDATE "settings" SET "value" = "value" #- '{tiers,fee45}' WHERE "key" = 'app';--> statement-breakpoint
UPDATE "settings" SET "value" = jsonb_set("value", '{tiers,fee10,short}', '"Только взнос"')
 WHERE "key" = 'app' AND "value" #>> '{tiers,fee10,short}' = '10 руб. · без питания';--> statement-breakpoint
UPDATE "settings" SET "value" = jsonb_set("value", '{tiers,fee10,description}', '"Регистрационный взнос, без обеда и ужина"')
 WHERE "key" = 'app' AND "value" #>> '{tiers,fee10,description}' = 'Регистрационный взнос без питания';--> statement-breakpoint
UPDATE "settings" SET "value" = jsonb_set("value", '{tiers,fee35,short}', '"Обед и ужин"')
 WHERE "key" = 'app' AND "value" #>> '{tiers,fee35,short}' = '35 руб. · обед и ужин';--> statement-breakpoint
-- Realtime: галочку завтрака поменяли - участнику тоже приходит «me» (как при смене варианта).
CREATE OR REPLACE FUNCTION sof_participants_trg()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM sof_notify('me', ARRAY[NEW.owner_user_id, NEW.holder_user_id]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM sof_notify('me', ARRAY[OLD.owner_user_id, OLD.holder_user_id]);
  ELSIF (NEW.payment_status, NEW.amount_paid, NEW.amount_due, NEW.status, NEW.tier, NEW.breakfast, NEW.payment_method, NEW.arrived_at,
         NEW.owner_user_id, NEW.holder_user_id, NEW.last_name, NEW.first_name, NEW.middle_name, NEW.category)
        IS DISTINCT FROM
        (OLD.payment_status, OLD.amount_paid, OLD.amount_due, OLD.status, OLD.tier, OLD.breakfast, OLD.payment_method, OLD.arrived_at,
         OLD.owner_user_id, OLD.holder_user_id, OLD.last_name, OLD.first_name, OLD.middle_name, OLD.category) THEN
    PERFORM sof_notify('me', ARRAY[NEW.owner_user_id, NEW.holder_user_id, OLD.owner_user_id, OLD.holder_user_id]);
  END IF;
  RETURN NULL;
END $$;
