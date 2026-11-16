import { autoRetry } from '@grammyjs/auto-retry';
import { limit } from '@grammyjs/ratelimiter';
import { sequentialize } from '@grammyjs/runner';
import { ROLE_LABELS, canUseAdminWeb, formatRub, fullName, hasPermission, type Role } from '@sof/shared';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { Bot, GrammyError, InlineKeyboard, Keyboard, type Context } from 'grammy';
import { telegramClient } from '../lib/telegram-net.ts';
import type { Message } from 'grammy/types';
import type { AppContext } from '../context.ts';
import { schema } from '../db/client.ts';
import { enqueue } from '../jobs/queues.ts';
import { AppError } from '../lib/errors.ts';
import { claim, displayPhone, findClaimable, normalizeTelegramPhone, setVerifiedPhone } from '../services/claim.service.ts';
import { cancelAwaitingQuestion, QUESTION_WINDOW_MS, startAwaitingQuestion, userWrites } from '../services/chat.service.ts';
import { rememberMessages, trackOutgoingMessages } from '../lib/message-tracking.ts';
import { claimTicket } from '../services/participants.service.ts';
import { autoLinkByUsername, unlinkByHolder } from '../services/link.service.ts';
import {
  cancelDraftReceipt,
  confirmReceipt,
  createPurposeReceipt,
  createReceipt,
  hasOpenPayments,
  recentReceipt,
  reservedOrders,
  toggleReceiptPerson,
  type ReceiptFile,
  type ReceiptPerson,
  type ReceiptPurpose,
} from '../services/payment.service.ts';
import { personPaymentText } from '../services/tiers.ts';
import { arrivedToday } from '../services/dashboard.service.ts';
import { feeDeadlineText, getSettings, isRegistrationOpen, otherTransferText } from '../services/settings.service.ts';
import { createAdminLoginLink, redeemInvite } from '../services/staff.service.ts';
import { answerGame } from '../services/game.service.ts';
import { getRoles, markBotBlocked, upsertTelegramUser, type UserRow } from '../services/users.service.ts';
import { adoptRestoredByPhone, adoptRestoredByUsername, hasPendingRestored } from '../services/restore.service.ts';
import { cancelOwnOrder, confirmOwnOrder, onlinePayment, PICKUP } from '../services/merch.service.ts';
import { countRequest } from '../services/traffic.service.ts';
import { recordVisit } from '../services/visits.service.ts';
import { syncChatCommands } from './commands.ts';
import { BTN, canScan, endKeyboard, mainKeyboard } from './keyboards.ts';
import { esc } from './format.ts';
import { draftKeyboard, draftText, receiptSum } from './receipt-ui.ts';

/** linkedNow - сколько людей привязали по нику прямо в этом апдейте (тогда меню пришлёт задача с QR-кодами). */
export type BotContext = Context & { appUser: UserRow | null; roles: Role[]; linkedNow: number };
type Ctx = Omit<AppContext, 'tg'>;

const RECEIPT_WINDOW_MS = 20 * 60_000;

async function family(ctx: Ctx, userId: number) {
  return ctx.db
    .select()
    .from(schema.participants)
    .where(
      and(
        eq(schema.participants.status, 'active'),
        or(eq(schema.participants.ownerUserId, userId), eq(schema.participants.holderUserId, userId)),
      ),
    )
    .orderBy(schema.participants.id);
}

/** Экран в том же сообщении (edit) - старые кнопки не плодят новых сообщений. */
async function showScreen(c: BotContext, text: string, keyboard?: InlineKeyboard) {
  const opts = { parse_mode: 'HTML' as const, reply_markup: keyboard, link_preview_options: { is_disabled: true } };
  const msg = c.callbackQuery?.message;
  if (msg && 'text' in msg && msg.text !== undefined) {
    try {
      await c.editMessageText(text, opts);
      return;
    } catch (err) {
      if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
    }
  }
  await c.reply(text, opts);
}

const back = () => new InlineKeyboard().text('← Меню', 'v1:menu');

