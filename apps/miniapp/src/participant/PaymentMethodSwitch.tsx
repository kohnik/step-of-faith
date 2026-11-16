import { REG_PAYMENT_METHOD_LABELS, type MyParticipant, type RegPaymentMethod } from '@sof/shared';
import { useState } from 'react';
import { errorMessage } from '../api/client.ts';
import { setMe } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { cx, Spinner } from '../ui/kit.tsx';
import { toast } from '../ui/toast.tsx';
import { participantApi, useMeData } from './api.ts';

const OPTIONS: [RegPaymentMethod, string][] = [
  ['transfer', 'Переводом'],
  ['cash', 'Наличными'],
];

/** Можно ли поменять способ оплаты: взнос не внесён и чек не на проверке. */
export function canChangeMethod(p: MyParticipant, amount: number): boolean {
  return p.status === 'active' && amount > 0 && (p.paymentStatus === 'unpaid' || p.paymentStatus === 'partial');
}

/**
 * «Переводом / Наличными» после регистрации. Меняем сразу (оптимистично); не получилось - возвращаем как было.
 */
export function PaymentMethodSwitch({ participant: p, className }: { participant: MyParticipant; className?: string }) {
  const me = useMeData();
  const [pending, setPending] = useState<RegPaymentMethod | null>(null);
  const value = pending ?? p.paymentMethod;

  const pick = async (method: RegPaymentMethod) => {
    if (method === value || pending) return;
    haptic('light');
    setPending(method);
    try {
      const updated = await participantApi.changePaymentMethod(p.id, method);
      setMe({ ...me, participants: me.participants.map((x) => (x.id === updated.id ? updated : x)) });
      toast.success(`${p.firstName}: ${REG_PAYMENT_METHOD_LABELS[method].toLowerCase()}`);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div role="radiogroup" aria-label="Как внесёте взнос" className={cx('flex min-h-10 gap-1 rounded-xl bg-fill p-1', className)}>
      {OPTIONS.map(([m, label]) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => void pick(m)}
          className={cx(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[14px] font-semibold transition',
            value === m ? 'bg-btn text-btn-fg' : 'text-subtle',
          )}
        >
          {pending === m && <Spinner className="size-4" />}
          {label}
        </button>
      ))}
    </div>
  );
}
