-- 360° вещи: кадры оборота одним файлом (.spin) - новый вид медиа рядом с фото и 3D-моделью.
ALTER TABLE "merch_media" DROP CONSTRAINT "merch_media_kind_ck";--> statement-breakpoint
ALTER TABLE "merch_media" ADD CONSTRAINT "merch_media_kind_ck" CHECK ("merch_media"."kind" in ('photo', 'model', 'spin'));
