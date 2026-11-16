import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.ts';
import {
  adminFeedback,
  createFeedback,
  feedbackXlsx,
  markPromptSeen,
  setFeedbackSwitches,
} from '../src/services/feedback.service.ts';
import { getMe } from '../src/services/participants.service.ts';
import { runJob } from '../src/jobs/workers.ts';
import { Api } from 'grammy';
import { getSettings, invalidateSettingsCache, patchSettings } from '../src/services/settings.service.ts';
import type { StaffPrincipal } from '../src/services/sessions.service.ts';
import { makeParticipant, makeStaff, makeUser, setupTestEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let admin: StaffPrincipal;
beforeAll(async () => {
  env = await setupTestEnv();
  admin = await makeStaff(env, ['admin'], 'Админ');
});
afterAll(async () => env?.teardown());
beforeEach(async () => {
  await env.db.delete(schema.feedback);
  await patchSettings(env.db, { feedbackOpen: false, feedbackAdmins: false, eventEnded: false }, admin.user.id);
  invalidateSettingsCache();
});

const note = { category: 'testimony' as const, text: 'Бог коснулся моего сердца', anonymous: true };

describe('отзывы', () => {
  it('выключено - никому; проверка на админах - только админам; всем - зарегистрированным', async () => {
    const guest = await makeUser(env);
    const { participant } = await makeParticipant(env, guest);
    expect(participant.id).toBeGreaterThan(0);
    const stranger = await makeUser(env);

    expect((await getMe(env, guest)).feedback.visible).toBe(false);
    await expect(createFeedback(env.db, guest, [], note)).rejects.toMatchObject({ code: 'feedback_closed' });

    await setFeedbackSwitches(env.db, admin, { feedbackAdmins: true });
    invalidateSettingsCache();
    expect((await getMe(env, admin.user)).feedback.visible).toBe(true);
    expect((await getMe(env, guest)).feedback.visible).toBe(false);

    // «Всем» включили - проверка на админах выключается сама.
    const s = await setFeedbackSwitches(env.db, admin, { feedbackOpen: true });
    expect(s.feedbackOpen).toBe(true);
    expect(s.feedbackAdmins).toBe(false);
    invalidateSettingsCache();
    expect((await getMe(env, guest)).feedback.visible).toBe(true);
    // Без регистрации отзыв о конференции не оставить.
    expect((await getMe(env, stranger)).feedback.visible).toBe(false);
    // Пока открыто всем, проверку на админах не включить.
    expect((await setFeedbackSwitches(env.db, admin, { feedbackAdmins: true })).feedbackAdmins).toBe(false);
  });

  it('заставка - один раз на включение; оставил отзыв - больше не показываем', async () => {
    const user = await makeUser(env);
    await makeParticipant(env, user);
    await setFeedbackSwitches(env.db, admin, { feedbackOpen: true });
    invalidateSettingsCache();
    expect((await getMe(env, user)).feedback.prompt).toBe(true);
    await markPromptSeen(env.db, user);
    expect((await getMe(env, user)).feedback.prompt).toBe(false);

    // Выключили и включили снова - новая волна, заставка снова.
    await setFeedbackSwitches(env.db, admin, { feedbackOpen: false });
    await setFeedbackSwitches(env.db, admin, { feedbackOpen: true });
    invalidateSettingsCache();
    expect((await getMe(env, user)).feedback.prompt).toBe(true);

    const res = await createFeedback(env.db, user, [], note);
    expect(res.mine).toBe(1);
    const me = await getMe(env, user);
    expect(me.feedback).toMatchObject({ visible: true, mine: 1, prompt: false });

    // Админ, уже оставивший отзыв, видит заставку после каждого включения.
    await setFeedbackSwitches(env.db, admin, { feedbackOpen: false });
    await setFeedbackSwitches(env.db, admin, { feedbackAdmins: true });
    invalidateSettingsCache();
    await createFeedback(env.db, admin.user, ['admin'], note);
    expect((await getMe(env, admin.user)).feedback.prompt).toBe(false);
    await setFeedbackSwitches(env.db, admin, { feedbackAdmins: false });
    await setFeedbackSwitches(env.db, admin, { feedbackAdmins: true });
    invalidateSettingsCache();
    expect((await getMe(env, admin.user)).feedback).toMatchObject({ mine: 1, prompt: true });
    // А участник, оставивший отзыв, - нет.
    await setFeedbackSwitches(env.db, admin, { feedbackOpen: true });
    invalidateSettingsCache();
    expect((await getMe(env, user)).feedback.prompt).toBe(false);
  });

  it('«Конец «Шага веры»» открывает форму всем зарегистрированным', async () => {
    const user = await makeUser(env);
    await makeParticipant(env, user);
    await patchSettings(env.db, { eventEnded: true }, admin.user.id);
    invalidateSettingsCache();
    const me = await getMe(env, user);
    expect(me.event.ended).toBe(true);
    expect(me.event.endTitle.length).toBeGreaterThan(0);
    expect(me.feedback.visible).toBe(true);
    expect((await adminFeedback(env.db, {})).ended).toBe(true);
  });

  it('в админке: анонимный - без автора, подписанный - с подписью и ником; фильтры, поиск и выгрузка', async () => {
    const a = await makeUser(env, 'Аня');
    await makeParticipant(env, a, { firstName: 'Анна', lastName: 'Иванова' });
    const b = await makeUser(env, 'Боря');
    await makeParticipant(env, b);
    await setFeedbackSwitches(env.db, admin, { feedbackOpen: true });
    invalidateSettingsCache();
    expect((await getMe(env, a)).feedback.name).toBe('Анна Иванова');

    await createFeedback(env.db, a, [], { category: 'testimony', text: 'Получила исцеление', anonymous: false, signature: 'Анна, @anna' });
    await createFeedback(env.db, b, [], { category: 'suggestion', text: 'Больше времени на хвалу', anonymous: true, signature: 'не должно сохраниться' });

    const all = await adminFeedback(env.db, {});
    expect(all.counts).toEqual({ testimony: 1, review: 0, suggestion: 1 });
    const signed = all.items.find((i) => i.category === 'testimony')!;
    expect(signed.author).toMatchObject({ userId: a.id, name: 'Анна, @anna' });
    const anon = all.items.find((i) => i.category === 'suggestion')!;
    expect(anon.author).toBeNull();
    const [row] = await env.db.select().from(schema.feedback).where(eq(schema.feedback.id, anon.id));
    expect(row!.signature).toBeNull();

    expect((await adminFeedback(env.db, { category: 'suggestion' })).items).toHaveLength(1);
    expect((await adminFeedback(env.db, { q: 'хвал' })).items.map((i) => i.id)).toEqual([anon.id]);
    // Поиск по подписи анонимного не находит.
    expect((await adminFeedback(env.db, { q: 'сохраниться' })).items).toHaveLength(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await feedbackXlsx(env.db, { ids: [anon.id, signed.id] })) as never);
    const ws = wb.getWorksheet('Отзывы')!;
    expect(ws.rowCount).toBe(3);
    const texts = [ws.getRow(2), ws.getRow(3)].map((r) => [r.getCell(3).value, r.getCell(5).value]);
    expect(texts).toContainEqual(['Пожелание', 'Анонимно']);
    expect(texts).toContainEqual(['Свидетельство', 'Анна, @anna']);
    expect((await getSettings(env.db)).feedbackOpen).toBe(true);
  });

  it('напоминание в бот: всем с регистрацией, кроме оставивших отзыв; с кнопкой на форму', async () => {
    const calls: { method: string; chat: number; payload: Record<string, unknown> }[] = [];
    const tg = new Api('123456:TEST-TOKEN-NOT-REAL');
    tg.config.use(async (_prev, method, payload) => {
      const p = payload as { chat_id: number };
      calls.push({ method, chat: p.chat_id, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' } } } as never;
    });
    const ctx = { ...env, tg };
    const [left, waiting] = [await makeUser(env), await makeUser(env)];
    await makeParticipant(env, left);
    await makeParticipant(env, waiting);
    await setFeedbackSwitches(env.db, admin, { feedbackOpen: true });
    invalidateSettingsCache();
    await createFeedback(env.db, left, [], note);

    await runJob(ctx, 'feedback.remind', {});
    expect(calls.some((c) => c.chat === waiting.tgId)).toBe(true);
    expect(calls.some((c) => c.chat === left.tgId)).toBe(false);
    const msg = calls.find((c) => c.chat === waiting.tgId)!;
    // Картинки в тестовой папке медиа нет - уходит текст с той же кнопкой.
    expect(msg.method).toBe('sendMessage');
    expect(String(msg.payload.text)).toContain('Поделись своим «Шагом веры»');
    expect(JSON.stringify(msg.payload.reply_markup)).toContain('/feedback');

    // Проверка - только указанным.
    calls.length = 0;
    await runJob(ctx, 'feedback.remind', { userIds: [left.id] });
    expect(calls.map((c) => c.chat)).toEqual([left.tgId]);
  });
});
