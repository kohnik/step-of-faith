/**
 * Локальная база сканера в IndexedDB (Dexie): манифест билетов, отметки и очередь неотправленных отметок.
 */
import type { CheckInEvent, ManifestResponse, TiersConfig } from '@sof/shared';
import { Dexie, type EntityTable, type Table } from 'dexie';

export type ManifestParticipant = ManifestResponse['participants'][number];
export type ManifestCode = ManifestResponse['codes'][number];

export interface LocalCheckIn {
  checkpointId: number;
  participantId: number;
  at: string;
  byName: string;
  /** 1 - отметка сделана на этом устройстве и ещё не подтверждена манифестом сервера. */
  local: 0 | 1;
  checkInId: number | null;
  clientEventId: string | null;
}

export interface ManifestMeta {
  key: 'manifest';
  version: string;
  etag: string;
  salt: string;
  generatedAt: string;
  fetchedAt: number;
  /** Нет в сохранённых до обновления копиях - тогда базу качаем заново целиком. */
  paymentsEnabled?: boolean;
  allowUnpaidEntry: boolean;
  eventTimezone: string;
  /** Варианты участия (цвета). Нет в старых копиях - тогда базу качаем заново. */
  tiers?: TiersConfig;
  ageOn?: string;
  participants: number;
  codes: number;
}

export interface OutboxItem {
  clientEventId: string;
  event: CheckInEvent;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /** Имя участника - для списка «не отправлено». */
  label: string;
}

export const db = new Dexie('sof-scanner') as Dexie & {
  meta: EntityTable<ManifestMeta, 'key'>;
  codes: EntityTable<ManifestCode, 'h'>;
  participants: EntityTable<ManifestParticipant, 'id'>;
  checkins: Table<LocalCheckIn, [number, number]>;
  outbox: EntityTable<OutboxItem, 'clientEventId'>;
};

db.version(1).stores({
  meta: 'key',
  codes: 'h',
  participants: 'id, familyId',
  checkins: '[checkpointId+participantId], participantId',
  outbox: 'clientEventId, createdAt',
});
