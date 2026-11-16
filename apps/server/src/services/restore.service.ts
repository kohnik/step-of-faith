import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { generatePaymentRef } from '../lib/crypto.ts';
import { phoneTail } from './claim.service.ts';
import type { TelegramUserLike, UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;

/**
 * Восстановление после сбоя хостинга: аккаунты и семьи подняты из выгрузки участников, но без Telegram id
 * (`users.restored_at`, `tg_id` пустой). Человек заходит в бот или Mini App - узнаём его:
 *  - по нику: аккаунт из выгрузки с тем же @ником просто получает этот Telegram id (вся семья, код оплаты, QR-коды);
 *  - по номеру, подтверждённому Telegram: семья из выгрузки переходит на его аккаунт, если в ней только этот номер.
 *    Где номера разные, по номеру человек забирает только свою регистрацию («Меня уже зарегистрировали»),
 *    иначе жена по своему номеру забрала бы всю семью мужа.
 */

// Проверяем Telegram id один раз на процесс, а не на каждое сообщение.
const checked = new Set<number>();
const CHECKED_MAX = 50_000;

/** Есть ли ещё не узнанные аккаунты из выгрузки - пока есть, бот подсказывает про восстановление. */
export async function hasPendingRestored(db: DbLike): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(isNotNull(schema.users.restoredAt), isNull(schema.users.tgId)))
    .limit(1);
  return !!row;
}

/** Активные участники семьи - им отправляем QR-коды после того, как узнали человека. */
async function activeOwned(db: DbLike, userId: number): Promise<number[]> {
  const rows = await db
    .select({ id: schema.participants.id })
    .from(schema.participants)
    .where(and(eq(schema.participants.ownerUserId, userId), eq(schema.participants.status, 'active')));
  return rows.map((r) => r.id);
}

type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];

/**
 * Семья аккаунта из выгрузки переходит на живой аккаунт: участники (кроме тех, кого он уже записал заново),
 * роли команды и - если своих регистраций у него не было - прежний код оплаты (его могли указать в переводе).
 * Опустевший аккаунт из выгрузки больше не ждёт владельца. Возвращает id перенесённых участников.
 */
async function mergeInto(ctx: Ctx, tx: Tx, ghost: { id: number; paymentRef: string }, userId: number, hadOwn: boolean): Promise<number[]> {
  const res = await tx.execute<{ id: number }>(sql`
    update participants p set owner_user_id = ${userId}, updated_at = now(),
           holder_user_id = case when p.holder_user_id = ${userId} then null else p.holder_user_id end
     where p.owner_user_id = ${ghost.id}
       and not exists (
         select 1 from participants q
          where q.owner_user_id = ${userId} and q.person_key = p.person_key and q.status <> 'cancelled')
    returning p.id::int as id`);
  const moved = res.rows.map((r) => r.id);
  await tx.execute(sql`
    insert into staff_roles (user_id, role) select ${userId}, role from staff_roles where user_id = ${ghost.id}
    on conflict do nothing`);
  await tx.execute(sql`delete from staff_roles where user_id = ${ghost.id}`);
  const left = await tx.select({ id: schema.participants.id }).from(schema.participants).where(eq(schema.participants.ownerUserId, ghost.id)).limit(1);
  if (left.length === 0) await tx.update(schema.users).set({ restoredAt: null }).where(eq(schema.users.id, ghost.id));
  if (!hadOwn && moved.length > 0) {
    // Сначала новый код аккаунту из выгрузки, потом прежний - живому: код оплаты уникален.
    await tx.update(schema.users).set({ paymentRef: generatePaymentRef() }).where(eq(schema.users.id, ghost.id));
    await tx.update(schema.users).set({ paymentRef: ghost.paymentRef }).where(eq(schema.users.id, userId));
  }
  const active = moved.length
    ? (await tx
        .select({ id: schema.participants.id })
        .from(schema.participants)
        .where(and(inArray(schema.participants.id, moved), eq(schema.participants.status, 'active')))).map((r) => r.id)
    : [];
  if (active.length) await enqueue(ctx.boss, 'tickets.send', { userId, participantIds: active, reason: 'found' }, { tx });
  return moved;
}

