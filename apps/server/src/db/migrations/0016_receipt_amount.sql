ALTER TABLE "payment_receipts" ADD COLUMN "amount" numeric(10, 2);--> statement-breakpoint
-- Уже принятые чеки: сколько по ним зачли - из журнала. Зачисление людям пишется в той же транзакции, что и
-- принятие чека, поэтому у записей одно и то же время; людей берём из списка зачтённых в записи о чеке.
UPDATE "payment_receipts" r SET "amount" = s.total
  FROM (
    SELECT a.entity_id::bigint AS receipt_id,
           sum((p.after->>'amountPaid')::numeric - coalesce((p.before->>'amountPaid')::numeric, 0)) AS total
      FROM audit_log a
      JOIN audit_log p ON p.action = 'receipt.accept_person' AND p.created_at = a.created_at
       AND (a.after->'credited') @> to_jsonb(p.entity_id::bigint)
     WHERE a.action = 'receipt.accept' AND a.entity = 'receipt'
     GROUP BY 1
  ) s
 WHERE r.id = s.receipt_id AND r.status = 'accepted';
