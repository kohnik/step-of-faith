import {
  COUNSELOR_AUDIENCE_LABELS,
  fullName,
  type CounselingAdminView,
  type CounselingBookRequest,
  type CounselingPublic,
  type CounselorAdminView,
  type CounselorInput,
  type CounselorAudience,
  type CounselorUpdate,
  type Gender,
} from '@sof/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { esc, fmtDateTime, fmtTime } from '../bot/format.ts';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors.ts';
import { roomIdByName } from './activity.service.ts';
import { activeFamilyIds, assertFamilyMember } from './registration.service.ts';
import type { StaffPrincipal } from './sessions.service.ts';
import { getSettings, updateSettings } from './settings.service.ts';
import type { UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;
type CounselorRow = typeof schema.counselors.$inferSelect;

/** Больше окошек у одного служителя не бывает - защищает от окна «на неделю» по 5 минут. */
const MAX_SLOTS = 96;

/** Начала окошек: от начала окна шагом slot_minutes; последнее окошко целиком помещается в окно. */
export function slotStarts(c: { startsAt: Date; endsAt: Date; slotMinutes: number }): Date[] {
  const out: Date[] = [];
  const step = c.slotMinutes * 60_000;
  for (let t = c.startsAt.getTime(); t + step <= c.endsAt.getTime() && out.length < MAX_SLOTS; t += step) out.push(new Date(t));
  return out;
}

function validateWindow(c: { startsAt: Date; endsAt: Date; slotMinutes: number }) {
  if (c.endsAt <= c.startsAt) throw badRequest('invalid_time', 'Окончание раньше начала');
  const count = Math.floor((c.endsAt.getTime() - c.startsAt.getTime()) / (c.slotMinutes * 60_000));
  if (count < 1) throw badRequest('invalid_time', 'В окно не помещается ни одного окошка');
  if (count > MAX_SLOTS) throw badRequest('too_many_slots', `Слишком много окошек (${count}) - сократите окно или увеличьте окошко`);
}

async function counselorRow(db: DbLike, id: number): Promise<CounselorRow> {
  const c = await db.query.counselors.findFirst({ where: eq(schema.counselors.id, id) });
  if (!c) throw notFound('Служитель не найден');
  return c;
}

/** Метки без повторов и пустых: «Для пар» и «для пар» - одна метка. */
function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

/** Служитель принимает только девушек (или только парней) - человек другого пола записаться не может. */
const audienceFits = (audience: string, gender: string) => audience === 'all' || audience === gender;

function audienceRefusal(audience: string): string {
  return audience === 'f' ? 'Этот служитель принимает только девушек - выберите другого' : 'Этот служитель принимает только парней - выберите другого';
}

const where = (c: { name: string; place: string | null }) => `${esc(c.name)}${c.place ? ` · ${esc(c.place)}` : ''}`;

/** «Для: Аня» - только если на аккаунте несколько человек, иначе и так понятно, о ком речь. */
async function forLine(ctx: Ctx, userId: number, p: { firstName: string }): Promise<string> {
  return (await activeFamilyIds(ctx, [userId])).length > 1 ? `\n👤 Для: ${esc(p.firstName)}` : '';
}

interface BookingInfo {
  id: number;
  slotStart: Date;
  participantId: number;
}

/** Сообщить людям об отменённых записях: текст собираем сейчас - строк записи уже не будет. */
async function notifyCancelled(ctx: Ctx, c: { name: string; place: string | null }, all: BookingInfo[], reason: string) {
  // Окошко уже прошло - писать об отмене незачем.
  const bookings = all.filter((b) => b.slotStart.getTime() > Date.now());
  if (bookings.length === 0) return;
  const settings = await getSettings(ctx.db);
  const tz = settings.eventTimezone;
  const people = await ctx.db.query.participants.findMany({
    where: inArray(
      schema.participants.id,
      bookings.map((b) => b.participantId),
    ),
  });
  for (const b of bookings) {
    const p = people.find((x) => x.id === b.participantId);
    if (!p || p.status !== 'active') continue;
    const userId = p.holderUserId ?? p.ownerUserId;
    await enqueue(ctx.boss, 'notify.text', {
      kind: 'counseling.changed',
      userId,
      text:
        `❗️ <b>Запись отменена: ${esc(settings.counselingTitle)}</b>\n${fmtDateTime(b.slotStart, tz)} · ${where(c)}${await forLine(ctx, userId, p)}\n\n` +
        reason,
    });
  }
}

// ---------- участник ----------

/** Служители с окошками. Занятые чужими - просто «занято», свои - с id человека. */
export async function publicCounseling(ctx: Pick<AppContext, 'db'>, userId: number): Promise<CounselingPublic> {
  const settings = await getSettings(ctx.db);
  const family = new Set(await activeFamilyIds(ctx, [userId]));
  // Скрытых служителей участник не видит (и записаться к ним не может).
  const counselors = await ctx.db.query.counselors.findMany({
    where: eq(schema.counselors.hidden, false),
    orderBy: [asc(schema.counselors.startsAt), asc(schema.counselors.id)],
  });
  const bookings = counselors.length
    ? await ctx.db
        .select()
        .from(schema.counselingBookings)
        .where(
          inArray(
            schema.counselingBookings.counselorId,
            counselors.map((c) => c.id),
          ),
        )
    : [];
  return {
    open: settings.counselingOpen,
    counselors: counselors.map((c) => {
      const taken = new Map(bookings.filter((b) => b.counselorId === c.id).map((b) => [b.slotStart.getTime(), b.participantId]));
      return {
        id: c.id,
        name: c.name,
        place: c.place,
        startsAt: c.startsAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        slotMinutes: c.slotMinutes,
        audience: c.audience as CounselorAudience,
        tags: c.tags,
        slots: slotStarts(c).map((s) => {
          const pid = taken.get(s.getTime());
          return { start: s.toISOString(), taken: pid !== undefined, participantId: pid !== undefined && family.has(pid) ? pid : null };
        }),
      };
    }),
    my: bookings
      .filter((b) => family.has(b.participantId))
      .map((b) => ({ participantId: b.participantId, counselorId: b.counselorId, slotStart: b.slotStart.toISOString() })),
  };
}

/** Записать человека на окошко. Уже записан - переносим: у человека одна запись. */
export async function bookCounseling(ctx: Ctx, user: UserRow, req: CounselingBookRequest): Promise<CounselingPublic> {
  const p = await assertFamilyMember(ctx, user.id, req.participantId);
  if (p.status !== 'active') throw notFound('Участник не найден');
  const settings = await getSettings(ctx.db);
  if (!settings.counselingOpen) {
    throw conflict('not_open', `${settings.counselingTitle}: запись сейчас закрыта`);
  }
  const c = await counselorRow(ctx.db, req.counselorId);
  if (c.hidden) throw notFound('Служитель не найден');
  if (!audienceFits(c.audience, p.gender)) throw badRequest('counselor_audience', audienceRefusal(c.audience));
  const start = new Date(req.slotStart);
  if (!slotStarts(c).some((s) => s.getTime() === start.getTime())) throw badRequest('invalid_slot', 'Такого окошка нет - обновите экран');
  if (start.getTime() <= Date.now()) throw conflict('slot_past', 'Это время уже прошло - выберите другое');

  const current = await ctx.db.query.counselingBookings.findFirst({
    where: eq(schema.counselingBookings.participantId, req.participantId),
  });
  if (current && current.counselorId === c.id && current.slotStart.getTime() === start.getTime()) {
    return publicCounseling(ctx, user.id);
  }
  try {
    await ctx.db.transaction(async (tx) => {
      // Прежняя запись освобождается только вместе с новой: окошко заняли - останется старая.
      if (current) await tx.delete(schema.counselingBookings).where(eq(schema.counselingBookings.id, current.id));
      const [row] = await tx
        .insert(schema.counselingBookings)
        .values({ counselorId: c.id, slotStart: start, participantId: req.participantId, bookedBy: user.id })
        .returning();
      await enqueue(ctx.boss, 'counseling.booked', { bookingId: row!.id }, { tx });
      const remindAt = new Date(start.getTime() - 15 * 60_000);
      if (remindAt.getTime() > Date.now()) {
        await enqueue(
          ctx.boss,
          'counseling.reminder',
          { bookingId: row!.id, slotStart: start.toISOString() },
          { tx, startAfter: remindAt, singletonKey: `counseling:${row!.id}` },
        );
      }
    });
  } catch (err) {
    if (isUniqueViolation(err, 'counseling_bookings_slot_uq')) {
      throw conflict('slot_taken', 'Это время только что заняли - выберите другое');
    }
    if (isUniqueViolation(err, 'counseling_bookings_participant_uq')) {
      throw conflict('already_booked', 'Этот человек уже записан - обновите экран');
    }
    throw err;
  }
  return publicCounseling(ctx, user.id);
}

/** Отменить свою запись - можно всегда, даже когда запись закрыта. */
export async function cancelCounseling(ctx: Ctx, user: UserRow, participantId: number): Promise<CounselingPublic> {
  await assertFamilyMember(ctx, user.id, participantId);
  await ctx.db.delete(schema.counselingBookings).where(eq(schema.counselingBookings.participantId, participantId));
  return publicCounseling(ctx, user.id);
}

// ---------- админка ----------

export async function adminCounseling(db: DbLike): Promise<CounselingAdminView> {
  const settings = await getSettings(db);
  const counselors = await db.query.counselors.findMany({ orderBy: [asc(schema.counselors.startsAt), asc(schema.counselors.id)] });
  const rows = counselors.length
    ? await db
        .select({ b: schema.counselingBookings, p: schema.participants })
        .from(schema.counselingBookings)
        .innerJoin(schema.participants, eq(schema.participants.id, schema.counselingBookings.participantId))
        .where(
          inArray(
            schema.counselingBookings.counselorId,
            counselors.map((c) => c.id),
          ),
        )
        .orderBy(asc(schema.counselingBookings.slotStart))
    : [];
  return {
    open: settings.counselingOpen,
    counselors: counselors.map(
      (c): CounselorAdminView => ({
        id: c.id,
        name: c.name,
        place: c.place,
        roomId: c.roomId,
        hidden: c.hidden,
        audience: c.audience as CounselorAudience,
        tags: c.tags,
        startsAt: c.startsAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        slotMinutes: c.slotMinutes,
        slots: slotStarts(c).map((s) => s.toISOString()),
        bookings: rows
          .filter((r) => r.b.counselorId === c.id)
          .map((r) => ({
            id: r.b.id,
            slotStart: r.b.slotStart.toISOString(),
            participantId: r.p.id,
            fullName: fullName(r.p),
            gender: r.p.gender as Gender,
            phone: r.p.phone,
            telegramUsername: r.p.telegramUsername,
            createdAt: r.b.createdAt.toISOString(),
          })),
      }),
    ),
  };
}

export async function setCounselingOpen(db: DbLike, open: boolean, actor: StaffPrincipal): Promise<CounselingAdminView> {
  const settings = await getSettings(db, { fresh: true });
  if (settings.counselingOpen !== open) await updateSettings(db, { ...settings, counselingOpen: open }, actor.user.id);
  return adminCounseling(db);
}

export async function createCounselor(ctx: Ctx, input: CounselorInput, actor: StaffPrincipal): Promise<CounselingAdminView> {
  const values = {
    name: input.name,
    place: input.place?.trim() || null,
    roomId: await roomIdByName(ctx.db, input.place),
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    slotMinutes: input.slotMinutes,
    hidden: input.hidden,
    audience: input.audience,
    tags: cleanTags(input.tags),
  };
  validateWindow(values);
  const [row] = await ctx.db.insert(schema.counselors).values(values).returning();
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'counselor.create', entity: 'counselor', entityId: row!.id, after: row });
  return adminCounseling(ctx.db);
}

