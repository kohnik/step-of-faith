import { TIERS, ageOn, fullName, type GuestRegistration, type RegistrationResult, type RegistrationSubmit } from '@sof/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { AppError, badRequest, conflict } from '../lib/errors.ts';
import { personKey } from '../lib/person-key.ts';
import { findRegisteredByOther } from './claim.service.ts';
import { getSettings, isRegistrationOpen } from './settings.service.ts';
import { linkNewParticipants } from './link.service.ts';
import {
  ageRefDate,
  amountForTier,
  assertBreakfastOffered,
  assertBreakfastRoom,
  assertTierOffered,
  assertTierRoom,
  initialPaymentStatus,
  withBreakfast,
} from './tiers.ts';
import { issueTicket } from './tickets.service.ts';
import type { UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;

/**
 * Регистрация одной отправкой формы («я» + семья).
 *
 * Идемпотентна по `idempotencyKey`: двойной тап, ретрай на плохой сети или повторная отправка
 * возвращают тот же результат. Параллельный запрос с тем же ключом ждёт на первичном ключе
 * `registration_requests`, пока первый не закоммитится, и получает его результат.
 * Запросы одного аккаунта сериализуются блокировкой строки пользователя - так лимит
 * «N человек на аккаунт» не обойти параллельными отправками.
 */
export async function submitRegistration(
  ctx: Ctx,
  user: UserRow,
  input: RegistrationSubmit,
): Promise<RegistrationResult> {
  const settings = await getSettings(ctx.db);
  const payloadHash = sha256Hex(JSON.stringify({ participants: input.participants, consent: input.consent }));

  const outcome = await ctx.db.transaction(async (tx) => {
    // Блокировка аккаунта - первой: FK-проверки ниже берут KEY SHARE на ту же строку,
    // а FOR NO KEY UPDATE с ними совместим (обычный FOR UPDATE давал взаимоблокировку).
    await tx.execute(sql`select 1 from ${schema.users} where ${schema.users.id} = ${user.id} for no key update`);

    const claimed = await tx
      .insert(schema.registrationRequests)
      .values({ idempotencyKey: input.idempotencyKey, userId: user.id, payloadSha256: payloadHash })
      .onConflictDoNothing()
      .returning({ key: schema.registrationRequests.idempotencyKey });
    if (claimed.length === 0) return { kind: 'replay' as const };

    if (!isRegistrationOpen(settings)) throw badRequest('registration_closed', 'Регистрация сейчас закрыта');

    // «Я» уже записан с другого аккаунта - предлагаем забрать ту регистрацию, а не заводить вторую.
    const self = input.participants.find((p) => p.relation === 'self');
    if (self?.phone && !input.notDuplicate) {
      const other = await findRegisteredByOther(tx, user.id, { ...self, phone: self.phone });
      if (other) {
        throw conflict('registered_by_other', `Похоже, вас уже зарегистрировал(а) ${other.registeredBy}`, other);
      }
    }

    if (settings.totalCapacity) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sof:registration_capacity'))`);
    }

    const existing = await tx
      .select({ personKey: schema.participants.personKey, relation: schema.participants.relation })
      .from(schema.participants)
      .where(and(eq(schema.participants.ownerUserId, user.id), ne(schema.participants.status, 'cancelled')));
    const taken = new Set(existing.map((r) => r.personKey));

    const toCreate: { input: RegistrationSubmit['participants'][number]; key: string }[] = [];
    const skipped: RegistrationResult['skipped'] = [];
    for (const p of input.participants) {
      const key = personKey(p);
      if (taken.has(key)) {
        skipped.push({ fullName: fullName(p), reason: 'already_registered' });
        continue;
      }
      taken.add(key);
      toCreate.push({ input: p, key });
    }
    // «Я» в аккаунте один: второго, с другими данными, не заводим (свои данные правят в карточке).
    if (toCreate.some((c) => c.input.relation === 'self') && existing.some((r) => r.relation === 'self')) {
      throw badRequest('self_exists', 'Вы уже зарегистрированы. Других людей добавьте как друзей или родственников.');
    }

    const max = settings.maxParticipantsPerAccount;
    if (existing.length + toCreate.length > max) {
      throw badRequest('too_many_participants', `С одного аккаунта можно зарегистрировать не больше ${max} человек`, {
        max,
        current: existing.length,
      });
    }

    if (settings.totalCapacity && toCreate.length > 0) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.participants)
        .where(eq(schema.participants.status, 'active'));
      const left = settings.totalCapacity - (row?.n ?? 0);
      if (toCreate.length > left) {
        throw conflict('capacity_full', left > 0 ? `Осталось мест: ${left}` : 'Все места заняты', { left });
      }
    }

    // Лимиты вариантов (например, 250 обедов) и завтраков. Всегда в одном порядке, чтобы блокировки не встречались.
    // Выключенный в настройках вариант или завтрак - не записываем.
    for (const tier of TIERS) {
      const adding = toCreate.filter((c) => c.input.tier === tier).length;
      if (adding > 0) assertTierOffered(settings, tier);
      await assertTierRoom(tx, settings, tier, adding);
    }
    const breakfasts = toCreate.filter((c) => withBreakfast(c.input.tier, c.input.breakfast)).length;
    if (breakfasts > 0) assertBreakfastOffered(settings);
    await assertBreakfastRoom(tx, settings, breakfasts);

    const created: RegistrationResult['created'] = [];
    let selfId: number | null = null;
    for (const { input: p, key } of toCreate) {
      const [row] = await tx
        .insert(schema.participants)
        .values({
          ownerUserId: user.id,
          lastName: p.lastName,
          firstName: p.firstName,
          middleName: p.middleName ?? null,
          birthDate: p.birthDate,
          gender: p.gender,
          city: p.city,
          church: p.church,
          phone: p.phone ?? null,
          // Свой ник не храним: этот аккаунт и так владелец.
          telegramUsername: p.relation === 'self' ? null : (p.telegramUsername ?? null),
          relation: p.relation,
          // «Ребёнок» - только несовершеннолетний: взрослого сына сканер не должен показывать ребёнком.
          category: p.relation === 'child' && ageOn(p.birthDate, ageRefDate(settings)) < 18 ? 'child' : 'participant',
          tier: p.tier,
          breakfast: withBreakfast(p.tier, p.breakfast),
          // Переводы выключены - только наличные, что бы ни пришло из старой формы.
          paymentMethod: settings.tiers[p.tier].amount > 0 ? (settings.transfersEnabled ? (p.paymentMethod ?? 'cash') : 'cash') : null,
          amountDue: amountForTier(settings, p.tier, withBreakfast(p.tier, p.breakfast)),
          paymentStatus: initialPaymentStatus(settings, p.tier, withBreakfast(p.tier, p.breakfast)),
          personKey: key,
        })
        .onConflictDoNothing()
        .returning({ id: schema.participants.id });
      if (!row) {
        skipped.push({ fullName: fullName(p), reason: 'already_registered' });
        continue;
      }
      if (p.relation === 'self') selfId = row.id;
      const ticket = await issueTicket(tx, row.id);
      {
        const consentRows: (typeof schema.consents.$inferInsert)[] = [
          { participantId: row.id, givenByUserId: user.id, kind: 'pd', documentVersion: input.consent.documentVersion },
        ];
        if (input.consent.photo && settings.photoConsentEnabled) {
          consentRows.push({
            participantId: row.id,
            givenByUserId: user.id,
            kind: 'photo',
            documentVersion: input.consent.documentVersion,
          });
        }
        await tx.insert(schema.consents).values(consentRows);
      }
      created.push({ id: row.id, fullName: fullName(p), ticketCode: ticket.code });
    }

    // «Готов(а) оплатить за того, у кого нет возможности» - одна галочка на анкету, от того, кто заполняет:
    // ставим её его «Я» (новому или уже зарегистрированному), а без «Я» - первому новому человеку.
    if (input.sponsorOffer) {
      let target = selfId;
      if (target === null) {
        const [own] = await tx
          .select({ id: schema.participants.id })
          .from(schema.participants)
          .where(
            and(
              eq(schema.participants.ownerUserId, user.id),
              eq(schema.participants.relation, 'self'),
              ne(schema.participants.status, 'cancelled'),
            ),
          )
          .limit(1);
        target = own?.id ?? created[0]?.id ?? null;
      }
      if (target !== null) {
        await tx.update(schema.participants).set({ sponsorOffer: true }).where(eq(schema.participants.id, target));
      }
    }

    const result: RegistrationResult = { created, skipped };
    await tx
      .update(schema.registrationRequests)
      .set({ result })
      .where(eq(schema.registrationRequests.idempotencyKey, input.idempotencyKey));

    if (created.length > 0) {
      await enqueue(
        ctx.boss,
        'tickets.send',
        { userId: user.id, participantIds: created.map((c) => c.id), reason: 'registered' },
        { tx },
      );
      await linkNewParticipants(ctx, tx, created.map((c) => c.id));
      await audit(tx, {
        actorUserId: user.id,
        action: 'registration.submit',
        entity: 'user',
        entityId: user.id,
        after: { participantIds: created.map((c) => c.id) },
      });
    }
    return { kind: 'done' as const, result };
  });

  if (outcome.kind === 'done') return outcome.result;
  return replayed(ctx, user, input.idempotencyKey, payloadHash);
}

