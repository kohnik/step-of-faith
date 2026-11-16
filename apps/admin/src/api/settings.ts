import type { DashboardResponse, Settings } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

export function useSettingsQuery(enabled = true) {
  return useQuery({
    queryKey: qk.settings,
    queryFn: ({ signal }) => api.get<Settings>('/api/admin/settings', { signal }),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Сохраняем только изменённые поля - сервер сливает их с текущими. Иначе форма, открытая с утра,
 * откатила бы выключатели, которые за это время переключили на других страницах (запись, душепопечение).
 */
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<Settings>('/api/admin/settings', patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.settings, data);
      // В сессии лежат название, пояс и включённые возможности (оплата) - обновляем, чтобы UI перестроился.
      return Promise.all([
        qc.invalidateQueries({ queryKey: qk.session }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
        qc.invalidateQueries({ queryKey: qk.merchSettings }),
      ]);
    },
  });
}

export function useDashboard(enabled = true) {
  return useQuery({
    queryKey: qk.dashboard,
    queryFn: ({ signal }) => api.get<DashboardResponse>('/api/admin/dashboard', { signal }),
    enabled,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}