/**
 * Изменить служителя. Записи, которые больше не попадают в окошки (сдвинули время или длину), отменяются
 * с сообщением; сменилось место - оставшимся записанным сообщаем новое.
 */
export async function updateCounselor(ctx: Ctx, id: number, patch: CounselorUpdate, actor: StaffPrincipal): Promise<CounselingAdminView> {
  const before = await counselorRow(ctx.db, id);
  const place = patch.place !== undefined ? patch.place?.trim() || null : before.place;
  const next = {
    name: patch.name ?? before.name,
    place,
    roomId: patch.place !== undefined ? await roomIdByName(ctx.db, place) : before.roomId,
    startsAt: patch.startsAt ? new Date(patch.startsAt) : before.startsAt,
    endsAt: patch.endsAt ? new Date(patch.endsAt) : before.endsAt,
    slotMinutes: patch.slotMinutes ?? before.slotMinutes,
    // Скрыть/показать не трогает время: окошки и записи остаются как были.
    hidden: patch.hidden ?? before.hidden,
    audience: patch.audience ?? before.audience,
    tags: patch.tags ? cleanTags(patch.tags) : before.tags,
  };
  validateWindow(next);
  const valid = new Set(slotStarts(next).map((s) => s.getTime()));
  const bookings = await ctx.db.query.counselingBookings.findMany({ where: eq(schema.counselingBookings.counselorId, id) });
  // Служитель теперь принимает только девушек (или парней) - записи другого пола отменяем с сообщением.
  const genders =
    next.audience === before.audience || next.audience === 'all' || bookings.length === 0
      ? new Map<number, string>()
      : new Map(
          (
            await ctx.db
              .select({ id: schema.participants.id, gender: schema.participants.gender })
              .from(schema.participants)
              .where(inArray(schema.participants.id, bookings.map((b) => b.participantId)))
          ).map((p) => [p.id, p.gender]),
        );
  const misfit = (b: (typeof bookings)[number]) => genders.has(b.participantId) && !audienceFits(next.audience, genders.get(b.participantId)!);
  const dropped = bookings.filter((b) => !valid.has(b.slotStart.getTime()) && !misfit(b));
  const refused = bookings.filter((b) => misfit(b));
  const kept = bookings.filter((b) => valid.has(b.slotStart.getTime()) && !misfit(b));
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(schema.counselors)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(schema.counselors.id, id));
    if (dropped.length || refused.length) {
      await tx.delete(schema.counselingBookings).where(
        inArray(
          schema.counselingBookings.id,
          [...dropped, ...refused].map((b) => b.id),
        ),
      );
    }
    await audit(tx, { actorUserId: actor.user.id, action: 'counselor.update', entity: 'counselor', entityId: id, before, after: next });
  });
  await notifyCancelled(ctx, before, dropped, 'Время служителя изменилось - выберите другое окошко в приложении.');
  if (next.audience !== 'all') {
    const label = COUNSELOR_AUDIENCE_LABELS[next.audience as Exclude<CounselorAudience, 'all'>].toLowerCase();
    await notifyCancelled(ctx, before, refused, `Служитель теперь принимает ${label.replace('для ', 'только ')} - выберите другого в приложении.`);
  }
  // Новое место - только тем, чьё окошко ещё впереди.
  const upcoming = kept.filter((b) => b.slotStart.getTime() > Date.now());
  if (place !== before.place && upcoming.length) {
    const settings = await getSettings(ctx.db);
    const tz = settings.eventTimezone;
    const people = await ctx.db.query.participants.findMany({
      where: inArray(
        schema.participants.id,
        upcoming.map((b) => b.participantId),
      ),
    });
    for (const b of upcoming) {
      const p = people.find((x) => x.id === b.participantId);
      if (!p || p.status !== 'active') continue;
      const userId = p.holderUserId ?? p.ownerUserId;
      await enqueue(ctx.boss, 'notify.text', {
        kind: 'counseling.changed',
        userId,
        text:
          // Места не было - «место назначено», было другое - «в другом месте».
          `${before.place ? `❗️ <b>${esc(settings.counselingTitle)} - в другом месте</b>` : `📍 <b>${esc(settings.counselingTitle)} - место назначено</b>`}\n${fmtDateTime(b.slotStart, tz)} · ${esc(next.name)} · ` +
          `<b>${esc(place ?? 'место уточните у организаторов')}</b>${await forLine(ctx, userId, p)}`,
      });
    }
  }
  return adminCounseling(ctx.db);
}

