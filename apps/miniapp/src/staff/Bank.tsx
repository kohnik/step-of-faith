/**
 * Банк: банкир с телефона выдаёт и принимает деньги и видит, сколько должно остаться.
 * Весь журнал с фильтрами - в админке, раздел «Деньги»; здесь - свои записи.
 */
import { formatRub, type PaymentEntryView, type PaymentMethod } from '@sof/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowDownLeft, IconArrowUpRight } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/client.ts';
import { haptic } from '../lib/feedback.ts';
import { uuid } from '../lib/ids.ts';
import { formatDateTime } from '../lib/time.ts';
import { confirmAction } from '../telegram/actions.ts';
import { Button, cx, EmptyState, ErrorState, Field, Section, Segmented, Spinner, TextArea, TextInput } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { useEventTimezone } from './common.ts';
import { SessionExpiredNotice } from './SessionExpired.tsx';

const KEY = ['bank'] as const;
const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Наличные' },
  { value: 'transfer', label: 'Перевод' },
];
const METHOD_LABEL: Record<PaymentMethod, string> = { cash: 'Наличные', transfer: 'Переводы', card: 'Карта' };
const CATEGORIES = ['Закупки', 'Питание', 'Транспорт', 'Аренда', 'Печать', 'Мерч'];
const isMoney = (v: string) => /^\d{1,7}(\.\d{1,2})?$/.test(v) && Number(v) > 0;