/** Повтор того же запроса: результат первого, если ключ и данные те же. */
async function replayed(ctx: Ctx, user: UserRow, idempotencyKey: string, payloadHash: string): Promise<RegistrationResult> {
  const row = await ctx.db.query.registrationRequests.findFirst({
    where: eq(schema.registrationRequests.idempotencyKey, idempotencyKey),
  });
  if (!row || row.userId !== user.id || row.payloadSha256 !== payloadHash) {
    throw new AppError(422, 'idempotency_mismatch', 'Этот ключ запроса уже использован с другими данными');
  }
  if (!row.result) throw conflict('in_progress', 'Запрос ещё обрабатывается, попробуйте через пару секунд');
  return row.result as RegistrationResult;
}

/**
 * «Гость» на месте (день конференции): Ф.И., телефон, пол - только за себя, вариант «Только взнос»,
 * без питания. Работает, пока в настройках включена регистрация на месте. Даты рождения и города нет.
 */
export async function submitGuestRegistration(ctx: Ctx, user: UserRow, input: GuestRegistration): Promise<RegistrationResult> {
  const settings = await getSettings(ctx.db);
  const person = { lastName: input.lastName, firstName: input.firstName, phone: input.phone!, gender: input.gender };
  const payloadHash = sha256Hex(JSON.stringify({ guest: person, consent: input.consent }));
  const tier = 'fee10' as const;

  const outcome = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${schema.users} where ${schema.users.id} = ${user.id} for no key update`);
    const claimed = await tx
      .insert(schema.registrationRequests)
      .values({ idempotencyKey: input.idempotencyKey, userId: user.id, payloadSha256: payloadHash })
      .onConflictDoNothing()
      .returning({ key: schema.registrationRequests.idempotencyKey });
    if (claimed.length === 0) return { kind: 'replay' as const };

    if (!settings.onSiteRegistration) throw badRequest('registration_closed', 'Регистрация на месте сейчас закрыта');
    if (!input.notDuplicate) {
      const other = await findRegisteredByOther(tx, user.id, person);
      if (other) throw conflict('registered_by_other', `Похоже, вас уже зарегистрировал(а) ${other.registeredBy}`, other);
    }
    if (settings.totalCapacity) await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sof:registration_capacity'))`);

    const existing = await tx
      .select({ relation: schema.participants.relation })
      .from(schema.participants)
      .where(and(eq(schema.participants.ownerUserId, user.id), ne(schema.participants.status, 'cancelled')));
    if (existing.some((r) => r.relation === 'self')) {
      throw badRequest('self_exists', 'Вы уже зарегистрированы - QR-код в разделе «Мои QR-коды».');
    }
    if (existing.length + 1 > settings.maxParticipantsPerAccount) {
      throw badRequest('too_many_participants', `С одного аккаунта можно зарегистрировать не больше ${settings.maxParticipantsPerAccount} человек`);
    }
    if (settings.totalCapacity) {
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.participants).where(eq(schema.participants.status, 'active'));
      if ((row?.n ?? 0) >= settings.totalCapacity) throw conflict('capacity_full', 'Все места заняты', { left: 0 });
    }
    await assertTierRoom(tx, settings, tier, 1);

    const [row] = await tx
      .insert(schema.participants)
      .values({
        ownerUserId: user.id,
        lastName: person.lastName,
        firstName: person.firstName,
        birthDate: null,
        gender: person.gender,
        city: null,
        church: null,
        phone: person.phone,
        relation: 'self',
        category: 'participant',
        tier,
        breakfast: false,
        paymentMethod: settings.tiers[tier].amount > 0 ? 'cash' : null,
        amountDue: amountForTier(settings, tier, false),
        paymentStatus: initialPaymentStatus(settings, tier, false),
        personKey: personKey({ ...person, birthDate: null }),
        onSite: true,
      })
      .returning({ id: schema.participants.id });
    const ticket = await issueTicket(tx, row!.id);
    await tx
      .insert(schema.consents)
      .values({ participantId: row!.id, givenByUserId: user.id, kind: 'pd', documentVersion: input.consent.documentVersion });
    const result: RegistrationResult = { created: [{ id: row!.id, fullName: fullName(person), ticketCode: ticket.code }], skipped: [] };
    await tx.update(schema.registrationRequests).set({ result }).where(eq(schema.registrationRequests.idempotencyKey, input.idempotencyKey));
    await enqueue(ctx.boss, 'tickets.send', { userId: user.id, participantIds: [row!.id], reason: 'registered' }, { tx });
    await linkNewParticipants(ctx, tx, [row!.id]);
    await audit(tx, { actorUserId: user.id, action: 'registration.guest', entity: 'user', entityId: user.id, after: { participantIds: [row!.id] } });
    return { kind: 'done' as const, result };
  });
  if (outcome.kind === 'done') return outcome.result;
  return replayed(ctx, user, input.idempotencyKey, payloadHash);
}

