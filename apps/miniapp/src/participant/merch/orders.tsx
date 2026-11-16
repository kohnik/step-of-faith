import type { MerchOrderView } from '@sof/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { participantApi } from '../api.ts';

/** Заказы мерча - общие для главной и «Моих заказов» (лёгкий модуль: главная не тянет за собой витрину). */
export const ORDERS_KEY = ['merch-orders'] as const;

export function useOrders(enabled: boolean, refetchInterval?: number | false) {
  return useQuery({ queryKey: ORDERS_KEY, queryFn: () => participantApi.merchOrders(), enabled, staleTime: 10_000, refetchInterval });
}

/** Взято в долг: сколько осталось оплатить. */
export const debtLeft = (o: MerchOrderView) => (o.status === 'owed' ? Math.max(0, Number(o.total) - Number(o.paidAmount)) : 0);

/**
 * Сколько осталось ответить на «Точно заберёте?»: тикает каждую секунду; вышло - обновляем заказы (бронь могли снять).
 * `drops` - без ответа бронь снимется.
 */
export function Countdown({ until, drops }: { until: string; drops: boolean }) {
  const qc = useQueryClient();
  const end = Date.parse(until);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, end - now);
  useEffect(() => {
    if (left <= 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [left <= 0]);
  useEffect(() => {
    // Снимает очередь на сервере - даём ей пару секунд и подтягиваем свежий статус.
    if (left > 0) return;
    const t = window.setTimeout(() => void qc.invalidateQueries({ queryKey: ORDERS_KEY }), 5000);
    return () => window.clearTimeout(t);
  }, [left <= 0, qc]);
  const s = Math.floor(left / 1000);
  const hms = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return (
    <p className="text-center text-[14px] text-warn-fg">
      {left > 0 ? (
        <>
          {drops ? 'До снятия брони' : 'Осталось ответить'}: <b className="font-display text-[22px] tabular-nums">{hms}</b>
        </>
      ) : drops ? (
        'Время вышло - бронь снимается'
      ) : (
        'Время вышло'
      )}
    </p>
  );
}
