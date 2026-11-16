import type { ActivityInput, ActivityRegistrationRow, ActivityUpdate, ActivityView } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

/** live - на странице «Расписание»: во время конференции правят несколько человек, сверяемся раз в 30 секунд. */
export function useActivities(enabled = true, live = false) {
  return useQuery({
    queryKey: qk.activities,
    queryFn: ({ signal }) => api.get<ActivityView[]>('/api/admin/activities', { signal }),
    enabled,
    staleTime: 20_000,
    refetchInterval: live ? 30_000 : false,
  });
}

/** Общая запись на мероприятия (у блоков семинаров и душепопечения - свои выключатели). */
export function useActivitySignup(enabled = true) {
  return useQuery({
    queryKey: qk.activitySignup,
    queryFn: ({ signal }) => api.get<{ open: boolean }>('/api/admin/activities-signup', { signal }),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useSetActivitySignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (open: boolean) => api.patch<{ open: boolean }>('/api/admin/activities-signup', { open }),
    onSuccess: (data) => {
      qc.setQueryData(qk.activitySignup, data);
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
  });
}

export function useRegistrations(activityId: number | null) {
  return useQuery({
    queryKey: qk.registrations(activityId ?? 0),
    queryFn: ({ signal }) => api.get<ActivityRegistrationRow[]>(`/api/admin/activities/${activityId}/registrations`, { signal }),
    enabled: activityId !== null,
    // Пока список открыт - новые записи появляются сами.
    refetchInterval: 15_000,
  });
}

function useInvalidateActivities() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.activities }),
      qc.invalidateQueries({ queryKey: qk.dashboard }),
      qc.invalidateQueries({ queryKey: qk.checkpoints }),
    ]);
}

export function useCreateActivity() {
  const invalidate = useInvalidateActivities();
  return useMutation({
    mutationFn: (input: ActivityInput) => api.post<ActivityView>('/api/admin/activities', input),
    onSuccess: () => invalidate(),
  });
}

/** Удалить мероприятие совсем; записавшимся сервер пришлёт сообщение. */
export function useDeleteActivity() {
  const invalidate = useInvalidateActivities();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ notified: number }>(`/api/admin/activities/${id}`),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateActivity() {
  const invalidate = useInvalidateActivities();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: ActivityUpdate }) => api.patch<ActivityView>(`/api/admin/activities/${id}`, patch),
    onSuccess: () => invalidate(),
  });
}
