import {
  CATEGORY_LABELS,
  DEFAULT_GAME_CONFIG,
  formatRub,
  formatTicketCode,
  fullName,
  MEAL_LABELS,
  tgHtml,
  tgPlain,
  tierShort,
  type Category,
  type Meal,
  type Segment,
  type Settings,
} from '@sof/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GrammyError, InlineKeyboard, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import sharp from 'sharp';
import type { AppContext } from '../context.ts';
import { schema } from '../db/client.ts';
import { syncChatCommands } from '../bot/commands.ts';
import { BTN, mainKeyboard } from '../bot/keyboards.ts';
import { draftKeyboard, draftText } from '../bot/receipt-ui.ts';
import { dayKey, esc, fmtDateTime, fmtTime } from '../bot/format.ts';
import { firstTime, forget } from '../lib/once.ts';
import { telegramDownload } from '../lib/telegram-net.ts';
import { segmentUsersSql } from '../services/broadcast.service.ts';
import { readStored, saveAvatar } from '../services/media.service.ts';
import {
  confirmDeadline,
  confirmTime,
  dropUnconfirmed,
  expireOrder,
  markConfirmAsked,
  merchNotifyRecipients,
  merchReceiptNotice,
  ordersToConfirm,
  paidToRemind,
  PICKUP,
  PICKUP_PAID,
} from '../services/merch.service.ts';
import { chatNotifyRecipients, namesOf } from '../services/chat.service.ts';
import { closeRoundIfDue, gameConfigNow, inviteAudience, launchOf, revealedTaskMessages, runScheduled, teamLabels, votersOnlyTesters, yesPlayersAccounts } from '../services/game.service.ts';
import { archiveReceipt, draftForReminder, receiptsToArchive } from '../services/payment.service.ts';
import { feeDeadlineText, getSettings } from '../services/settings.service.ts';
import { TICKET_DESIGN } from '../services/ticket-image.ts';
import { ticketPng } from '../services/tickets.service.ts';
import { mealEatersSql, personPaymentText, tierConfig, tiersVersion } from '../services/tiers.ts';
import { FEEDBACK_REMIND_IMAGE, FEEDBACK_REMIND_TEXT, feedbackRemindAudience } from '../services/feedback.service.ts';
import { getRoles, getUser, markBotBlocked } from '../services/users.service.ts';
import { enqueue, type JobPayloads, type QueueName } from './queues.ts';
import { jobScope } from './scope.ts';
import { sendToUser } from './telegram.ts';

type Handler<Q extends QueueName> = (ctx: AppContext, data: JobPayloads[Q]) => Promise<void>;

/** Какая задача очереди сейчас выполняется: из её id строим ключи «это сообщение уже отправлено». */

/** Ключ шага текущей задачи; вне очереди (тесты, прямой вызов) - null, шаг выполняется всегда. */
function jobKey(part: string): string | null {
  const scope = jobScope.getStore();
  return scope?.jobId ? `job:${scope.jobId}:${part}` : null;
}

/** Выполнить шаг один раз на задачу: при повторе задачи уже сделанный шаг пропускается (undefined). */
async function step<T>(ctx: AppContext, key: string | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (key && !(await firstTime(ctx.db, key))) return undefined;
  try {
    return await fn();
  } catch (err) {
    if (key) await forget(ctx.db, key);
    throw err;
  }
}

// ---------- билеты ----------

