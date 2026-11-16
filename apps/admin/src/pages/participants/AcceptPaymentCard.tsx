import { Alert, Button, Card, Group, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import type { AdminParticipantRow, PaymentMethod } from '@sof/shared';
import { IconArrowBackUp, IconCash } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useAcceptPayment, useUndoPayment } from '../../api/participants.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { formatMoney, normalizeMoneyInput } from '../../lib/format.ts';
import { notifyError, notifyInfo, notifySuccess } from '../../lib/notify.tsx';

const MONEY_RE = /^\d{1,8}(\.\d{1,2})?$/;

const leftOf = (p: Pick<AdminParticipantRow, 'amountDue' | 'amountPaid'>) => Math.max(0, Number(p.amountDue ?? 0) - Number(p.amountPaid ?? 0));
// toFixed: 35 − 26.12 даёт 8.879999999999999, а такая строка не проходит проверку суммы.
const amountFor = (left: number) => (left > 0 ? String(Number(left.toFixed(2))) : '');

/**
 * Принять оплату за одного человека: наличные в 504-м, перевод по выписке банка (в т. ч. у людей без Telegram).
 * Сумма меньше остатка - «оплачено частично». Человеку (и записавшему) придёт уведомление в бот.
 */
export function AcceptPaymentCard({ participant: p }: { participant: AdminParticipantRow }) {
  const accept = useAcceptPayment();
  const undo = useUndoPayment();
  const confirm = useConfirm();
  const left = leftOf(p);
  const [method, setMethod] = useState<PaymentMethod>(p.paymentMethod === 'cash' ? 'cash' : 'transfer');
  const [amount, setAmount] = useState(amountFor(left));
  const [note, setNote] = useState('');
  // Ключ повтора: двойное нажатие или повтор после обрыва связи не зачисляет оплату дважды.
  const requestRef = useRef<string | null>(null);
  const value = normalizeMoneyInput(amount);
  const error = value && !MONEY_RE.test(value) ? 'Сумма в формате 35 или 35.50' : value && Number(value) <= 0 ? 'Сумма больше нуля' : null;
  const open = p.paymentStatus === 'unpaid' || p.paymentStatus === 'partial' || p.paymentStatus === 'pending';
  const paidSomething = p.paymentStatus === 'paid' || p.paymentStatus === 'partial';

  const submit = () => {
    if (error || !value) return;
    requestRef.current ??= crypto.randomUUID();
    accept.mutate(
      { id: p.id, body: { method, amount: value, note: note.trim() || null, requestId: requestRef.current } },
      {
        onSuccess: (row) => {
          requestRef.current = null;
          const rest = leftOf(row);
          if (row.warning) notifyInfo(row.warning, row.fullName);
          else notifySuccess(row.paymentStatus === 'partial' ? `Внесено частично, осталось ${formatMoney(rest)}` : 'Оплата принята', row.fullName);
          // В поле - новый остаток, а не только что принятая сумма.
          setAmount(amountFor(rest));
          setNote('');
        },
        onError: (err) => {
          // Ключ оставляем только при обрыве связи или сбое сервера - тогда повтор безопасен.
          if (!(err instanceof ApiError && (err.status === 0 || err.status >= 500))) requestRef.current = null;
        },
      },
    );
  };

  const cancel = async () => {
    const ok = await confirm({
      title: 'Отменить оплату?',
      message: `${p.fullName}: статус вернётся к тому, что было до последнего приёма (давний приём - «не оплачено»).`,
      confirmLabel: 'Отменить оплату',
      danger: true,
    });
    if (!ok) return;
    undo.mutate(p.id, {
      onSuccess: (row) => {
        setAmount(amountFor(leftOf(row)));
        notifySuccess('Оплата отменена', row.fullName);
      },
      onError: (err) => notifyError(err),
    });
  };

  if (p.paymentStatus === 'exempt') return null;

  return (
    <Card padding="md" radius="md" withBorder>
      <Stack gap="sm">
        {open ? (
          <>
            <Group justify="space-between" gap="xs">
              <Text fw={700}>Принять оплату</Text>
              {left > 0 && (
                <Text size="sm" c="dimmed">
                  осталось внести {formatMoney(left)}
                </Text>
              )}
            </Group>
            {p.paymentStatus === 'pending' && (
              <Alert color="yellow" variant="light" p="xs">
                <Text size="sm">Есть чек на проверке - его можно принять во вкладке ниже. Здесь - если оплату подтвердили иначе.</Text>
              </Alert>
            )}
            <SegmentedControl
              fullWidth
              value={method}
              onChange={(v) => setMethod(v as PaymentMethod)}
              data={[
                { value: 'cash', label: 'Наличные' },
                { value: 'transfer', label: 'Перевод' },
              ]}
            />
            <Group grow align="flex-start" gap="sm">
              <TextInput label="Сумма, руб." inputMode="decimal" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} error={error} />
              <TextInput label="Заметка" placeholder="по выписке 12.10" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
            </Group>
            <Button leftSection={<IconCash size={16} />} color="green" onClick={submit} loading={accept.isPending} disabled={!value || !!error}>
              {value && !error ? `Принять ${formatMoney(value)}` : 'Принять'}
            </Button>
          </>
        ) : (
          <Text fw={600}>Взнос внесён: {formatMoney(p.amountPaid)}</Text>
        )}
        {paidSomething && (
          <Button variant="subtle" color="red" size="xs" leftSection={<IconArrowBackUp size={14} />} onClick={() => void cancel()} loading={undo.isPending}>
            Отменить оплату
          </Button>
        )}
      </Stack>
    </Card>
  );
}
