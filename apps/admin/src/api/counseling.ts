import type { CounselingAdminView, CounselorInput, CounselorUpdate } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

/** Служители и записи к ним: обновляем каждые 15 секунд, пока страница открыта. */
export function useCounseling(enabled = true) {
  return useQuery({
    queryKey: qk.counseling,
    queryFn: ({ signal }) => api.get<CounselingAdminView>('/api/admin/counseling', { signal }),
    refetchInterval: 15_000,
    enabled,
  });
}

/** Любое изменение возвращает свежий список - кладём его в кэш сразу. */
function useApply() {
  const qc = useQueryClient();
  return (data: CounselingAdminView) => {
    qc.setQueryData(qk.counseling, data);
    void qc.invalidateQueries({ queryKey: qk.settings });
  };
}

export function useSetCounselingOpen() {
  const apply = useApply();
  return useMutation({
    mutationFn: (open: boolean) => api.patch<CounselingAdminView>('/api/admin/counseling', { open }),
    onSuccess: apply,
  });
}

export function useSaveCounselor() {
  const apply = useApply();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: CounselorInput | CounselorUpdate }) =>
      id === null
        ? api.post<CounselingAdminView>('/api/admin/counselors', input)
        : api.patch<CounselingAdminView>(`/api/admin/counselors/${id}`, input),
    onSuccess: apply,
  });
}

export function useDeleteCounselor() {
  const apply = useApply();
  return useMutation({
    mutationFn: (id: number) => api.delete<CounselingAdminView>(`/api/admin/counselors/${id}`),
    onSuccess: apply,
  });
}

export function useCancelCounselingBooking() {
  const apply = useApply();
  return useMutation({
    mutationFn: (bookingId: number) => api.delete<CounselingAdminView>(`/api/admin/counseling-bookings/${bookingId}`),
    onSuccess: apply,
  });
}

/** «Напомнить всем»: записанным (ко всем служителям или к одному) - их время, служитель и место. */
export function useAnnounceCounseling() {
  return useMutation({
    mutationFn: (counselorId: number | null) => api.post<{ bookings: number }>('/api/admin/counseling/announce', { counselorId }),
  });
}