const sendTickets: Handler<'tickets.send'> = async (ctx, data) => {
  const [user, settings] = await Promise.all([getUser(ctx.db, data.userId), getSettings(ctx.db)]);
  const rows = await ctx.db
    .select({ p: schema.participants, t: schema.tickets })
    .from(schema.participants)
    .innerJoin(
      schema.tickets,
      and(eq(schema.tickets.participantId, schema.participants.id), eq(schema.tickets.status, 'active')),
    )
    .where(and(inArray(schema.participants.id, data.participantIds), eq(schema.participants.status, 'active')))
    .orderBy(asc(schema.participants.id));
  if (rows.length === 0 || !user) return;

  // Картинку рендерим один раз и дальше шлём по file_id; версия - время последней правки участника
  // и цвета/подписи вариантов из настроек.
  const tv = tiersVersion(settings);
  const items = await Promise.all(
    rows.map(async ({ p, t }) => {
      const version = `v${p.updatedAt.getTime()}.${tv}.d${TICKET_DESIGN}|`;
      const cached = t.imageFileId?.startsWith(version) ? t.imageFileId.slice(version.length) : null;
      const category = p.category === 'participant' ? '' : ` · ${CATEGORY_LABELS[p.category as Category]}`;
      const tier = tierConfig(settings, p.tier);
      const caption =
        `<b>${esc(fullName(p))}</b>${category}\n` +
        (tier ? `${esc(tierShort(tier, p.breakfast))}\n` : '') +
        `<code>${formatTicketCode(t.code)}</code>`;
      const media = cached ?? new InputFile(await ticketPng(ctx.db, t, p), `qr-${t.code}.png`);
      return { p, t, version, caption, media };
    }),
  );

  const n = items.length;
  const intro: Record<JobPayloads['tickets.send']['reason'], string> = {
    registered:
      n === 1
        ? '🎉 <b>Регистрация готова!</b>\n🎟 QR-код для входа:'
        : `🎉 <b>Регистрация готова!</b>\n🎟 QR-коды для входа, по одному на человека (${n}):`,
    resend: n === 1 ? '🎟 <b>QR-код для входа</b>' : `🎟 <b>QR-коды для входа (${n})</b>`,
    claimed: '🎁 <b>Вам передали QR-код для входа</b>',
    reissued: '🔄 <b>QR-код обновлён</b>\nСтарый больше не действует. Показывайте на входе этот:',
    linked: '',
    found:
      n === 1 ? '🔎 <b>Нашли вашу регистрацию</b>\n🎟 QR-код для входа:' : `🔎 <b>Нашли ваши регистрации</b>\n🎟 QR-коды для входа (${n}):`,
    restored: '↩️ <b>Регистрацию вернули</b>\n🎟 Новый QR-код для входа:',
    updated:
      (n === 1
        ? '✏️ <b>Данные участника изменились</b>\nВот актуальный QR-код. Сам код тот же, старый тоже сработает на входе.'
        : `✏️ <b>Данные изменились</b>\nВот актуальные QR-коды (${n}). Сами коды те же, старые тоже сработают на входе.`) +
      // Вариант мог смениться вместе с суммой взноса - сразу говорим, сколько теперь.
      (settings.paymentsEnabled
        ? '\n\n' + items.map((it) => `💰 ${n > 1 ? `${esc(fullName(it.p))}: ` : 'Взнос: '}${esc(personPaymentText(settings, it.p))}`).join('\n')
        : ''),
  };
  if (data.reason === 'linked') {
    const ownerIds = [...new Set(rows.map((r) => r.p.ownerUserId))];
    const owners = await Promise.all(ownerIds.map((id) => getUser(ctx.db, id)));
    const names = owners
      .filter((u) => !!u)
      .map((u) => u!.displayName ?? ([u!.firstName, u!.lastName].filter(Boolean).join(' ') || (u!.username ? `@${u!.username}` : '')))
      .filter(Boolean);
    intro.linked =
      `🎉 <b>Вас зарегистрировали на конференцию «${esc(settings.eventName)}»</b>` +
      (names.length ? `, записал(а) ${names.map(esc).join(', ')}` : '') +
      (n === 1 ? '.\n\n🎟 Ниже QR-код для входа.' : `.\n\n🎟 Ниже QR-коды для входа (${n}).`) +
      '\n🙅 Если это не вы - нажмите «Это не я».';
  }

  // Прежние QR этих людей в чате устарели (данные поменялись или код перевыпущен): снимаем закрепление
  // и подписываем «актуальный - ниже». Один раз на задачу - повтор не тронет уже отправленные новые.
  const outdated =
    data.reason === 'updated'
      ? 'Данные изменились - актуальный QR-код ниже.'
      : data.reason === 'reissued' || data.reason === 'restored'
        ? 'Этот QR-код больше не действует - новый ниже.'
        : null;

  // Каждое сообщение - под ключом «уже отправлено» этой задачи: повтор после сбоя (или копия задачи,
  // запущенная очередью по истечении срока) досылает только недошедшее, без дублей у человека.
  const { outcome } = await sendToUser(ctx, user, async (chatId) => {
    if (outdated) {
      await step(ctx, jobKey('outdated'), async () => {
        const old = await ctx.db
          .select()
          .from(schema.ticketMessages)
          .where(and(eq(schema.ticketMessages.chatId, chatId), inArray(schema.ticketMessages.participantId, data.participantIds)));
        for (const m of old) {
          await ctx.tg.unpinChatMessage(chatId, m.messageId).catch(() => {});
          await ctx.tg.editMessageCaption(chatId, m.messageId, { caption: outdated }).catch(() => {});
        }
        if (old.length) {
          await ctx.db
            .delete(schema.ticketMessages)
            .where(and(eq(schema.ticketMessages.chatId, chatId), inArray(schema.ticketMessages.participantId, data.participantIds)));
        }
      });
    }
    // «Это не я» - одна кнопка на всё сообщение, а не под каждой картинкой.
    const notMe = data.reason === 'linked' && items[0] ? new InlineKeyboard().text('Это не я', `v1:notme:${items[0].p.id}`) : undefined;
    await step(ctx, jobKey('intro'), () => ctx.tg.sendMessage(chatId, intro[data.reason], { parse_mode: 'HTML', reply_markup: notMe }));
    // Каждый QR - отдельным сообщением со своей подписью: в альбоме Telegram показывает подпись только одного фото.
    for (const [i, it] of items.entries()) {
      const msg: Message | undefined = await step(ctx, jobKey(`t${it.t.id}`), async () => {
        const opts = { caption: it.caption, parse_mode: 'HTML' as const };
        try {
          return await ctx.tg.sendPhoto(chatId, it.media, opts);
        } catch (err) {
          // Сохранённый file_id Telegram не принял (другой бот, устаревший файл) - рисуем и загружаем заново.
          if (typeof it.media !== 'string' || !(err instanceof GrammyError) || err.error_code !== 400) throw err;
          return ctx.tg.sendPhoto(chatId, new InputFile(await ticketPng(ctx.db, it.t, it.p), `qr-${it.t.code}.png`), opts);
        }
      });
      if (!msg) continue;
      // Где лежит этот QR - чтобы при следующей смене данных подписать его устаревшим.
      await ctx.db
        .insert(schema.ticketMessages)
        .values({ participantId: it.p.id, ticketId: it.t.id, chatId, messageId: msg.message_id })
        .onConflictDoNothing();
      // file_id запоминаем сразу: повтор задачи не будет заново рисовать и загружать картинку.
      const photo = msg.photo?.at(-1);
      if (photo) await ctx.db.update(schema.tickets).set({ imageFileId: it.version + photo.file_id }).where(eq(schema.tickets.id, it.t.id));
      if (i === 0) await ctx.tg.pinChatMessage(chatId, msg.message_id, { disable_notification: true }).catch(() => {});
    }

    if (data.reason === 'registered' || data.reason === 'linked' || data.reason === 'found') {
      const kb = mainKeyboard(ctx.config.APP_URL, {
        registered: true,
        canRegister: true,
        payments: settings.paymentsEnabled,
        roles: await getRoles(ctx.db, user.id),
        schedule: settings.scheduleVisible,
      });
      const due = items.filter((it) => ['unpaid', 'partial'].includes(it.p.paymentStatus));
      const total = due.reduce((sum, it) => sum + Number(it.p.amountDue ?? 0), 0);
      const payText =
        settings.paymentsEnabled && data.reason === 'registered' && due.length
          ? `\n\n💰 ${feeDeadlineText(settings).replace('Взнос', '<b>Взнос</b>')}\n` +
            (due.length === 1
              ? `💳 ${formatRub(total)}, ${due[0]!.p.paymentMethod === 'cash' || !settings.transfersEnabled ? 'наличными' : 'переводом'}`
              : due.map((it) => `💳 ${esc(fullName(it.p))}: ${esc(personPaymentText(settings, it.p))}`).join('\n') +
                `\nВсего ${formatRub(total)}`) +
            '\n👉 Как оплатить - кнопка «Оплата».'
          : '';
      const saved =
        n === 1
          ? '📌 <b>QR-код закреплён вверху чата</b>\nСохраните его в галерею: на входе он сработает и без интернета.'
          : '📌 <b>Первый QR-код закреплён вверху чата</b>\nСохраните все в галерею: на входе они сработают и без интернета.';
      // Пока расписание не опубликовано, о нём не говорим (оно ещё может поменяться).
      const schedule = settings.scheduleVisible ? '\n\n📅 Расписание и запись на семинары - в приложении.' : '';
      const keepBot =
        '\n\n🙏 <b>Пожалуйста, не удаляйте чат-бот до окончания конференции!</b>\n' +
        'Он важен для информирования участников и позволит им регистрироваться на мероприятия, ' +
        'предусматривающие предпочтения / выбор самих участников конференции.';
      await step(ctx, jobKey('done'), () =>
        ctx.tg.sendMessage(chatId, saved + schedule + keepBot + payText, {
          parse_mode: 'HTML',
          reply_markup: kb,
        }),
      );
    }
  }, { ignoreBlocked: true });
  if (outcome !== 'sent') return;

  await ctx.db.update(schema.users).set({ lastTicketsSentAt: new Date() }).where(eq(schema.users.id, user.id));
};

// ---------- вход ----------

const checkinWelcome: Handler<'checkin.welcome'> = async (ctx, { participantId }) => {
  const p = await ctx.db.query.participants.findFirst({ where: eq(schema.participants.id, participantId) });
  if (!p) return;
  // Приветствие - одно на всю конференцию: повторная отметка после отмены его не повторяет.
  const key = `welcome:${participantId}`;
  if (!(await firstTime(ctx.db, key))) return;
  const settings = await getSettings(ctx.db);
  const tz = settings.eventTimezone;
  const today = dayKey(new Date(), tz);
  const acts = await ctx.db.query.activities.findMany({
    where: and(eq(schema.activities.status, 'published'), sql`${schema.activities.endsAt} > now()`),
    orderBy: [asc(schema.activities.startsAt)],
    limit: 50,
  });
  const todays = acts.filter((a) => dayKey(a.startsAt, tz) === today).slice(0, 8);
  const lines = todays.map((a) => `${fmtTime(a.startsAt, tz)}  ${esc(a.title)}${a.location ? `, ${esc(a.location)}` : ''}`);
  const user = await getUser(ctx.db, p.holderUserId ?? p.ownerUserId);
  // Расписание скрыто - без списка «Сегодня» и без кнопки.
  const showSchedule = settings.scheduleVisible;
  try {
    await sendToUser(ctx, user, (chatId) =>
      ctx.tg.sendMessage(
        chatId,
        `🙌 <b>${esc(p.firstName)}, добро пожаловать на «${esc(settings.eventName)}»!</b>` +
          (showSchedule && lines.length ? `\n\n📅 <b>Сегодня</b>\n${lines.join('\n')}` : ''),
        {
          parse_mode: 'HTML',
          reply_markup: showSchedule ? new InlineKeyboard().webApp(BTN.schedule, `${ctx.config.APP_URL}/schedule`) : undefined,
        },
      ),
    );
  } catch (err) {
    await forget(ctx.db, key);
    throw err;
  }
};

// ---------- активности ----------

/**
 * Получатели по участникам: держатель билета или владелец аккаунта; имена сгруппированы по аккаунту.
 * Имена оставляем, только если на аккаунте больше одного человека - иначе и так понятно, о ком речь.
 */
async function recipientsFor(ctx: AppContext, participantIds: number[]) {
  if (participantIds.length === 0) return new Map<number, string[]>();
  const people = await ctx.db
    .select()
    .from(schema.participants)
    .where(and(inArray(schema.participants.id, participantIds), eq(schema.participants.status, 'active')));
  const byUser = new Map<number, string[]>();
  for (const p of people) {
    const uid = p.holderUserId ?? p.ownerUserId;
    byUser.set(uid, [...(byUser.get(uid) ?? []), p.firstName]);
  }
  if (byUser.size === 0) return byUser;
  const recipient = sql<number>`coalesce(${schema.participants.holderUserId}, ${schema.participants.ownerUserId})`;
  const counts = await ctx.db
    .select({ uid: recipient, n: sql<number>`count(*)::int` })
    .from(schema.participants)
    .where(and(inArray(recipient, [...byUser.keys()]), eq(schema.participants.status, 'active')))
    .groupBy(recipient);
  for (const { uid, n } of counts) if (n <= 1) byUser.set(Number(uid), []);
  return byUser;
}