/**
 * Заход с этого Telegram id: аккаунт из выгрузки с тем же ником становится его аккаунтом.
 * Если строка с этим Telegram id уже есть (зашёл раньше, чем его узнали) - семья из выгрузки переходит на неё.
 * Вызывать до `upsertTelegramUser`: тот потом просто обновит имя и время захода. Возвращает, сколько активных участников нашли.
 */
export async function adoptRestoredByUsername(ctx: Ctx, tg: TelegramUserLike): Promise<number> {
  if (!tg.username || checked.has(tg.id)) return 0;
  if (checked.size > CHECKED_MAX) checked.clear();
  const nick = tg.username.toLowerCase();
  const adopted = await ctx.db.transaction(async (tx) => {
    const [ghost] = (
      await tx.execute<{ id: number; payment_ref: string }>(sql`
        select id::int as id, payment_ref from users
         where tg_id is null and restored_at is not null and lower(username) = ${nick}
         order by id limit 1
         for update`)
    ).rows;
    if (!ghost) return 0;
    const existing = await tx.query.users.findFirst({ where: eq(schema.users.tgId, tg.id) });
    if (existing) {
      const hadOwn = (await activeOwned(tx, existing.id)).length > 0;
      const moved = await mergeInto(ctx, tx, { id: ghost.id, paymentRef: ghost.payment_ref }, existing.id, hadOwn);
      await audit(tx, { actorUserId: existing.id, action: 'restore.merge_by_username', entity: 'user', entityId: existing.id, after: { from: ghost.id, participants: moved } });
      return moved.length;
    }
    const [row] = await tx
      .update(schema.users)
      .set({ tgId: tg.id, firstName: tg.first_name ?? null, lastName: tg.last_name ?? null, restoredAt: null, lastSeenAt: new Date() })
      .where(eq(schema.users.id, ghost.id))
      .returning();
    if (!row) return 0;
    const ids = await activeOwned(tx, row.id);
    if (ids.length) await enqueue(ctx.boss, 'tickets.send', { userId: row.id, participantIds: ids, reason: 'found' }, { tx });
    await audit(tx, { actorUserId: row.id, action: 'restore.adopt_by_username', entity: 'user', entityId: row.id, after: { tgId: tg.id, participants: ids } });
    return ids.length;
  });
  // Ошибка выше пролетит мимо - и в следующий заход попробуем снова.
  checked.add(tg.id);
  return adopted;
}

/**
 * Человек подтвердил номер через Telegram: семья из выгрузки переходит к нему, если в ней это единственный номер -
 * тогда понятно, чья она. Где номера разные (муж и жена, руководитель и группа), семью не трогаем: каждый забирает
 * свою регистрацию через «Меня уже зарегистрировали», а владелец - по нику. Возвращает id перенесённых участников.
 */
export async function adoptRestoredByPhone(ctx: Ctx, user: UserRow): Promise<number[]> {
  if (!user.phone) return [];
  const tail = phoneTail(user.phone);
  return ctx.db.transaction(async (tx) => {
    const owners = await tx.execute<{ id: number; payment_ref: string }>(sql`
      select u.id::int as id, u.payment_ref
        from users u
       where u.tg_id is null and u.restored_at is not null and u.id <> ${user.id}
         and exists (
           select 1 from participants p
            where p.owner_user_id = u.id and p.status = 'active'
              and right(regexp_replace(coalesce(p.phone, ''), '\\D', '', 'g'), 10) = ${tail})
         and not exists (
           select 1 from participants p
            where p.owner_user_id = u.id and p.status = 'active' and coalesce(p.phone, '') <> ''
              and right(regexp_replace(p.phone, '\\D', '', 'g'), 10) <> ${tail})
       order by u.id
       for update`);
    if (owners.rows.length === 0) return [];
    let hadOwn = (await activeOwned(tx, user.id)).length > 0;
    const moved: number[] = [];
    for (const owner of owners.rows) {
      // Код оплаты забираем только у первой семьи, если своих регистраций не было.
      moved.push(...(await mergeInto(ctx, tx, { id: owner.id, paymentRef: owner.payment_ref }, user.id, hadOwn)));
      hadOwn = hadOwn || moved.length > 0;
    }
    if (moved.length) {
      await audit(tx, {
        actorUserId: user.id,
        action: 'restore.adopt_by_phone',
        entity: 'user',
        entityId: user.id,
        after: { from: owners.rows.map((o) => o.id), participants: moved },
      });
    }
    return moved;
  });
}
