/**
 * Логика отметки: цвет карточки, отправка онлайн (3 секунды) с откатом в офлайн-очередь, отмена.
 * Цвета повторяют правила сервера: неоплата блокирует только точку «Вход», только если оплата
 * вообще включена и в настройках не разрешён вход без оплаты.
 */
import {
  PAYMENT_STATUS_LABELS,
  type CheckInEvent,
  type CheckInOutcome,
  type CheckInResult,
  type CheckpointKind,
  type CheckpointView,
} from '@sof/shared';
import { ApiError } from '../api/client.ts';
import { dayKey, formatDayKey, formatTime } from '../lib/time.ts';
import { staffApi } from './api.ts';
import type { LocalCheckIn } from './db.ts';
import { deleteLocalCheckIn, putLocalCheckIns, type CardInfo, type LookupState } from './manifest.ts';
import { enqueue, queueRevoke, removeFromOutbox, syncedResult } from './outbox.ts';

export const CHECKPOINT_KIND_LABELS: Record<CheckpointKind, string> = {
  entrance: 'Вход',
  activity: 'Активность',
  meal: 'Питание',
  training: 'Обучение',
};

export type Color = 'green' | 'yellow' | 'red';

export interface Verdict {
  color: Color;
  title: string;
  detail?: string;
  canCheckIn: boolean;
  unpaid: boolean;
}

export interface PaymentRules {
  /** Оплата включена организаторами (выключена - оплату не проверяем и не показываем). */
  paymentsEnabled: boolean;
  allowUnpaidEntry: boolean;
}

export function needsPayment(card: CardInfo, cp: CheckpointView, rules: PaymentRules): boolean {
  return (
    rules.paymentsEnabled &&
    !rules.allowUnpaidEntry &&
    cp.kind === 'entrance' &&
    card.paymentStatus !== 'paid' &&
    card.paymentStatus !== 'exempt' &&
    // Чек прислали - пускаем, проверим после конференции.
    card.paymentStatus !== 'pending'
  );
}

/** «09:12», а если не сегодня - «6 нояб., 09:12»: на 2-й день повтор с прошлого дня видно сразу. */
export function whenText(at: string, tz: string): string {
  const time = formatTime(at, tz);
  return dayKey(at, tz) === dayKey(new Date(), tz) ? time : `${formatDayKey(dayKey(at, tz), { day: 'numeric', month: 'short' })}, ${time}`;
}

export function checkInLabel(mark: NonNullable<CardInfo['checkIn']>, tz: string): string {
  return `${whenText(mark.at, tz)} · ${mark.byName}${mark.local ? ' (офлайн)' : ''}`;
}

export function personVerdict(
  card: CardInfo,
  cp: CheckpointView,
  rules: PaymentRules,
  tz: string,
  codeStatus: 'active' | 'revoked' | 'by_id' = 'by_id',
): Verdict {
  // Отмена участия тоже гасит QR-код - тогда главное сказать, что регистрация отменена, а не «перевыпущен».
  if (card.status === 'cancelled') {
    return { color: 'red', title: 'Регистрация отменена', detail: 'Этот QR-код больше не работает', canCheckIn: false, unpaid: false };
  }
  if (codeStatus === 'revoked') {
    return {
      color: 'red',
      title: 'QR-код перевыпущен',
      detail: 'Этот QR-код больше не работает - попросите открыть новый в боте',
      canCheckIn: false,
      unpaid: false,
    };
  }
  if (card.checkIn) {
    return {
      color: 'yellow',
      title: 'Уже отмечен',
      detail: `${whenText(card.checkIn.at, tz)}, ${card.checkIn.byName}${card.checkIn.local ? ' (офлайн)' : ''}`,
      canCheckIn: false,
      unpaid: false,
    };
  }
  if (needsPayment(card, cp, rules)) {
    return {
      color: 'yellow',
      title: 'Не оплачено → на кассу',
      // «Не оплачено» и так в заголовке; «Чек на проверке» / «Оплачено частично» - полезная подсказка.
      detail: card.paymentStatus === 'unpaid' ? undefined : PAYMENT_STATUS_LABELS[card.paymentStatus],
      canCheckIn: false,
      unpaid: true,
    };
  }
  const receipt = rules.paymentsEnabled && cp.kind === 'entrance' && card.paymentStatus === 'pending';
  return { color: 'green', title: 'Можно пускать', detail: receipt ? 'Чек прислан, проверим позже' : undefined, canCheckIn: true, unpaid: false };
}

export function lookupVerdict(l: LookupState, cp: CheckpointView, tz: string): Verdict {
  if (!l.found) {
    if (l.reason === 'invalid_code')
      return { color: 'red', title: 'Не наш QR-код', detail: 'Это не QR-код для входа на конференцию', canCheckIn: false, unpaid: false };
    if (l.reason === 'unknown_code')
      return {
        color: 'red',
        title: 'QR-код не найден',
        detail: 'Такого кода нет в базе - найдите участника по фамилии',
        canCheckIn: false,
        unpaid: false,
      };
    return { color: 'red', title: 'Участник не найден', canCheckIn: false, unpaid: false };
  }
  return personVerdict(l.card, cp, l, tz, l.codeStatus);
}

