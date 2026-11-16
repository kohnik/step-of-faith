/**
 * Локальная база билетов для сканера: `GET /api/staff/manifest` с If-None-Match раз в минуту и при
 * возврате в приложение. Ключ кода - sha256hex(salt + канонический код) через WebCrypto, поэтому
 * сами коды билетов на устройстве не хранятся.
 */
import {
  MIN_AGE,
  ageOn,
  parseTicketCode,
  type Tier,
  type TiersConfig,
  type Category,
  type ManifestResponse,
  type ParticipantCard,
  type ParticipantStatus,
  type PaymentStatus,
} from '@sof/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../api/client.ts';
import { db, type LocalCheckIn, type ManifestMeta, type ManifestParticipant } from './db.ts';

// ---------- общие типы карточек ----------

export interface CheckInMark {
  id: number | null;
  at: string;
  byName: string;
  /** Отметка сделана на этом устройстве офлайн и ещё не подтверждена сервером. */
  local?: boolean;
}

export interface CardInfo {
  id: number;
  fullName: string;
  birthDate?: string | null;
  age: number | null;
  category: Category;
  status: ParticipantStatus;
  paymentStatus: PaymentStatus;
  tier: Tier | null;
  /** Завтрак к варианту - волонтёр видит его на полосе варианта. */
  breakfast: boolean;
  amountDue: string | null;
  /** Сколько уже внесено - знает только сервер (в базе на устройстве нет). */
  amountPaid?: string | null;
  under16: boolean;
  familyId: number;
  checkIn: CheckInMark | null;
}

export type LookupState =
  | {
      found: true;
      origin: 'server' | 'local';
      codeStatus: 'active' | 'revoked' | 'by_id';
      card: CardInfo;
      family: CardInfo[];
      /** Оплата выключена → статусы оплаты не показываем и «не оплачено» не бывает. */
      paymentsEnabled: boolean;
      allowUnpaidEntry: boolean;
      tiers: TiersConfig | null;
    }
  | { found: false; origin: 'server' | 'local'; reason: 'invalid_code' | 'unknown_code' | 'not_found' };

export function fromServerCard(c: ParticipantCard): CardInfo {
  return { ...c, checkIn: c.checkIn ? { id: c.checkIn.id, at: c.checkIn.at, byName: c.checkIn.byName } : null };
}

// ---------- мета и подписка ----------

let metaCache: ManifestMeta | null | undefined;
let lastError: string | null = null;
let syncingNow = false;
const listeners = new Set<() => void>();
let snapshot = { meta: null as ManifestMeta | null, syncing: false, error: null as string | null, loaded: false };

function emit(): void {
  snapshot = { meta: metaCache ?? null, syncing: syncingNow, error: lastError, loaded: metaCache !== undefined };
  for (const l of listeners) l();
}

export async function loadManifestMeta(): Promise<ManifestMeta | null> {
  if (metaCache === undefined) {
    try {
      metaCache = (await db.meta.get('manifest')) ?? null;
    } catch {
      metaCache = null;
    }
    emit();
  }
  return metaCache;
}

