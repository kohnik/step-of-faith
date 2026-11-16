import {
  fullName,
  merchAccess,
  permissionsFor,
  priceOf,
  type Category,
  type Gender,
  type MeResponse,
  type MyParticipant,
  type ParticipantStatus,
  type ParticipantUpdate,
  type PaymentStatus,
  type Relation,
  type RegPaymentMethod,
  type Settings,
  type TransferLinkResponse,
} from '@sof/shared';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike, type Tx } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.ts';
import { botLink, iso, ticketView } from '../lib/format.ts';
import { personKey } from '../lib/person-key.ts';
import { familyParticipants } from './registration.service.ts';
import { gameFeature } from './game.service.ts';
import { getSettings, isRegistrationOpen, otherTransferText } from './settings.service.ts';
import { feedbackState } from './feedback.service.ts';
import { linkNewParticipants } from './link.service.ts';
import {
  amountForTier,
  asTier,
  assertBreakfastOffered,
  assertBreakfastRoom,
  assertTierOffered,
  assertTierRoom,
  breakfastLeft,
  initialPaymentStatus,
  isUnder16,
  tierLeft,
  withBreakfast,
} from './tiers.ts';
import { enqueueTicketsUpdated, getActiveTicket, lastEntranceAt, revokeActiveTicket } from './tickets.service.ts';
import { getRoles, type UserRow } from './users.service.ts';
import { hasPendingRestored } from './restore.service.ts';

type ParticipantRow = typeof schema.participants.$inferSelect;

/** Имена аккаунтов-владельцев (для «вас записал(а) …»). */
async function ownerNames(db: DbLike, rows: ParticipantRow[], meId: number): Promise<Map<number, string>> {
  const ids = [...new Set(rows.filter((r) => r.ownerUserId !== meId).map((r) => r.ownerUserId))];
  if (ids.length === 0) return new Map();
  const users = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(
    users.map((u) => [u.id, u.displayName ?? ([u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : 'другой аккаунт'))]),
  );
}

export async function toMyParticipant(
  ctx: Pick<AppContext, 'db' | 'config'>,
  p: ParticipantRow,
  meId: number,
  settings: Settings,
  owners: Map<number, string> = new Map(),
): Promise<MyParticipant> {
  const ticket = p.status === 'active' ? await getActiveTicket(ctx.db, p.id) : undefined;
  const lastArrival = p.arrivedAt ? await lastEntranceAt(ctx.db, p.id) : null;
  return {
    id: p.id,
    lastName: p.lastName,
    firstName: p.firstName,
    middleName: p.middleName,
    fullName: fullName(p),
    birthDate: p.birthDate,
    gender: p.gender as Gender,
    city: p.city,
    church: p.church,
    phone: p.phone,
    relation: p.relation as Relation,
    category: p.category as Category,
    status: p.status as ParticipantStatus,
    tier: asTier(p.tier),
    breakfast: p.breakfast,
    paymentMethod: (p.paymentMethod as RegPaymentMethod | null) ?? null,
    telegramUsername: p.telegramUsername,
    under16: isUnder16(settings, p.birthDate),
    onSite: p.onSite,
    paymentStatus: p.paymentStatus as PaymentStatus,
    amountDue: p.amountDue,
    amountPaid: p.amountPaid,
    arrivedAt: iso(p.arrivedAt),
    lastArrivedAt: iso(lastArrival ?? p.arrivedAt),
    registeredBy: p.ownerUserId !== meId ? (owners.get(p.ownerUserId) ?? null) : null,
    transferredToMe: p.holderUserId === meId && p.ownerUserId !== meId,
    transferredAway: p.ownerUserId === meId && p.holderUserId !== null && p.holderUserId !== meId,
    ticket: ticket ? ticketView(ctx.config, ticket) : null,
  };
}

