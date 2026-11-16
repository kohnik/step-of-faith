/**
 * Очередь отметок, сохранённых без связи. Хранится в IndexedDB (Dexie) и дублируется в Telegram
 * DeviceStorage. Фоновая отправка - каждые 10 секунд и при появлении сети, пачками до 100 событий.
 * Событие удаляется из очереди только после окончательного ответа сервера по нему.
 * Пока очередь не пуста - Telegram спрашивает подтверждение при закрытии приложения.
 */
import type { CheckInEvent, CheckInOutcome, CheckInResult } from '@sof/shared';
import { deviceStorage } from '@tma.js/sdk-react';
import { useSyncExternalStore } from 'react';
import { ApiError } from '../api/client.ts';
import { local } from '../lib/storage.ts';
import { isTelegram, setClosingConfirmation } from '../telegram/sdk.ts';
import { staffApi } from './api.ts';
import { db, type OutboxItem } from './db.ts';
import { deleteLocalCheckIn, putLocalCheckIns } from './manifest.ts';

const MIRROR_KEY = 'sof_outbox';
const BATCH = 100;
/** Отмены, которые не дошли до сервера (не было связи): номера событий. */
const REVOKES_KEY = 'sof:pending-revokes';

export interface SyncIssue {
  clientEventId: string;
  label: string;
  outcome: CheckInOutcome | 'rejected';
  at: number;
}

/**
 * Буфер на время, пока IndexedDB не отвечает (на iOS бывает «Connection to Indexed Database server lost»).
 * Он дополняет базу, а не заменяет её: уже сохранённые события не пропадают из счётчика и из зеркала,
 * а буфер переносится в базу, как только она снова доступна.
 */
let memory: OutboxItem[] = [];
let count = 0;
let issues: SyncIssue[] = [];
let flushing = false;
const listeners = new Set<() => void>();
/** Результаты уже отправленных из очереди событий - чтобы «Отменить» нашёл id отметки. */
const synced = new Map<string, CheckInResult>();

let snapshot = { count: 0, flushing: false, issues: [] as SyncIssue[] };

function emit(): void {
  snapshot = { count, flushing, issues };
  for (const l of listeners) l();
}

/** Операция с базой; при ошибке - переоткрыть соединение и попробовать ещё раз. */
async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    try {
      db.close();
      await db.open();
    } catch {
      /* ниже повтор упадёт и покажет, что база недоступна */
    }
    return fn();
  }
}

/** Перенести буфер в базу (если она снова отвечает). */
async function drainMemory(): Promise<void> {
  if (memory.length === 0) return;
  const items = memory;
  await withDb(() => db.outbox.bulkPut(items));
  const moved = new Set(items.map((i) => i.clientEventId));
  memory = memory.filter((m) => !moved.has(m.clientEventId));
}

async function all(): Promise<OutboxItem[]> {
  let stored: OutboxItem[] = [];
  try {
    await drainMemory();
    stored = await withDb(() => db.outbox.orderBy('createdAt').toArray());
  } catch {
    /* база недоступна - работаем с тем, что есть в буфере */
  }
  const ids = new Set(memory.map((m) => m.clientEventId));
  return [...stored.filter((i) => !ids.has(i.clientEventId)), ...memory].sort((a, b) => a.createdAt - b.createdAt);
}

async function refresh(): Promise<void> {
  const items = await all();
  count = items.length;
  setClosingConfirmation(count > 0);
  scheduleMirror(items);
  emit();
}

// ---------- зеркало в Telegram DeviceStorage ----------