// ---------- исходы отправки ----------

export interface OutcomeView {
  color: Color;
  text: string;
}

export function outcomeView(r: CheckInResult | undefined, tz: string): OutcomeView {
  if (!r) return { color: 'yellow', text: 'Сохранено офлайн - отправим, когда появится связь' };
  const by = r.checkedAt ? `${whenText(r.checkedAt, tz)}${r.byName ? `, ${r.byName}` : ''}` : '';
  const map: Record<CheckInOutcome, OutcomeView> = {
    new: { color: 'green', text: 'Отмечен' },
    retry: { color: 'green', text: 'Отмечен' },
    duplicate: { color: 'yellow', text: `Уже отмечен ${by}`.trim() },
    unpaid: { color: 'yellow', text: 'Не оплачено → на кассу' },
    before_event: { color: 'yellow', text: 'Конференция ещё не началась, вход не отмечается' },
    revoked_ticket: { color: 'red', text: 'QR-код перевыпущен - нужен новый' },
    not_found: { color: 'red', text: 'QR-код или участник не найден' },
    cancelled_participant: { color: 'red', text: 'Регистрация участника отменена' },
    checkpoint_inactive: { color: 'red', text: 'Точка «Вход» закрыта - обратитесь к администратору' },
    forbidden: { color: 'red', text: 'Нет прав отмечать вход' },
    event_id_reused: { color: 'red', text: 'Сбой идентификатора отметки - отсканируйте ещё раз' },
    check_in_undone: { color: 'yellow', text: 'Эту отметку отменили - отсканируйте ещё раз' },
  };
  return map[r.outcome];
}

// ---------- отправка ----------

export interface PlannedCheckIn {
  event: CheckInEvent;
  name: string;
}

export type SubmitResult = { mode: 'online'; results: Map<string, CheckInResult> } | { mode: 'offline' };

const ACCEPTED: CheckInOutcome[] = ['new', 'retry', 'duplicate'];

/**
 * Сначала онлайн (3 секунды) - ответ сервера окончательный. Нет связи или сервер не ответил -
 * события уходят в очередь и отмечаются локально, чтобы повторный скан показал «уже отмечен».
 */
export async function submitCheckIns(planned: PlannedCheckIn[], myName: string): Promise<SubmitResult> {
  const events = planned.map((p) => p.event);
  try {
    const res = await staffApi.checkIns(events, 3000);
    const results = new Map(res.results.map((r) => [r.clientEventId, r]));
    const rows: LocalCheckIn[] = [];
    for (const ev of events) {
      const r = results.get(ev.clientEventId);
      if (r && ACCEPTED.includes(r.outcome) && r.checkedAt) {
        rows.push({
          checkpointId: ev.checkpointId,
          participantId: ev.participantId,
          at: r.checkedAt,
          byName: r.byName ?? myName,
          local: 0,
          checkInId: r.checkInId,
          clientEventId: ev.clientEventId,
        });
      }
    }
    await putLocalCheckIns(rows);
    return { mode: 'online', results };
  } catch (err) {
    // 400/403 - ошибка данных или прав, в очередь такое класть бессмысленно.
    if (err instanceof ApiError && !(err.isTransient || err.status === 401)) throw err;
    const offline = planned.map((p) => ({ event: { ...p.event, offline: true }, label: p.name }));
    await enqueue(offline);
    await putLocalCheckIns(
      offline.map((o) => ({
        checkpointId: o.event.checkpointId,
        participantId: o.event.participantId,
        at: o.event.clientTs,
        byName: myName,
        local: 1,
        checkInId: null,
        clientEventId: o.event.clientEventId,
      })),
    );
    return { mode: 'offline' };
  }
}

export interface UndoItem {
  clientEventId: string;
  checkInId: number | null;
  checkpointId: number;
  participantId: number;
}

/** «Отменить»: офлайн-событие просто убираем из очереди, отправленное - отзываем на сервере. */
export async function undoCheckIns(items: UndoItem[]): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const item of items) {
    let id = item.checkInId;
    if (id === null) {
      if (await removeFromOutbox(item.clientEventId)) {
        await deleteLocalCheckIn(item.checkpointId, item.participantId);
        // Событие могло успеть дойти до сервера (ответ не пришёл за 3 секунды) - снимаем и там.
        // Нет связи - повторим позже вместе с очередью.
        try {
          await staffApi.revokeByEvent(item.clientEventId);
        } catch {
          queueRevoke(item.clientEventId);
        }
        ok += 1;
        continue;
      }
      id = syncedResult(item.clientEventId)?.checkInId ?? null;
    }
    if (id === null) {
      failed += 1;
      continue;
    }
    try {
      await staffApi.revoke(id);
      await deleteLocalCheckIn(item.checkpointId, item.participantId);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}
