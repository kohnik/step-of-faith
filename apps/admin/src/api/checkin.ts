import type { AdminCheckInRow, CheckpointView, ScanLogRow } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client.ts';
import { qk } from './keys.ts';

export function useCheckpoints(enabled = true) {
  return useQuery({
    queryKey: qk.checkpoints,
    queryFn: ({ signal }) => api.get<CheckpointView[]>('/api/admin/checkpoints', { signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function useCheckIns(checkpointId: number | null, opts: { enabled?: boolean; live?: boolean } = {}) {
  return useQuery({
    queryKey: qk.checkIns(checkpointId),
    queryFn: async ({ signal }) =>
      (await api.get<{ items: AdminCheckInRow[] }>(withQuery('/api/admin/check-ins', { checkpointId }), { signal })).items,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.live ? 15_000 : false,
  });
}

export function useScanLog(outcome: string | null, opts: { enabled?: boolean; live?: boolean } = {}) {
  return useQuery({
    queryKey: qk.scanLog(outcome),
    queryFn: async ({ signal }) =>
      (await api.get<{ items: ScanLogRow[] }>(withQuery('/api/admin/scan-log', { outcome }), { signal })).items,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.live ? 15_000 : false,
  });
}

export function useRevokeCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<{ ok: true }>(`/api/admin/check-ins/${id}/revoke`),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.checkInsAll }),
        qc.invalidateQueries({ queryKey: qk.participantsAll }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
      ]),
  });
}

export function useUpdateCheckpoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<CheckpointView, 'name' | 'isActive' | 'day'>> }) =>
      api.patch<CheckpointView>(`/api/admin/checkpoints/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.checkpoints }),
  });
}

/** Точки входа на каждый день конференции (недостающие). Возвращает все точки. */
export function useCreateDailyEntrances() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CheckpointView[]>('/api/admin/checkpoints/daily-entrances'),
    onSuccess: (list) => qc.setQueryData(qk.checkpoints, list),
  });
}
