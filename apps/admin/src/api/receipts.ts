import type { ReceiptView, UnsentDraftView } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client.ts';
import { qk } from './keys.ts';

export type ReceiptStatus = ReceiptView['status'];

/** 'all' - все проверенные и на проверке (для табличного вида). */
export function useReceipts(status: ReceiptStatus | 'all', enabled = true) {
  return useQuery({
    queryKey: qk.receipts(status),
    queryFn: ({ signal }) =>
      api.get<ReceiptView[]>(withQuery('/api/admin/receipts', { status: status === 'all' ? undefined : status }), { signal }),
    enabled,
    refetchInterval: status === 'pending' ? 30_000 : false,
  });
}

/** Прислали чек, но не нажали «Отправить». */
export function useUnsentDrafts(enabled = true) {
  return useQuery({
    queryKey: [...qk.receiptsAll, 'drafts'],
    queryFn: ({ signal }) => api.get<UnsentDraftView[]>('/api/admin/receipts/drafts', { signal }),
    enabled,
    refetchInterval: 60_000,
  });
}

function useInvalidateAfterReview() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.receiptsAll }),
      qc.invalidateQueries({ queryKey: qk.payments }),
      qc.invalidateQueries({ queryKey: qk.participantsAll }),
      qc.invalidateQueries({ queryKey: qk.dashboard }),
    ]);
}

export function useAcceptReceipt() {
  const invalidate = useInvalidateAfterReview();
  return useMutation({
    mutationFn: ({ id, amount, participantIds }: { id: number; amount?: string | null; participantIds?: number[] }) =>
      api.post<ReceiptView>(`/api/admin/receipts/${id}/accept`, { ...(amount ? { amount } : {}), ...(participantIds ? { participantIds } : {}) }),
    onSettled: () => invalidate(),
    meta: { silent: true },
  });
}

export function useRejectReceipt() {
  const invalidate = useInvalidateAfterReview();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string | null }) =>
      api.post<ReceiptView>(`/api/admin/receipts/${id}/reject`, reason ? { reason } : {}),
    onSettled: () => invalidate(),
    meta: { silent: true },
  });
}

/** Удалить чек насовсем - только суперадмин. */
export function useDeleteReceipt() {
  const invalidate = useInvalidateAfterReview();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ deleted: true }>(`/api/admin/receipts/${id}`),
    onSettled: () => invalidate(),
    meta: { silent: true },
  });
}
