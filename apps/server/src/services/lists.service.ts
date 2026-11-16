import type { ParticipantListInput, ParticipantListView } from '@sof/shared';
import { eq, sql } from 'drizzle-orm';
import { schema, type DbLike } from '../db/client.ts';
import { audit } from '../lib/audit.ts';
import { conflict, isUniqueViolation, notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import type { StaffPrincipal } from './sessions.service.ts';

const nameTaken = (err: unknown) =>
  isUniqueViolation(err, 'participant_lists_name_uq') ? conflict('list_exists', 'Список с таким названием уже есть') : err;

/** Списки с числом участников и тех, до кого дойдёт рассылка (как считает рассылка: по аккаунтам). */
export async function listParticipantLists(db: DbLike, ids?: number[]): Promise<ParticipantListView[]> {
  const res = await db.execute<{
    id: string;
    name: string;
    count: number;
    recipients: number;
    created_at: Date;
    updated_at: Date;
    uid: string | null;
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
  }>(sql`
    select l.id, l.name, l.created_at, l.updated_at,
           u.id as uid, u.display_name, u.first_name, u.last_name, u.username,
           (select count(*)::int from participant_list_members m
              join participants p on p.id = m.participant_id and p.status = 'active'
             where m.list_id = l.id) as count,
           (select count(distinct r.id)::int from participant_list_members m
              join participants p on p.id = m.participant_id and p.status = 'active'
              join users r on r.id in (p.owner_user_id, p.holder_user_id) and r.tg_id is not null and not r.bot_blocked
             where m.list_id = l.id) as recipients
      from participant_lists l
      left join users u on u.id = l.created_by
     where ${ids ? sql`l.id in ${sql.raw(`(${ids.map(Number).join(',') || '-1'})`)}` : sql`true`}
     order by lower(l.name)`);
  return res.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    count: r.count,
    recipients: r.recipients,
    createdByName: r.uid
      ? userDisplayName({ displayName: r.display_name, firstName: r.first_name, lastName: r.last_name, username: r.username })
      : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

async function one(db: DbLike, id: number): Promise<ParticipantListView> {
  const [row] = await listParticipantLists(db, [id]);
  if (!row) throw notFound('Список не найден');
  return row;
}

export async function createParticipantList(db: DbLike, input: ParticipantListInput, actor: StaffPrincipal): Promise<ParticipantListView> {
  const [row] = await db
    .insert(schema.participantLists)
    .values({ name: input.name, createdBy: actor.user.id })
    .returning()
    .catch((err: unknown) => {
      throw nameTaken(err);
    });
  await audit(db, { actorUserId: actor.user.id, action: 'list.create', entity: 'participant_list', entityId: row!.id, after: row });
  return one(db, row!.id);
}

export async function renameParticipantList(db: DbLike, id: number, input: ParticipantListInput, actor: StaffPrincipal): Promise<ParticipantListView> {
  const before = await db.query.participantLists.findFirst({ where: eq(schema.participantLists.id, id) });
  if (!before) throw notFound('Список не найден');
  await db
    .update(schema.participantLists)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(schema.participantLists.id, id))
    .catch((err: unknown) => {
      throw nameTaken(err);
    });
  await audit(db, { actorUserId: actor.user.id, action: 'list.rename', entity: 'participant_list', entityId: id, before: { name: before.name }, after: input });
  return one(db, id);
}

export async function deleteParticipantList(db: DbLike, id: number, actor: StaffPrincipal): Promise<void> {
  const [row] = await db.delete(schema.participantLists).where(eq(schema.participantLists.id, id)).returning();
  if (!row) throw notFound('Список не найден');
  await audit(db, { actorUserId: actor.user.id, action: 'list.delete', entity: 'participant_list', entityId: id, before: row });
}

/** Добавить людей в список; кто уже там - пропускаем. */
export async function addToParticipantList(db: DbLike, id: number, ids: number[], actor: StaffPrincipal): Promise<{ added: number; list: ParticipantListView }> {
  await one(db, id);
  const unique = [...new Set(ids)];
  const res = await db.execute(sql`
    insert into participant_list_members (list_id, participant_id, added_by)
    select ${id}, p.id, ${actor.user.id} from participants p where p.id in ${sql.raw(`(${unique.map(Number).join(',')})`)}
    on conflict do nothing`);
  const added = res.rowCount ?? 0;
  if (added) {
    await db.update(schema.participantLists).set({ updatedAt: new Date() }).where(eq(schema.participantLists.id, id));
    await audit(db, { actorUserId: actor.user.id, action: 'list.add', entity: 'participant_list', entityId: id, after: { ids: unique, added } });
  }
  return { added, list: await one(db, id) };
}

export async function removeFromParticipantList(db: DbLike, id: number, ids: number[], actor: StaffPrincipal): Promise<{ removed: number; list: ParticipantListView }> {
  await one(db, id);
  const unique = [...new Set(ids)];
  const res = await db.execute(sql`
    delete from participant_list_members
     where list_id = ${id} and participant_id in ${sql.raw(`(${unique.map(Number).join(',')})`)}`);
  const removed = res.rowCount ?? 0;
  if (removed) {
    await db.update(schema.participantLists).set({ updatedAt: new Date() }).where(eq(schema.participantLists.id, id));
    await audit(db, { actorUserId: actor.user.id, action: 'list.remove', entity: 'participant_list', entityId: id, after: { ids: unique, removed } });
  }
  return { removed, list: await one(db, id) };
}
