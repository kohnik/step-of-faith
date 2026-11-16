import type { ParticipantListView } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

export function useParticipantLists(enabled = true) {
  return useQuery({
    queryKey: qk.lists,
    queryFn: ({ signal }) => api.get<ParticipantListView[]>('/api/admin/lists', { signal }),
    enabled,
    staleTime: 10_000,
  });
}

/** Списки и таблица участников (колонка «Списки») обновляются вместе. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: qk.participantsAll }), qc.invalidateQueries({ queryKey: ['broadcasts', 'preview'] })]);
}

export function useCreateList() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (name: string) => api.post<ParticipantListView>('/api/admin/lists', { name }),
    onSuccess: invalidate,
  });
}

export function useRenameList() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.patch<ParticipantListView>(`/api/admin/lists/${id}`, { name }),
    onSuccess: invalidate,
  });
}

export function useDeleteList() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/api/admin/lists/${id}`),
    onSuccess: invalidate,
  });
}

export function useListMembers() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ids, remove }: { id: number; ids: number[]; remove?: boolean }) =>
      api.post<{ added?: number; removed?: number; list: ParticipantListView }>(`/api/admin/lists/${id}/${remove ? 'remove' : 'add'}`, { ids }),
    onSuccess: invalidate,
  });
}
