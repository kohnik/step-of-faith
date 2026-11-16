import { tgPlain, type BroadcastInput, type BroadcastView, type Segment } from '@sof/shared';
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { userDisplayName } from '../lib/format.ts';
import type { StaffPrincipal } from './sessions.service.ts';

/** Условие на участника для сегмента (участник p активен и связан с получателем u). */
function participantCondition(segment: Segment): SQL | null {
  switch (segment.kind) {
    case 'all':
      return sql`true`;
    case 'unpaid':
      return sql`p.payment_status in ('unpaid', 'pending', 'partial')`;
    case 'not_arrived':
      return sql`p.arrived_at is null`;
    case 'arrived':
      return sql`p.arrived_at is not null`;
    case 'category':
      return sql`p.category = ${segment.category}`;
    case 'activity':
      return sql`exists (select 1 from activity_registrations ar
                          where ar.participant_id = p.id and ar.activity_id = ${segment.activityId} and ar.status = 'registered')`;
    case 'list':
      return sql`exists (select 1 from participant_list_members m where m.participant_id = p.id and m.list_id = ${segment.listId})`;
    case 'staff':
      return null;
  }
}

/** Получатели: у кого есть Telegram и кто не заблокировал бота. */
export function segmentUsersSql(segment: Segment): SQL {
  const cond = participantCondition(segment);
  const match =
    cond === null
      ? sql`exists (select 1 from staff_roles sr where sr.user_id = u.id)`
      : sql`exists (select 1 from participants p
                     where (p.owner_user_id = u.id or p.holder_user_id = u.id) and p.status = 'active' and ${cond})`;
  return sql`select u.id from users u where u.tg_id is not null and not u.bot_blocked and ${match}`;
}

export async function previewSegment(db: DbLike, segment: Segment): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from (${segmentUsersSql(segment)}) s`);
  return res.rows[0]?.n ?? 0;
}

async function toView(db: DbLike, ids?: number[]): Promise<BroadcastView[]> {
  const rows = await db
    .select({ b: schema.broadcasts, u: schema.users })
    .from(schema.broadcasts)
    .leftJoin(schema.users, eq(schema.users.id, schema.broadcasts.createdBy))
    .where(ids ? sql`${schema.broadcasts.id} in ${sql.raw(`(${ids.map(Number).join(',') || '-1'})`)}` : undefined)
    .orderBy(desc(schema.broadcasts.createdAt))
    .limit(200);
  return rows.map(({ b, u }) => ({
    id: b.id,
    text: b.text,
    segment: b.segment as Segment,
    status: b.status as BroadcastView['status'],
    isTest: b.isTest,
    scheduledAt: b.scheduledAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
    createdByName: u ? userDisplayName(u) : null,
    total: b.total,
    sent: b.sent,
    failed: b.failed,
    blocked: b.blocked,
  }));
}

export const listBroadcasts = (ctx: Pick<AppContext, 'db'>) => toView(ctx.db);

export async function createBroadcast(
  ctx: Pick<AppContext, 'db' | 'boss'>,
  input: BroadcastInput,
  actor: StaffPrincipal,
): Promise<BroadcastView> {
  if (input.test && !actor.user.tgId) throw badRequest('no_telegram', 'Тестовая отправка - только если у вас есть Telegram');
  if (input.segment.kind === 'list') {
    const list = await ctx.db.query.participantLists.findFirst({ where: eq(schema.participantLists.id, input.segment.listId) });
    if (!list) throw notFound('Список не найден');
  }
  const id = await ctx.db.transaction(async (tx) => {
    const [b] = await tx
      .insert(schema.broadcasts)
      .values({
        text: input.text,
        segment: input.segment,
        isTest: input.test,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        createdBy: actor.user.id,
      })
      .returning({ id: schema.broadcasts.id });
    // Отложенная рассылка берёт получателей в момент отправки («не пришли» к вечеру - уже без пришедших);
    // сейчас только оцениваем, сколько их будет.
    const deferred = !input.test && !!input.scheduledAt && new Date(input.scheduledAt).getTime() > Date.now();
    if (deferred) {
      await tx.update(schema.broadcasts).set({ total: await previewSegment(tx, input.segment) }).where(eq(schema.broadcasts.id, b!.id));
    } else {
      const recipients = input.test ? sql`select ${actor.user.id}::bigint as id` : segmentUsersSql(input.segment);
      const inserted = await tx.execute(sql`
        insert into broadcast_deliveries (broadcast_id, user_id)
        select ${b!.id}, s.id from (${recipients}) s on conflict do nothing`);
      await tx.update(schema.broadcasts).set({ total: inserted.rowCount ?? 0 }).where(eq(schema.broadcasts.id, b!.id));
    }
    if (input.alsoAnnouncement && !input.test) {
      const [first, ...rest] = input.text.split('\n');
      await tx.insert(schema.announcements).values({
        // Заголовок - без разметки; текст ниже - Markdown ленты (**жирный**, __подчёркнутый__ и т.д. там тоже работают).
        title: tgPlain(first ?? '').slice(0, 160) || 'Объявление',
        bodyMd: rest.join('\n').trim(),
        createdBy: actor.user.id,
      });
    }
    await enqueue(
      ctx.boss,
      'broadcast.run',
      { broadcastId: b!.id },
      { tx, startAfter: input.scheduledAt ? new Date(input.scheduledAt) : undefined },
    );
    await audit(tx, { actorUserId: actor.user.id, action: 'broadcast.create', entity: 'broadcast', entityId: b!.id, after: input });
    return b!.id;
  });
  const [view] = await toView(ctx.db, [id]);
  return view!;
}

export async function cancelBroadcast(ctx: Pick<AppContext, 'db'>, id: number, actor: StaffPrincipal): Promise<BroadcastView> {
  const [row] = await ctx.db
    .update(schema.broadcasts)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(sql`${schema.broadcasts.id} = ${id} and ${schema.broadcasts.status} in ('scheduled', 'sending')`)
    .returning({ id: schema.broadcasts.id });
  if (!row) {
    const exists = await ctx.db.query.broadcasts.findFirst({ where: eq(schema.broadcasts.id, id) });
    if (!exists) throw notFound('Рассылка не найдена');
    throw conflict('not_cancellable', 'Рассылка уже завершена');
  }
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'broadcast.cancel', entity: 'broadcast', entityId: id });
  const [view] = await toView(ctx.db, [id]);
  return view!;
}
