import type { BroadcastInput, BroadcastView, Segment } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

export function useBroadcasts(enabled = true) {
  return useQuery({
    queryKey: qk.broadcasts,
    queryFn: ({ signal }) => api.get<BroadcastView[]>('/api/admin/broadcasts', { signal }),
    enabled,
    // Пока что-то отправляется - обновляем прогресс часто, запланированные - пореже.
    refetchInterval: (query) => {
      const items = query.state.data ?? [];
      if (items.some((b) => b.status === 'sending')) return 2_000;
      if (items.some((b) => b.status === 'scheduled')) return 15_000;
      return false;
    },
  });
}

export function useBroadcastPreview(segment: Segment | null) {
  return useQuery({
    queryKey: segment ? qk.broadcastPreview(segment) : ['broadcasts', 'preview', 'none'],
    queryFn: async ({ signal }) =>
      (await api.post<{ recipients: number }>('/api/admin/broadcasts/preview', { segment }, { signal })).recipients,
    enabled: segment !== null,
    staleTime: 15_000,
  });
}

export function useCreateBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BroadcastInput) => api.post<BroadcastView>('/api/admin/broadcasts', input),
    onSuccess: (_data, input) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.broadcasts }),
        input.alsoAnnouncement ? qc.invalidateQueries({ queryKey: qk.content }) : Promise.resolve(),
      ]),
  });
}

export function useCancelBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<BroadcastView>(`/api/admin/broadcasts/${id}/cancel`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.broadcasts }),
  });
}
