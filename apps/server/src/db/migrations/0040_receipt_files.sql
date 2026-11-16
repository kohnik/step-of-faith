-- Несколько файлов в одном чеке: фото подряд (альбом или пока черновик не отправлен) складываются в один чек.
-- Первый файл - как раньше в payment_receipts, остальные - здесь.
CREATE TABLE "payment_receipt_files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_receipt_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"receipt_id" bigint NOT NULL,
	"file_id" text,
	"file_unique_id" text,
	"file_kind" text NOT NULL,
	"mime_type" text,
	"stored_file" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_receipt_files_uq" UNIQUE("receipt_id","file_unique_id")
);--> statement-breakpoint
ALTER TABLE "payment_receipt_files" ADD CONSTRAINT "payment_receipt_files_receipt_id_payment_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."payment_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_receipt_files_receipt_idx" ON "payment_receipt_files" USING btree ("receipt_id");