let mirrorTimer = 0;
function scheduleMirror(items: OutboxItem[]): void {
  if (!isTelegram()) return;
  window.clearTimeout(mirrorTimer);
  mirrorTimer = window.setTimeout(() => {
    try {
      if (!deviceStorage.setItem.isAvailable()) return;
      const value = items.length ? JSON.stringify(items.map((i) => ({ e: i.event, l: i.label, t: i.createdAt }))) : null;
      deviceStorage.setItem(MIRROR_KEY, value).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }, 400);
}

async function restoreFromMirror(): Promise<void> {
  if (!isTelegram()) return;
  try {
    if (!deviceStorage.getItem.isAvailable()) return;
    const raw = await deviceStorage.getItem(MIRROR_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { e: CheckInEvent; l: string; t: number }[];
    const existing = new Set((await all()).map((i) => i.clientEventId));
    const missing = saved.filter((s) => s?.e?.clientEventId && !existing.has(s.e.clientEventId));
    if (missing.length === 0) return;
    await put(
      missing.map((s) => ({
        clientEventId: s.e.clientEventId,
        event: s.e,
        createdAt: s.t ?? Date.now(),
        attempts: 0,
        lastError: null,
        label: s.l ?? '',
      })),
    );
  } catch {
    /* ignore */
  }
}

// ---------- операции ----------

async function put(items: OutboxItem[]): Promise<void> {
  const ids = new Set(items.map((i) => i.clientEventId));
  try {
    await withDb(() => db.outbox.bulkPut(items));
    memory = memory.filter((m) => !ids.has(m.clientEventId));
  } catch {
    memory = [...memory.filter((m) => !ids.has(m.clientEventId)), ...items];
  }
}

async function remove(ids: string[]): Promise<void> {
  const set = new Set(ids);
  memory = memory.filter((m) => !set.has(m.clientEventId));
  try {
    await withDb(() => db.outbox.bulkDelete(ids));
  } catch {
    /* база недоступна - удалим при следующей возможности: событие уже вне буфера, а повтор сервер узнает по номеру */
  }
}

export async function enqueue(entries: { event: CheckInEvent; label: string }[]): Promise<void> {
  const now = Date.now();
  await put(
    entries.map((e) => ({ clientEventId: e.event.clientEventId, event: e.event, createdAt: now, attempts: 0, lastError: null, label: e.label })),
  );
  await refresh();
}

/** Убрать событие из очереди (отмена до отправки). true - событие ещё было в очереди. */
export async function removeFromOutbox(clientEventId: string): Promise<boolean> {
  const present = (await all()).some((i) => i.clientEventId === clientEventId);
  if (present) {
    await remove([clientEventId]);
    await refresh();
  }
  return present;
}

/** Запомнить отмену, которую не удалось отправить: повторим вместе с очередью. */
export function queueRevoke(clientEventId: string): void {
  const list = local.getJSON<string[]>(REVOKES_KEY) ?? [];
  if (!list.includes(clientEventId)) local.setJSON(REVOKES_KEY, [...list, clientEventId].slice(-200));
}

const pendingRevokes = () => local.getJSON<string[]>(REVOKES_KEY) ?? [];

async function flushRevokes(): Promise<void> {
  for (const id of pendingRevokes()) {
    try {
      await staffApi.revokeByEvent(id);
      local.setJSON(
        REVOKES_KEY,
        pendingRevokes().filter((x) => x !== id),
      );
    } catch (err) {
      // Нет связи - попробуем в следующий раз; ошибка данных - повторять бессмысленно.
      if (err instanceof ApiError && !err.isTransient && err.status !== 401) {
        local.setJSON(
          REVOKES_KEY,
          pendingRevokes().filter((x) => x !== id),
        );
      } else return;
    }
  }
}

export function syncedResult(clientEventId: string): CheckInResult | undefined {
  return synced.get(clientEventId);
}

export function dismissIssues(): void {
  issues = [];
  emit();
}

const ACCEPTED: CheckInOutcome[] = ['new', 'retry', 'duplicate'];

async function applyResults(items: OutboxItem[], results: CheckInResult[]): Promise<number> {
  const byId = new Map(results.map((r) => [r.clientEventId, r]));
  const done: string[] = [];
  const localRows = [];
  for (const item of items) {
    const r = byId.get(item.clientEventId);
    if (!r) continue;
    done.push(item.clientEventId);
    synced.set(item.clientEventId, r);
    if (ACCEPTED.includes(r.outcome) && r.checkedAt) {
      localRows.push({
        checkpointId: item.event.checkpointId,
        participantId: item.event.participantId,
        at: r.checkedAt,
        byName: r.byName ?? '-',
        local: 0 as const,
        checkInId: r.checkInId,
        clientEventId: item.clientEventId,
      });
    } else {
      await deleteLocalCheckIn(item.event.checkpointId, item.event.participantId);
    }
    if (!ACCEPTED.includes(r.outcome)) {
      issues = [...issues, { clientEventId: item.clientEventId, label: item.label, outcome: r.outcome, at: Date.now() }].slice(-30);
    }
  }
  await putLocalCheckIns(localRows);
  await remove(done);
  return done.length;
}

async function markAttempt(items: OutboxItem[], error: string): Promise<void> {
  await put(items.map((i) => ({ ...i, attempts: i.attempts + 1, lastError: error })));
}

/** Отправить очередь. Возвращает, сколько событий получили окончательный ответ. */
export async function flushOutbox(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  emit();
  let handled = 0;
  try {
    await flushRevokes();
    for (;;) {
      const batch = (await all()).slice(0, BATCH);
      if (batch.length === 0) break;
      try {
        const res = await staffApi.checkIns(
          batch.map((b) => b.event),
          20_000,
        );
        const done = await applyResults(batch, res.results);
        handled += done;
        // Сервер ответил не на все события - не крутимся в цикле, повторим по таймеру.
        if (done < batch.length) break;
      } catch (err) {
        // Ошибка данных (400) или сервер раз за разом падает на этой пачке (5xx) - отправляем по одному,
        // чтобы одно испорченное событие не блокировало очередь.
        const perItem =
          err instanceof ApiError && (err.status === 400 || (err.status >= 500 && (batch[0]?.attempts ?? 0) >= 2));
        if (perItem) {
          let doneHere = 0;
          for (const item of batch) {
            try {
              const one = await staffApi.checkIns([item.event], 10_000);
              await applyResults([item], one.results);
              handled += 1;
              doneHere += 1;
            } catch (e) {
              // Удаляем только то, что сервер явно отверг (400). 5xx - сервер лежит или чинится: такие отметки
              // он не получал, их нельзя терять, повторяем по таймеру сколько угодно долго.
              const bad = e instanceof ApiError && e.status === 400;
              if (bad) {
                await remove([item.clientEventId]);
                await deleteLocalCheckIn(item.event.checkpointId, item.event.participantId);
                issues = [...issues, { clientEventId: item.clientEventId, label: item.label, outcome: 'rejected' as const, at: Date.now() }];
                handled += 1;
                doneHere += 1;
              } else if (e instanceof ApiError && e.status >= 500) {
                // Сервер падает именно на этом событии - помечаем попытку и идём дальше по очереди.
                await markAttempt([item], e.message);
              } else {
                await markAttempt([item], e instanceof Error ? e.message : 'error');
                throw e;
              }
            }
          }
          // В этой пачке ничего не прошло - не крутимся, повторим по таймеру.
          if (doneHere === 0) break;
          continue;
        }
        await markAttempt(batch, err instanceof Error ? err.message : 'error');
        break;
      }
    }
  } catch {
    /* сеть пропала посреди отправки - продолжим по таймеру */
  } finally {
    flushing = false;
    await refresh();
  }
  return handled;
}

let loopStarted = false;

export function startOutboxLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  void (async () => {
    await restoreFromMirror();
    await refresh();
    if (count > 0) void flushOutbox();
  })();
  window.setInterval(() => {
    if (count > 0 || pendingRevokes().length > 0) void flushOutbox();
  }, 10_000);
  window.addEventListener('online', () => {
    if (count > 0) void flushOutbox();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && count > 0) void flushOutbox();
  });
}

export function useOutbox() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}