/**
 * Сообщение каждому аккаунту. `once` - ключ «уже отправлено» на получателя: копии одной задачи
 * (например, напоминания после нескольких правок) не шлют повторно, а повтор после сбоя дошлёт остальным.
 */
async function notifyMany(
  ctx: AppContext,
  byUser: Map<number, string[]>,
  text: (names: string[]) => string,
  keyboard?: InlineKeyboard,
  once?: (userId: number) => string,
) {
  for (const [userId, names] of byUser) {
    // Без своего ключа - ключ задачи: повтор после сбоя не шлёт тем, кому уже отправили.
    const key = once ? once(userId) : jobKey(`u${userId}`);
    if (key && !(await firstTime(ctx.db, key))) continue;
    try {
      const user = await getUser(ctx.db, userId);
      await sendToUser(ctx, user, (chatId) =>
        ctx.tg.sendMessage(chatId, text(names), { parse_mode: 'HTML', reply_markup: keyboard }),
      );
    } catch (err) {
      if (key) await forget(ctx.db, key);
      throw err;
    }
  }
}

async function activityAudience(ctx: AppContext, activityId: number, statuses: string[]) {
  const regs = await ctx.db
    .select({ pid: schema.activityRegistrations.participantId })
    .from(schema.activityRegistrations)
    .where(and(eq(schema.activityRegistrations.activityId, activityId), inArray(schema.activityRegistrations.status, statuses)));
  const byUser = await recipientsFor(ctx, regs.map((r) => r.pid));
  const interested = await ctx.db
    .select({ userId: schema.activityInterest.userId })
    .from(schema.activityInterest)
    .where(eq(schema.activityInterest.activityId, activityId));
  for (const { userId } of interested) if (!byUser.has(userId)) byUser.set(userId, []);
  return byUser;
}

/** Все аккаунты с активными участниками (у кого QR-код, иначе кто записывал) - без имён: напоминание общее. */
async function everyoneAudience(ctx: AppContext): Promise<Map<number, string[]>> {
  const rows = await ctx.db.execute<{ uid: string }>(sql`
    select distinct coalesce(holder_user_id, owner_user_id) as uid from participants where status = 'active'`);
  return new Map(rows.rows.map((r) => [Number(r.uid), []]));
}

/** У кого есть это питание: завтрак - по галочке, обед и ужин - по варианту с чёрным браслетом. Имена - кто именно ест. */
async function mealAudience(ctx: AppContext, meal: Meal, settings: Settings): Promise<Map<number, string[]>> {
  const eat = mealEatersSql(settings, meal);
  if (!eat) return new Map();
  const rows = await ctx.db.execute<{ id: string }>(sql`select id from participants where status = 'active' and ${eat}`);
  return recipientsFor(ctx, rows.rows.map((r) => Number(r.id)));
}

const namesLine = (names: string[]) => (names.length ? `\n👤 Для: ${names.map(esc).join(', ')}` : '');
/** «16 октября в 10:00 · Основной зал» или «10:00 · Основной зал». */
const whenWhere = (a: { startsAt: Date; location: string | null }, tz: string, full = true) =>
  `${full ? fmtDateTime(a.startsAt, tz) : fmtTime(a.startsAt, tz)}${a.location ? ` · ${esc(a.location)}` : ''}`;

const activityPromoted: Handler<'activity.promoted'> = async (ctx, { activityId, participantIds }) => {
  const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, activityId) });
  if (!a) return;
  const tz = (await getSettings(ctx.db)).eventTimezone;
  await notifyMany(
    ctx,
    await recipientsFor(ctx, participantIds),
    (names) =>
      `✅ Освободилось место - вы записаны на «<b>${esc(a.title)}</b>»\n${whenWhere(a, tz)}${namesLine(names)}`,
  );
};

const activityReminder: Handler<'activity.reminder'> = async (ctx, { activityId, startsAt }) => {
  const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, activityId) });
  // Перенесли или отменили - у новой даты своя задача-напоминание.
  if (!a || a.status !== 'published' || a.startsAt.toISOString() !== startsAt) return;
  const settings = await getSettings(ctx.db);
  const tz = settings.eventTimezone;
  // Пункт программы без записи (сессия, перерыв, ужин) - напоминание всем участникам; с записью - записанным.
  const open = a.registrationMode === 'none';
  const keyboard = settings.scheduleVisible ? new InlineKeyboard().webApp(BTN.schedule, `${ctx.config.APP_URL}/schedule`) : undefined;
  // После каждой правки мероприятия в очереди копится ещё одна задача - напоминание уходит один раз.
  const once = (userId: number) => `activity-reminder:${activityId}:${startsAt}:${userId}`;
  const meal = open && a.meal ? (a.meal as Meal) : null;
  if (meal) {
    // Завтрак, обед, ужин: у кого это питание есть - личное напоминание вместо общего (ключ тот же - второго не будет).
    const what = MEAL_LABELS[meal].toLowerCase();
    await notifyMany(
      ctx,
      await mealAudience(ctx, meal, settings),
      (names) =>
        `🍽 Через 15 минут - «<b>${esc(a.title)}</b>»\n${whenWhere(a, tz, false)}\n✅ Вы в списке на ${what}${meal === 'breakfast' ? '' : ' - не забудьте браслет'}${namesLine(names)}`,
      keyboard,
      once,
    );
  }
  await notifyMany(
    ctx,
    open ? await everyoneAudience(ctx) : await activityAudience(ctx, activityId, ['registered']),
    (names) => `⏰ Через 15 минут - «<b>${esc(a.title)}</b>»\n${whenWhere(a, tz, false)}${namesLine(names)}`,
    keyboard,
    once,
  );
};

const activityChanged: Handler<'activity.changed'> = async (ctx, { activityId, change }) => {
  const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, activityId) });
  if (!a) return;
  const tz = (await getSettings(ctx.db)).eventTimezone;
  await notifyMany(ctx, await activityAudience(ctx, activityId, ['registered', 'waitlist']), (names) =>
    change === 'cancelled'
      ? `❗️ «<b>${esc(a.title)}</b>» отменили\n${fmtDateTime(a.startsAt, tz)}${namesLine(names)}`
      : change === 'place'
        ? `❗️ «<b>${esc(a.title)}</b>» пройдёт в другом месте\n${fmtDateTime(a.startsAt, tz)} · <b>${esc(a.location ?? 'место уточните у организаторов')}</b>${namesLine(names)}`
        : `❗️ «<b>${esc(a.title)}</b>» перенесли\nТеперь: <b>${whenWhere(a, tz)}</b>${namesLine(names)}`,
  );
};

const seminarRooms: Handler<'seminar.rooms'> = async (ctx, { topicIds }) => {
  const tz = (await getSettings(ctx.db)).eventTimezone;
  for (const id of topicIds) {
    const a = await ctx.db.query.activities.findFirst({ where: eq(schema.activities.id, id) });
    if (!a || a.status !== 'published' || !a.location) continue;
    const regs = await ctx.db
      .select({ pid: schema.activityRegistrations.participantId })
      .from(schema.activityRegistrations)
      .where(and(eq(schema.activityRegistrations.activityId, id), eq(schema.activityRegistrations.status, 'registered')));
    await notifyMany(
      ctx,
      await recipientsFor(ctx, regs.map((r) => r.pid)),
      (names) =>
        `📍 Семинар «<b>${esc(a.title)}</b>»\n${fmtTime(a.startsAt, tz)} · <b>${esc(a.location!)}</b>${namesLine(names)}`,
    );
  }
};

/**
 * Опубликовали распределение семинаров: каждому аккаунту - семинары его людей по времени, с залами.
 * Человек без семинара (распределение его убрало) - так и пишем, чтобы не ждал.
 */
