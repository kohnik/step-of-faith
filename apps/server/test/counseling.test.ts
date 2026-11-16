import { Api } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../src/jobs/workers.ts';
import {
  adminCancelBooking,
  announceCounseling,
  adminCounseling,
  bookCounseling,
  cancelCounseling,
  createCounselor,
  deleteCounselor,
  publicCounseling,
  setCounselingOpen,
  slotStarts,
  updateCounselor,
} from '../src/services/counseling.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.teardown());

async function jobs(name: string) {
  return (await env.pool.query<{ data: Record<string, unknown>; start_after: Date }>(
    `select data, start_after from pgboss.job where name = $1 order by created_on`,
    [name],
  )).rows;
}

const at = (iso: string) => new Date(iso);
const hourFromNow = (h: number) => {
  const d = new Date(Date.now() + h * 3600_000);
  d.setUTCMinutes(0, 0, 0);
  return d;
};

describe('окошки', () => {
  it('16:00–18:00 по 20 минут - шесть окошек; неполное в конце не считается', () => {
    const s = slotStarts({ startsAt: at('2026-11-07T13:00:00Z'), endsAt: at('2026-11-07T15:00:00Z'), slotMinutes: 20 });
    expect(s.map((d) => d.toISOString().slice(11, 16))).toEqual(['13:00', '13:20', '13:40', '14:00', '14:20', '14:40']);
    expect(slotStarts({ startsAt: at('2026-11-07T13:00:00Z'), endsAt: at('2026-11-07T14:50:00Z'), slotMinutes: 20 })).toHaveLength(5);
  });
});

