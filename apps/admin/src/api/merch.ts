import type { AdminMerchOrderView, AdminMerchProduct, ChatMessageView, MerchPayMethod, MerchProductSave, MerchSettings, MerchSettingsView, MerchStats, MerchUploadView } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

export function useMerchProducts() {
  return useQuery({ queryKey: qk.merch, queryFn: ({ signal }) => api.get<AdminMerchProduct[]>('/api/admin/merch', { signal }) });
}

export function useMerchOrders(enabled = true) {
  return useQuery({
    queryKey: qk.merchOrders,
    queryFn: ({ signal }) => api.get<AdminMerchOrderView[]>('/api/admin/merch/orders', { signal }),
    enabled,
    refetchInterval: 30_000,
  });
}

/** Редактор вещи: всё набранное - одним запросом; в ответе вещь целиком - подменяем в списке без перезапроса. */
export function useSaveProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MerchProductSave) => api.post<AdminMerchProduct>('/api/admin/merch/save', body),
    onSuccess: (p) => qc.setQueryData<AdminMerchProduct[]>(qk.merch, (list) => (list?.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...(list ?? []), p])),
  });
}

/** Файл для редактора: сервер его обработает, а привяжет к вещи «Сохранить». */
export function uploadMerchFile(file: File): Promise<MerchUploadView> {
  const form = new FormData();
  form.append('file', file);
  return api.post<MerchUploadView>('/api/admin/merch/uploads', form);
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ deleted: true }>(`/api/admin/merch/${id}`),
    onSuccess: (_r, id) => qc.setQueryData<AdminMerchProduct[]>(qk.merch, (list) => list?.filter((x) => x.id !== id)),
  });
}

/** Действия с заказом: обновляем заказ в списке и остатки товаров. */
function useOrderMutation<V>(fn: (v: V) => Promise<AdminMerchOrderView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (o) => {
      qc.setQueryData<AdminMerchOrderView[]>(qk.merchOrders, (list) => (list?.some((x) => x.id === o.id) ? list.map((x) => (x.id === o.id ? o : x)) : [o, ...(list ?? [])]));
      void qc.invalidateQueries({ queryKey: qk.merch, exact: true });
      void qc.invalidateQueries({ queryKey: qk.merchStats });
      void qc.invalidateQueries({ queryKey: qk.money });
    },
  });
}

export const useOrderPaid = () => useOrderMutation(({ id, method }: { id: number; method: MerchPayMethod }) => api.post<AdminMerchOrderView>(`/api/admin/merch/orders/${id}/pay`, { method }));
export const useOrderIssued = () =>
  useOrderMutation(({ id, method }: { id: number; method: MerchPayMethod | null }) => api.post<AdminMerchOrderView>(`/api/admin/merch/orders/${id}/issue`, { method }));
export const useOrderCancel = () =>
  useOrderMutation(({ id, reason }: { id: number; reason: string | null }) => api.post<AdminMerchOrderView>(`/api/admin/merch/orders/${id}/cancel`, { reason }));
export interface SellBody {
  requestId: string;
  items: { variantId: number; qty: number }[];
  method: MerchPayMethod;
  /** В долг: покупатель обязателен - участник или имя и телефон; `paidNow` - сколько внесли сразу. */
  debt?: boolean;
  paidNow?: string | null;
  buyerParticipantId?: number | null;
  buyerName?: string | null;
  buyerPhone?: string | null;
}
export const useSellOnSite = () => useOrderMutation((body: SellBody) => api.post<AdminMerchOrderView>('/api/admin/merch/sell', { ...body, paymentMethod: 'cash' }));
/** Бронь человеку из переписки (по заявке или сама): обновляем переписку, заказы и остатки. */
export function useReserveForUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { requestId: string; userId: number; items: { variantId: number; qty: number }[]; messageId?: number | null }) =>
      api.post<{ order: AdminMerchOrderView; message: ChatMessageView | null }>('/api/admin/merch/reserve', body),
    onSuccess: ({ order }) => {
      qc.setQueryData<AdminMerchOrderView[]>(qk.merchOrders, (list) => (list ? [order, ...list.filter((x) => x.id !== order.id)] : list));
      void qc.invalidateQueries({ queryKey: qk.merch, exact: true });
      void qc.invalidateQueries({ queryKey: qk.merchStats });
      void qc.invalidateQueries({ queryKey: qk.chats });
    },
  });
}
/** Чек за мерч: принять (бронь оплачена) или отклонить с причиной - продавцу без доступа к «Оплатам и чекам». */
export const useAcceptMerchReceipt = () => useOrderMutation((receiptId: number) => api.post<AdminMerchOrderView>(`/api/admin/merch/receipts/${receiptId}/accept`, {}));
export const useRejectMerchReceipt = () =>
  useOrderMutation(({ receiptId, reason }: { receiptId: number; reason: string }) =>
    api.post<AdminMerchOrderView>(`/api/admin/merch/receipts/${receiptId}/reject`, { reason }),
  );
export const useRepayDebt = () =>
  useOrderMutation(({ id, amount, method }: { id: number; amount: string; method: MerchPayMethod }) =>
    api.post<AdminMerchOrderView>(`/api/admin/merch/orders/${id}/repay`, { amount, method }),
  );

export function useMerchStats(enabled = true) {
  return useQuery({ queryKey: qk.merchStats, queryFn: ({ signal }) => api.get<MerchStats>('/api/admin/merch/stats', { signal }), enabled, refetchInterval: 30_000 });
}

export function useMerchSettings() {
  return useQuery({ queryKey: qk.merchSettings, queryFn: ({ signal }) => api.get<MerchSettingsView>('/api/admin/merch-settings', { signal }) });
}

/** Уходят только изменённые поля - сервер сливает их с остальными настройками. */
export function useSaveMerchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<MerchSettings>) => api.patch<MerchSettingsView>('/api/admin/merch-settings', patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.merchSettings, data);
      return Promise.all([qc.invalidateQueries({ queryKey: qk.settings }), qc.invalidateQueries({ queryKey: qk.session })]);
    },
  });
}

export interface BuyerHit {
  id: number;
  name: string;
  phone: string | null;
  city: string | null;
}
/** Покупатель в долг - участник из базы. */
export function useBuyerSearch(q: string) {
  return useQuery({
    queryKey: ['merch', 'buyers', q],
    queryFn: ({ signal }) => api.get<BuyerHit[]>(`/api/admin/merch/buyers?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}