const seminarAssigned: Handler<'seminar.assigned'> = async (ctx, { participantIds }) => {
  const tz = (await getSettings(ctx.db)).eventTimezone;
  const recipient = sql<number>`coalesce(${schema.participants.holderUserId}, ${schema.participants.ownerUserId})`;
  const changed = await ctx.db
    .select({ uid: recipient })
    .from(schema.participants)
    .where(and(inArray(schema.participants.id, participantIds), eq(schema.participants.status, 'active')));
  if (changed.length === 0) return;
  // В сообщении - вся семья аккаунта, а не только те, у кого поменялось: так видно картину целиком.
  const people = await ctx.db
    .select()
    .from(schema.participants)
    .where(and(inArray(recipient, [...new Set(changed.map((c) => Number(c.uid)))]), eq(schema.participants.status, 'active')))
    .orderBy(asc(schema.participants.id));
  const seats = await ctx.db
    .select({ pid: schema.activityRegistrations.participantId, a: schema.activities })
    .from(schema.activityRegistrations)
    .innerJoin(schema.activities, eq(schema.activities.id, schema.activityRegistrations.activityId))
    .where(
      and(
        inArray(schema.activityRegistrations.participantId, people.map((p) => p.id)),
        eq(schema.activityRegistrations.status, 'registered'),
        eq(schema.activities.status, 'published'),
        sql`${schema.activities.blockId} is not null`,
      ),
    )
    .orderBy(schema.activities.startsAt);
  const byUser = new Map<number, typeof people>();
  for (const p of people) {
    const uid = p.holderUserId ?? p.ownerUserId;
    byUser.set(uid, [...(byUser.get(uid) ?? []), p]);
  }
  // У тем с кавычками в названии («№1 «Что будет после смерти?»») свои кавычки не добавляем.
  const title = (t: string) => (t.includes('«') ? `<b>${esc(t)}</b>` : `«<b>${esc(t)}</b>»`);
  const line = (a: typeof schema.activities.$inferSelect) =>
    `${fmtTime(a.startsAt, tz)} · ${title(a.title)}${a.location ? ` · ${esc(a.location)}` : ''}`;
  for (const [userId, list] of byUser) {
    const blocks = list.map((p) => {
      const mine = seats.filter((s) => s.pid === p.id).map((s) => line(s.a));
      const body = mine.length ? mine.join('\n') : 'без семинара - подойдите к организаторам';
      return list.length > 1 ? `👤 <b>${esc(p.firstName)}</b>\n${body}` : body;
    });
    await notifyMany(ctx, new Map([[userId, []]]), () => `🎓 <b>Ваши семинары</b>\n\n${blocks.join('\n\n')}`);
  }
};

// ---------- душепопечение ----------

async function counselingBooking(ctx: AppContext, bookingId: number) {
  const [row] = await ctx.db
    .select({ b: schema.counselingBookings, c: schema.counselors })
    .from(schema.counselingBookings)
    .innerJoin(schema.counselors, eq(schema.counselors.id, schema.counselingBookings.counselorId))
    .where(eq(schema.counselingBookings.id, bookingId));
  return row;
}

const counselorWhere = (c: { name: string; place: string | null }) => `${esc(c.name)}${c.place ? ` · ${esc(c.place)}` : ''}`;

const counselingBooked: Handler<'counseling.booked'> = async (ctx, { bookingId }) => {
  const row = await counselingBooking(ctx, bookingId);
  // Успели отменить или перенести - у новой записи своё подтверждение.
  if (!row) return;
  const settings = await getSettings(ctx.db);
  const tz = settings.eventTimezone;
  // Напоминание ставится, только если на момент записи до окошка было больше 15 минут.
  const reminds = row.b.slotStart.getTime() - 15 * 60_000 > row.b.createdAt.getTime();
  await notifyMany(
    ctx,
    await recipientsFor(ctx, [row.b.participantId]),
    (names) =>
      `✅ Вы записаны: ${esc(settings.counselingTitle)}\n<b>${fmtDateTime(row.b.slotStart, tz)}</b> · ${counselorWhere(row.c)}${namesLine(names)}\n\n` +
      `${reminds ? 'Напомним за 15 минут. ' : ''}Отменить или перенести можно в приложении.`,
  );
};

const counselingReminder: Handler<'counseling.reminder'> = async (ctx, { bookingId, slotStart }) => {
  const row = await counselingBooking(ctx, bookingId);
  if (!row || row.b.slotStart.toISOString() !== slotStart) return;
  const settings = await getSettings(ctx.db);
  const tz = settings.eventTimezone;
  await notifyMany(
    ctx,
    await recipientsFor(ctx, [row.b.participantId]),
    (names) => `⏰ Через 15 минут - ${esc(settings.counselingTitle)}\n<b>${fmtTime(row.b.slotStart, tz)}</b> · ${counselorWhere(row.c)}${namesLine(names)}`,
    undefined,
    (userId) => `counseling-reminder:${bookingId}:${userId}`,
  );
};

/** «Напомнить всем»: каждому аккаунту - его записи, у которых окошко ещё впереди: время, служитель и место (если указано). */
const counselingAnnounce: Handler<'counseling.announce'> = async (ctx, { counselorId, at }) => {
  const settings = await getSettings(ctx.db);
  const tz = settings.eventTimezone;
  const rows = await ctx.db
    .select({ b: schema.counselingBookings, c: schema.counselors, p: schema.participants })
    .from(schema.counselingBookings)
    .innerJoin(schema.counselors, eq(schema.counselors.id, schema.counselingBookings.counselorId))
    .innerJoin(schema.participants, eq(schema.participants.id, schema.counselingBookings.participantId))
    .where(
      and(
        sql`${schema.counselingBookings.slotStart} > now()`,
        eq(schema.participants.status, 'active'),
        counselorId ? eq(schema.counselingBookings.counselorId, counselorId) : undefined,
      ),
    )
    .orderBy(asc(schema.counselingBookings.slotStart));
  // Имя - только если на аккаунте несколько человек.
  const names = await recipientsFor(
    ctx,
    rows.map((r) => r.p.id),
  );
  const byUser = new Map<number, typeof rows>();
  for (const r of rows) {
    const uid = r.p.holderUserId ?? r.p.ownerUserId;
    byUser.set(uid, [...(byUser.get(uid) ?? []), r]);
  }
  const kb = new InlineKeyboard().webApp('🙏 Моя запись', `${ctx.config.APP_URL}/counseling`);
  for (const [userId, list] of byUser) {
    const family = (names.get(userId)?.length ?? 0) > 0;
    const lines = list.map((r) => `<b>${fmtDateTime(r.b.slotStart, tz)}</b> · ${counselorWhere(r.c)}${family ? ` · 👤 ${esc(r.p.firstName)}` : ''}`);
    await notifyMany(
      ctx,
      new Map([[userId, []]]),
      () => `🙏 <b>${esc(settings.counselingTitle)}</b> - напоминаем о записи\n\n${lines.join('\n')}\n\nОтменить или перенести можно в приложении.`,
      kb,
      (uid) => `counseling-announce:${at}:${uid}`,
    );
  }
};

// ---------- рассылки ----------

/** Лимит Telegram - около 30 сообщений в секунду на бота; рассылка берёт 20, остальное - билетам и ответам. */
const BROADCAST_BATCH = 20;