export async function getMe(ctx: Pick<AppContext, 'db' | 'config'>, user: UserRow): Promise<MeResponse> {
  const [settings, roles, family] = await Promise.all([
    getSettings(ctx.db),
    getRoles(ctx.db, user.id),
    familyParticipants(ctx, user.id),
  ]);
  let capacityLeft: number | null = null;
  if (settings.totalCapacity) {
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.participants)
      .where(eq(schema.participants.status, 'active'));
    capacityLeft = Math.max(0, settings.totalCapacity - (row?.n ?? 0));
  }
  return {
    user: {
      id: user.id,
      tgId: user.tgId,
      firstName: user.firstName,
      username: user.username,
      paymentRef: user.paymentRef,
    },
    roles,
    permissions: permissionsFor(roles),
    feedback: await feedbackState(ctx.db, settings, user, roles, family),
    participants: await (async () => {
      const owners = await ownerNames(ctx.db, family, user.id);
      return Promise.all(family.map((p) => toMyParticipant(ctx, p, user.id, settings, owners)));
    })(),
    registration: {
      open: isRegistrationOpen(settings),
      onSite: settings.onSiteRegistration,
      opensAt: settings.registrationOpensAt,
      closesAt: settings.registrationClosesAt,
      maxPerAccount: settings.maxParticipantsPerAccount,
      consentVersion: settings.consentDocumentVersion,
      consentUrl: settings.consentDocumentUrl,
      photoConsentEnabled: settings.photoConsentEnabled,
      capacityLeft,
      tiers: settings.tiers,
      tierLeft: await tierLeft(ctx.db, settings),
      breakfast: settings.breakfast,
      breakfastLeft: await breakfastLeft(ctx.db, settings),
      restored: await hasPendingRestored(ctx.db),
    },
    payment: {
      instructions: settings.paymentInstructions,
      cash: settings.cashInstructions,
      transfers: settings.transfersEnabled,
      otherInstructions: otherTransferText(settings),
    },
    features: {
      payments: settings.paymentsEnabled,
      softPaymentLabels: settings.softPaymentLabels,
      activitySignup: settings.activityRegistrationOpen,
      schedule: settings.scheduleVisible,
      merch: merchAccess(settings, roles).visible,
      merchSales: merchAccess(settings, roles).sales,
      game: await gameFeature(ctx.db, roles, user.id),
    },
    event: {
      name: settings.eventName,
      timezone: settings.eventTimezone,
      startsAt: settings.eventStartsAt,
      endsAt: settings.eventEndsAt,
      supportContact: settings.supportContact,
      counselingTitle: settings.counselingTitle,
      ended: settings.eventEnded,
      endTitle: settings.endTitle,
      endText: settings.endText,
    },
  };
}

async function ownParticipant(db: DbLike, userId: number, participantId: number): Promise<ParticipantRow> {
  const p = await db.query.participants.findFirst({ where: eq(schema.participants.id, participantId) });
  if (!p || p.ownerUserId !== userId) throw notFound('Участник не найден');
  if (p.status !== 'active') throw badRequest('participant_cancelled', 'Регистрация этого участника отменена');
  return p;
}

