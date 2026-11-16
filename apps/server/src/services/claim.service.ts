import {
  fullName,
  normalizePhone,
  type ClaimableResponse,
  type ClaimCandidate,
  type ClaimResponse,
  type RegisteredByOtherDetails,
} from '@sof/shared';
import { validate } from '@tma.js/init-data-node';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema, type DbLike } from '../db/client.ts';
import { badRequest, conflict, forbidden } from '../lib/errors.ts';
import { normalizeNamePart } from '../lib/person-key.ts';
import { afterLinked } from './link.service.ts';
import type { UserRow } from './users.service.ts';

type Ctx = Pick<AppContext, 'db' | 'boss'>;

/**
 * «Меня уже зарегистрировали»: друга записали с чужого аккаунта без ника. Он делится номером
 * в Telegram - номер подтверждён самим Telegram, - и мы находим регистрации на этот номер.
 * Номер, набранный руками, для этого не годится: иначе любой, кто знает телефон и ФИО, заберёт чужой QR-код.
 */

/** Сравниваем последние 10 цифр - так совпадут и `+375…`, и номер, набранный с `80…` или без кода страны. */
export const phoneTail = (phone: string) => phone.replace(/\D/g, '').slice(-10);

/** `+375291112233` → `+375 29 111-22-33`; остальные номера - как есть. */
export function displayPhone(phone: string): string {
  const m = /^\+375(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return m ? `+375 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : phone;
}

/** Номер из Telegram (как присылает бот или Mini App) → `+…`. */
export function normalizeTelegramPhone(raw: string): string | null {
  const s = raw.trim();
  return normalizePhone(s.startsWith('+') ? s : `+${s}`);
}

/**
 * Mini App присылает ответ `requestContact` как есть: `contact=…&auth_date=…&hash=…`, подписанный
 * ботом так же, как initData. Проверяем подпись и что это номер именно этого аккаунта.
 */
export function phoneFromSignedContact(raw: string, botToken: string, tgId: number | null): string {
  try {
    validate(raw, botToken, { expiresIn: 3600 });
  } catch {
    throw badRequest('bad_contact', 'Не получилось проверить номер. Попробуйте ещё раз');
  }
  let contact: { user_id?: number; phone_number?: string } = {};
  try {
    contact = JSON.parse(new URLSearchParams(raw).get('contact') ?? '{}') as typeof contact;
  } catch {
    throw badRequest('bad_contact', 'Не получилось прочитать номер. Попробуйте ещё раз');
  }
  if (tgId == null || Number(contact.user_id) !== tgId) throw forbidden('Это номер другого аккаунта Telegram');
  const phone = normalizeTelegramPhone(contact.phone_number ?? '');
  if (!phone) throw badRequest('bad_contact', 'Не получилось прочитать номер. Попробуйте ещё раз');
  return phone;
}

/** Запоминаем подтверждённый номер аккаунта. В `users.phone` попадает только номер от Telegram. */
export async function setVerifiedPhone(db: DbLike, user: UserRow, phone: string): Promise<UserRow> {
  const [row] = await db.update(schema.users).set({ phone }).where(eq(schema.users.id, user.id)).returning();
  return row ?? { ...user, phone };
}

/** «Саша Л.»: имя из регистрации «Я» того аккаунта, иначе из Telegram. */
function shortName(first: string | null | undefined, last: string | null | undefined): string | null {
  const f = first?.trim();
  if (!f) return null;
  const l = last?.trim();
  return l ? `${f} ${l[0]!.toUpperCase()}.` : f;
}

async function registrantNames(db: DbLike, ownerIds: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (ownerIds.length === 0) return names;
  const [users, selves] = await Promise.all([
    db.query.users.findMany({ where: inArray(schema.users.id, ownerIds) }),
    db.query.participants.findMany({
      where: and(
        inArray(schema.participants.ownerUserId, ownerIds),
        eq(schema.participants.relation, 'self'),
        eq(schema.participants.status, 'active'),
      ),
    }),
  ]);
  for (const u of users) {
    const name = shortName(u.firstName, u.lastName) ?? (u.username ? `@${u.username}` : null) ?? u.displayName;
    names.set(u.id, name ?? 'другой аккаунт');
  }
  for (const p of selves) names.set(p.ownerUserId, shortName(p.firstName, p.lastName)!);
  return names;
}

/** Условие «эту регистрацию можно забрать этому аккаунту по этому номеру». */
function claimableWhere(userId: number, phone: string) {
  return and(
    sql`right(regexp_replace(coalesce(${schema.participants.phone}, ''), '\\D', '', 'g'), 10) = ${phoneTail(phone)}`,
    sql`${schema.participants.holderUserId} is null`,
    sql`${schema.participants.ownerUserId} <> ${userId}`,
    eq(schema.participants.status, 'active'),
  );
}

export async function findClaimable(db: DbLike, user: UserRow): Promise<ClaimableResponse> {
  if (!user.phone) return { phone: null, candidates: [] };
  const rows = await db.query.participants.findMany({
    where: claimableWhere(user.id, user.phone),
    orderBy: (p, { asc }) => [asc(p.id)],
    limit: 20,
  });
  const owners = await registrantNames(db, [...new Set(rows.map((r) => r.ownerUserId))]);
  const candidates: ClaimCandidate[] = rows.map((r) => ({
    id: r.id,
    fullName: fullName(r),
    registeredBy: owners.get(r.ownerUserId) ?? 'другой аккаунт',
  }));
  return { phone: user.phone, candidates };
}

/**
 * Забираем регистрации: становимся держателем, как при привязке по нику. Условие повторяем прямо
 * в UPDATE - если кто-то успел раньше, строка просто не обновится.
 */
export async function claim(ctx: Ctx, user: UserRow, participantIds: number[]): Promise<ClaimResponse> {
  if (!user.phone) throw badRequest('phone_required', 'Сначала поделитесь номером телефона');
  const rows = await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.participants)
      .set({ holderUserId: user.id, updatedAt: new Date() })
      .where(and(inArray(schema.participants.id, participantIds), claimableWhere(user.id, user.phone!)))
      .returning();
    if (updated.length > 0) await afterLinked(ctx, tx, user.id, updated, 'participant.link_by_phone');
    return updated;
  });
  if (rows.length === 0) {
    throw conflict('not_claimable', 'Эту регистрацию уже нельзя забрать. Попросите того, кто вас записывал, прислать ссылку «Передать QR-код»');
  }
  return { claimed: rows.map((r) => ({ id: r.id, fullName: fullName(r) })) };
}

/**
 * Человек регистрирует себя («Я»), а его уже записали с другого аккаунта: тот же телефон, та же
 * фамилия и имя. Набранный номер - не доказательство, поэтому регистрацию не отдаём, а подсказываем
 * подтвердить номер через Telegram. Так не будет двух регистраций и двух оплат за одного человека.
 */
export async function findRegisteredByOther(
  db: DbLike,
  userId: number,
  self: { lastName: string; firstName: string; phone: string },
): Promise<RegisteredByOtherDetails | null> {
  const rows = await db.query.participants.findMany({ where: claimableWhere(userId, self.phone), limit: 20 });
  const same = (a: string, b: string) => normalizeNamePart(a) === normalizeNamePart(b);
  const match = rows.find((r) => same(r.lastName, self.lastName) && same(r.firstName, self.firstName));
  if (!match) return null;
  const owners = await registrantNames(db, [match.ownerUserId]);
  return { fullName: fullName(match), registeredBy: owners.get(match.ownerUserId) ?? 'другой аккаунт' };
}