const broadcastRun: Handler<'broadcast.run'> = async (ctx, { broadcastId }) => {
  const started = await ctx.db
    .update(schema.broadcasts)
    .set({ status: 'sending', startedAt: sql`coalesce(${schema.broadcasts.startedAt}, now())` })
    .where(and(eq(schema.broadcasts.id, broadcastId), inArray(schema.broadcasts.status, ['scheduled', 'sending'])))
    .returning();
  const b = started[0];
  if (!b) return;
  // Отложенная рассылка: получатели - те, кто подходит сейчас, а не в момент создания.
  if (!b.isTest) {
    await ctx.db.execute(sql`
      insert into broadcast_deliveries (broadcast_id, user_id)
      select ${b.id}, s.id from (${segmentUsersSql(b.segment as Segment)}) s on conflict do nothing`);
    await ctx.db
      .update(schema.broadcasts)
      .set({ total: sql`(select count(*)::int from broadcast_deliveries where broadcast_id = ${b.id})` })
      .where(eq(schema.broadcasts.id, b.id));
  }

  // Получатели, «забранные» прошлым запуском, который оборвался (рестарт), - снова в очередь.
  await ctx.db.execute(sql`
    update broadcast_deliveries set status = 'pending', sent_at = null
     where broadcast_id = ${broadcastId} and status = 'sending' and sent_at < now() - interval '5 minutes'`);

  let transient = 0;
  for (;;) {
    const current = await ctx.db.query.broadcasts.findFirst({ where: eq(schema.broadcasts.id, broadcastId) });
    if (!current || current.status === 'cancelled') return;
    const t0 = Date.now();
    // Забираем пачку атомарно (status → sending, sent_at - время захвата): параллельная копия задачи
    // возьмёт других получателей, а не тех же самых.
    const claimed = await ctx.db.execute<{ user_id: string }>(sql`
      update broadcast_deliveries d set status = 'sending', sent_at = now()
       where d.broadcast_id = ${broadcastId} and d.user_id in (
         select user_id from broadcast_deliveries
          where broadcast_id = ${broadcastId} and status = 'pending'
          order by user_id limit ${BROADCAST_BATCH} for update skip locked)
       returning d.user_id`);
    const ids = claimed.rows.map((r) => Number(r.user_id));
    if (ids.length === 0) break;
    const batch = await ctx.db.select().from(schema.users).where(inArray(schema.users.id, ids));

    const results = await Promise.allSettled(
      batch.map(async (u) => {
        if (!u.tgId || u.botBlocked) return 'blocked' as const;
        try {
          await ctx.tg.sendMessage(u.tgId, tgHtml(b.text), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch((err: unknown) => {
            // Разметку не приняли (кривая вложенность маркеров) - шлём тот же текст без неё, но шлём.
            if (err instanceof GrammyError && err.error_code === 400 && /can't parse entities/i.test(err.description)) {
              return ctx.tg.sendMessage(u.tgId!, tgPlain(b.text), { link_preview_options: { is_disabled: true } });
            }
            throw err;
          });
          return 'sent' as const;
        } catch (err) {
          const code = (err as { error_code?: number }).error_code;
          if (code === 403) {
            await markBotBlocked(ctx.db, u.id);
            return 'blocked' as const;
          }
          throw err;
        }
      }),
    );
    let sent = 0;
    let blocked = 0;
    let failed = 0;
    for (let i = 0; i < batch.length; i++) {
      const r = results[i]!;
      const u = batch[i]!;
      // 4xx (кроме 429) - окончательно; сеть, 5xx, 429 - получатель вернётся в очередь.
      const code = r.status === 'rejected' ? (r.reason as { error_code?: number })?.error_code : undefined;
      const permanent = r.status === 'rejected' && code !== undefined && code >= 400 && code < 500 && code !== 429;
      const status = r.status === 'fulfilled' ? r.value : permanent ? 'failed' : 'pending';
      if (status === 'sent') sent++;
      else if (status === 'blocked') blocked++;
      else if (status === 'failed') failed++;
      else transient++;
      await ctx.db
        .update(schema.broadcastDeliveries)
        .set({
          status,
          error: r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason).slice(0, 300) : null,
          sentAt: status === 'sent' ? new Date() : null,
        })
        .where(and(eq(schema.broadcastDeliveries.broadcastId, broadcastId), eq(schema.broadcastDeliveries.userId, u.id)));
    }
    await ctx.db
      .update(schema.broadcasts)
      .set({
        sent: sql`${schema.broadcasts.sent} + ${sent}`,
        blocked: sql`${schema.broadcasts.blocked} + ${blocked}`,
        failed: sql`${schema.broadcasts.failed} + ${failed}`,
      })
      .where(eq(schema.broadcasts.id, broadcastId));
    // Временные сбои - не крутимся на месте: задача повторится позже и дошлёт оставшимся.
    if (transient > 0) throw new Error(`broadcast ${broadcastId}: ${transient} temporary failures, will retry`);
    // Темп: не больше BROADCAST_BATCH сообщений в секунду - остаётся запас под билеты и ответы бота.
    const rest = 1000 - (Date.now() - t0);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  }
  await ctx.db
    .update(schema.broadcasts)
    .set({ status: 'done', finishedAt: new Date() })
    .where(and(eq(schema.broadcasts.id, broadcastId), eq(schema.broadcasts.status, 'sending')));
};

// ---------- оплаты и прочее ----------

/** Строка про оплату человека: «Семьина Аня - 35 руб.» или «Семьин Петя - внесено 20 из 35 руб., осталось 15 руб.». */
function paidLine(p: typeof schema.participants.$inferSelect): string {
  const due = Number(p.amountDue ?? 0);
  const paid = Number(p.amountPaid ?? 0);
  return p.paymentStatus === 'partial'
    ? `👤 ${esc(fullName(p))} - внесено ${formatRub(paid)} из ${formatRub(due)}, осталось ${formatRub(due - paid)}`
    : `👤 ${esc(fullName(p))} - ${formatRub(paid)}`;
}

const receiptReviewed: Handler<'receipt.reviewed'> = async (ctx, { receiptId, notAccepted = [] }) => {
  const r = await ctx.db.query.paymentReceipts.findFirst({ where: eq(schema.paymentReceipts.id, receiptId) });
  if (!r) return;
  const reason = r.rejectReason ? `\nПричина: ${esc(r.rejectReason)}` : '';
  if (r.kind === 'donation' || r.kind === 'merch') {
    // Принятый чек за мерч: человеку уже пришло «Оплата за мерч принята».
    if (r.kind === 'merch' && r.status !== 'rejected') return;
    const order = r.merchOrderId ? await ctx.db.query.merchOrders.findFirst({ where: eq(schema.merchOrders.id, r.merchOrderId) }) : undefined;
    const note =
      r.kind === 'merch'
        ? `❌ <b>Чек за мерч${order ? ` ${esc(order.code)}` : ''} не принят</b>${reason}\n\n👉 Проверьте перевод и пришлите чек ещё раз - или оплатите у стола мерча.`
        : r.status === 'accepted'
          ? `💝 <b>Пожертвование получили</b>${r.amount ? ` - ${formatRub(r.amount)}` : ''}. Спасибо! 🙏`
          : `❌ <b>Чек пожертвования не принят</b>${reason}\n\n👉 Проверьте перевод и пришлите чек ещё раз - или напишите организаторам.`;
    await sendToUser(ctx, await getUser(ctx.db, r.userId), (chatId) => ctx.tg.sendMessage(chatId, note, { parse_mode: 'HTML' }));
    return;
  }
  const ids = [...new Set([...r.participantIds, ...notAccepted])];
  const people = ids.length ? await ctx.db.select().from(schema.participants).where(inArray(schema.participants.id, ids)) : [];
  const accepted = people.filter((p) => r.status === 'accepted' && r.participantIds.includes(p.id));
  const rest = people.filter((p) => notAccepted.includes(p.id));
  const user = await getUser(ctx.db, r.userId);
  let text: string;
  if (r.status === 'accepted') {
    text = `✅ <b>Чек принят</b>\n${accepted.map(paidLine).join('\n')}`;
    if (rest.length) {
      text += `\n\n⚠️ По этому чеку не засчитали: ${rest.map((p) => esc(fullName(p))).join(', ')}. ${rest.length > 1 ? 'За них' : 'За этого человека'} взнос ещё нужно внести.`;
    }
  } else {
    text =
      `❌ <b>Чек не принят</b>${r.rejectReason ? `\nПричина: ${esc(r.rejectReason)}` : ''}\n\n` +
      '👉 Проверьте перевод и пришлите чек ещё раз - или напишите организаторам.';
  }
  await sendToUser(ctx, user, (chatId) =>
    ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text(BTN.pay, 'v1:pay') }),
  );
};

const receiptArchive: Handler<'receipt.archive'> = async (ctx, { receiptId }) => {
  await archiveReceipt(ctx, receiptId);
};

/** Копии старых чеков и тех, что не скачались сразу; не вышло с одним - остальные всё равно копируем. */
const receiptArchiveMissing: Handler<'receipt.archive_missing'> = async (ctx) => {
  for (const id of await receiptsToArchive(ctx.db)) {
    await archiveReceipt(ctx, id).catch((err: unknown) => ctx.log.warn({ err, receiptId: id }, 'receipt archive failed'));
    await new Promise((r) => setTimeout(r, 300));
  }
};

/** Черновик чека не отправлен: показываем его ещё раз с теми же кнопками. Один раз на черновик. */
const receiptDraftReminder: Handler<'receipt.draft_reminder'> = async (ctx, { receiptId }) => {
  const draft = await draftForReminder(ctx.db, receiptId);
  if (!draft) return;
  const user = await getUser(ctx.db, draft.userId);
  await step(ctx, `draft-reminder:${receiptId}`, () =>
    sendToUser(ctx, user, (chatId) =>
      ctx.tg.sendMessage(chatId, `⚠️ <b>Чек ещё не отправлен на проверку</b>\nОрганизаторы его пока не видят.\n\n${draftText(draft.people)}`, {
        parse_mode: 'HTML',
        reply_markup: draftKeyboard(receiptId, draft.people),
      }),
    ),
  );
};

