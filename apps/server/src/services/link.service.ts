import { fullName } from '@sof/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type Tx } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { esc } from '../bot/format.ts';
import type { UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;

/**
 * Узнаём человека по нику в Telegram: кто-то зарегистрировал друга и указал его @ник -
 * когда друг сам заходит в бот или Mini App, QR-код появляется и у него (через holder_user_id,
 * как при передаче QR-кода). Владелец аккаунта QR-код не теряет.
 */

// Проверяем пару «аккаунт + ник» один раз на процесс, а не на каждое сообщение.
const checked = new Set<string>();
const CHECKED_MAX = 20_000;

export async function autoLinkByUsername(ctx: Ctx, user: UserRow): Promise<number> {
  if (!user.username || !user.tgId) return 0;
  const key = `${user.id}:${user.username.toLowerCase()}`;
  if (checked.has(key)) return 0;
  if (checked.size > CHECKED_MAX) checked.clear();

  const linked = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.participants)
      .set({ holderUserId: user.id, updatedAt: new Date() })
      .where(
        and(
          sql`lower(${schema.participants.telegramUsername}) = ${user.username!.toLowerCase()}`,
          sql`${schema.participants.holderUserId} is null`,
          sql`${schema.participants.ownerUserId} <> ${user.id}`,
          eq(schema.participants.status, 'active'),
        ),
      )
      .returning();
    if (rows.length > 0) await afterLinked(ctx, tx, user.id, rows);
    return rows.length;
  });
  checked.add(key);
  return linked;
}

/** Сразу после регистрации: если человек с этим ником уже есть в боте - связываем. */
export async function linkNewParticipants(ctx: Ctx, tx: Tx, participantIds: number[]): Promise<void> {
  if (participantIds.length === 0) return;
  const matches = await tx.execute<{ pid: number; uid: number }>(sql`
    select distinct on (p.id) p.id::int as pid, u.id::int as uid
    from ${schema.participants} p
    join ${schema.users} u on lower(u.username) = lower(p.telegram_username)
    where p.id in (${sql.join(participantIds.map((id) => sql`${id}`), sql`, `)})
      and p.telegram_username is not null
      and p.holder_user_id is null
      and u.tg_id is not null
      and u.id <> p.owner_user_id
    order by p.id, u.last_seen_at desc nulls last
  `);
  const byUser = new Map<number, number[]>();
  for (const m of matches.rows) byUser.set(m.uid, [...(byUser.get(m.uid) ?? []), m.pid]);
  for (const [uid, pids] of byUser) {
    const rows = await tx
      .update(schema.participants)
      .set({ holderUserId: uid, updatedAt: new Date() })
      .where(and(inArray(schema.participants.id, pids), sql`${schema.participants.holderUserId} is null`))
      .returning();
    if (rows.length > 0) await afterLinked(ctx, tx, uid, rows);
  }
}

/** После привязки (по нику или по номеру): QR-коды - новому держателю, записавшему - сообщение. */
export async function afterLinked(
  ctx: Ctx,
  tx: Tx,
  holderUserId: number,
  rows: (typeof schema.participants.$inferSelect)[],
  action: 'participant.link_by_username' | 'participant.link_by_phone' = 'participant.link_by_username',
): Promise<void> {
  // По номеру человек сам подтвердил «Это я» - кнопка «Это не я» под QR-кодом ему не нужна.
  const reason = action === 'participant.link_by_phone' ? 'found' : 'linked';
  await enqueue(ctx.boss, 'tickets.send', { userId: holderUserId, participantIds: rows.map((r) => r.id), reason }, { tx });
  const byOwner = new Map<number, string[]>();
  for (const r of rows) byOwner.set(r.ownerUserId, [...(byOwner.get(r.ownerUserId) ?? []), fullName(r)]);
  for (const [ownerId, names] of byOwner) {
    await enqueue(
      ctx.boss,
      'notify.text',
      {
        kind: 'tickets.shared',
        userId: ownerId,
        text: `📲 ${names.map((n) => `<b>${esc(n)}</b>`).join(', ')} теперь тоже пользуется ботом, QR-код отправили и туда. У вас он остаётся.`,
      },
      { tx },
    );
  }
  await audit(tx, {
    actorUserId: holderUserId,
    action,
    entity: 'participant',
    entityId: rows.map((r) => r.id).join(','),
    after: { holderUserId },
  });
}

/**
 * «Это не я»: снимаем связь и ник со всех, кого привязали к этому аккаунту по тому же нику
 * (одна кнопка на всё сообщение), чтобы не связать снова. Владельцам - подсказка проверить ник.
 */
export async function unlinkByHolder(ctx: Ctx, user: UserRow, participantId: number): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const first = await tx.query.participants.findFirst({
      where: and(eq(schema.participants.id, participantId), eq(schema.participants.holderUserId, user.id)),
    });
    if (!first) return false;
    const sameNick = first.telegramUsername
      ? and(
          eq(schema.participants.holderUserId, user.id),
          sql`lower(${schema.participants.telegramUsername}) = ${first.telegramUsername.toLowerCase()}`,
        )
      : eq(schema.participants.id, first.id);
    const rows = await tx
      .update(schema.participants)
      .set({ holderUserId: null, telegramUsername: null, updatedAt: new Date() })
      .where(sameNick)
      .returning();
    const byOwner = new Map<number, string[]>();
    for (const r of rows) byOwner.set(r.ownerUserId, [...(byOwner.get(r.ownerUserId) ?? []), fullName(r)]);
    for (const [ownerId, names] of byOwner) {
      await enqueue(
        ctx.boss,
        'notify.text',
        {
          kind: 'tickets.shared',
          userId: ownerId,
          text:
            `⚠️ У ${names.length === 1 ? 'участника' : 'участников'} ${names.map((n) => `<b>${esc(n)}</b>`).join(', ')} указан чужой ник: ` +
            `@${esc(user.username ?? '')} ответил «Это не я». Ник убрали.\n\n` +
            '👉 Правильный можно указать в приложении: «Мои QR-коды» → «⋯» → «Изменить данные».',
        },
        { tx },
      );
    }
    await audit(tx, {
      actorUserId: user.id,
      action: 'participant.unlink_not_me',
      entity: 'participant',
      entityId: rows.map((r) => r.id).join(','),
    });
    return rows.length > 0;
  });
}
