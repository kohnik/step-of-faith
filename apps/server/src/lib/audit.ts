import { schema, type DbLike } from '../db/client.ts';

export interface AuditInput {
  actorUserId: number | null;
  action: string;
  entity: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
}

export async function audit(db: DbLike, e: AuditInput): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorUserId: e.actorUserId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId == null ? null : String(e.entityId),
    before: e.before ?? null,
    after: e.after ?? null,
  });
}