/** Правка своих данных - пока открыта регистрация. */
export async function updateOwnParticipant(
  ctx: Pick<AppContext, 'db' | 'config' | 'boss'>,
  user: UserRow,
  participantId: number,
  patch: ParticipantUpdate,
): Promise<MyParticipant> {
  const settings = await getSettings(ctx.db);
  if (!isRegistrationOpen(settings)) {
    throw badRequest('registration_closed', 'Регистрация закрыта - для изменений напишите организаторам');
  }
  const updated = await ctx.db.transaction(async (tx) => {
    const before = await ownParticipant(tx, user.id, participantId);
    return updateOwnInTx(tx, before);
  }).catch((err: unknown) => {
    // Правка сделала человека копией другого из этой же регистрации (ФИО и дата рождения совпали).
    if (isUniqueViolation(err, 'participants_person_uq')) {
      throw conflict('duplicate_person', 'Такой человек уже есть в вашей регистрации - проверьте имя и дату рождения');
    }
    throw err;
  });
  return toMyParticipant(ctx, updated, user.id, settings);

  async function updateOwnInTx(tx: Tx, before: ParticipantRow) {
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    // Вариант участия и завтрак меняем, только пока ничего не оплачено и чек не на проверке.
    const tier = asTier(next.tier);
    const tierChanged = patch.tier !== undefined && patch.tier !== before.tier;
    // Ушёл на «Без взноса» - завтрак снимается вместе с вариантом.
    const breakfast = withBreakfast(tier, next.breakfast);
    const breakfastChanged = breakfast !== before.breakfast;
    if ((tierChanged || breakfastChanged) && before.onSite) {
      throw badRequest('guest_tier', 'Регистрация на месте - только взнос, без питания. Сменить вариант можно у организаторов');
    }
    // После оплаты можно только докупить завтрак: к оплате прибавляется его цена, остаток доплачивают на кассе или переводом.
    const paidBefore = ['paid', 'partial'].includes(before.paymentStatus);
    const addBreakfastOnly = breakfastChanged && breakfast && !tierChanged;
    // Докупленный завтрак ещё не оплачен (внесено не больше цены без завтрака) - передумал, снимает сам; оплаченный - только через организаторов.
    const dropUnpaidBreakfast =
      breakfastChanged &&
      !breakfast &&
      !tierChanged &&
      paidBefore &&
      !!tier &&
      Number(before.amountPaid ?? 0) <= Number(amountForTier(settings, tier, false)) + 1e-9;
    const breakfastOnly = paidBefore && (addBreakfastOnly || dropUnpaidBreakfast);
    if ((tierChanged || breakfastChanged) && !['unpaid', 'exempt'].includes(before.paymentStatus) && !breakfastOnly) {
      throw badRequest(
        'tier_locked',
        before.paymentStatus === 'pending'
          ? 'Чек ещё на проверке - докупить завтрак можно будет после проверки, а сменить вариант - через организаторов'
          : 'Взнос уже внесён - докупить завтрак можно, а сменить вариант или убрать завтрак - через организаторов',
      );
    }
    if (tierChanged && tier) {
      assertTierOffered(settings, tier);
      await assertTierRoom(tx, settings, tier, 1);
    }
    if (breakfast && !before.breakfast) {
      assertBreakfastOffered(settings);
      await assertBreakfastRoom(tx, settings, 1);
    }
    // «Без взноса», поставленное вручную (волонтёр, спикер - при платном варианте), смена варианта не снимает.
    const oldTier = asTier(before.tier);
    const manualExempt = before.paymentStatus === 'exempt' && !(oldTier && priceOf(settings, oldTier, before.breakfast) === 0);
    const extraDue = tier ? amountForTier(settings, tier, breakfast) : null;
    const pricing =
      breakfastOnly && tier && extraDue
        ? {
            breakfast,
            amountDue: extraDue,
            // Внесённого не хватает на новую сумму - «частично» (доплата за завтрак); сняли неоплаченный завтрак - снова «оплачено».
            paymentStatus: Number(before.amountPaid ?? 0) + 1e-9 >= Number(extraDue) ? ('paid' as const) : ('partial' as const),
          }
        : (tierChanged || breakfastChanged) && tier
        ? manualExempt
          ? { tier, breakfast }
          : {
              tier,
              breakfast,
              amountDue: amountForTier(settings, tier, breakfast),
              paymentStatus: initialPaymentStatus(settings, tier, breakfast),
            }
        : {};
    const free = tier ? settings.tiers[tier].amount === 0 : false;
    const usernameChanged = patch.telegramUsername !== undefined && patch.telegramUsername !== before.telegramUsername;
    const [row] = await tx
      .update(schema.participants)
      .set({
        ...pricing,
        church: next.church ?? null,
        paymentMethod: free ? null : ((next.paymentMethod as string | null | undefined) ?? null),
        telegramUsername: before.relation === 'self' ? null : (next.telegramUsername ?? null),
        // Новый ник - старую связь снимаем, дальше узнаем заново.
        ...(usernameChanged && before.telegramUsername && before.holderUserId !== null ? { holderUserId: null } : {}),
        lastName: next.lastName,
        firstName: next.firstName,
        middleName: next.middleName ?? null,
        birthDate: next.birthDate,
        gender: next.gender,
        city: next.city,
        phone: next.phone ?? null,
        personKey: personKey(next),
        updatedAt: new Date(),
      })
      .where(eq(schema.participants.id, participantId))
      .returning();
    await audit(tx, {
      actorUserId: user.id,
      action: 'participant.self_update',
      entity: 'participant',
      entityId: participantId,
      before,
      after: row,
    });
    if (usernameChanged && row?.telegramUsername) await linkNewParticipants(ctx, tx, [row.id]);
    // Поменялось то, что напечатано на QR (вариант, завтрак, ФИО), - в чат придёт актуальный QR-код.
    const onQr = (r: ParticipantRow) => [r.tier, r.breakfast, r.lastName, r.firstName, r.middleName ?? null].join('|');
    if (row && row.status === 'active' && onQr(row) !== onQr(before)) await enqueueTicketsUpdated(tx, ctx.boss, row);
    return row!;
  }
}