/** Оплату приняли в кассе или в админке - пишем владельцу аккаунта и держателю QR-кода (если это разные люди). */
const paymentConfirmed: Handler<'payment.confirmed'> = async (ctx, { participantIds, method, donation }) => {
  const people = await ctx.db.select().from(schema.participants).where(inArray(schema.participants.id, participantIds));
  const byUser = new Map<number, (typeof people)[number][]>();
  for (const p of people) {
    for (const uid of new Set([p.ownerUserId, p.holderUserId].filter((x): x is number => x != null))) {
      byUser.set(uid, [...(byUser.get(uid) ?? []), p]);
    }
  }
  const how = { cash: 'наличными', card: 'картой', transfer: 'переводом' }[method];
  for (const [uid, list] of byUser) {
    const user = await getUser(ctx.db, uid);
    await step(ctx, jobKey(`u${uid}`), () =>
      sendToUser(ctx, user, (chatId) =>
        ctx.tg.sendMessage(
          chatId,
          `✅ <b>Взнос получен</b> - ${how}\n${list.map(paidLine).join('\n')}${donation ? `\n💝 Пожертвование: ${formatRub(donation)}` : ''}\n\n🙏 Спасибо!`,
          { parse_mode: 'HTML' },
        ),
      ),
    );
  }
};

const userCommands: Handler<'user.commands'> = async (ctx, { userId }) => {
  const user = await getUser(ctx.db, userId);
  if (!user?.tgId) return;
  const settings = await getSettings(ctx.db);
  await syncChatCommands(ctx.tg, user.tgId, await getRoles(ctx.db, userId), settings.paymentsEnabled);
};

/**
 * Сообщение команды из переписки - в бот: «Организаторы» и текст, картинка - фото с подписью.
 * Под сообщением «Ответить» - открывает окно, как «Задать вопрос». Итог доставки пишем в сообщение.
 */
const chatDeliver: Handler<'chat.deliver'> = async (ctx, { messageId }) => {
  const m = await ctx.db.query.supportMessages.findFirst({ where: eq(schema.supportMessages.id, messageId) });
  if (!m || m.delivery !== null) return;
  const user = await getUser(ctx.db, m.userId);
  const kb = new InlineKeyboard().text('✍️ Ответить', 'v1:ask');
  const body = `💬 <b>Организаторы</b>${m.text ? `\n${esc(m.text)}` : ''}`;
  const { outcome } = await sendToUser(ctx, user, async (chatId) => {
    if (m.photo) {
      // Telegram надёжнее принимает JPEG, чем WebP: перекодируем при отправке.
      const jpeg = await sharp(await readStored(ctx.config.PRIVATE_DIR, m.photo)).jpeg({ quality: 85 }).toBuffer();
      const photo = new InputFile(jpeg, 'photo.jpg');
      // Подпись к фото - до 1024 знаков; длинный текст - отдельным сообщением.
      if (body.length <= 1000) return ctx.tg.sendPhoto(chatId, photo, { caption: body, parse_mode: 'HTML', reply_markup: kb });
      await ctx.tg.sendPhoto(chatId, photo);
    }
    return ctx.tg.sendMessage(chatId, body, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
  });
  await ctx.db.update(schema.supportMessages).set({ delivery: outcome }).where(eq(schema.supportMessages.id, messageId));
};

/**
 * Копия сообщения из папки «Мерч» - в бот продавцам и админам, кому включили (настройки мерча).
 * Кнопка открывает переписку в админке; отвечают там, а не в боте.
 */
/** Обычное сообщение участника (не «Мерч») - копия в бот админам и суперадминам, кому включено («Сообщения» → «Копии в Telegram»). */
const chatNotify: Handler<'chat.notify'> = async (ctx, { messageId }) => {
  const m = await ctx.db.query.supportMessages.findFirst({ where: eq(schema.supportMessages.id, messageId) });
  if (!m || m.fromStaff) return;
  const th = await ctx.db.query.supportThreads.findFirst({ where: eq(schema.supportThreads.userId, m.userId) });
  // Переписку уже перенесли в «Мерч» - туда своя копия, продавцам.
  if (th?.topic === 'merch') return;
  const name = (await namesOf(ctx.db, [m.userId])).get(m.userId)?.name ?? 'Участник';
  const body = (m.text ?? '').length > 1500 ? `${m.text!.slice(0, 1500)}…` : (m.text ?? '');
  const text = `💬 <b>Сообщение организаторам</b> · ${esc(name)}\n${esc(body)}`;
  const kb = new InlineKeyboard().url('Открыть переписку', `${ctx.config.ADMIN_URL.replace(/\/$/, '')}/messages/${m.userId}`);
  for (const uid of await chatNotifyRecipients(ctx.db)) {
    if (uid === m.userId) continue;
    await step(ctx, jobKey(`u${uid}`), async () =>
      sendToUser(ctx, await getUser(ctx.db, uid), (chatId) =>
        ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } }),
      ),
    );
  }
};

const chatMerchNotify: Handler<'chat.merch_notify'> = async (ctx, { messageId }) => {
  const m = await ctx.db.query.supportMessages.findFirst({ where: eq(schema.supportMessages.id, messageId) });
  if (!m || m.fromStaff) return;
  const th = await ctx.db.query.supportThreads.findFirst({ where: eq(schema.supportThreads.userId, m.userId) });
  if (th?.topic !== 'merch') return;
  const name = (await namesOf(ctx.db, [m.userId])).get(m.userId)?.name ?? 'Участник';
  const body = (m.text ?? '').length > 1500 ? `${m.text!.slice(0, 1500)}…` : (m.text ?? '');
  const text = `🛍 <b>Мерч</b> · ${esc(name)}\n${esc(body)}`;
  const kb = new InlineKeyboard().url('Открыть переписку', `${ctx.config.ADMIN_URL.replace(/\/$/, '')}/messages/${m.userId}`);
  for (const uid of await merchNotifyRecipients(ctx.db)) {
    if (uid === m.userId) continue;
    await step(ctx, jobKey(`u${uid}`), async () =>
      sendToUser(ctx, await getUser(ctx.db, uid), (chatId) =>
        ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } }),
      ),
    );
  }
};

/** Фото профиля из Telegram для списка переписок: нет фото или закрыто настройками - остаются буквы. */
const chatAvatar: Handler<'chat.avatar'> = async (ctx, { userId }) => {
  const user = await getUser(ctx.db, userId);
  if (!user?.tgId) return;
  let avatar: string | null = user.avatar;
  try {
    const photos = await ctx.tg.getUserProfilePhotos(user.tgId, { limit: 1 });
    const sizes = photos.photos[0];
    if (!sizes?.length) {
      avatar = null;
    } else {
      const pick = sizes.find((s) => s.width >= 160) ?? sizes.at(-1)!;
      const file = await ctx.tg.getFile(pick.file_id);
      if (file.file_path) {
        const data = await telegramDownload(`https://api.telegram.org/file/bot${ctx.config.BOT_TOKEN}/${file.file_path}`, 20_000);
        avatar = await saveAvatar(ctx.config.PRIVATE_DIR, data);
      }
    }
  } catch (err) {
    // Не вышло (сеть, Telegram) - попробуем через сутки, список переписок от этого не ломается.
    ctx.log.warn({ err, userId }, 'avatar fetch failed');
  }
  await ctx.db.update(schema.users).set({ avatar, avatarCheckedAt: new Date() }).where(eq(schema.users.id, userId));
};

