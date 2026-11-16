import type {
  RoomInput,
  RoomView,
  SeminarBlockInput,
  SeminarBlockUpdate,
  SeminarBlockView,
  SeminarChangedRow,
  SeminarMoveInput,
  SeminarsSummary,
  SeminarTopicInput,
  SeminarUnplacedRow,
} from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

export function useRooms(enabled = true) {
  return useQuery({
    queryKey: qk.rooms,
    queryFn: ({ signal }) => api.get<RoomView[]>('/api/admin/rooms', { signal }),
    enabled,
    staleTime: 60_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.rooms }),
      // Префикс ['seminars'] - и потоки, и темы с голосами, и «без места».
      qc.invalidateQueries({ queryKey: qk.seminars }),
      qc.invalidateQueries({ queryKey: qk.activities }),
    ]);
}

/** «Выбор семинаров открыт» - открыть или закрыть сразу во всех потоках. */
export function useSetAllSeminarsRegistration() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (open: boolean) => api.patch<SeminarBlockView[]>('/api/admin/seminars/registration', { open }),
    onSuccess: (blocks) => {
      qc.setQueryData(qk.seminars, blocks);
      return invalidate();
    },
  });
}

export function useSaveRoom() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: RoomInput }) =>
      id === null ? api.post<RoomView>('/api/admin/rooms', input) : api.patch<RoomView>(`/api/admin/rooms/${id}`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteRoom() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/api/admin/rooms/${id}`),
    onSuccess: () => invalidate(),
  });
}

/** Блоки семинаров с живым распределением: обновляем каждые 10 секунд, пока страница открыта. */
export function useSeminars(enabled = true) {
  return useQuery({
    queryKey: qk.seminars,
    queryFn: ({ signal }) => api.get<SeminarBlockView[]>('/api/admin/seminars', { signal }),
    refetchInterval: 10_000,
    enabled,
  });
}

export function useSaveBlock() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: SeminarBlockInput | SeminarBlockUpdate }) =>
      id === null
        ? api.post<SeminarBlockView>('/api/admin/seminars', input)
        : api.patch<SeminarBlockView>(`/api/admin/seminars/${id}`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteBlock() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/api/admin/seminars/${id}`),
    onSuccess: () => invalidate(),
  });
}

/** Темы с голосами и состояние распределения: обновляем каждые 10 секунд, пока страница открыта. */
export function useSeminarsSummary(enabled = true) {
  return useQuery({
    queryKey: qk.seminarTopics,
    queryFn: ({ signal }) => api.get<SeminarsSummary>('/api/admin/seminar-topics', { signal }),
    refetchInterval: 10_000,
    enabled,
  });
}

export function useSaveTopic() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: Partial<SeminarTopicInput> }) =>
      id === null
        ? api.post<SeminarsSummary>('/api/admin/seminar-topics', input)
        : api.patch<SeminarsSummary>(`/api/admin/seminar-topics/${id}`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteTopic() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.delete<SeminarsSummary>(`/api/admin/seminar-topics/${id}`),
    onSuccess: () => invalidate(),
  });
}

/** Зал сеанса вручную; null - пусть решает распределение. */
export function useSetSessionRoom() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ sessionId, roomId }: { sessionId: number; roomId: number | null }) =>
      api.post<SeminarBlockView>(`/api/admin/seminar-sessions/${sessionId}/room`, { roomId }),
    onSuccess: () => invalidate(),
  });
}

/** Распределить: reset - заново (кроме ручных переносов), иначе только тех, у кого места ещё нет. */
export function useDistributeSeminars() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (reset: boolean) => api.post<{ placed: number }>('/api/admin/seminars/plan', { reset }),
    onSuccess: () => invalidate(),
  });
}

/** «Распределять автоматически» - после каждого выбора тем и правок тем, потоков и залов. */
export function useSeminarAutoPlan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (on: boolean) => api.post<SeminarsSummary>('/api/admin/seminars/auto', { on }),
    onSuccess: () => invalidate(),
  });
}

export function usePublishSeminars() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api.post<SeminarsSummary>('/api/admin/seminars/publish'),
    onSuccess: () => invalidate(),
  });
}

export function useMoveSeminarPerson() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SeminarMoveInput) => api.post<{ ok: true }>('/api/admin/seminars/move', input),
    onSuccess: () => invalidate(),
  });
}

/** Проголосовали, но в потоке без места. */
export function useUnplaced(blockId: number | null) {
  return useQuery({
    queryKey: qk.seminarUnplaced(blockId ?? 0),
    queryFn: ({ signal }) => api.get<SeminarUnplacedRow[]>(`/api/admin/seminars/${blockId}/unplaced`, { signal }),
    enabled: blockId !== null,
  });
}

/** Поменяли выбор после распределения: место пока прежнее. */
export function useSeminarChanged(enabled: boolean) {
  return useQuery({
    queryKey: [...qk.seminars, 'changed'],
    queryFn: ({ signal }) => api.get<SeminarChangedRow[]>('/api/admin/seminars/changed', { signal }),
    enabled,
    refetchInterval: 10_000,
  });
}
