import { DEFAULT_TIERS, type ActivityStatus, type CheckpointView, type TiersConfig } from '@sof/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { qrScanner } from '@tma.js/sdk-react';
import { isMobileTelegram, isTelegram } from '../telegram/sdk.ts';
import { useCallback, useContext, useMemo, useState } from 'react';
import { meQuery } from '../api/queries.ts';
import { useEnv } from '../app/env.ts';
import { local } from '../lib/storage.ts';
import { dayKey } from '../lib/time.ts';
import type { Tone } from '../ui/kit.tsx';
import { staffApi } from './api.ts';
import { useManifestState } from './manifest.ts';
import { paymentsEnabledFor, StaffContext } from './session.ts';

const CP_LIST_KEY = 'sof:checkpoints';

/** Список активных точек; последний ответ хранится на устройстве - сканер открывается и без связи. */
export const checkpointsQuery = queryOptions({
  queryKey: ['staff-checkpoints'] as const,
  queryFn: async () => {
    const list = await staffApi.checkpoints();
    local.setJSON(CP_LIST_KEY, list);
    return list;
  },
  staleTime: 60_000,
  // Админ создаёт входы по дням или выключает старый - сканер, открытый с утра, подхватит это сам.
  refetchInterval: 5 * 60_000,
  initialData: () => local.getJSON<CheckpointView[]>(CP_LIST_KEY) ?? undefined,
  initialDataUpdatedAt: 0,
});

export const staffActivitiesQuery = queryOptions({
  queryKey: ['staff-activities'] as const,
  queryFn: () => staffApi.activities(),
  staleTime: 30_000,
});

/**
 * Точка «Вход»: сканер всегда работает на ней. Берём активную точку типа entrance -
 * сначала на сегодняшний день, потом без дня, иначе первую.
 */
export function pickEntrance(list: readonly CheckpointView[], today: string): CheckpointView | null {
  const entrances = list.filter((c) => c.kind === 'entrance' && c.isActive);
  return entrances.find((c) => c.day === today) ?? entrances.find((c) => !c.day) ?? entrances[0] ?? null;
}

export function useEntranceCheckpoint() {
  const q = useQuery(checkpointsQuery);
  const tz = useEventTimezone();
  const today = dayKey(new Date(), tz);
  const checkpoint = useMemo(() => pickEntrance(q.data ?? [], today), [q.data, today]);
  return {
    checkpoint,
    /** Список ещё ни разу не получен (ни с сервера, ни из памяти устройства). */
    loading: !q.data && q.isFetching,
    error: q.data ? null : q.error,
    /** Сервер ответил, но точки «Вход» нет. */
    missing: !checkpoint && q.isFetched && q.isSuccess,
    refetch: () => void q.refetch(),
  };
}

const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * Часовой пояс события: из сессии персонала, из /api/me (Telegram) или из манифеста сканера.
 * Если ничего этого нет (первый запуск без связи) - пояс устройства: волонтёры на месте события.
 */
export function useEventTimezone(): string {
  const env = useEnv();
  const staff = useContext(StaffContext);
  const fromSession = staff?.event?.timezone;
  const me = useQuery({ ...meQuery, enabled: env.mode === 'telegram' && !fromSession });
  const manifest = useManifestState();
  return fromSession ?? me.data?.event.timezone ?? manifest.meta?.eventTimezone ?? deviceZone();
}

/** Включена ли оплата: свежее - из манифеста сканера, иначе из сессии. */
export function usePaymentsEnabled(): boolean {
  const staff = useContext(StaffContext);
  const manifest = useManifestState();
  return manifest.meta?.paymentsEnabled ?? (staff ? paymentsEnabledFor(staff) : false);
}

/** Варианты участия (цвета): свежее - из манифеста сканера, иначе из сессии, иначе по умолчанию. */
export function useTiers(): TiersConfig {
  const staff = useContext(StaffContext);
  const manifest = useManifestState();
  return manifest.meta?.tiers ?? staff?.tiers ?? DEFAULT_TIERS;
}

/**
 * Конференция ещё не началась (до даты начала из настроек). В это время «Сканер» - касса:
 * скан открывает оплату человека, вход не отмечается (сервер тоже не примет отметку).
 */
export function useBeforeEvent(): boolean {
  const staff = useContext(StaffContext);
  const startsAt = staff?.event?.startsAt;
  // По дню, как на сервере: в день начала вход отмечается с самого утра, даже если программа вечером.
  if (!startsAt) return false;
  const tz = staff?.event?.timezone;
  return dayKey(new Date(), tz) < dayKey(startsAt, tz);
}

/** Нативный сканер Telegram есть только в мобильных клиентах. */
export function nativeScannerAvailable(): boolean {
  if (!isTelegram() || !isMobileTelegram()) return false;
  try {
    return qrScanner.open.isAvailable();
  } catch {
    return false;
  }
}

/** Флаг, сохраняемый на устройстве (звук сканера). */
export function usePersistentFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const raw = local.get(key);
    return raw === null ? initial : raw === '1';
  });
  const set = useCallback(
    (v: boolean) => {
      local.set(key, v ? '1' : '0');
      setValue(v);
    },
    [key],
  );
  return [value, set];
}

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, { text: string; tone: Tone }> = {
  draft: { text: 'Скрыто', tone: 'gray' },
  published: { text: 'Показано', tone: 'green' },
  cancelled: { text: 'Отменено', tone: 'red' },
};
