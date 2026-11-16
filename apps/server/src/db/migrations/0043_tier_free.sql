-- Второй бесплатный вариант: free - «Без взноса» (вход бесплатно, без питания); nofee теперь «Нуждаюсь в спонсоре» (с питанием).
ALTER TABLE "participants" DROP CONSTRAINT "participants_tier_ck";--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_tier_ck" CHECK ("participants"."tier" is null or "participants"."tier" in ('fee10', 'fee35', 'nofee', 'free'));