const notifyText: Handler<'notify.text'> = async (ctx, { userId, text, kind }) => {
  await sendToUser(ctx, await getUser(ctx.db, userId), (chatId) => ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML' }), { log: { kind: kind ?? 'notify.text' } });
};

const merchExpire: Handler<'merch.expire'> = async (ctx, { orderId }) => {
  await expireOrder(ctx, orderId);
};

/** Раз в минуту: подошло время из настроек мерча - один раз на это время спрашиваем «Точно заберёте?». */
const merchConfirmTick: Handler<'merch.confirm_tick'> = async (ctx) => {
  const s = await getSettings(ctx.db);
  const by = confirmDeadline(s);
  if (!s.merchConfirmAt || !by || !s.merchVisible || !s.merchSalesEnabled) return;
  const at = new Date(s.merchConfirmAt);
  // Время ещё не пришло или ответить уже некогда.
  if (Date.now() < at.getTime() || Date.now() >= by.getTime()) return;
  if (!(await firstTime(ctx.db, `merch-confirm:${at.toISOString()}`))) return;
  await enqueue(ctx.boss, 'merch.confirm_ask', { at: at.toISOString() });
};

/**
 * «Точно заберёте?» с кнопками всем с неоплаченной бронью; дошло - ждём ответа до срока из настроек, молчание снимает бронь
 * (если так в настройках; подтверждённую раньше - не снимаем). Оплаченным, но не забранным - напоминание забрать.
 */
const merchConfirmAsk: Handler<'merch.confirm_ask'> = async (ctx, { at }) => {
  const settings = await getSettings(ctx.db);
  if (!settings.merchVisible || !settings.merchSalesEnabled) return;
  // Время в настройках поменяли, пока задача ждала, - спросит запуск на новое время.
  if (!settings.merchConfirmAt || Date.parse(settings.merchConfirmAt) !== Date.parse(at)) return;
  const by = confirmDeadline(settings)!;
  const until = confirmTime(by, settings.eventTimezone);
  const orders = `${ctx.config.APP_URL}/merch/orders`;
  for (const o of await ordersToConfirm(ctx.db, new Date(at), settings.merchConfirmDrop)) {
    await step(ctx, jobKey(`o${o.id}`), async () => {
      const kb = new InlineKeyboard().text('✅ Да, заберу', `v1:mcy:${o.id}`).text('❌ Отменить бронь', `v1:mcn:${o.id}`).row().webApp('🛍 Мои заказы', orders);
      const text =
        `🛍 <b>Ваша бронь мерча</b> - код <b>${esc(o.code)}</b>\n${o.items.map((i) => `• ${esc(i)}`).join('\n')}\n\n` +
        (o.soft
          ? `<b>Точно заберёте?</b> Ответьте, пожалуйста, до ${until}.`
          : `<b>Точно заберёте?</b> Ответьте до ${until} - иначе бронь снимется и вещи вернутся в витрину для других.`) +
        `\n\n${PICKUP}.`;
      const askedAt = new Date();
      const r = await sendToUser(ctx, await getUser(ctx.db, o.userId), (chatId) => ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb }), {
        log: { ref: `order:${o.id}` },
      });
      // Не дошло (нет Telegram, заблокировал бота) - не спросили, значит и не снимаем.
      if (r.outcome !== 'sent') return;
      await markConfirmAsked(ctx.db, o.id, askedAt, by, o.soft);
      if (!o.soft) await enqueue(ctx.boss, 'merch.confirm_drop', { orderId: o.id, askedAt: askedAt.toISOString() }, { startAfter: by });
    });
  }
  for (const o of await paidToRemind(ctx.db)) {
    const text = `🛍 <b>Ваш мерч оплачен и ждёт вас</b> - код <b>${esc(o.code)}</b>\n${o.items.map((i) => `• ${esc(i)}`).join('\n')}\n\n${PICKUP_PAID}.`;
    // Одно напоминание на заказ и время вопроса - даже если задачу запустят ещё раз.
    await step(ctx, `merch-paid-reminder:${at}:${o.id}`, async () =>
      sendToUser(ctx, await getUser(ctx.db, o.userId), (chatId) => ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML' }), { log: { kind: 'merch.paid_reminder', ref: `order:${o.id}` } }),
    );
  }
};

/** Прислали чек за мерч - продавцам (кому включены копии из «Мерча»): открыть заказы в админке или в приложении команды. */
const merchReceiptNotify: Handler<'merch.receipt_notify'> = async (ctx, { receiptId }) => {
  const notice = await merchReceiptNotice(ctx.db, receiptId);
  if (!notice) return;
  const kb = new InlineKeyboard()
    .url('Открыть чеки (админка)', `${ctx.config.ADMIN_URL.replace(/\/$/, '')}/merch?receipts=1`)
    .row()
    .webApp('📱 Мерч в приложении', `${ctx.config.APP_URL}/staff/merch`);
  for (const uid of notice.recipients) {
    await step(ctx, jobKey(`u${uid}`), async () =>
      sendToUser(ctx, await getUser(ctx.db, uid), (chatId) => ctx.tg.sendMessage(chatId, notice.text, { parse_mode: 'HTML', reply_markup: kb }), {
        log: { ref: `receipt:${receiptId}` },
      }),
    );
  }
};

const merchConfirmDrop: Handler<'merch.confirm_drop'> = async (ctx, { orderId, askedAt }) => {
  await dropUnconfirmed(ctx, orderId, askedAt);
};

// ---------- игра ----------

/** Приглашение в игру: за одного человека - кнопки прямо в чате, за нескольких - выбор во вкладке «Игра». */
const gameInvite: Handler<'game.invite'> = async (ctx, { userIds }) => {
  const config = await gameConfigNow(ctx.db);
  const audience = await inviteAudience(ctx.db);
  const url = `${ctx.config.APP_URL}/game`;
  const only = userIds?.length ? new Set(userIds) : null;
  // В тестовом запуске честно пишем, что это тест: участники конференции ничего не видят.
  const test = launchOf(config) === 'test';
  const intro = test ? '🧪 <b>Тестовый запуск</b> - проверяем игру до конференции.\n\n' : '';
  for (const [uid, people] of audience) {
    if (only && !only.has(uid)) continue;
    const user = await getUser(ctx.db, uid);
    const kb = new InlineKeyboard();
    if (people.length === 1) kb.text('🙋 Участвую', `v1:gy:${people[0]!.id}`).text('Не участвую', `v1:gn:${people[0]!.id}`).row();
    kb.webApp('🌍 Открыть игру', url);
    const names = people.length > 1 ? `\n\nЗа кого отвечаете: ${people.map((p) => `<b>${esc(p.name)}</b>`).join(', ')} - отметьте каждого во вкладке «Игра».` : '';
    await step(ctx, jobKey(`u${uid}`), () =>
      sendToUser(ctx, user, (chatId) =>
        ctx.tg.sendMessage(chatId, `${intro}${config.inviteText.trim() || DEFAULT_GAME_CONFIG.inviteText}${names}`, { parse_mode: 'HTML', reply_markup: kb }),
      ),
    );
  }
  // Тест-лист без регистрации: записать в команду нельзя, но голосовать можно - коротко объясняем.
  for (const uid of await votersOnlyTesters(ctx.db)) {
    if (only && !only.has(uid)) continue;
    const user = await getUser(ctx.db, uid);
    const kb = new InlineKeyboard().webApp('🌍 Открыть игру', url);
    const text = `${intro}🌍 <b>Миссионерская игра «Церкви»</b>\n\nТы в тест-листе. Играть в команде могут только зарегистрированные на конференцию, а голосовать - все: когда ведущий откроет голосование, оно появится во вкладке «Игра».`;
    await step(ctx, jobKey(`v${uid}`), () => sendToUser(ctx, user, (chatId) => ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb })));
  }
};

// ---------- отзывы ----------

const feedbackRemind: Handler<'feedback.remind'> = async (ctx, { userIds }) => {
  const kb = new InlineKeyboard().webApp('💛 Оставить отзыв', `${ctx.config.APP_URL}/feedback`);
  const path = join(ctx.config.MEDIA_DIR, FEEDBACK_REMIND_IMAGE);
  const image = existsSync(path) ? path : null;
  // Картинку грузим в Telegram один раз, дальше - по её file_id (быстро, без повторной загрузки).
  let fileId: string | null = null;
  for (const uid of userIds?.length ? userIds : await feedbackRemindAudience(ctx.db)) {
    const user = await getUser(ctx.db, uid);
    await step(ctx, jobKey(`u${uid}`), () =>
      sendToUser(ctx, user, async (chatId) => {
        if (!image) return ctx.tg.sendMessage(chatId, FEEDBACK_REMIND_TEXT, { parse_mode: 'HTML', reply_markup: kb });
        const msg = await ctx.tg.sendPhoto(chatId, fileId ?? new InputFile(image), { caption: FEEDBACK_REMIND_TEXT, parse_mode: 'HTML', reply_markup: kb });
        fileId ??= msg.photo?.at(-1)?.file_id ?? null;
        return msg;
      }),
    );
  }
};

