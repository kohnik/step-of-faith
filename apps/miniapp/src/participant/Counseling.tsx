import { COUNSELOR_AUDIENCE_LABELS, type CounselingPublic, type CounselorPublic, type MyParticipant } from '@sof/shared';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconChevronDown, IconClock, IconHeartHandshake, IconMapPin } from '@tabler/icons-react';
import { useState } from 'react';
import { errorMessage } from '../api/client.ts';
import { queryClient } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { dayKey, formatDayKey, formatTime, formatWhen, plural } from '../lib/time.ts';
import { confirmAction } from '../telegram/actions.ts';
import { Button, cx, EmptyState, ErrorState, Notice, Spinner } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { COUNSELING_CLOSED, COUNSELING_KEY, COUNSELING_UNREGISTERED, counselingTitle, participantApi, useMeData } from './api.ts';
import { PersonPicker, usePerson } from './PersonPicker.tsx';
import { useNow } from './Schedule.tsx';
import { usePollInterval } from '../api/realtime.ts';

export function useCounseling() {
  return useQuery({ queryKey: COUNSELING_KEY, queryFn: () => participantApi.counseling(), staleTime: 15_000, refetchInterval: usePollInterval(30_000) });
}

const ms = (iso: string) => new Date(iso).getTime();

/** «16:00–18:00», а если служители в разные дни - с днём. */
function windowText(c: CounselorPublic, tz: string, withDay: boolean): string {
  const time = `${formatTime(c.startsAt, tz)}–${formatTime(c.endsAt, tz)}`;
  return withDay ? `${formatDayKey(dayKey(c.startsAt, tz))}, ${time}` : time;
}

const pill = 'rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase leading-[1.35] tracking-wider';

/** Метки служителя: «Для девушек» / «Для парней» и свои подписи. */
function CounselorBadges({ c }: { c: CounselorPublic }) {
  if (c.audience === 'all' && c.tags.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      {c.audience !== 'all' && (
        <span className={cx(pill, 'text-white', c.audience === 'f' ? 'bg-[#e0518f]' : 'bg-[#3b7be0]')}>{COUNSELOR_AUDIENCE_LABELS[c.audience]}</span>
      )}
      {c.tags.map((t) => (
        <span key={t} className={cx(pill, 'bg-fill text-subtle')}>
          {t}
        </span>
      ))}
    </span>
  );
}

