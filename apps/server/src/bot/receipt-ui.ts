import { formatRub } from '@sof/shared';
import { InlineKeyboard } from 'grammy';
import type { ReceiptPerson } from '../services/payment.service.ts';
import { esc } from './format.ts';

export const receiptSum = (people: ReceiptPerson[]) => people.filter((p) => p.included).reduce((acc, p) => acc + p.due, 0);

/** Черновик чека: галочки по людям, «Отправить», «Отмена». Ряды собираем явно - без пустых. */
export function draftKeyboard(receiptId: number, people: ReceiptPerson[]): InlineKeyboard {
  const rows = people.map((p) => [
    InlineKeyboard.text(`${p.included ? '✅' : '⬜'} ${p.fullName}${p.due > 0 ? ` - ${formatRub(p.due)}` : ''}`, `v1:rt:${receiptId}.${p.id}`),
  ]);
  const n = people.filter((p) => p.included).length;
  rows.push([InlineKeyboard.text(n ? `Отправить · ${formatRub(receiptSum(people))}` : 'Отправить', `v1:rs:${receiptId}`)]);
  rows.push([InlineKeyboard.text('Отмена', `v1:rx:${receiptId}`)]);
  return InlineKeyboard.from(rows);
}

/** Черновик: за кого чек. Кнопки с именами - переключатели: нажали - ✅ (за него), ещё раз - ⬜ (не за него). */
export function draftText(people: ReceiptPerson[]): string {
  const chosen = people.filter((p) => p.included);
  return (
    '🧾 <b>За кого этот чек?</b>\n' +
    'Нажмите на имя внизу: ✅ - чек за этого человека, ⬜ - не за него. Нажмите ещё раз, чтобы снять. Потом - «Отправить».\n' +
    'Переводов несколько? Пришлите сюда все чеки подряд - они соберутся в этот же.\n\n' +
    (chosen.length ? `✅ Отмечено: ${chosen.map((p) => esc(p.fullName)).join(', ')}, ${formatRub(receiptSum(people))}` : 'Пока никто не отмечен.')
  );
}
