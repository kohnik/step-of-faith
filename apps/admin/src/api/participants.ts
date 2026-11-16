import type {
  AdminPaymentRequest,
  AdminParticipantCreate,
  AdminParticipantDetail,
  AdminParticipantRow,
  AdminParticipantUpdate,
  BulkParticipantsRequest,
  DuplicateGroup,
  PeopleCounts,
  TicketView,
} from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

/** Живое обновление списков участников - как у сводки. */
export const LIVE_INTERVAL = 10_000;

export function useParticipants(enabled = true, opts: { live?: boolean } = {}) {
  return useQuery({
    queryKey: qk.participants,
    queryFn: async ({ signal }) => (await api.get<{ items: AdminParticipantRow[] }>('/api/admin/participants', { signal })).items,
    enabled,
    staleTime: opts.live ? 5_000 : 30_000,
    refetchInterval: opts.live ? LIVE_INTERVAL : false,
  });
}

/** Счётчики в меню: зарегистрировано и подтверждено (отсканированы на входе). */
export function usePeopleCounts(enabled = true) {
  return useQuery({
    queryKey: qk.counts,
    queryFn: ({ signal }) => api.get<PeopleCounts>('/api/admin/counts', { signal }),
    enabled,
    refetchInterval: LIVE_INTERVAL,
    refetchOnWindowFocus: true,
  });
}

export function useParticipant(id: number | null) {
  return useQuery({
    queryKey: qk.participant(id ?? 0),
    queryFn: ({ signal }) => api.get<AdminParticipantDetail>(`/api/admin/participants/${id}`, { signal }),
    enabled: id !== null,
  });
}

export function useDuplicates(enabled = true) {
  return useQuery({
    queryKey: qk.duplicates,
    queryFn: ({ signal }) => api.get<DuplicateGroup[]>('/api/admin/participants/duplicates', { signal }),
    enabled,
  });
}

/** После любых изменений участников: таблица, карточки, дубли, дашборд, чеки. */
function useInvalidateParticipants() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.participantsAll }),
      qc.invalidateQueries({ queryKey: qk.dashboard }),
      qc.invalidateQueries({ queryKey: qk.receiptsAll }),
      qc.invalidateQueries({ queryKey: qk.payments }),
    ]);
}

export function useUpdateParticipant() {
  const invalidate = useInvalidateParticipants();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: AdminParticipantUpdate }) =>
      api.patch<AdminParticipantRow>(`/api/admin/participants/${id}`, patch),
    onSuccess: () => invalidate(),
  });
}

/** Принять оплату за человека (наличные, перевод по выписке) - статус считается по сумме. */
export function useAcceptPayment() {
  const invalidate = useInvalidateParticipants();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: AdminPaymentRequest }) =>
      api.post<AdminParticipantRow>(`/api/admin/participants/${id}/payment`, body),
    onSuccess: () => invalidate(),
  });
}

/** Отменить оплату (ошиблись человеком). */
export function useUndoPayment() {
  const invalidate = useInvalidateParticipants();
  return useMutation({
    mutationFn: (id: number) => api.post<AdminParticipantRow>(`/api/admin/participants/${id}/payment/undo`, {}),
    onSuccess: () => invalidate(),
  });
}

/** Удалить участника совсем (дубль, тест). Карточка остаётся в «Истории изменений». */
export function useDeleteParticipant() {
  const invalidate = useInvalidateParticipants();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ deleted: true }>(`/api/admin/participants/${id}`),
    onSuccess: () => invalidate(),
  });
}

export function useCreateParticipant() {
  const invalidate = useInvalidateParticipants();
  return useMutation({
    mutationFn: (input: AdminParticipantCreate) => api.post<AdminParticipantRow>('/api/admin/participants', input),
    onSuccess: () => invalidate(),
  });
}

export function useBulkParticipants() {
  const invalidate = useInvalidateParticipants();
  return useMutation({
    mutationFn: (req: BulkParticipantsRequest) => api.post<{ updated: number }>('/api/admin/participants/bulk', req),
    onSuccess: () => invalidate(),
  });
}

export function useReissueTicket() {
  const invalidate = useInvalidateParticipants();
  return useMutation({
    mutationFn: (id: number) => api.post<TicketView>(`/api/admin/participants/${id}/reissue`),
    onSuccess: () => invalidate(),
  });
}

export function useResendTicket() {
  return useMutation({
    mutationFn: (id: number) => api.post<{ queued: boolean }>(`/api/admin/participants/${id}/resend`),
  });
}
