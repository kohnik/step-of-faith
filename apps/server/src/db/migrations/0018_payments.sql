CREATE TABLE "payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"participant_id" bigint NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"method" text NOT NULL,
	"source" text NOT NULL,
	"receipt_id" bigint,
	"accepted_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" bigint,
	CONSTRAINT "payments_method_ck" CHECK ("payments"."method" in ('cash', 'card', 'transfer')),
	CONSTRAINT "payments_source_ck" CHECK ("payments"."source" in ('desk', 'receipt', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_receipt_id_payment_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."payment_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_participant_idx" ON "payments" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "payments_accepted_by_idx" ON "payments" USING btree ("accepted_by");--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("created_at");--> statement-breakpoint
-- Прошлые зачисления - в журнал. Чек и его люди принимаются одной транзакцией: время записей в аудите совпадает.
INSERT INTO "payments" ("participant_id", "amount", "method", "source", "receipt_id", "accepted_by", "created_at")
SELECT a.entity_id::bigint,
       (a.after->>'amountPaid')::numeric - coalesce((a.before->>'amountPaid')::numeric, 0),
       CASE WHEN a.action = 'receipt.accept_person' THEN 'transfer'
            WHEN a.before->>'paymentNote' IS NULL AND p.payment_note LIKE 'карта%' THEN 'card'
            WHEN a.before->>'paymentNote' IS NULL AND p.payment_note LIKE 'перевод%' THEN 'transfer'
            ELSE 'cash' END,
       CASE WHEN a.action = 'receipt.accept_person' THEN 'receipt' ELSE 'desk' END,
       (SELECT r.entity_id::bigint FROM audit_log r
         WHERE r.action = 'receipt.accept' AND r.entity = 'receipt' AND r.created_at = a.created_at
           AND a.entity_id::bigint = ANY (SELECT unnest(pr.participant_ids) FROM payment_receipts pr WHERE pr.id = r.entity_id::bigint)
         LIMIT 1),
       a.actor_user_id,
       a.created_at
  FROM audit_log a
  JOIN participants p ON p.id = a.entity_id::bigint
 WHERE a.entity = 'participant'
   AND a.action IN ('payment.mark_paid', 'receipt.accept_person')
   AND a.entity_id ~ '^[0-9]+$'
   AND (a.after->>'amountPaid')::numeric > coalesce((a.before->>'amountPaid')::numeric, 0)
   AND NOT EXISTS (
     SELECT 1 FROM audit_log u
      WHERE u.action = 'payment.undo' AND u.entity = 'participant' AND u.entity_id = a.entity_id AND u.created_at > a.created_at
   )
 ORDER BY a.id;
--> statement-breakpoint
-- Внесённое, которого нет в аудите (отметили оплату вручную, массово или при создании), - строкой «правка в админке».
INSERT INTO "payments" ("participant_id", "amount", "method", "source", "created_at")
SELECT p.id,
       p.amount_paid - coalesce(l.s, 0),
       CASE WHEN p.payment_method = 'transfer' THEN 'transfer' ELSE 'cash' END,
       'manual',
       coalesce(p.paid_at, p.updated_at)
  FROM participants p
  LEFT JOIN (SELECT participant_id, sum(amount) s FROM payments WHERE undone_at IS NULL GROUP BY participant_id) l ON l.participant_id = p.id
 WHERE p.amount_paid > coalesce(l.s, 0) + 0.005;