/** Участники, которых видит аккаунт: свои и переданные ему. */
export async function familyParticipants(ctx: Pick<AppContext, 'db'>, userId: number) {
  return ctx.db.query.participants.findMany({
    where: (p, { or, eq: e }) => or(e(p.ownerUserId, userId), e(p.holderUserId, userId)),
    orderBy: (p, { asc }) => [asc(p.id)],
  });
}

export async function assertFamilyMember(ctx: Pick<AppContext, 'db'>, userId: number, participantId: number) {
  const p = await ctx.db.query.participants.findFirst({ where: eq(schema.participants.id, participantId) });
  if (!p || (p.ownerUserId !== userId && p.holderUserId !== userId)) {
    throw new AppError(404, 'not_found', 'Участник не найден');
  }
  return p;
}

export async function activeFamilyIds(ctx: Pick<AppContext, 'db'>, userIds: number[]): Promise<number[]> {
  if (userIds.length === 0) return [];
  const rows = await ctx.db
    .select({ id: schema.participants.id })
    .from(schema.participants)
    .where(
      and(
        eq(schema.participants.status, 'active'),
        sql`(${inArray(schema.participants.ownerUserId, userIds)} or ${inArray(schema.participants.holderUserId, userIds)})`,
      ),
    );
  return rows.map((r) => r.id);
}
