import { CATEGORY_LABELS, type ActivityRegistrationRow, type ActivityView, type StaffEnrollResponse } from '@sof/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { IconSearch, IconUserPlus, IconUsers } from '@tabler/icons-react';
import { errorMessage } from '../api/client.ts';
import { haptic } from '../lib/feedback.ts';
import { formatDateTime, formatTime, yearsLabel } from '../lib/time.ts';
import { confirmAction } from '../telegram/actions.ts';
import { Button, Card, EmptyState, ErrorState, Notice, Spinner, TextInput, cx } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { staffActivitiesQuery, useEventTimezone } from './common.ts';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Rows({
  rows,
  tz,
  numbered,
  onRemove,
}: {
  rows: ActivityRegistrationRow[];
  tz: string;
  numbered?: boolean;
  onRemove?: (r: ActivityRegistrationRow) => void;
}) {
  return (
    <div className="rounded-2xl bg-section px-3 py-1">
      {rows.map((r, i) => (
        <div key={r.participantId} className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
          {numbered && <span className="w-6 shrink-0 text-right text-[13px] text-hint">{i + 1}</span>}
          <div className="min-w-0 flex-1">
            <p className="font-medium leading-snug">{r.fullName}</p>
            <p className="text-[13px] text-subtle">
              {yearsLabel(r.age)} · {CATEGORY_LABELS[r.category]} · {formatDateTime(r.queuedAt, tz)}
            </p>
          </div>
          {onRemove && (
            <button type="button" onClick={() => onRemove(r)} className="h-9 shrink-0 px-2 text-[14px] font-medium text-danger active:opacity-70">
              Убрать
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Итог записи волонтёром - коротко, как у участника в «Расписании». */
function enrollToast(name: string, res: StaffEnrollResponse, tz: string) {
  switch (res.outcome) {
    case 'registered':
      haptic('success');
      return toast.success(`${name}: записали`);
    case 'waitlist':
      haptic('success');
      return toast.info(`${name}: мест нет, поставили в лист ожидания`);
    case 'already_registered':
      return toast.info(`${name} уже записан(а)`);
    case 'already_waitlist':
      return toast.info(`${name} уже в листе ожидания`);
    case 'full':
      haptic('error');
      return toast.error('Мест больше нет');
    case 'closed':
      haptic('error');
      return toast.error('Запись закрыта');
    case 'age_restricted':
      haptic('error');
      return toast.error(`${name}: не подходит по возрасту`);
    case 'time_conflict':
      haptic('error');
      return toast.error(
        res.conflict
          ? `${name} в это время записан(а) на «${res.conflict.title}» (${formatTime(res.conflict.startsAt, tz)}). Сначала уберите ту запись`
          : `${name}: в это время уже есть другая запись`,
      );
    default:
      haptic('error');
      return toast.error('Не получилось записать');
  }
}

/** Волонтёр записывает человека сам - для тех, у кого нет своего Telegram. */
function EnrollSheet({
  activity,
  open,
  taken,
  onClose,
  onEnrolled,
}: {
  activity: ActivityView;
  open: boolean;
  taken: Set<number>;
  onClose: () => void;
  onEnrolled: (res: StaffEnrollResponse) => void;
}) {
  const tz = useEventTimezone();
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const term = useDebounced(q.trim(), 300);
  const search = useQuery({
    queryKey: ['staff-people', term],
    queryFn: ({ signal }) => staffApi.searchPeople(term, signal),
    enabled: open && term.length >= 2,
    placeholderData: keepPreviousData,
  });
  const items = term.length >= 2 ? (search.data?.items ?? []).filter((c) => c.status === 'active') : [];

  const enroll = async (id: number, name: string) => {
    const ok = await confirmAction({ message: `Записать: ${name} на «${activity.title}»?`, ok: 'Записать' });
    if (!ok) return;
    setBusyId(id);
    try {
      const res = await staffApi.enroll(activity.id, id);
      enrollToast(name, res, tz);
      onEnrolled(res);
      if (res.outcome === 'registered' || res.outcome === 'waitlist') setQ('');
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Записать человека">
      <p className="mb-3 px-1 text-[14px] leading-snug text-subtle">
        Для тех, у кого нет своего Telegram. Правила те же: места, лист ожидания, пересечение по времени.
      </p>
      <div className="relative mb-3">
        <IconSearch size={20} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-hint" />
        <TextInput
          type="search"
          enterKeyHint="search"
          placeholder="Фамилия, имя или телефон"
          className="pl-11"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {term.length < 2 ? null : search.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner className="text-btn" />
        </div>
      ) : search.isError ? (
        <Notice tone="red">{errorMessage(search.error)}</Notice>
      ) : items.length === 0 ? (
        <p className="px-1 py-2 text-[15px] text-subtle">Никого не нашли</p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-fill">
          {items.map((c) => {
            const already = taken.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                disabled={already || busyId !== null}
                onClick={() => void enroll(c.id, c.fullName)}
                className="flex min-h-14 w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left last:border-b-0 active:bg-section disabled:active:bg-transparent"
              >
                <span className="min-w-0 flex-1">
                  <span className={cx('block font-semibold leading-snug', already && 'text-subtle')}>{c.fullName}</span>
                  <span className="block text-[13px] text-subtle">{yearsLabel(c.age)}</span>
                </span>
                {busyId === c.id ? (
                  <Spinner className="size-5 text-btn" />
                ) : already ? (
                  <span className="shrink-0 text-[14px] text-hint">уже записан(а)</span>
                ) : (
                  <IconUserPlus size={20} className="shrink-0 text-accent" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

export default function Registrations({ id }: { id: number }) {
  const tz = useEventTimezone();
  const qc = useQueryClient();
  const acts = useQuery(staffActivitiesQuery);
  const key = ['staff-registrations', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => staffApi.registrations(id),
    refetchInterval: 30_000,
  });
  const [showCancelled, setShowCancelled] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const activity = acts.data?.find((a) => a.id === id);
  const rows = q.data ?? [];
  const registered = rows.filter((r) => r.status === 'registered');
  const waitlist = rows.filter((r) => r.status === 'waitlist');
  const cancelled = rows.filter((r) => r.status === 'cancelled');
  const canEnroll = activity?.registrationMode === 'required' && activity.status === 'published';
  const taken = new Set([...registered, ...waitlist].map((r) => r.participantId));

  const refreshLists = (next: ActivityRegistrationRow[]) => {
    qc.setQueryData(key, next);
    void qc.invalidateQueries(staffActivitiesQuery);
  };

  const remove = async (r: ActivityRegistrationRow) => {
    const ok = await confirmAction({
      message: `Убрать запись: ${r.fullName}? Место достанется первому из листа ожидания.`,
      ok: 'Убрать',
      destructive: true,
    });
    if (!ok) return;
    try {
      refreshLists(await staffApi.unenroll(id, r.participantId));
      haptic('success');
      toast.success(`${r.fullName}: запись убрана`);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page
      title="Записавшиеся"
      subtitle={
        activity
          ? `${activity.title} · ${formatDateTime(activity.startsAt, tz)}–${formatTime(activity.endsAt, tz)}`
          : undefined
      }
      back="/activities"
    >
      {canEnroll && (
        <Button variant="secondary" block className="mb-4" onClick={() => setEnrollOpen(true)}>
          <IconUserPlus size={20} />
          Записать человека
        </Button>
      )}
      {q.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-9 text-btn" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={IconUsers} hue="gray" title="Пока никто не записался" />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 text-center">
            <Card className="px-2 py-2">
              <p className="text-xl font-bold">
                {registered.length}
                {activity?.capacity ? `/${activity.capacity}` : ''}
              </p>
              <p className="text-[12px] text-subtle">записаны</p>
            </Card>
            <Card className="px-2 py-2">
              <p className="text-xl font-bold">{waitlist.length}</p>
              <p className="text-[12px] text-subtle">в ожидании</p>
            </Card>
          </div>
          {registered.length > 0 && (
            <section className="mb-5">
              <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-head">Записаны</p>
              <Rows rows={registered} tz={tz} numbered onRemove={canEnroll ? remove : undefined} />
            </section>
          )}
          {waitlist.length > 0 && (
            <section className="mb-5">
              <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-head">Лист ожидания (по очереди)</p>
              <Rows rows={waitlist} tz={tz} numbered onRemove={canEnroll ? remove : undefined} />
            </section>
          )}
          {cancelled.length > 0 && (
            <section className="mb-5">
              <button
                type="button"
                className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-accent"
                onClick={() => setShowCancelled((v) => !v)}
              >
                {showCancelled ? '▾' : '▸'} Отменили запись ({cancelled.length})
              </button>
              {showCancelled && <Rows rows={cancelled} tz={tz} />}
            </section>
          )}
        </>
      )}
      {activity && canEnroll && (
        <EnrollSheet
          activity={activity}
          open={enrollOpen}
          taken={taken}
          onClose={() => setEnrollOpen(false)}
          onEnrolled={(res) => refreshLists(res.rows)}
        />
      )}
    </Page>
  );
}