describe('запись на душепопечение', () => {
  it('одна запись на человека, занятое окошко не отдаём, чужих имён не видно', async () => {
    const admin = await makeStaff(env, ['admin']);
    const start = hourFromNow(48);
    let view = await createCounselor(
      env,
      {
        name: 'Кот Евгений',
        place: '504 каб. церкви, 5-й этаж',
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 2 * 3600_000).toISOString(),
        slotMinutes: 20, hidden: false, audience: 'all', tags: [],
      },
      admin,
    );
    const c = view.counselors.find((x) => x.name === 'Кот Евгений')!;
    expect(c.slots).toHaveLength(6);
    const [s0, s1, s2] = c.slots;

    const owner = await makeUser(env, 'Мама');
    const { participant: p1 } = await makeParticipant(env, owner);
    const { participant: p2 } = await makeParticipant(env, owner);
    const other = await makeUser(env, 'Сосед');
    const { participant: q } = await makeParticipant(env, other);

    await setCounselingOpen(env.db, false, admin);
    await expect(bookCounseling(env, owner, { counselorId: c.id, slotStart: s0!, participantId: p1.id })).rejects.toMatchObject({
      code: 'not_open',
    });
    await setCounselingOpen(env.db, true, admin);

    let mine = await bookCounseling(env, owner, { counselorId: c.id, slotStart: s0!, participantId: p1.id });
    expect(mine.my).toEqual([{ participantId: p1.id, counselorId: c.id, slotStart: s0 }]);
    expect((await jobs('counseling.booked')).at(-1)!.data).toMatchObject({ bookingId: expect.any(Number) });
    const reminders = await jobs('counseling.reminder');
    expect(new Date(reminders.at(-1)!.start_after).getTime()).toBe(new Date(s0!).getTime() - 15 * 60_000);

    // Чужому - только «занято».
    await expect(bookCounseling(env, other, { counselorId: c.id, slotStart: s0!, participantId: q.id })).rejects.toMatchObject({
      code: 'slot_taken',
    });
    const seen = await publicCounseling(env, other.id);
    const slot0 = seen.counselors.find((x) => x.id === c.id)!.slots[0]!;
    expect(slot0).toEqual({ start: s0, taken: true, participantId: null });
    expect(seen.my).toEqual([]);

    // Перейти на другое время: прежнее окошко освобождается, запись одна.
    mine = await bookCounseling(env, owner, { counselorId: c.id, slotStart: s1!, participantId: p1.id });
    expect(mine.my).toEqual([{ participantId: p1.id, counselorId: c.id, slotStart: s1 }]);
    expect(mine.counselors.find((x) => x.id === c.id)!.slots[0]!.taken).toBe(false);

    // Не вышло перейти (окошко занято) - старая запись остаётся.
    await bookCounseling(env, owner, { counselorId: c.id, slotStart: s2!, participantId: p2.id });
    await expect(bookCounseling(env, owner, { counselorId: c.id, slotStart: s1!, participantId: p2.id })).rejects.toMatchObject({
      code: 'slot_taken',
    });
    mine = await publicCounseling(env, owner.id);
    expect(mine.my.find((m) => m.participantId === p2.id)!.slotStart).toBe(s2);

    // Окошка с таким временем нет.
    const odd = new Date(new Date(s0!).getTime() + 5 * 60_000).toISOString();
    await expect(bookCounseling(env, other, { counselorId: c.id, slotStart: odd, participantId: q.id })).rejects.toMatchObject({
      code: 'invalid_slot',
    });

    // Админ видит имена и телефоны.
    view = await adminCounseling(env.db);
    expect(view.counselors.find((x) => x.id === c.id)!.bookings.map((b) => b.participantId)).toEqual([p1.id, p2.id]);

    // Сдвинули начало на 10 минут - окошки съехали, обе записи отменены с сообщением.
    const notesBefore = (await jobs('notify.text')).length;
    await updateCounselor(env, c.id, { startsAt: new Date(new Date(s0!).getTime() + 10 * 60_000).toISOString() }, admin);
    const after = await publicCounseling(env, owner.id);
    expect(after.my).toEqual([]);
    expect((await jobs('notify.text')).length - notesBefore).toBe(2);

    // Своя отмена и отмена админом.
    await updateCounselor(env, c.id, { startsAt: s0! }, admin);
    await bookCounseling(env, owner, { counselorId: c.id, slotStart: s0!, participantId: p1.id });
    await cancelCounseling(env, owner, p1.id);
    expect((await publicCounseling(env, owner.id)).my).toEqual([]);
    await bookCounseling(env, other, { counselorId: c.id, slotStart: s0!, participantId: q.id });
    const booking = (await adminCounseling(env.db)).counselors.find((x) => x.id === c.id)!.bookings[0]!;
    await adminCancelBooking(env, booking.id, admin);
    const notes = await jobs('notify.text');
    expect(notes.at(-1)!.data).toMatchObject({ userId: other.id });
    expect(String(notes.at(-1)!.data.text)).toContain('отменили организаторы');

    // Удалили служителя - записанным сообщение.
    await bookCounseling(env, other, { counselorId: c.id, slotStart: s0!, participantId: q.id });
    await deleteCounselor(env, c.id, admin);
    expect(String((await jobs('notify.text')).at(-1)!.data.text)).toContain('Кот Евгений');
    expect((await publicCounseling(env, other.id)).my).toEqual([]);
  });

  it('на одно окошко двое одновременно - достаётся одному; прошедшее время не записать', async () => {
    const admin = await makeStaff(env, ['admin']);
    await setCounselingOpen(env.db, true, admin);
    const start = hourFromNow(-1);
    const view = await createCounselor(
      env,
      {
        name: 'Сонич Владимир',
        place: '327 ауд. ТИ, 3-й этаж',
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 4 * 3600_000).toISOString(),
        slotMinutes: 20, hidden: false, audience: 'all', tags: [],
      },
      admin,
    );
    const c = view.counselors.find((x) => x.name === 'Сонич Владимир')!;
    const a = await makeUser(env);
    const b = await makeUser(env);
    const { participant: pa } = await makeParticipant(env, a);
    const { participant: pb } = await makeParticipant(env, b);

    await expect(bookCounseling(env, a, { counselorId: c.id, slotStart: c.slots[0]!, participantId: pa.id })).rejects.toMatchObject({
      code: 'slot_past',
    });
    const future = c.slots.at(-1)!;
    const results = await Promise.allSettled([
      bookCounseling(env, a, { counselorId: c.id, slotStart: future, participantId: pa.id }),
      bookCounseling(env, b, { counselorId: c.id, slotStart: future, participantId: pb.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'slot_taken' });
  });

  it('«только для девушек»: парню записаться нельзя, метки видны; поменяли на «для парней» - запись девушки отменяется', async () => {
    const admin = await makeStaff(env, ['admin']);
    await setCounselingOpen(env.db, true, admin);
    const start = hourFromNow(72);
    const view = await createCounselor(
      env,
      {
        name: 'Анна',
        place: null,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600_000).toISOString(),
        slotMinutes: 20,
        hidden: false,
        audience: 'f',
        tags: ['на русском', ' На русском ', 'для пар'],
      },
      admin,
    );
    const c = view.counselors.find((x) => x.name === 'Анна')!;
    expect(c).toMatchObject({ audience: 'f', tags: ['на русском', 'для пар'] });
    const [s0, s1] = c.slots;

    const owner = await makeUser(env, 'Семья');
    const { participant: girl } = await makeParticipant(env, owner, { gender: 'f' });
    const { participant: boy } = await makeParticipant(env, owner, { gender: 'm' });
    const pub = await publicCounseling(env, owner.id);
    expect(pub.counselors.find((x) => x.id === c.id)).toMatchObject({ audience: 'f', tags: ['на русском', 'для пар'] });
    await expect(bookCounseling(env, owner, { counselorId: c.id, slotStart: s0!, participantId: boy.id })).rejects.toMatchObject({
      code: 'counselor_audience',
    });
    await bookCounseling(env, owner, { counselorId: c.id, slotStart: s1!, participantId: girl.id });

    const after = await updateCounselor(env, c.id, { audience: 'm' }, admin);
    expect(after.counselors.find((x) => x.id === c.id)!.bookings).toEqual([]);
    const notes = await jobs('notify.text');
    expect(String(notes.at(-1)!.data.text)).toContain('только парней');
    await bookCounseling(env, owner, { counselorId: c.id, slotStart: s0!, participantId: boy.id });
  });

  it('«Напомнить всем»: каждому аккаунту - его записи впереди: время, служитель, место; одно сообщение на аккаунт', async () => {
    const admin = await makeStaff(env, ['admin']);
    await setCounselingOpen(env.db, true, admin);
    const start = hourFromNow(2);
    const view = await createCounselor(
      env,
      {
        name: 'Кот Евгений',
        place: '504 каб. церкви, 5-й этаж',
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 2 * 3600_000).toISOString(),
        slotMinutes: 20, hidden: false, audience: 'all', tags: [],
      },
      admin,
    );
    const c = view.counselors.find((x) => x.name === 'Кот Евгений')!;
    const owner = await makeUser(env);
    const { participant: p1 } = await makeParticipant(env, owner, { firstName: 'Аня' });
    const { participant: p2 } = await makeParticipant(env, owner, { firstName: 'Петя' });
    await bookCounseling(env, owner, { counselorId: c.id, slotStart: c.slots[0]!, participantId: p1.id });
    await bookCounseling(env, owner, { counselorId: c.id, slotStart: c.slots[1]!, participantId: p2.id });

    expect(await announceCounseling(env, c.id, admin)).toEqual({ bookings: 2 });
    const job = (await jobs('counseling.announce')).at(-1)!;
    expect(job.data).toMatchObject({ counselorId: c.id });

    const sent: { chat: number; text: string }[] = [];
    const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
    tg.config.use(async (_prev, method, payload) => {
      const p = payload as { chat_id: number; text: string };
      if (method === 'sendMessage') sent.push({ chat: p.chat_id, text: p.text });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' }, text: '' } } as never;
    });
    const data = job.data as { counselorId: number | null; at: string };
    await runJob({ ...env, tg }, 'counseling.announce', data);
    const mine = sent.filter((m) => m.chat === owner.tgId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain('Кот Евгений · 504 каб. церкви, 5-й этаж');
    expect(mine[0]!.text).toContain('Аня');
    expect(mine[0]!.text).toContain('Петя');
    // Повтор той же задачи не шлёт второй раз.
    await runJob({ ...env, tg }, 'counseling.announce', data);
    expect(sent.filter((m) => m.chat === owner.tgId)).toHaveLength(1);

    // Записанных впереди нет - напоминать некому.
    const empty = await createCounselor(
      env,
      { name: 'Пустой Служитель', place: null, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(), slotMinutes: 20, hidden: false, audience: 'all', tags: [] },
      admin,
    );
    const e = empty.counselors.find((x) => x.name === 'Пустой Служитель')!;
    await expect(announceCounseling(env, e.id, admin)).rejects.toMatchObject({ code: 'nobody' });
  });
});