export function useManifestState() {
  useEffect(() => {
    void loadManifestMeta();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

// ---------- синхронизация ----------

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function applyManifest(m: ManifestResponse, etag: string): Promise<void> {
  await db.transaction('rw', [db.meta, db.codes, db.participants, db.checkins], async () => {
    // Отметки этого устройства, которых ещё нет на сервере, переживают обновление манифеста.
    const pending = (await db.checkins.toArray()).filter((c) => c.local === 1);
    await db.codes.clear();
    await db.codes.bulkPut(m.codes);
    await db.participants.clear();
    await db.participants.bulkPut(m.participants);
    await db.checkins.clear();
    await db.checkins.bulkPut(
      m.checkIns.map(
        (c): LocalCheckIn => ({ ...c, local: 0, checkInId: null, clientEventId: null }),
      ),
    );
    for (const p of pending) {
      const exists = await db.checkins.get([p.checkpointId, p.participantId]);
      if (!exists) await db.checkins.put(p);
    }
    const meta: ManifestMeta = {
      key: 'manifest',
      version: m.version,
      etag,
      salt: m.salt,
      generatedAt: m.generatedAt,
      fetchedAt: Date.now(),
      allowUnpaidEntry: m.allowUnpaidEntry,
      eventTimezone: m.eventTimezone,
      participants: m.participants.length,
      codes: m.codes.length,
      paymentsEnabled: m.paymentsEnabled === true,
      tiers: m.tiers,
      ageOn: m.ageOn,
    };
    await db.meta.put(meta);
    metaCache = meta;
  });
}

let inflight: Promise<'updated' | 'not_modified'> | null = null;

export function syncManifest(): Promise<'updated' | 'not_modified'> {
  inflight ??= (async () => {
    syncingNow = true;
    emit();
    try {
      const meta = await loadManifestMeta();
      // Копия без paymentsEnabled/tiers сохранена старой версией приложения - берём базу целиком.
      const etag = meta?.etag && meta.paymentsEnabled !== undefined && meta.tiers ? meta.etag : null;
      const res = await apiFetch<ManifestResponse>('/api/staff/manifest', {
        auth: 'staff',
        headers: etag ? { 'If-None-Match': etag } : undefined,
        cache: 'no-store',
        timeoutMs: 30_000,
        retries: 1,
      });
      if (res.status === 304 && meta) {
        const next = { ...meta, fetchedAt: Date.now() };
        await db.meta.put(next);
        metaCache = next;
        lastError = null;
        return 'not_modified' as const;
      }
      await applyManifest(res.data, res.headers.get('ETag') ?? `"${res.data.version}"`);
      lastError = null;
      return 'updated' as const;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Не удалось обновить базу';
      throw err;
    } finally {
      syncingNow = false;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

let loopStarted = false;
let lastSyncAt = 0;

/** Обновление базы: сразу, каждые 60 секунд и при возвращении в приложение. */
export function startManifestLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  const tick = (force = false) => {
    if (!force && Date.now() - lastSyncAt < 15_000) return;
    lastSyncAt = Date.now();
    syncManifest().catch(() => undefined);
  };
  tick(true);
  window.setInterval(() => tick(true), 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
  window.addEventListener('focus', () => tick());
  window.addEventListener('online', () => tick());
}

// ---------- поиск по локальной базе ----------

function toCard(p: ManifestParticipant, mark: LocalCheckIn | undefined): CardInfo {
  return {
    id: p.id,
    fullName: p.fullName,
    // Старая база на устройстве ещё с датой рождения - считаем по ней, новая присылает возраст.
    // null - гость на месте без даты рождения («возраст не указан»).
    age: p.age !== undefined ? p.age : p.birthDate ? ageOn(p.birthDate) : null,
    category: p.category,
    status: p.status,
    paymentStatus: p.paymentStatus,
    tier: p.tier ?? null,
    // База, скачанная до появления завтрака, его не знает - после обновления сервер пришлёт новую целиком.
    breakfast: p.breakfast ?? false,
    amountDue: p.amountDue ?? null,
    under16:
      p.under16 ?? (p.birthDate ? ageOn(p.birthDate, metaCache?.ageOn ?? new Date().toISOString().slice(0, 10)) < MIN_AGE : false),
    familyId: p.familyId,
    checkIn: mark ? { id: mark.checkInId, at: mark.at, byName: mark.byName, local: mark.local === 1 } : null,
  };
}

/** Карточка по коду или id из локальной базы. null - базы нет (или IndexedDB недоступна). */
export async function localLookup(
  canonicalCode: string | null,
  participantId: number | null,
  checkpointId: number,
): Promise<LookupState | null> {
  try {
    const meta = await loadManifestMeta();
    if (!meta) return null;
    let pid = participantId;
    let codeStatus: 'active' | 'revoked' | 'by_id' = 'by_id';
    if (canonicalCode) {
      const code = await db.codes.get(await sha256Hex(meta.salt + canonicalCode));
      if (!code) return { found: false, origin: 'local', reason: 'unknown_code' };
      pid = code.pid;
      codeStatus = code.st;
    }
    if (pid === null) return null;
    const p = await db.participants.get(pid);
    // В манифесте только активные участники: отменённого там нет, а его билет помечен revoked.
    if (!p) return { found: false, origin: 'local', reason: codeStatus === 'revoked' ? 'unknown_code' : 'not_found' };
    const family = (await db.participants.where('familyId').equals(p.familyId).toArray()).filter(
      (f) => f.id !== p.id && f.status === 'active',
    );
    family.sort((a, b) => a.id - b.id);
    const marks = await db.checkins.bulkGet([p, ...family].map((x) => [checkpointId, x.id] as [number, number]));
    return {
      found: true,
      origin: 'local',
      codeStatus,
      card: toCard(p, marks[0]),
      family: family.map((f, i) => toCard(f, marks[i + 1])),
      paymentsEnabled: meta.paymentsEnabled === true,
      allowUnpaidEntry: meta.allowUnpaidEntry,
      tiers: meta.tiers ?? null,
    };
  } catch {
    return null;
  }
}

const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

/** Поиск по фамилии/имени в локальной базе - запасной вариант, когда нет связи. */
export async function localSearch(q: string, checkpointId: number): Promise<CardInfo[]> {
  try {
    const meta = await loadManifestMeta();
    if (!meta) return [];
    const code = parseTicketCode(q);
    if (code) {
      const res = await localLookup(code, null, checkpointId);
      return res?.found ? [res.card] : [];
    }
    const words = normalize(q).split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0 || q.trim().length < 2) return [];
    const all = await db.participants.toArray();
    const hits = all
      .filter((p) => {
        const parts = normalize(p.fullName).split(/\s+/);
        return words.every((w) => parts.some((part) => part.startsWith(w)));
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'))
      .slice(0, 20);
    const marks = await db.checkins.bulkGet(hits.map((h) => [checkpointId, h.id] as [number, number]));
    return hits.map((h, i) => toCard(h, marks[i]));
  } catch {
    return [];
  }
}

// ---------- локальные отметки ----------

export async function putLocalCheckIns(rows: LocalCheckIn[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.checkins.bulkPut(rows);
  } catch {
    /* без IndexedDB - просто не помним */
  }
}

export async function deleteLocalCheckIn(checkpointId: number, participantId: number): Promise<void> {
  try {
    await db.checkins.delete([checkpointId, participantId]);
  } catch {
    /* ignore */
  }
}

/** Оплата принята на кассе - локальная база сразу знает об этом (до следующего манифеста). */
export async function markLocalPaid(participantIds: number[]): Promise<void> {
  try {
    await db.participants.where('id').anyOf(participantIds).modify({ paymentStatus: 'paid' });
  } catch {
    /* ignore */
  }
}