export default function Bank() {
  const tz = useEventTimezone();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: staffApi.money, refetchInterval: 30_000 });
  const [entry, setEntry] = useState<'payout' | 'income' | null>(null);
  const [cancelling, setCancelling] = useState<PaymentEntryView | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });

  const s = q.data?.summary;
  return (
    <Page title="Банк" subtitle="Выдать и принять деньги" back="/">
      <SessionExpiredNotice />
      {q.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className="mb-4 rounded-3xl bg-section p-4">
            <p className="text-[14px] text-subtle">Должно остаться</p>
            <p className="text-[32px] font-bold leading-tight tabular-nums">{formatRub(s!.balance)}</p>
            <div className="mt-2 flex gap-4 text-[14px]">
              <span className="text-ok-fg">Пришло {formatRub(s!.income.total)}</span>
              <span className="text-danger">Выдано {formatRub(s!.payout)}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {s!.byMethod.map((m) => (
                <div key={m.method} className="rounded-2xl bg-fill px-3 py-2">
                  <p className="text-[13px] text-subtle">{METHOD_LABEL[m.method]}</p>
                  <p className="text-[18px] font-bold tabular-nums">{formatRub(m.balance)}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3">
            <Button size="lg" variant="danger" onClick={() => setEntry('payout')}>
              <IconArrowUpRight size={22} />
              Выдать
            </Button>
            <Button size="lg" variant="success" onClick={() => setEntry('income')}>
              <IconArrowDownLeft size={22} />
              Принять
            </Button>
          </div>

          <Section title="Мои записи">
            {q.data.mine.length === 0 ? (
              <EmptyState title="Пока пусто">Здесь появятся ваши выдачи и приходы. Весь журнал - в админке, раздел «Деньги».</EmptyState>
            ) : (
              <div className="space-y-2">
                {q.data.mine.map((r) => (
                  <Entry key={r.id} r={r} tz={tz} onCancel={() => setCancelling(r)} />
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      <Sheet open={entry !== null} onClose={() => setEntry(null)} title={entry === 'payout' ? 'Выдать деньги' : 'Принять деньги'}>
        {entry && (
          <EntryForm
            kind={entry}
            onDone={() => {
              setEntry(null);
              refresh();
            }}
          />
        )}
      </Sheet>
      <Sheet open={cancelling !== null} onClose={() => setCancelling(null)} title="Отменить запись">
        {cancelling && (
          <CancelForm
            r={cancelling}
            onDone={() => {
              setCancelling(null);
              refresh();
            }}
          />
        )}
      </Sheet>
    </Page>
  );
}

function Entry({ r, tz, onCancel }: { r: PaymentEntryView; tz: string; onCancel: () => void }) {
  const out = r.kind === 'payout';
  return (
    <div className={cx('rounded-2xl bg-section p-3', r.undoneAt && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cx('font-semibold leading-snug', r.undoneAt && 'line-through')}>{r.fullName}</p>
          <p className="text-[13px] text-subtle">{[r.category, r.comment].filter(Boolean).join(' · ')}</p>
          <p className="text-[12px] text-hint">
            {formatDateTime(r.createdAt, tz)} · {r.method === 'cash' ? 'наличные' : r.method === 'transfer' ? 'перевод' : 'карта'}
          </p>
        </div>
        <p className={cx('shrink-0 text-[17px] font-bold tabular-nums', out ? 'text-danger' : 'text-ok-fg')}>
          {out ? '−' : '+'}
          {formatRub(r.amount)}
        </p>
      </div>
      {r.undoneAt ? (
        <p className="mt-1 text-[13px] text-danger">Отменено{r.undoReason ? `: ${r.undoReason}` : ''}</p>
      ) : (
        <button type="button" onClick={onCancel} className="mt-1 text-[14px] text-accent">
          Отменить
        </button>
      )}
    </div>
  );
}

/** Всё набирается в шторке и записывается одной кнопкой. */
function EntryForm({ kind, onDone }: { kind: 'payout' | 'income'; onDone: () => void }) {
  const payout = kind === 'payout';
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState('');
  const [who, setWho] = useState('');
  const [what, setWhat] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Ключ записи: не дождались ответа и нажали снова - сервер не запишет дважды. */
  const requestRef = useRef<string | null>(null);
  const value = amount.trim().replace(',', '.');
  const valid = isMoney(value) && who.trim() !== '' && what.trim() !== '';

  const submit = async () => {
    if (!valid || busy) return;
    const ok = await confirmAction({
      title: payout ? `Выдать ${formatRub(value)}?` : `Принять ${formatRub(value)}?`,
      message: `${payout ? 'Кому' : 'От кого'}: ${who.trim()}. ${what.trim()}.`,
      ok: payout ? 'Выдать' : 'Принять',
    });
    if (!ok) return;
    setBusy(true);
    requestRef.current ??= uuid();
    try {
      const res = await staffApi.addMoney({ requestId: requestRef.current, kind, amount: value, method, counterparty: who.trim(), comment: what.trim(), category });
      requestRef.current = null;
      haptic('success');
      if (res.duplicate) toast.info('Эта запись уже есть - второй раз не записали');
      else toast.success(payout ? `Выдано ${formatRub(value)}` : `Принято ${formatRub(value)}`);
      onDone();
    } catch (err) {
      // Нет связи - ключ оставляем: повтор не запишется дважды.
      if (!(err instanceof ApiError && err.isTransient)) requestRef.current = null;
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Segmented value={method} options={METHODS} onChange={setMethod} className="mb-4" />
      <Field label="Сумма, ₽">
        <TextInput inputMode="decimal" placeholder="1500" value={amount} invalid={amount !== '' && !isMoney(value)} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label={payout ? 'Кому' : 'От кого'}>
        <TextInput placeholder={payout ? 'Имя или организация' : 'Имя или организация'} value={who} maxLength={120} onChange={(e) => setWho(e.target.value)} />
      </Field>
      <Field label={payout ? 'На что' : 'За что'}>
        <TextArea placeholder={payout ? 'Вода и стаканы' : 'Возврат аванса'} value={what} maxLength={300} onChange={(e) => setWhat(e.target.value)} />
      </Field>
      <Field label="Статья" optional>
        <div className="flex flex-wrap gap-2">
          {/* В шторке фон - как у обычного чипа, поэтому здесь чипы на подложке. */}
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(category === c ? null : c)}
              className={cx('min-h-9 rounded-full px-3.5 text-[15px] font-semibold transition', category === c ? 'bg-btn text-btn-fg' : 'bg-fill text-fg')}
            >
              {c}
            </button>
          ))}
        </div>
      </Field>
      <Button block size="lg" variant={payout ? 'danger' : 'success'} loading={busy} disabled={!valid} onClick={() => void submit()}>
        {payout ? 'Выдать' : 'Принять'}
        {isMoney(value) ? ` ${formatRub(value)}` : ''}
      </Button>
    </div>
  );
}

function CancelForm({ r, onDone }: { r: PaymentEntryView; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 2;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      await staffApi.cancelMoney(r.id, reason.trim());
      haptic('success');
      toast.success('Запись отменена');
      onDone();
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="mb-3 text-[15px]">
        {r.fullName}, {formatRub(r.amount)} - запись останется в журнале зачёркнутой и в итоги не пойдёт.
      </p>
      <Field label="Причина">
        <TextArea placeholder="Ошиблись суммой" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Button block size="lg" variant="danger" loading={busy} disabled={!ok} onClick={() => void submit()}>
        Отменить запись
      </Button>
    </div>
  );
}