/**
 * Смена способа оплаты (перевод ↔ наличные) - своим и переданным мне участникам, пока взнос не внесён
 * и чек не на проверке. Регистрация при этом может быть уже закрыта.
 */
export async function changePaymentMethod(
  ctx: Pick<AppContext, 'db' | 'config'>,
  user: UserRow,
  participantId: number,
  method: RegPaymentMethod,
): Promise<MyParticipant> {
  const settings = await getSettings(ctx.db);
  if (method === 'transfer' && !settings.transfersEnabled) {
    throw badRequest('transfers_disabled', 'Сейчас взнос принимается только наличными');
  }
  const updated = await ctx.db.transaction(async (tx) => {
    const before = await tx.query.participants.findFirst({ where: eq(schema.participants.id, participantId) });
    if (!before || (before.ownerUserId !== user.id && before.holderUserId !== user.id)) throw notFound('Участник не найден');
    if (before.status !== 'active') throw badRequest('participant_cancelled', 'Регистрация этого участника отменена');
    if (before.paymentStatus === 'paid' || before.paymentStatus === 'exempt') {
      throw badRequest('already_paid', 'Взнос уже внесён - менять ничего не нужно');
    }
    if (before.paymentStatus === 'pending') {
      throw badRequest('receipt_pending', 'Чек уже на проверке - дождитесь ответа организаторов');
    }
    if (before.paymentMethod === method) return before;
    const [row] = await tx
      .update(schema.participants)
      .set({ paymentMethod: method, updatedAt: new Date() })
      .where(eq(schema.participants.id, participantId))
      .returning();
    await audit(tx, {
      actorUserId: user.id,
      action: 'participant.payment_method',
      entity: 'participant',
      entityId: participantId,
      before: { paymentMethod: before.paymentMethod },
      after: { paymentMethod: method },
    });
    return row!;
  });
  return toMyParticipant(ctx, updated, user.id, settings);
}