function CounselorCard({
  c,
  open,
  expanded,
  onToggle,
  person,
  family,
  now,
  tz,
  withDay,
  busySlot,
  onBook,
}: {
  c: CounselorPublic;
  open: boolean;
  expanded: boolean;
  onToggle: () => void;
  person: MyParticipant | undefined;
  family: MyParticipant[];
  now: number;
  tz: string;
  withDay: boolean;
  busySlot: string | null;
  onBook: (c: CounselorPublic, slot: string) => void;
}) {
  const upcoming = c.slots.filter((s) => ms(s.start) > now);
  const free = upcoming.filter((s) => !s.taken).length;
  const mineHere = c.slots.some((s) => s.participantId !== null && s.participantId === person?.id);
  // Служитель только для девушек (или парней): время видно всем, записаться может только подходящий человек.
  const fits = !person || c.audience === 'all' || person.gender === c.audience;
  // Без регистрации на конференцию записаться нельзя: время видно, кнопки серые.
  const canBook = !!person && fits;
  return (
    <div
      id={`counselor-${c.id}`}
      className={cx('scroll-mt-4 rounded-2xl bg-section', mineHere && 'ring-2 ring-[var(--color-ok)]')}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 p-4 text-left active:opacity-80">
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold leading-snug">{c.name}</span>
          <CounselorBadges c={c} />
          {c.place && (
            <span className="mt-1 flex items-start gap-1 text-[14px] leading-snug text-subtle">
              <IconMapPin size={15} className="mt-0.5 shrink-0" />
              {c.place}
            </span>
          )}
          <span className="mt-0.5 flex items-center gap-1 text-[14px] text-subtle">
            <IconClock size={15} className="shrink-0" />
            {windowText(c, tz, withDay)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {open && (
            <span className={cx('text-[13px] font-semibold', free ? 'text-ok-fg' : 'text-hint')}>
              {upcoming.length === 0 ? 'приём закончен' : free ? `свободно ${free}` : 'всё занято'}
            </span>
          )}
          <IconChevronDown size={20} className={cx('text-hint transition', expanded && 'rotate-180')} />
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          {!open ? (
            <p className="text-[14px] text-subtle">{person ? COUNSELING_CLOSED : COUNSELING_UNREGISTERED}.</p>
          ) : upcoming.length === 0 ? (
            <p className="text-[14px] text-subtle">Окошек больше нет.</p>
          ) : (
            <>
              {!person && <p className="mb-2 text-[14px] leading-snug text-subtle">{COUNSELING_UNREGISTERED}.</p>}
              {!fits && (
                <p className="mb-2 text-[14px] leading-snug text-subtle">
                  Принимает только {c.audience === 'f' ? 'девушек' : 'парней'}
                  {family.length > 1 && person ? ` - ${person.firstName} записаться не может` : ''}.
                </p>
              )}
              <div className="grid grid-cols-3 gap-2">
                {upcoming.map((s) => {
                  const isMine = s.participantId !== null && s.participantId === person?.id;
                  const relative = s.participantId !== null && !isMine ? family.find((p) => p.id === s.participantId) : undefined;
                  const taken = s.taken && !isMine;
                  return (
                    <button
                      key={s.start}
                      type="button"
                      disabled={taken || isMine || busySlot !== null || !canBook}
                      onClick={() => onBook(c, s.start)}
                      className={cx(
                        'flex min-h-12 flex-col items-center justify-center rounded-xl px-2 py-1.5 text-center transition active:scale-[0.97] disabled:active:scale-100',
                        isMine ? 'bg-ok text-white' : taken || !canBook ? 'bg-fill text-hint opacity-60' : 'bg-fill text-fg',
                        busySlot === s.start && 'opacity-60',
                      )}
                    >
                      <span className={cx('text-[16px] font-semibold leading-tight', taken && 'line-through')}>
                        {busySlot === s.start ? <Spinner className="size-4" /> : formatTime(s.start, tz)}
                      </span>
                      {(isMine || taken) && (
                        <span className="mt-0.5 flex items-center gap-0.5 text-[11px] font-medium leading-none">
                          {isMine && <IconCheck size={12} />}
                          {isMine ? (family.length > 1 && person ? person.firstName : 'ваше') : relative ? relative.firstName : 'занято'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Counseling() {
  const me = useMeData();
  const tz = me.event.timezone;
  const q = useCounseling();
  const now = useNow(30_000);
  const family = me.participants.filter((p) => p.status === 'active');
  const { person, choose } = usePerson(family);
  const solo = family.length <= 1;
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!q.data) {
    return (
      <Page title={counselingTitle(me)} back="/">
        {q.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-9 text-btn" />
          </div>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </Page>
    );
  }

  const data = q.data;
  const apply = (next: CounselingPublic) => queryClient.setQueryData(COUNSELING_KEY, next);
  const who = (p: MyParticipant) => (solo ? null : p.firstName);
  const mine = person ? data.my.find((m) => m.participantId === person.id) : undefined;
  const mineCounselor = mine ? data.counselors.find((c) => c.id === mine.counselorId) : undefined;
  const days = new Set(data.counselors.map((c) => dayKey(c.startsAt, tz)));
  const withDay = days.size > 1;
  const slotMinutes = [...new Set(data.counselors.map((c) => c.slotMinutes))];
  // Где больше свободных окошек впереди - выше; поровну - как расставили в админке.
  const freeOf = (c: CounselorPublic) => c.slots.filter((s) => !s.taken && ms(s.start) > now).length;
  const counselors = [...data.counselors].sort((a, b) => freeOf(b) - freeOf(a));

  const book = async (c: CounselorPublic, slot: string) => {
    if (!person) return;
    const name = who(person);
    const time = formatWhen(slot, tz);
    const ok = await confirmAction({
      title: counselingTitle(me),
      message: mine
        ? `${name ? `${name}: перенести` : 'Перенести'} запись на ${time} - ${c.name}? Прежнее время (${formatWhen(mine.slotStart, tz)}) освободится.`
        : `${name ? `Записать ${name}` : 'Записаться'} на ${time} - ${c.name}?`,
      ok: mine ? 'Перенести' : 'Записаться',
    });
    if (!ok) return;
    setBusy(slot);
    try {
      apply(await participantApi.bookCounseling({ counselorId: c.id, slotStart: slot, participantId: person.id }));
      haptic('success');
      // Напоминание бот ставит, только если до начала больше 15 минут.
      const remind = ms(slot) - Date.now() > 15 * 60_000 ? ' Напомним в боте за 15 минут' : '';
      toast.success(`${name ? `${name}: ` : 'Вы записаны: '}${time}, ${c.name}.${remind}`, 5000);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
      void q.refetch();
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!person || !mine) return;
    const ok = await confirmAction({
      title: 'Отменить запись?',
      message: `${counselingTitle(me)}: ${formatWhen(mine.slotStart, tz)} - окошко освободится для других.`,
      ok: 'Отменить запись',
      destructive: true,
    });
    if (!ok) return;
    setBusy('cancel');
    try {
      apply(await participantApi.cancelCounseling(person.id));
      toast.info('Запись отменена');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const otherTime = () => {
    if (!mine) return;
    setExpanded(mine.counselorId);
    requestAnimationFrame(() => document.getElementById(`counselor-${mine.counselorId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <Page
      title={counselingTitle(me)}
      subtitle={
        days.size === 1
          ? formatDayKey([...days][0]!, { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (ch) => ch.toUpperCase())
          : undefined
      }
      back="/"
    >
      <p className="mb-4 px-1 text-[15px] leading-snug text-subtle">
        Личная беседа и молитва со служителем
        {slotMinutes.length === 1 ? ` - ${slotMinutes[0]} ${plural(slotMinutes[0]!, ['минута', 'минуты', 'минут'])}` : ''}. Выберите
        служителя и свободное время, у каждого - одна запись.
      </p>

      <PersonPicker family={family} person={person} onChoose={choose} />

      {family.length === 0 && (
        <Notice tone="gray" className="mb-4">
          {COUNSELING_UNREGISTERED}.
        </Notice>
      )}
      {!data.open && family.length > 0 && (
        <Notice tone="gray" className="mb-4">
          {COUNSELING_CLOSED}. Можно посмотреть, кто служит и где.
        </Notice>
      )}

      {mine && mineCounselor && (
        <div className="mb-4 rounded-2xl bg-section p-4 ring-2 ring-[var(--color-ok)]">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-ok-fg">
            {person && who(person) ? `${who(person)} записан(а)` : 'Вы записаны'}
          </p>
          <p className="mt-1 font-display text-[22px] font-semibold leading-tight">
            {withDay ? `${formatDayKey(dayKey(mine.slotStart, tz))}, ` : ''}
            {formatTime(mine.slotStart, tz)}
          </p>
          <p className="mt-1 text-[16px] font-semibold">{mineCounselor.name}</p>
          {mineCounselor.place && (
            <p className="mt-0.5 flex items-start gap-1 text-[14px] text-subtle">
              <IconMapPin size={15} className="mt-0.5 shrink-0" />
              {mineCounselor.place}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {data.open && (
              <Button size="sm" variant="secondary" onClick={otherTime} disabled={busy !== null}>
                Другое время
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={() => void cancel()} loading={busy === 'cancel'} disabled={busy !== null && busy !== 'cancel'}>
              Отменить
            </Button>
          </div>
        </div>
      )}

      {data.counselors.length === 0 ? (
        <EmptyState icon={IconHeartHandshake} hue="pink" title="Служителей пока нет">
          Список появится ближе к конференции.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {counselors.map((c) => (
            <CounselorCard
              key={c.id}
              c={c}
              open={data.open && family.length > 0}
              expanded={expanded === c.id}
              onToggle={() => setExpanded((v) => (v === c.id ? null : c.id))}
              person={person}
              family={family}
              now={now}
              tz={tz}
              withDay={withDay}
              busySlot={busy}
              onBook={(counselor, slot) => void book(counselor, slot)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