/** «Ты в команде …»; капитану - ещё и что оформить. */
const gameAssigned: Handler<'game.assigned'> = async (ctx, { participantIds }) => {
  if (participantIds.length === 0) return;
  const config = await gameConfigNow(ctx.db);
  const labels = await teamLabels(ctx.db);
  const rows = await ctx.db
    .select({ p: schema.participants, teamId: schema.gamePlayers.teamId, captainOf: schema.gameTeams.id })
    .from(schema.gamePlayers)
    .innerJoin(schema.participants, eq(schema.participants.id, schema.gamePlayers.participantId))
    .leftJoin(schema.gameTeams, eq(schema.gameTeams.captainId, schema.participants.id))
    .where(and(inArray(schema.gamePlayers.participantId, participantIds), eq(schema.gamePlayers.answer, 'yes')));
  const kb = new InlineKeyboard().webApp('🌍 Открыть игру', `${ctx.config.APP_URL}/game`);
  for (const { p, teamId, captainOf } of rows) {
    if (!teamId) continue;
    const team = labels.get(teamId) ?? 'команда';
    const who = rows.length > 1 || p.holderUserId ? `<b>${esc(fullName(p))}</b>\n` : '';
    let text = `${who}${(config.assignedText.trim() || DEFAULT_GAME_CONFIG.assignedText).replaceAll('{team}', team)}`;
    if (captainOf === teamId) text += `\n\n${(config.captainText.trim() || DEFAULT_GAME_CONFIG.captainText).replaceAll('{team}', team)}`;
    const user = await getUser(ctx.db, p.holderUserId ?? p.ownerUserId);
    await step(ctx, jobKey(`p${p.id}`), () => sendToUser(ctx, user, (chatId) => ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb })));
  }
};

/** Задания открыты: каждому аккаунту - задание его команды с флагом и страной. */
const gameTasksRevealed: Handler<'game.tasks_revealed'> = async (ctx) => {
  const kb = new InlineKeyboard().webApp('🌍 Открыть игру', `${ctx.config.APP_URL}/game`);
  for (const m of await revealedTaskMessages(ctx.db)) {
    const { title, context, text: task } = m.task;
    const text = [
      `🌍 <b>Задание вашей команды</b>\n${m.label}`,
      `<b>${esc(title)}</b>`,
      context && `<b>Контекст</b>\n${tgHtml(context)}`,
      task && `<b>Задание</b>\n${tgHtml(task)}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const user = await getUser(ctx.db, m.userId);
    await step(ctx, jobKey(`u${m.userId}t${m.teamId}`), () => sendToUser(ctx, user, (chatId) => ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb })));
  }
};

const gameRoundClose: Handler<'game.round_close'> = async (ctx, { roundId, closesAt }) => {
  await closeRoundIfDue(ctx, roundId, closesAt);
};

/** Открылось голосование - игрокам в бот (если включено). */
const gameRoundNotify: Handler<'game.round_notify'> = async (ctx, { roundId }) => {
  const [round] = await ctx.db.select().from(schema.gameRounds).where(eq(schema.gameRounds.id, roundId));
  if (!round || round.status !== 'open') return;
  const labels = await teamLabels(ctx.db);
  // Тексты - из настроек игры; пустое поле - текст по умолчанию.
  const config = await gameConfigNow(ctx.db);
  const text = round.teamId
    ? (config.roundText.trim() || DEFAULT_GAME_CONFIG.roundText).replaceAll('{team}', labels.get(round.teamId) ?? '')
    : config.budgetRoundText.trim() || DEFAULT_GAME_CONFIG.budgetRoundText;
  const kb = new InlineKeyboard().webApp('🗳 Голосовать', `${ctx.config.APP_URL}/game`);
  for (const uid of await yesPlayersAccounts(ctx.db)) {
    const user = await getUser(ctx.db, uid);
    await step(ctx, jobKey(`u${uid}`), () => sendToUser(ctx, user, (chatId) => ctx.tg.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb })));
  }
};

const gameSchedule: Handler<'game.schedule'> = async (ctx, { key, at }) => {
  await runScheduled(ctx, key, at);
};

const HANDLERS: { [Q in QueueName]: { handler: Handler<Q>; concurrency: number } } = {
  'tickets.send': { handler: sendTickets, concurrency: 4 },
  'checkin.welcome': { handler: checkinWelcome, concurrency: 4 },
  'activity.promoted': { handler: activityPromoted, concurrency: 2 },
  'activity.reminder': { handler: activityReminder, concurrency: 2 },
  'activity.changed': { handler: activityChanged, concurrency: 2 },
  'seminar.rooms': { handler: seminarRooms, concurrency: 1 },
  'seminar.assigned': { handler: seminarAssigned, concurrency: 1 },
  'counseling.booked': { handler: counselingBooked, concurrency: 2 },
  'counseling.reminder': { handler: counselingReminder, concurrency: 2 },
  'counseling.announce': { handler: counselingAnnounce, concurrency: 1 },
  'broadcast.run': { handler: broadcastRun, concurrency: 1 },
  'receipt.reviewed': { handler: receiptReviewed, concurrency: 2 },
  'receipt.archive': { handler: receiptArchive, concurrency: 2 },
  'receipt.archive_missing': { handler: receiptArchiveMissing, concurrency: 1 },
  'receipt.draft_reminder': { handler: receiptDraftReminder, concurrency: 2 },
  'payment.confirmed': { handler: paymentConfirmed, concurrency: 2 },
  'user.commands': { handler: userCommands, concurrency: 2 },
  'notify.text': { handler: notifyText, concurrency: 4 },
  'chat.deliver': { handler: chatDeliver, concurrency: 4 },
  'chat.merch_notify': { handler: chatMerchNotify, concurrency: 2 },
  'chat.notify': { handler: chatNotify, concurrency: 2 },
  'chat.avatar': { handler: chatAvatar, concurrency: 2 },
  'merch.expire': { handler: merchExpire, concurrency: 2 },
  'merch.receipt_notify': { handler: merchReceiptNotify, concurrency: 2 },
  'merch.confirm_tick': { handler: merchConfirmTick, concurrency: 1 },
  'merch.confirm_ask': { handler: merchConfirmAsk, concurrency: 1 },
  'merch.confirm_drop': { handler: merchConfirmDrop, concurrency: 2 },
  'feedback.remind': { handler: feedbackRemind, concurrency: 1 },
  'game.invite': { handler: gameInvite, concurrency: 1 },
  'game.assigned': { handler: gameAssigned, concurrency: 2 },
  'game.tasks_revealed': { handler: gameTasksRevealed, concurrency: 1 },
  'game.round_close': { handler: gameRoundClose, concurrency: 2 },
  'game.round_notify': { handler: gameRoundNotify, concurrency: 1 },
  'game.schedule': { handler: gameSchedule, concurrency: 1 },
};

/** Для тестов: выполнить задачу сразу, как это сделал бы воркер. */
export async function runJob<Q extends QueueName>(ctx: AppContext, name: Q, data: JobPayloads[Q], jobId?: string): Promise<void> {
  const run = () => (HANDLERS[name].handler as Handler<Q>)(ctx, data);
  // Без jobId - как раньше без ключей шагов; имя задачи - для журнала сообщений.
  await jobScope.run({ jobId: jobId ?? '', name }, run);
}

export async function registerWorkers(ctx: AppContext): Promise<void> {
  // Ключи шагов задач нужны, пока задачу могут повторить (часы), - старые чистим при запуске воркера.
  await ctx.db
    .execute(sql`delete from once_keys where key like 'job:%' and created_at < now() - interval '14 days'`)
    .catch((err: unknown) => ctx.log.warn({ err }, 'once_keys cleanup failed'));
  // Журнал сообщений бота - два месяца.
  await ctx.db
    .execute(sql`delete from bot_messages where created_at < now() - interval '60 days'`)
    .catch((err: unknown) => ctx.log.warn({ err }, 'bot_messages cleanup failed'));
  // «Точно заберёте мерч?» - во время из настроек мерча: сверяемся раз в минуту. Старое расписание «ср-пт в 12:00» убираем.
  await ctx.boss.unschedule('merch.confirm_ask');
  await ctx.boss.schedule('merch.confirm_tick', '* * * * *', {});
  await ctx.boss.schedule('receipt.archive_missing', '*/10 * * * *', {});
  for (const name of Object.keys(HANDLERS) as QueueName[]) {
    const { handler, concurrency } = HANDLERS[name] as { handler: Handler<QueueName>; concurrency: number };
    await ctx.boss.work<JobPayloads[QueueName]>(
      name,
      { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          try {
            await jobScope.run({ jobId: job.id, name }, () => handler(ctx, job.data));
          } catch (err) {
            ctx.log.error({ err, queue: name, jobId: job.id }, 'job failed');
            throw err;
          }
        }
      },
    );
  }
}
