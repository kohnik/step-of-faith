import type { PaymentEntryView } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

/** Журнал оплат: наличные на кассе, принятые чеки, правки. На кассе он меняется часто - обновляем каждые 20 секунд. */
export function usePaymentsLedger(enabled = true) {
  return useQuery({
    queryKey: qk.payments,
    queryFn: ({ signal }) => api.get<PaymentEntryView[]>('/api/admin/payments', { signal }),
    enabled,
    refetchInterval: 20_000,
  });
}

/** Отменить пожертвование: админ - всегда, кассир - своё в первые 15 минут. */
export function useUndoDonation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<{ ok: true }>(`/api/admin/donations/${id}/undo`, {}),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.payments }), qc.invalidateQueries({ queryKey: qk.dashboard })]),
  });
}
