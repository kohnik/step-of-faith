import { hasPermission, type Role } from '@sof/shared';
import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';

export function canScan(roles: readonly Role[]): boolean {
  return hasPermission(roles, 'checkin:write') || hasPermission(roles, 'activities:own');
}

/**
 * Подписи кнопок разделов: одна иконка в начале - меню читается быстрее.
 * Ответы («Да», «Нет», «Отмена», «← Меню») - без иконок, чтобы не пестрило.
 */
export const BTN = {
  register: '📝 Зарегистрироваться',
  claim: '🙋 Меня уже зарегистрировали',
  app: '📱 Открыть приложение',
  tickets: '🎟 QR-коды',
  schedule: '📅 Расписание',
  pay: '💳 Оплата',
  scanner: '📷 Сканер',
  openScanner: '📷 Открыть сканер',
  merch: '🛍 Мерч: продажа',
  admin: '🖥 Открыть админку',
  refresh: '🔄 Обновить',
  ask: '❓ Задать вопрос',
  feedback: '💛 Оставить отзыв',
  shareNumber: '📞 Поделиться номером',
} as const;

/**
 * Единственное меню бота. Всё остальное - внутри приложения.
 * Не зарегистрирован: Зарегистрироваться · Меня уже зарегистрировали · Расписание.
 * Зарегистрирован: Открыть приложение / QR-коды · Расписание / Оплата.
 * Всем - «Задать вопрос». Сотрудникам - отдельной строкой «Сканер», сразу готовый к работе;
 * продавцу без сканера - «Мерч: продажа».
 * Расписание скрыто в настройках - кнопки нет (команде остаётся).
 */
export function mainKeyboard(
  appUrl: string,
  opts: { registered: boolean; canRegister: boolean; payments: boolean; roles: readonly Role[]; schedule?: boolean },
): InlineKeyboard {
  const staff = canScan(opts.roles);
  const schedule = (opts.schedule ?? true) || staff;
  const scheduleBtn = InlineKeyboard.webApp(BTN.schedule, `${appUrl}/schedule`);
  const rows: InlineKeyboardButton[][] = [];
  if (!opts.registered) {
    if (opts.canRegister) rows.push([InlineKeyboard.webApp(BTN.register, `${appUrl}/register`)]);
    rows.push([InlineKeyboard.text(BTN.claim, 'v1:claim')]);
    if (schedule) rows.push([scheduleBtn]);
  } else {
    rows.push([InlineKeyboard.webApp(BTN.app, appUrl)]);
    rows.push([InlineKeyboard.webApp(BTN.tickets, `${appUrl}/tickets`), ...(schedule ? [scheduleBtn] : [])]);
    if (opts.payments) rows.push([InlineKeyboard.text(BTN.pay, 'v1:pay')]);
  }
  rows.push([InlineKeyboard.text(BTN.ask, 'v1:ask')]);
  if (staff) rows.push([InlineKeyboard.webApp(BTN.scanner, `${appUrl}/staff/scan`)]);
  else if (hasPermission(opts.roles, 'merch:sell')) rows.push([InlineKeyboard.webApp(BTN.merch, `${appUrl}/staff/merch`)]);
  return InlineKeyboard.from(rows);
}

/** «Конец «Шага веры»»: оставить отзыв, написать организаторам, приложение; команде - её кнопки как обычно. */
export function endKeyboard(appUrl: string, roles: readonly Role[]): InlineKeyboard {
  const rows: InlineKeyboardButton[][] = [
    [InlineKeyboard.webApp(BTN.feedback, `${appUrl}/feedback`)],
    [InlineKeyboard.text(BTN.ask, 'v1:ask')],
    [InlineKeyboard.webApp(BTN.app, appUrl)],
  ];
  if (canScan(roles)) rows.push([InlineKeyboard.webApp(BTN.scanner, `${appUrl}/staff/scan`)]);
  else if (hasPermission(roles, 'merch:sell')) rows.push([InlineKeyboard.webApp(BTN.merch, `${appUrl}/staff/merch`)]);
  return InlineKeyboard.from(rows);
}
