import type { MeResponse } from '@sof/shared';
import { QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { local } from '../lib/storage.ts';
import { telegramUser } from '../telegram/sdk.ts';
import { api } from './client.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    // GET-повторы уже делает клиент API (×2 с паузой) - здесь не дублируем.
    queries: { retry: 0, staleTime: 15_000, gcTime: 30 * 60_000, refetchOnWindowFocus: true },
    mutations: { retry: 0 },
  },
});

interface CachedMe {
  at: number;
  data: MeResponse;
}

/**
 * Последний ответ /api/me храним на устройстве: если на входе плохая связь, билеты (QR строится
 * из кода на клиенте) всё равно откроются. Ключ - по Telegram id, чтобы не смешивать аккаунты.
 */
const meCacheKey = () => `sof:me:${telegramUser()?.id ?? 'anon'}`;

export function saveMe(data: MeResponse): void {
  local.setJSON(meCacheKey(), { at: Date.now(), data } satisfies CachedMe);
}

export async function fetchMe(): Promise<MeResponse> {
  const data = await api<MeResponse>('/api/me');
  saveMe(data);
  return data;
}

export const meQuery = queryOptions({
  queryKey: ['me'] as const,
  queryFn: fetchMe,
  staleTime: 20_000,
  initialData: () => local.getJSON<CachedMe>(meCacheKey())?.data,
  initialDataUpdatedAt: () => local.getJSON<CachedMe>(meCacheKey())?.at,
});

export function useMe() {
  return useQuery(meQuery);
}

/** Обновить `me` в кэше (после мутаций, которые возвращают свежий MeResponse). */
export function setMe(data: MeResponse): void {
  queryClient.setQueryData(meQuery.queryKey, data);
  saveMe(data);
}

export function refreshMe(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
}