export function createBot(ctx: Ctx): Bot<BotContext> {
  const { config, db, boss, log } = ctx;
  // Таймаут запроса - минута (по умолчанию 500 с): зависший запрос не держит задачу дольше её срока в очереди.
  const bot = new Bot<BotContext>(config.BOT_TOKEN, { client: { timeoutSeconds: 60, ...telegramClient() } });
  // Сетевые ошибки не повторяем здесь бесконечно (так auto-retry делает по умолчанию):
  // их повторит очередь задач, а long polling - runner.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60, rethrowHttpErrors: true }));
  // Номера исходящих сообщений - чтобы «Очистить всю базу» могла удалить переписку.
  trackOutgoingMessages(bot.api, db);

  // Апдейты одного чата - строго по очереди: двойные нажатия не обгоняют друг друга.
  bot.use(sequentialize((c) => c.chat?.id.toString() ?? c.from?.id.toString()));

  // Блокировка/разблокировка бота пользователем.
  bot.on('my_chat_member', async (c) => {
    if (c.chat.type !== 'private') return;
    const status = c.myChatMember.new_chat_member.status;
    const user = await db.query.users.findFirst({ where: eq(schema.users.tgId, c.from.id) });
    if (!user) return;
    if (status === 'kicked') await markBotBlocked(db, user.id);
    else if (status === 'member') {
      await db.update(schema.users).set({ botBlocked: false, allowsWrite: true }).where(eq(schema.users.id, user.id));
    }
  });

  // Больше 4 действий за 1.5 с от одного человека - лишние тихо отбрасываем.
  bot.use(
    limit({
      timeFrame: 1500,
      limit: 4,
      keyGenerator: (c) => c.from?.id.toString(),
      onLimitExceeded: async (c) => {
        if (c.callbackQuery) await c.answerCallbackQuery().catch(() => {});
      },
    }),
  );

  bot.use(async (c, next) => {
    c.appUser = null;
    c.linkedNow = 0;
    c.roles = [];
    if (c.from && !c.from.is_bot && c.chat?.type === 'private') {
      // После сбоя хостинга: аккаунт из выгрузки с тем же @ником становится этим аккаунтом (семья, код оплаты, QR-коды).
      const adopted = await adoptRestoredByUsername(ctx, c.from).catch((err: unknown) => {
        log.warn({ err }, 'restore adopt failed');
        return 0;
      });
      c.appUser = await upsertTelegramUser(db, c.from, { allowsWrite: true, superadminTgIds: config.SUPERADMIN_TG_IDS });
      countRequest('bot', c.appUser.id);
      c.roles = await getRoles(db, c.appUser.id);
      await recordVisit(db, c.appUser.id, 'bot', log);
      // Кто-то уже записал этого человека и указал его @ник - QR-код придёт сам.
      // Узнали по нику аккаунт из выгрузки - тоже считаем: меню и QR-коды пришлёт задача, второе меню не нужно.
      c.linkedNow =
        adopted +
        (await autoLinkByUsername(ctx, c.appUser).catch((err) => {
          log.warn({ err }, 'auto-link failed');
          return 0;
        }));
      if (c.msg?.message_id) await rememberMessages(db, c.chat.id, [c.msg.message_id]).catch(() => {});
    } else countRequest('bot');
    await next();
  });

  const pm = bot.chatType('private');

  // ---------- экраны ----------

  /** Значок к строке оплаты - по статусу, чтобы с первого взгляда было видно, у кого что. */
  const payIcon = (status: string) =>
    ({ paid: '✅', pending: '⏳', partial: '🟡', exempt: '🤝' } as Record<string, string>)[status] ?? '💳';
  /** «👤 Имя» и строка статуса со значком - одинаково на главном экране и в «Оплате». */
  const personBlock = (settings: Awaited<ReturnType<typeof getSettings>>, p: Awaited<ReturnType<typeof family>>[number], payments: boolean) => {
    const parts = [payments ? `${payIcon(p.paymentStatus)} ${personPaymentText(settings, p)}` : null, p.arrivedAt ? '📍 на месте' : null].filter(Boolean);
    return `👤 <b>${esc(fullName(p))}</b>${parts.length ? `\n${esc(parts.join(' · '))}` : ''}`;
  };

  /** После сбоя хостинга: регистрации после 29 октября не сохранились. */
  const RE_REGISTER =
    'Если вы регистрировались после 29 октября, просим прощения: из-за сбоя сервиса эти регистрации не сохранились. Пожалуйста, зарегистрируйтесь ещё раз - это займёт пару минут.';

  async function mainMenu(c: BotContext, { withWelcome = false } = {}) {
    const user = c.appUser;
    // Служебные апдейты (например, «бот закрепил сообщение» - от самого бота) без пользователя - молчим.
    if (!user) return;
    const [settings, people] = await Promise.all([getSettings(db), family(ctx, user.id)]);
    // «Конец «Шага веры»»: вместо статусов и регистрации - благодарность, отзыв и вопрос организаторам.
    if (settings.eventEnded) {
      const text = `⛪️ <b>${esc(settings.eventName)}</b>\n\n🙏 <b>${esc(settings.endTitle)}</b>\n\n${esc(settings.endText)}`;
      await showScreen(c, text, endKeyboard(config.APP_URL, c.roles));
      return;
    }
    const payments = settings.paymentsEnabled;
    const open = isRegistrationOpen(settings);
    let text = `⛪️ <b>${esc(settings.eventName)}</b>\n\n`;
    if (withWelcome && settings.welcomeText) text += `👋 ${esc(settings.welcomeText)}\n\n`;
    if (people.length === 0) {
      text += open
        ? '📝 Чтобы попасть на конференцию, нужна <b>регистрация</b>. Она займёт пару минут, можно сразу записать и тех, кто придёт с вами.'
        : '🔒 Регистрация сейчас закрыта.';
      text += (await hasPendingRestored(db))
        ? '\n\n🛠 <b>Мы переехали на новый сервер.</b> Из-за сбоя у хостинга мы восстановили регистрации по состоянию на 29 октября.' +
          '\n\n✅ Если вы регистрировались до 29 октября, нажмите «Меня уже зарегистрировали» и поделитесь номером телефона - мы найдём вашу регистрацию.' +
          '\n\n🙏 ' + RE_REGISTER
        : '\n\n🙋 Если вас уже записал кто-то другой, нажмите «Меня уже зарегистрировали».';
    } else {
      // Каждый человек - имя и одна строка статуса со значком.
      text += people.map((p) => personBlock(settings, p, payments)).join('\n\n');
    }
    const kb = mainKeyboard(config.APP_URL, {
      registered: people.length > 0,
      canRegister: open,
      payments,
      roles: c.roles,
      schedule: settings.scheduleVisible,
    });
    await showScreen(c, text, kb);
  }

  async function paymentScreen(c: BotContext) {
    const user = c.appUser!;
    const [settings, people] = await Promise.all([getSettings(db), family(ctx, user.id)]);
    if (!settings.paymentsEnabled) return mainMenu(c);
    const open = people.filter((p) => p.paymentStatus === 'unpaid' || p.paymentStatus === 'partial');
    const left = open.reduce((sum, p) => sum + Math.max(0, Number(p.amountDue ?? 0) - Number(p.amountPaid ?? 0)), 0);
    // Переводы выключены - всем показываем только наличные.
    const byTransfer = settings.transfersEnabled ? open.filter((p) => p.paymentMethod !== 'cash') : [];
    const byCash = settings.transfersEnabled ? open.filter((p) => p.paymentMethod === 'cash') : open;
    let text = '💰 <b>Взнос</b>\n';
    if (people.length) {
      text += `\n${people.map((p) => personBlock(settings, { ...p, arrivedAt: null }, true)).join('\n\n')}\n`;
    }
    if (open.length) {
      // formatRub уже заканчивается точкой («45 руб.») - вторую не ставим.
      text += `\n⏳ Осталось внести ${formatRub(left)} ${feeDeadlineText(settings)}\n`;
      if (byTransfer.length) {
        text +=
          `\n🏦 <b>Переводом</b>\n${esc(settings.paymentInstructions)}\n<i>Взнос, оплаченный переводом, не возвращается.</i>\n` +
          (byTransfer.length > 1 || open.length > 1
            ? '✍️ В комментарии к переводу укажите фамилии и имена тех, за кого платите.\n'
            : '✍️ В комментарии к переводу укажите фамилию и имя.\n') +
          // Самый важный шаг - отдельным жирным блоком, чтобы его не пропустили в конце инструкции.
          '\n❗️ <b>ОБЯЗАТЕЛЬНО: после перевода пришлите сюда фото, скриншот или PDF чека' +
          (open.length > 1 ? ' - бот спросит, за кого он.' : '.') +
          '</b>\nБез чека оплату не засчитаем.\n' +
          (open.length > 1 ? 'Переводов несколько - пришлите все чеки подряд, они соберутся в один.\n' : '');
      }
      if (byCash.length) text += `\n💵 <b>Наличными</b>\n${esc(settings.cashInstructions)}\n`;
      // Ждём чек только если есть кому платить переводом.
      if (byTransfer.length) {
        await db
          .update(schema.users)
          .set({ awaitingReceiptUntil: new Date(Date.now() + RECEIPT_WINDOW_MS), awaitingReceiptFor: null })
          .where(eq(schema.users.id, user.id));
      }
    } else if (people.some((p) => p.paymentStatus === 'pending')) {
      text += settings.softPaymentLabels ? '\n✅ <b>Чек получен.</b> Спасибо! 🙏' : '\n⏳ <b>Чек на проверке.</b> Напишем, когда проверим.';
    } else if (people.length) {
      text += people.length > 1 ? '\n✅ <b>Взнос внесён за всех.</b> Спасибо! 🙏' : '\n✅ <b>Взнос внесён.</b> Спасибо! 🙏';
    }
    // Пожертвование и мерч - свои кнопки: чек после них уходит своим видом, а не за взнос.
    const kb = new InlineKeyboard();
    if (settings.transfersEnabled) kb.text('💝 Пожертвование', 'v1:don');
    if (onlinePayment(settings) && (await reservedOrders(db, user.id)).length) kb.text('🛍 Оплатить мерч', 'v1:mpay');
    await showScreen(c, text, kb.row().text('← Меню', 'v1:menu'));
  }

  /** Ждём чек этого вида 20 минут: следующее фото или файл уйдёт пожертвованием или за эту бронь. */
  async function awaitReceipt(userId: number, purpose: string) {
    await db
      .update(schema.users)
      .set({ awaitingReceiptUntil: new Date(Date.now() + RECEIPT_WINDOW_MS), awaitingReceiptFor: purpose })
      .where(eq(schema.users.id, userId));
  }

  async function donationScreen(c: BotContext) {
    const settings = await getSettings(db);
    if (!settings.paymentsEnabled || !settings.transfersEnabled) return paymentScreen(c);
    await awaitReceipt(c.appUser!.id, 'donation');
    await showScreen(
      c,
      `💝 <b>Пожертвование</b>\n\n${esc(otherTransferText(settings))}\nВ комментарии к переводу напишите «Пожертвование».\n\n` +
        '❗️ <b>После перевода пришлите сюда фото, скриншот или PDF чека.</b>',
      new InlineKeyboard().text('← Оплата', 'v1:pay'),
    );
  }

  /** Оплата брони мерча переводом: одна бронь - сразу реквизиты, несколько - сначала выбрать. */
  async function merchPayScreen(c: BotContext, orderId: number | null) {
    const settings = await getSettings(db);
    if (!settings.paymentsEnabled || !onlinePayment(settings)) return paymentScreen(c);
    const orders = await reservedOrders(db, c.appUser!.id);
    const toPay = orderId ? orders.find((o) => o.id === orderId) : orders.length === 1 ? orders[0] : undefined;
    if (!toPay) {
      const kb = new InlineKeyboard();
      for (const o of orders) kb.text(`${o.code} · ${formatRub(o.total)}`, `v1:mpay:${o.id}`).row();
      await showScreen(c, orders.length ? '🛍 <b>За какую бронь чек?</b>' : '🛍 Неоплаченных броней мерча нет.', kb.text('← Оплата', 'v1:pay'));
      return;
    }
    await awaitReceipt(c.appUser!.id, `merch:${toPay.id}`);
    await showScreen(
      c,
      `🛍 <b>Мерч - бронь ${esc(toPay.code)}</b>\nК оплате: ${formatRub(toPay.total)}\n\n${esc(otherTransferText(settings))}\n` +
        `В комментарии к переводу укажите код ${esc(toPay.code)}.\n\n❗️ <b>После перевода пришлите сюда фото, скриншот или PDF чека.</b>`,
      new InlineKeyboard().text('← Оплата', 'v1:pay'),
    );
  }

  async function statsScreen(c: BotContext) {
    if (!hasPermission(c.roles, 'dashboard:read') && !hasPermission(c.roles, 'checkin:write')) return mainMenu(c);
    const settings = await getSettings(db);
    const res = await db.execute<{ active: number; paid: number; arrived: number; receipts: number; last_hour: number }>(sql`
      select (select count(*) from participants where status = 'active')::int as active,
             (select count(*) from participants where status = 'active' and payment_status in ('paid', 'exempt'))::int as paid,
             (select count(*) from participants where status = 'active' and arrived_at is not null)::int as arrived,
             (select count(*) from payment_receipts where status = 'pending')::int as receipts,
             (select count(*) from check_ins where revoked_at is null and created_at > now() - interval '1 hour')::int as last_hour`);
    const s = res.rows[0]!;
    const payments = settings.paymentsEnabled ? `Оплачено: ${s.paid}\nЧеков на проверке: ${s.receipts}\n` : '';
    // На 2-й и 3-й день «пришли хоть раз» уже почти все - важнее, сколько отмечено сегодня.
    const today = await arrivedToday(db, settings.eventTimezone);
    const arrival =
      today > 0 ? `На месте сегодня: ${today} из ${s.active}\nЗа конференцию приходили: ${s.arrived}` : `На месте: ${s.arrived} из ${s.active}`;
    await showScreen(
      c,
      `📊 <b>Статистика</b>\n\nЗарегистрировано: ${s.active}\n${arrival}\nОтметок за час: ${s.last_hour}\n${payments}`,
      new InlineKeyboard().text(BTN.refresh, 'v1:stats').text('← Меню', 'v1:menu'),
    );
  }

  async function sendAdminLink(c: BotContext) {
    if (!canUseAdminWeb(c.roles)) return;
    const url = await createAdminLoginLink(ctx, c.appUser!);
    await c.reply('🔑 Ссылка для входа в админку. Одноразовая, действует 15 минут.', {
      reply_markup: new InlineKeyboard().url(BTN.admin, url),
    });
  }

  async function resendTickets(c: BotContext): Promise<string> {
    const user = c.appUser!;
    const people = await family(ctx, user.id);
    if (people.length === 0) return 'QR-кодов пока нет: сначала нужна регистрация';
    if (user.lastTicketsSentAt && Date.now() - user.lastTicketsSentAt.getTime() < 60_000) {
      return people.length > 1 ? 'QR-коды уже в чате выше' : 'QR-код уже в чате выше';
    }
    await db.update(schema.users).set({ lastTicketsSentAt: new Date() }).where(eq(schema.users.id, user.id));
    await enqueue(boss, 'tickets.send', { userId: user.id, participantIds: people.map((p) => p.id), reason: 'resend' });
    return people.length > 1 ? 'Отправляю QR-коды' : 'Отправляю QR-код';
  }

  // ---------- чеки (только когда оплата включена) ----------

  /**
   * Чек из сообщения: фото или файл. Файлом принимаем картинки (JPG, PNG, WebP) и PDF.
   * HEIC с айфона у проверяющих в браузере не откроется, а файлы больше 20 МБ бот не может скачать -
   * такие не берём и объясняем, как прислать.
   */
  function receiptFileOf(msg: Message | undefined): ReceiptFile | { problem: string } | null {
    const photo = msg?.photo?.at(-1);
    if (photo) return { fileId: photo.file_id, fileUniqueId: photo.file_unique_id, kind: 'photo', mimeType: 'image/jpeg' };
    const doc = msg?.document;
    if (!doc) return null;
    const name = (doc.file_name ?? '').toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    const byExt: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', heic: 'image/heic', heif: 'image/heif' };
    const mime = (doc.mime_type ?? byExt[ext] ?? '').toLowerCase();
    if (mime === 'image/heic' || mime === 'image/heif') {
      return { problem: '⚠️ Этот файл в формате HEIC, у проверяющих он не откроется. Пришлите чек как фото (не файлом) или скриншотом.' };
    }
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(mime)) {
      return { problem: '⚠️ Такой файл не подходит. Пришлите чек фото, скриншотом или PDF-файлом.' };
    }
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      return { problem: '⚠️ Файл больше 20 МБ, бот не сможет его передать. Пришлите фото или скриншот чека.' };
    }
    return { fileId: doc.file_id, fileUniqueId: doc.file_unique_id, kind: 'document', mimeType: mime };
  }
  const isProblem = (f: ReturnType<typeof receiptFileOf>): f is { problem: string } => f !== null && 'problem' in f;

  const sum = receiptSum;

  function sentText(people: ReceiptPerson[]): string {
    const chosen = people.filter((p) => p.included);
    const others = people.filter((p) => !p.included && p.due > 0);
    return (
      '📨 <b>Чек отправлен на проверку</b>\n' +
      chosen.map((p) => `👤 ${esc(p.fullName)}${p.due > 0 ? `, ${formatRub(p.due)}` : ''}`).join('\n') +
      (chosen.length > 1 ? `\nВсего ${formatRub(sum(people))}` : '') +
      '\n\n⏳ Напишем, когда проверим.' +
      // Имена не склоняем («за Петю») - пишем без них.
      (others.length ? ' Взнос за остальных можно внести отдельно.' : '')
    );
  }

  /** Чек за взнос; null - платить взнос не за кого (тогда спросим, за что чек). */
  async function acceptReceipt(user: UserRow, file: ReceiptFile, caption?: string | null): Promise<{ text: string; kb?: InlineKeyboard } | null> {
    const res = await createReceipt(ctx, user, file, caption);
    await db.update(schema.users).set({ awaitingReceiptUntil: null }).where(eq(schema.users.id, user.id));
    if (res.status === 'draft') {
      // Не нажал «Отправить» - через 15 минут напомним: иначе семья думает, что оплатила, а чек никто не видит.
      await enqueue(boss, 'receipt.draft_reminder', { receiptId: res.receiptId }, { startAfter: new Date(Date.now() + 15 * 60_000) });
      return { text: draftText(res.people), kb: draftKeyboard(res.receiptId, res.people) };
    }
    if (res.status === 'sent') return { text: sentText(res.people) };
    if (res.status === 'duplicate') return { text: '👌 Этот чек уже получен.' };
    if (res.status === 'added') {
      // Ещё один файл того же платежа: черновик - отметить людей выше и отправить; отправленный - просто добавили.
      return res.draft
        ? { text: `➕ <b>Добавили к этому же чеку</b> - файлов: ${res.files}.\nОтметьте выше, за кого он, и нажмите «Отправить».` }
        : { text: `➕ <b>Добавили к чеку на проверке</b> - файлов: ${res.files}.` };
    }
    return null;
  }

  /** Чек пожертвования или за бронь мерча - сразу на проверку. */
  async function acceptPurposeReceipt(user: UserRow, file: ReceiptFile, caption: string | null | undefined, purpose: ReceiptPurpose): Promise<string> {
    const res = await createPurposeReceipt(ctx, user, purpose, { telegram: file }, caption);
    await db.update(schema.users).set({ awaitingReceiptUntil: null, awaitingReceiptFor: null }).where(eq(schema.users.id, user.id));
    if (res.status === 'duplicate') return '👌 Этот чек уже получен.';
    if (res.status === 'not_reserved') return '⚠️ Эта бронь уже оплачена или снята - чек не отправили.';
    if (res.status === 'added') return `➕ <b>Добавили к чеку на проверке</b> - файлов: ${res.files}.`;
    return purpose.kind === 'donation'
      ? '💝 <b>Чек пожертвования отправлен на проверку.</b> Спасибо! 🙏'
      : `📨 <b>Чек за мерч ${esc(res.orderCode ?? '')} отправлен.</b> Продавец увидит его в заказе.`;
  }

  /** Фото или файл без кнопки: спрашиваем, чек ли это и за что. */
  async function askPurpose(c: BotContext, messageId: number, hasFee: boolean) {
    const settings = await getSettings(db);
    const orders = onlinePayment(settings) ? await reservedOrders(db, c.appUser!.id) : [];
    const kb = new InlineKeyboard();
    if (hasFee) kb.text('💳 Взнос', 'v1:rk:fee').row();
    kb.text('💝 Пожертвование', 'v1:rk:don').row();
    for (const o of orders) kb.text(`🛍 Мерч ${o.code}`, `v1:rk:m${o.id}`).row();
    kb.text('Нет, это не чек', 'v1:rk:no');
    await c.reply('🧾 Это чек? За что он?', { reply_parameters: { message_id: messageId }, reply_markup: kb });
  }

  /** Перерисовать сообщение под кнопкой. Не получилось - пишем в лог и присылаем новым сообщением, а не молчим. */
  async function redraw(c: BotContext, text: string, kb?: InlineKeyboard) {
    try {
      await c.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch (err) {
      if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
      log.warn({ err, update: c.update.update_id }, 'edit message failed');
      await c.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  // ---------- «Меня уже зарегистрировали» ----------
  // Друга записали без ника. Он делится номером (его подтверждает Telegram) - ищем регистрации на этот номер.

  const shareKeyboard = () => new Keyboard().requestContact(BTN.shareNumber).row().text('Отмена').resized().oneTime();

  async function notFoundKeyboard() {
    const kb = new InlineKeyboard();
    if (isRegistrationOpen(await getSettings(db))) kb.webApp(BTN.register, `${config.APP_URL}/register`).row();
    return kb.text('← Меню', 'v1:menu');
  }

  /** Сколько ждём номер после «Поделиться номером». */
  const CONTACT_WINDOW_MS = 15 * 60_000;

  const OTHER_NUMBER =
    '💡 Если вас записали на другой номер, попросите того, кто записывал, передать вам QR-код: «Мои QR-коды» → «⋯» → «Передать QR-код». Или зарегистрируйтесь сами.';

  async function claimStart(c: BotContext) {
    const user = c.appUser!;
    if (user.phone) return claimFound(c, user);
    // Номер ждём только отсюда: контакт из Mini App («Взять номер из Telegram») бот сохраняет молча.
    await db
      .update(schema.users)
      .set({ awaitingContactUntil: new Date(Date.now() + CONTACT_WINDOW_MS) })
      .where(eq(schema.users.id, user.id));
    await c.reply(
      '📱 Нажмите <b>«Поделиться номером»</b> внизу экрана. Telegram пришлёт номер этого аккаунта, и мы найдём регистрацию на него.',
      { parse_mode: 'HTML', reply_markup: shareKeyboard() },
    );
  }

  async function claimFound(c: BotContext, user: UserRow) {
    // После сбоя хостинга: семья из выгрузки с этим номером переходит на аккаунт, QR-коды придут отдельно.
    const adopted = await adoptRestoredByPhone(ctx, user);
    const { phone, candidates } = await findClaimable(db, user);
    // Нашли семью - QR-коды и меню пришлёт задача; здесь только подтверждаем (и показываем, если есть кого забрать ещё).
    if (adopted.length > 0) {
      await c.reply('🔎 <b>Нашли вашу регистрацию.</b> QR-коды пришлю следующими сообщениями.', { parse_mode: 'HTML' });
      if (candidates.length === 0) return;
    }
    if (candidates.length === 0) {
      const restoring = await hasPendingRestored(db);
      await showScreen(
        c,
        restoring
          ? `🔎 <b>На номер ${displayPhone(phone ?? '')} регистраций не нашли</b>\n\n🙏 ${RE_REGISTER}\n\n${OTHER_NUMBER}`
          : `🔎 <b>На номер ${displayPhone(phone ?? '')} регистраций нет</b>\n\n${OTHER_NUMBER}`,
        await notFoundKeyboard(),
      );
      return;
    }
    const one = candidates.length === 1;
    const list = candidates.map((p) => `👤 <b>${esc(p.fullName)}</b>, записал(а) ${esc(p.registeredBy)}`).join('\n');
    const ids = candidates.map((p) => p.id).join('.');
    const kb = new InlineKeyboard()
      .text(one ? 'Да, это я' : 'Да, это мы', `v1:claimok:${ids.length <= 50 ? ids : 'all'}`)
      .text('Нет', 'v1:claimno');
    await showScreen(c, `🔎 <b>${one ? 'На ваш номер есть регистрация' : 'На ваш номер есть регистрации'}</b>\n${list}\n\n${one ? 'Это вы?' : 'Это вы и ваши близкие?'}`, kb);
  }

  async function claimConfirm(c: BotContext, arg: string | undefined) {
    const user = c.appUser!;
    const ids = arg === 'all' || !arg ? (await findClaimable(db, user)).candidates.map((p) => p.id) : arg.split('.').map(Number).filter(Boolean);
    try {
      const { claimed } = await claim(ctx, user, ids);
      const names = claimed.map((p) => `<b>${esc(p.fullName)}</b>`).join(', ');
      await redraw(
        c,
        claimed.length === 1
          ? `✅ <b>Готово!</b> Регистрация ${names} теперь и у вас. QR-код пришлю следующим сообщением.`
          : `✅ <b>Готово!</b> Регистрации ${names} теперь и у вас. QR-коды пришлю следующими сообщениями.`,
      );
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      await redraw(c, esc(err.message), await notFoundKeyboard());
    }
  }

  pm.on('message:contact', async (c) => {
    const contact = c.message.contact;
    // Отвечаем, только если номер просил сам бот («Меня уже зарегистрировали»). Иначе контакт пришёл из Mini App
    // («Взять номер из Telegram»): приложение само проверит регистрации, а в чате карточку контакта убираем.
    const asked = !!c.appUser!.awaitingContactUntil && c.appUser!.awaitingContactUntil > new Date();
    const own = contact.user_id === c.from.id;
    const phone = own ? normalizeTelegramPhone(contact.phone_number) : null;
    if (!asked) {
      if (phone) c.appUser = await setVerifiedPhone(db, c.appUser!, phone);
      await c.deleteMessage().catch(() => {});
      return;
    }
    // Кнопка «Поделиться номером» присылает контакт самого человека. Чужой контакт из записной книжки - не подтверждение.
    if (!own) {
      await c.reply('⚠️ Это чужой номер. Нажмите «Поделиться номером» внизу экрана - Telegram отправит ваш.', { reply_markup: shareKeyboard() });
      return;
    }
    if (!phone) {
      await c.reply('⚠️ Не получилось прочитать номер.', { reply_markup: { remove_keyboard: true } });
      return;
    }
    const user = await setVerifiedPhone(db, c.appUser!, phone);
    await db.update(schema.users).set({ awaitingContactUntil: null }).where(eq(schema.users.id, user.id));
    c.appUser = user;
    await c.reply(`📱 Ваш номер: <b>${displayPhone(phone)}</b>`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    await claimFound(c, user);
  });

  // ---------- «Задать вопрос» ----------

  async function askStart(c: BotContext) {
    await startAwaitingQuestion(db, c.appUser!.id);
    await c.reply('✍️ Напишите организаторам - в ближайшие 20 минут всё, что вы напишете, передадим им. Ответ придёт сюда.', {
      reply_markup: new InlineKeyboard().text('Отмена', 'v1:askno'),
    });
  }

  pm.hears('Отмена', async (c) => {
    await db.update(schema.users).set({ awaitingContactUntil: null }).where(eq(schema.users.id, c.appUser!.id));
    await c.reply('Хорошо.', { reply_markup: { remove_keyboard: true } });
    await mainMenu(c);
  });

  // ---------- команды ----------

  pm.command('start', async (c) => {
    const payload = c.match?.trim() ?? '';
    const user = c.appUser!;
    try {
      if (payload.startsWith('staff_')) {
        const role = await redeemInvite(ctx, payload.slice(6), user);
        c.roles = await getRoles(db, user.id);
        const settings = await getSettings(db);
        await syncChatCommands(bot.api, c.chat.id, c.roles, settings.paymentsEnabled);
        const where = hasPermission(c.roles, 'checkin:write') ? 'Сканер открывается кнопкой «Сканер» ниже, админка - в приложении' : 'Админка - в приложении';
        await c.reply(`🤝 Вы в команде, роль: <b>${ROLE_LABELS[role]}</b>. ${where}: «Команда» → «Админка».`, { parse_mode: 'HTML' });
        return mainMenu(c);
      }
      if (payload.startsWith('claim_')) {
        const claimed = await claimTicket(ctx, payload.slice(6), user);
        await c.reply(`🎁 QR-код участника <b>${esc(claimed.fullName)}</b> теперь есть и у вас. Отправляю.`, { parse_mode: 'HTML' });
        const who = user.username ? `@${esc(user.username)}` : esc(user.firstName ?? 'другой аккаунт');
        await enqueue(boss, 'notify.text', {
          kind: 'tickets.shared',
          userId: claimed.ownerUserId,
          text: `📲 QR-код участника <b>${esc(claimed.fullName)}</b> теперь есть и у ${who}. У вас он тоже остаётся.`,
        });
        return;
      }
      if (payload === 'admin' && canUseAdminWeb(c.roles)) return sendAdminLink(c);
    } catch (err) {
      if (err instanceof AppError) {
        await c.reply(esc(err.message), { parse_mode: 'HTML' });
        return;
      }
      throw err;
    }
    // Только что узнали по нику: QR-коды и меню придут одним блоком - второе меню не шлём.
    if (c.linkedNow > 0) return;
    await mainMenu(c, { withWelcome: true });
    // Зарегистрировался в приложении, но бот не мог написать (не нажимал /start или отказал в разрешении) -
    // QR-коды так и не дошли. Досылаем, если задача на отправку уже не стоит в очереди.
    if (!user.lastTicketsSentAt) {
      const people = await family(ctx, user.id);
      const queued = await db.execute(sql`
        select 1 from pgboss.job
         where name = 'tickets.send' and state in ('created', 'retry', 'active') and data->>'userId' = ${String(user.id)}
         limit 1`);
      if (people.length > 0 && queued.rows.length === 0) {
        await enqueue(boss, 'tickets.send', { userId: user.id, participantIds: people.map((p) => p.id), reason: 'resend' });
      }
    }
  });

  pm.command(['menu', 'help', 'status', 'info'], (c) => mainMenu(c));
  // Запасной вариант без интернета на входе: QR-коды картинками прямо в чат.
  pm.command(['qr', 'tickets'], async (c) => {
    await c.reply(await resendTickets(c));
  });
  pm.command('pay', (c) => paymentScreen(c));
  pm.command('scanner', async (c) => {
    if (!canScan(c.roles)) return mainMenu(c);
    await c.reply('📷 Сканер на входе:', { reply_markup: new InlineKeyboard().webApp(BTN.openScanner, `${config.APP_URL}/staff/scan`) });
  });
  // Скрытые запасные входы - в списке команд их нет.
  pm.command('stats', (c) => statsScreen(c));
  pm.command('admin', (c) => sendAdminLink(c));

  // ---------- кнопки ----------

  pm.callbackQuery(/^v1:([a-z]+)(?::(.+))?$/, async (c) => {
    const [, action, arg] = c.match;
    let toast: string | undefined;
    switch (action) {
      case 'menu':
        await mainMenu(c);
        break;
      case 'tickets':
        toast = await resendTickets(c);
        break;
      case 'pay':
        await paymentScreen(c);
        break;
      case 'don':
        await donationScreen(c);
        break;
      case 'mpay':
        await merchPayScreen(c, arg ? Number(arg) : null);
        break;
      case 'rk': {
        // «За что этот чек?» - файл берём из сообщения, на которое бот отвечал.
        const question = c.callbackQuery.message;
        const original = question && 'reply_to_message' in question ? question.reply_to_message : undefined;
        const file = receiptFileOf(original);
        if (arg === 'no' || !file) {
          await redraw(c, 'Хорошо, не отправляем.');
        } else if (isProblem(file)) {
          await redraw(c, file.problem);
        } else if (arg === 'fee') {
          const r = await acceptReceipt(c.appUser!, file, original?.caption);
          await redraw(c, r?.text ?? '👌 Сейчас платить взнос не за кого: он внесён или чек уже на проверке.', r?.kb);
        } else {
          const purpose: ReceiptPurpose | null = arg === 'don' ? { kind: 'donation' } : /^m\d+$/.test(arg ?? '') ? { kind: 'merch', orderId: Number(arg!.slice(1)) } : null;
          if (purpose) await redraw(c, await acceptPurposeReceipt(c.appUser!, file, original?.caption, purpose));
        }
        break;
      }
      case 'stats':
        await statsScreen(c);
        break;
      case 'adminlink':
        await sendAdminLink(c);
        break;
      case 'rcpt': {
        const question = c.callbackQuery.message;
        const original = question && 'reply_to_message' in question ? question.reply_to_message : undefined;
        const file = receiptFileOf(original);
        const settings = await getSettings(db);
        if (arg === 'yes' && isProblem(file)) {
          await redraw(c, file.problem);
        } else if (arg === 'yes' && file && !isProblem(file) && settings.paymentsEnabled && settings.transfersEnabled) {
          const r = await acceptReceipt(c.appUser!, file, original?.caption);
          await redraw(c, r?.text ?? '👌 Сейчас платить взнос не за кого: он внесён или чек уже на проверке.', r?.kb);
        } else {
          await redraw(c, 'Хорошо, не отправляем.');
        }
        break;
      }
      case 'rt': {
        const [receiptId, pid] = (arg ?? '').split('.').map(Number);
        if (!receiptId || !pid) break;
        const r = await toggleReceiptPerson(ctx, c.appUser!, receiptId, pid);
        if (r.status === 'ok') await redraw(c, draftText(r.people), draftKeyboard(receiptId, r.people));
        else toast = r.status === 'locked' ? 'Чек уже отправлен, изменить нельзя' : 'За этого человека уже заплатили';
        break;
      }
      case 'rs': {
        const receiptId = Number(arg);
        const r = await confirmReceipt(ctx, c.appUser!, receiptId);
        if (r.status === 'sent') await redraw(c, sentText(r.people));
        else toast = { empty: 'Отметьте хотя бы одного человека', locked: 'Чек уже отправлен', not_found: 'Чек не найден' }[r.status];
        break;
      }
      case 'rx': {
        const ok = await cancelDraftReceipt(ctx, c.appUser!, Number(arg));
        await redraw(c, ok ? 'Чек не отправлен. Можно прислать другой.' : 'Этот чек уже отправлен.');
        break;
      }
      case 'claim':
        await claimStart(c);
        break;
      case 'claimok':
        await claimConfirm(c, arg);
        break;
      case 'claimno':
        await redraw(c, `Хорошо, ничего не меняем.\n\n${OTHER_NUMBER}`, await notFoundKeyboard());
        break;
      case 'ask':
        await askStart(c);
        break;
      case 'askno':
        await cancelAwaitingQuestion(db, c.appUser!.id);
        await redraw(c, 'Хорошо, не отправляем.');
        break;
      case 'gy':
      case 'gn': {
        // Ответ на приглашение в игру прямо из чата.
        const yes = action === 'gy';
        try {
          const state = await answerGame(ctx, c.appUser!, c.roles, Number(arg), yes);
          const me = state.people.find((p) => p.participantId === Number(arg));
          const team = me?.teamId ? state.teams.find((t) => t.id === me.teamId) : null;
          const text = yes
            ? team
              ? `🙋 <b>Ты в игре!</b>\nТвоя команда - «${esc(team.title)}». Подробности - во вкладке «Игра».`
              : state.distributed
                ? '🙋 <b>Записали: ты в игре!</b>\nСвободных мест в командах нет - подойди к ведущему, он добавит.'
                : '🙋 <b>Записали: ты в игре!</b>\nПеред началом пришлём, в какой ты команде.'
            : 'Хорошо, записали: в этот раз не участвуешь. Приходи болеть и голосовать - это можно всем 🙂';
          await redraw(c, text, new InlineKeyboard().webApp('🌍 Открыть игру', `${config.APP_URL}/game`));
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          toast = err.message;
        }
        break;
      }
      case 'mcy':
      case 'mcn': {
        // «Точно заберёте мерч?» - ответ прямо из чата.
        try {
          const o = action === 'mcy' ? await confirmOwnOrder(ctx, c.appUser!, Number(arg)) : await cancelOwnOrder(ctx, c.appUser!, Number(arg));
          await redraw(
            c,
            action === 'mcy'
              ? `✅ <b>Спасибо, ждём вас!</b> Бронь <b>${esc(o.code)}</b> держим.\n\n${PICKUP}.`
              : `Бронь <b>${esc(o.code)}</b> отменена - вещи вернулись в витрину.`,
          );
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          toast = err.message;
          await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        }
        break;
      }
      case 'notme': {
        const ok = await unlinkByHolder(ctx, c.appUser!, Number(arg));
        toast = ok ? 'Спасибо, исправили' : 'Уже исправлено';
        if (ok) await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
        break;
      }
      default:
        await mainMenu(c);
    }
    await c.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {});
  });

  // Кнопки из старых версий меню: не ломаемся, показываем актуальное.
  pm.on('callback_query:data', async (c) => {
    await c.answerCallbackQuery({ text: 'Меню обновилось' }).catch(() => {});
    if (c.appUser) await mainMenu(c);
  });

  pm.on(['message:photo', 'message:document'], async (c, next) => {
    const settings = await getSettings(db);
    // Чеки нужны только для переводов.
    if (!settings.paymentsEnabled || !settings.transfersEnabled) return next();
    const user = c.appUser!;
    const file = receiptFileOf(c.message);
    if (!file) return next();
    const waiting = user.awaitingReceiptUntil && user.awaitingReceiptUntil > new Date();
    if (isProblem(file)) {
      // Объясняем, только если человек действительно шлёт чек (открыт экран оплаты или есть что оплачивать).
      if (waiting || (await hasOpenPayments(db, user.id))) {
        await c.reply(file.problem, { reply_parameters: { message_id: c.message.message_id } });
        return;
      }
      return next();
    }
    if (waiting) {
      // После кнопки «Пожертвование» или «Оплатить мерч» - чек этого вида.
      const purpose: ReceiptPurpose | null =
        user.awaitingReceiptFor === 'donation'
          ? { kind: 'donation' }
          : /^merch:\d+$/.test(user.awaitingReceiptFor ?? '')
            ? { kind: 'merch', orderId: Number(user.awaitingReceiptFor!.slice(6)) }
            : null;
      if (purpose) {
        const text = await acceptPurposeReceipt(user, file, c.message.caption, purpose);
        await c.reply(text, { parse_mode: 'HTML', reply_parameters: { message_id: c.message.message_id } });
        return;
      }
      const r = await acceptReceipt(user, file, c.message.caption);
      if (r) {
        await c.reply(r.text, { parse_mode: 'HTML', reply_markup: r.kb, reply_parameters: { message_id: c.message.message_id } });
        return;
      }
      // Взнос платить не за кого - может, это пожертвование или мерч.
      await askPurpose(c, c.message.message_id, false);
      return;
    }
    // Только что присылал чек - это продолжение того же платежа: к нему или такого же вида.
    const recent = await recentReceipt(db, user.id);
    if (recent) {
      if (recent.kind === 'fee') {
        const r = await acceptReceipt(user, file, c.message.caption);
        if (r) {
          await c.reply(r.text, { parse_mode: 'HTML', reply_markup: r.kb, reply_parameters: { message_id: c.message.message_id } });
          return;
        }
      } else {
        const purpose: ReceiptPurpose = recent.kind === 'merch' && recent.merchOrderId ? { kind: 'merch', orderId: recent.merchOrderId } : { kind: 'donation' };
        const text = await acceptPurposeReceipt(user, file, c.message.caption, purpose);
        await c.reply(text, { parse_mode: 'HTML', reply_parameters: { message_id: c.message.message_id } });
        return;
      }
    }
    // Вне окна «Оплата» переспрашиваем - случайные фото не попадут в очередь проверки.
    await askPurpose(c, c.message.message_id, await hasOpenPayments(db, user.id));
  });

  // На обычный текст - меню. Служебные сообщения (закрепление и т. п.) пропускаем.
  pm.on('message:text', async (c) => {
    const user = c.appUser!;
    // После «Задать вопрос» или «Ответить» текст уходит в переписку с организаторами (команды сюда не попадают).
    if (user.awaitingQuestionUntil && user.awaitingQuestionUntil > new Date() && !c.message.text.startsWith('/')) {
      try {
        // Первое сообщение после кнопки - подтверждаем словами, следующие - 👍, чтобы не засорять чат.
        const started = new Date(user.awaitingQuestionUntil.getTime() - QUESTION_WINDOW_MS);
        const [earlier] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.supportMessages)
          .where(
            and(
              eq(schema.supportMessages.userId, user.id),
              eq(schema.supportMessages.fromStaff, false),
              gte(schema.supportMessages.createdAt, started),
            ),
          );
        await userWrites(db, user, c.message.text, { boss });
        if (earlier!.n === 0) {
          await c.reply('✅ Передали организаторам. Ответ придёт в этот чат.', {
            reply_parameters: { message_id: c.message.message_id },
          });
        } else {
          await c.react('👍').catch(() => undefined);
        }
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await c.reply(err.message);
      }
      return;
    }
    await mainMenu(c);
  });

  bot.catch((err) => {
    log.error({ err: err.error, update: err.ctx.update.update_id }, 'bot handler error');
  });

  return bot;
}
