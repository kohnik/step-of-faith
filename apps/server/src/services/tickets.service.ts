import { tierShort, type Category, type PaymentStatus, type PublicTicket } from '@sof/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Config } from '../config.ts';
import { schema, type DbLike, type Tx } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { generateTicketCode, randomToken } from '../lib/crypto.ts';
import { iso, ticketView } from '../lib/format.ts';
import { getSettings } from './settings.service.ts';
import { asTier, tierConfig, tiersVersion } from './tiers.ts';
import { renderTicketPng, TICKET_DESIGN } from './ticket-image.ts';

export type TicketRow = typeof schema.tickets.$inferSelect;

/** Выдаёт новый активный билет. Код и web-токен случайные; на невероятную коллизию - повтор. */
export async function issueTicket(db: DbLike, participantId: number): Promise<TicketRow> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const [row] = await db
      .insert(schema.tickets)
      .values({ participantId, code: generateTicketCode(), webToken: randomToken(18) })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
  }
  throw new Error(`Could not issue ticket for participant ${participantId}`);
}

/** Перевыпуск: старый код становится «перевыпущен» (красный экран на входе), выдаётся новый. */
export async function reissueTicket(db: DbLike, participantId: number, reason: string): Promise<TicketRow> {
  await db
    .update(schema.tickets)
    .set({ status: 'revoked', revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(schema.tickets.participantId, participantId), eq(schema.tickets.status, 'active')));
  return issueTicket(db, participantId);
}

export async function revokeActiveTicket(db: DbLike, participantId: number, reason: string): Promise<void> {
  await db
    .update(schema.tickets)
    .set({ status: 'revoked', revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(schema.tickets.participantId, participantId), eq(schema.tickets.status, 'active')));
}

export async function getActiveTicket(db: DbLike, participantId: number): Promise<TicketRow | undefined> {
  return db.query.tickets.findFirst({
    where: and(eq(schema.tickets.participantId, participantId), eq(schema.tickets.status, 'active')),
  });
}

async function findByWebToken(db: DbLike, webToken: string) {
  const rows = await db
    .select({ ticket: schema.tickets, participant: schema.participants })
    .from(schema.tickets)
    .innerJoin(schema.participants, eq(schema.participants.id, schema.tickets.participantId))
    .where(eq(schema.tickets.webToken, webToken))
    .limit(1);
  return rows[0];
}

/** Последняя действующая отметка на входе (точки входа по дням - на 2-й и 3-й день это сегодняшняя). */
export async function lastEntranceAt(db: DbLike, participantId: number): Promise<Date | null> {
  const [row] = await db
    .select({ at: schema.checkIns.createdAt })
    .from(schema.checkIns)
    .innerJoin(schema.checkpoints, eq(schema.checkpoints.id, schema.checkIns.checkpointId))
    .where(
      and(
        eq(schema.checkIns.participantId, participantId),
        isNull(schema.checkIns.revokedAt),
        eq(schema.checkpoints.kind, 'entrance'),
      ),
    )
    .orderBy(desc(schema.checkIns.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/**
 * На QR поменялись данные (вариант, ФИО, категория) - прислать в чат актуальный QR-код. Через 30 секунд
 * и одной задачей на человека: несколько правок подряд дают одно сообщение, и в нём уже последние данные.
 */
export async function enqueueTicketsUpdated(
  tx: Tx,
  boss: PgBoss,
  p: { id: number; ownerUserId: number; holderUserId: number | null },
): Promise<void> {
  const pending = await tx.execute(sql`
    select 1 from pgboss.job
     where name = 'tickets.send' and state in ('created', 'retry')
       and data->>'reason' = 'updated' and data->'participantIds' @> ${JSON.stringify([p.id])}::jsonb
     limit 1`);
  if (pending.rows.length > 0) return;
  await enqueue(
    boss,
    'tickets.send',
    { userId: p.holderUserId ?? p.ownerUserId, participantIds: [p.id], reason: 'updated' },
    { tx, startAfter: 30 },
  );
}

export async function getPublicTicket(db: DbLike, config: Config, webToken: string): Promise<PublicTicket | null> {
  const found = await findByWebToken(db, webToken);
  if (!found || found.participant.status !== 'active') return null;
  const settings = await getSettings(db);
  const view = ticketView(config, found.ticket);
  return {
    fullName: [found.participant.lastName, found.participant.firstName, found.participant.middleName]
      .filter(Boolean)
      .join(' '),
    eventTimezone: settings.eventTimezone,
    code: view.code,
    displayCode: view.displayCode,
    status: found.ticket.status as 'active' | 'revoked',
    eventName: settings.eventName,
    paymentStatus: found.participant.paymentStatus as PaymentStatus,
    arrivedAt: found.participant.arrivedAt ? iso((await lastEntranceAt(db, found.participant.id)) ?? found.participant.arrivedAt) : null,
    imageUrl: view.imageUrl,
    tier: (() => {
      const key = asTier(found.participant.tier);
      return key
        ? { key, short: tierShort(settings.tiers[key], found.participant.breakfast), color: settings.tiers[key].color }
        : null;
    })(),
    breakfast: found.participant.breakfast,
  };
}

// Картинки билетов не меняются, пока не сменился код, - держим небольшой кэш в памяти.
const imageCache = new Map<string, Buffer>();
const IMAGE_CACHE_MAX = 300;

export async function ticketPng(
  db: DbLike,
  ticket: TicketRow,
  participant: typeof schema.participants.$inferSelect,
): Promise<Buffer> {
  const settings = await getSettings(db);
  const key = `${ticket.code}:${participant.updatedAt.getTime()}:${tiersVersion(settings)}:${TICKET_DESIGN}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const tier = tierConfig(settings, participant.tier);
  const png = await renderTicketPng({
    code: ticket.code,
    lastName: participant.lastName,
    firstName: participant.firstName,
    middleName: participant.middleName,
    category: participant.category as Category,
    eventName: settings.eventName,
    // «Обед и ужин + завтрак»: волонтёр у столовой видит завтрак прямо на QR-коде.
    tier: tier ? { short: tierShort(tier, participant.breakfast), color: tier.color } : null,
  });
  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value!);
  imageCache.set(key, png);
  return png;
}

export async function publicTicketPng(db: DbLike, webToken: string): Promise<Buffer | null> {
  const found = await findByWebToken(db, webToken);
  if (!found || found.ticket.status !== 'active' || found.participant.status !== 'active') return null;
  return ticketPng(db, found.ticket, found.participant);
}