/** Удалить служителя; записанным к нему - сообщение. */
export async function deleteCounselor(ctx: Ctx, id: number, actor: StaffPrincipal): Promise<CounselingAdminView> {
  const c = await counselorRow(ctx.db, id);
  const bookings = await ctx.db.query.counselingBookings.findMany({ where: eq(schema.counselingBookings.counselorId, id) });
  await ctx.db.transaction(async (tx) => {
    await tx.delete(schema.counselors).where(eq(schema.counselors.id, id));
    await audit(tx, { actorUserId: actor.user.id, action: 'counselor.delete', entity: 'counselor', entityId: id, before: c });
  });
  await notifyCancelled(ctx, c, bookings, 'Служитель не сможет принять - выберите другого в приложении.');
  return adminCounseling(ctx.db);
}

/**
 * «Напомнить всем»: записанным, у кого окошко ещё впереди (ко всем служителям или к одному), - их время, служитель и место.
 * Одно сообщение на аккаунт. Возвращает, сколько записей напомним.
 */
export async function announceCounseling(ctx: Ctx, counselorId: number | null, actor: StaffPrincipal): Promise<{ bookings: number }> {
  if (counselorId) await counselorRow(ctx.db, counselorId);
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.counselingBookings)
    .where(and(sql`${schema.counselingBookings.slotStart} > now()`, counselorId ? eq(schema.counselingBookings.counselorId, counselorId) : undefined));
  const bookings = row?.n ?? 0;
  if (bookings === 0) throw conflict('nobody', 'Записанных на время впереди нет - напоминать некому');
  const at = new Date().toISOString();
  await enqueue(ctx.boss, 'counseling.announce', { counselorId, at });
  await audit(ctx.db, { actorUserId: actor.user.id, action: 'counseling.announce', entity: 'counselor', entityId: counselorId ?? 0, after: { bookings } });
  return { bookings };
}

/** Админ отменил запись человека - человеку сообщение. */
export async function adminCancelBooking(ctx: Ctx, bookingId: number, actor: StaffPrincipal): Promise<CounselingAdminView> {
  const b = await ctx.db.query.counselingBookings.findFirst({ where: eq(schema.counselingBookings.id, bookingId) });
  if (!b) throw notFound('Запись не найдена');
  const c = await counselorRow(ctx.db, b.counselorId);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(schema.counselingBookings).where(eq(schema.counselingBookings.id, bookingId));
    await audit(tx, { actorUserId: actor.user.id, action: 'counseling.cancel', entity: 'counseling_booking', entityId: bookingId, before: b });
  });
  await notifyCancelled(ctx, c, [b], 'Её отменили организаторы. Можно выбрать другое время в приложении.');
  return adminCounseling(ctx.db);
}
