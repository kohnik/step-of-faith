import type { MoneyEntryRequest, MoneyResponse } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

/** Раздел «Деньги»: сводка и журнал всего прихода и расхода. Обновляем каждые 20 секунд, как журнал оплат. */
export function useMoney() {
  return useQuery({
    queryKey: qk.money,
    queryFn: ({ signal }) => api.get<MoneyResponse>('/api/admin/money', { signal }),
    refetchInterval: 20_000,
  });
}

function useMoneyMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.money }),
        qc.invalidateQueries({ queryKey: qk.payments }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
      ]),
  });
}

/** Выдать или принять деньги. */
export const useAddMoney = () => useMoneyMutation((body: MoneyEntryRequest) => api.post<{ id: number | null }>('/api/admin/money', body));

/** Отменить запись с причиной: она останется в журнале зачёркнутой. */
export const useCancelMoney = () =>
  useMoneyMutation(({ id, reason }: { id: number; reason: string }) => api.post<{ ok: true }>(`/api/admin/money/${id}/cancel`, { reason }));