/** Отмена своей регистрации: билет отзывается, записи на активности снимаются (очереди продвигаются). */
export async function cancelOwnParticipant(ctx: Pick<AppContext, 'db' | 'boss'>, user: UserRow, participantId: number) {
  await ctx.db.transaction(async (tx) => {
    const before = await ownParticipant(tx, user.id, participantId);
    await tx
      .update(schema.participants)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(schema.participants.id, participantId));
    await revokeActiveTicket(tx, participantId, 'cancelled');
    await tx.delete(schema.counselingBookings).where(eq(schema.counselingBookings.participantId, participantId));
    const regs = await tx
      .select({ activityId: schema.activityRegistrations.activityId })
      .from(schema.activityRegistrations)
      .where(
        and(
          eq(schema.activityRegistrations.participantId, participantId),
          sql`${schema.activityRegistrations.status} in ('registered', 'waitlist')`,
        ),
      )
      // Тот же порядок блокировок, что у перезаписи (по id активности), - без взаимоблокировок.
      .orderBy(schema.activityRegistrations.activityId);
    for (const { activityId } of regs) {
      const res = await tx.execute<{ promoted: number[] }>(
        sql`select promoted from cancel_activity_registration(${activityId}, ${participantId})`,
      );
      const promoted = (res.rows[0]?.promoted ?? []).map(Number);
      if (promoted.length > 0) {
        await enqueue(ctx.boss, 'activity.promoted', { activityId, participantIds: promoted }, { tx });
      }
    }
    await audit(tx, {
      actorUserId: user.id,
      action: 'participant.self_cancel',
      entity: 'participant',
      entityId: participantId,
      before,
    });
  });
}

/** Ссылка, по которой билет можно забрать в другой Telegram (брат, сестра, взрослый ребёнок). */
export async function createTransferLink(
  ctx: Pick<AppContext, 'db' | 'config'>,
  user: UserRow,
  participantId: number,
): Promise<TransferLinkResponse> {
  await ownParticipant(ctx.db, user.id, participantId);
  const token = randomToken(18);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
  await ctx.db.insert(schema.oneTimeTokens).values({
    tokenHash: sha256Hex(token),
    purpose: 'ticket_claim',
    payload: { participantId },
    createdBy: user.id,
    expiresAt,
  });
  return { link: botLink(ctx.config, `claim_${token}`), expiresAt: expiresAt.toISOString() };
}

/**
 * Забрать билет по ссылке. Код не меняется: владелец тоже продолжает видеть билет,
 * а закреплённая у него картинка остаётся рабочей.
 */
export async function claimTicket(
  ctx: Pick<AppContext, 'db' | 'boss'>,
  token: string,
  claimer: UserRow,
): Promise<{ participantId: number; ownerUserId: number; fullName: string }> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.oneTimeTokens)
      .set({ uses: sql`${schema.oneTimeTokens.uses} + 1`, lastUsedBy: claimer.id, lastUsedAt: new Date() })
      .where(
        and(
          eq(schema.oneTimeTokens.tokenHash, sha256Hex(token)),
          eq(schema.oneTimeTokens.purpose, 'ticket_claim'),
          gt(schema.oneTimeTokens.expiresAt, sql`now()`),
          sql`${schema.oneTimeTokens.uses} < ${schema.oneTimeTokens.maxUses}`,
        ),
      )
      .returning();
    if (!row) throw new AppError(410, 'link_expired', 'Ссылка недействительна или уже использована');
    const participantId = Number((row.payload as { participantId: number }).participantId);
    const p = await tx.query.participants.findFirst({ where: eq(schema.participants.id, participantId) });
    if (!p || p.status !== 'active') throw new AppError(410, 'link_expired', 'Этот билет больше недействителен');
    if (p.ownerUserId === claimer.id) throw badRequest('own_ticket', 'Это ваш собственный билет');
    await tx
      .update(schema.participants)
      .set({ holderUserId: claimer.id, updatedAt: new Date() })
      .where(eq(schema.participants.id, participantId));
    await enqueue(ctx.boss, 'tickets.send', { userId: claimer.id, participantIds: [participantId], reason: 'claimed' }, { tx });
    await audit(tx, {
      actorUserId: claimer.id,
      action: 'ticket.claim',
      entity: 'participant',
      entityId: participantId,
      before: { holderUserId: p.holderUserId },
      after: { holderUserId: claimer.id },
    });
    return { participantId, ownerUserId: p.ownerUserId, fullName: fullName(p) };
  });
}
