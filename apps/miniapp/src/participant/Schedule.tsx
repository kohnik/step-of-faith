import {
  ageOn,
  type ActivityConflict,
  type ActivityRegisterOutcome,
  type ActivityView,
  type CounselingPublic,
  type MyParticipant,
  type SeminarsPublic,
} from '@sof/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  IconCalendarEvent,
  IconCalendarOff,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconHourglass,
  IconMapPin,
  IconMicrophone2,
  IconMoodKid,
  IconStar,
  IconTicket,
} from '@tabler/icons-react';
import { useLocation } from 'wouter';
import { errorMessage } from '../api/client.ts';
import { meQuery, queryClient, refreshMe } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { local, session } from '../lib/storage.ts';
import { dayKey, formatDateTime, formatDayKey, formatTime, plural } from '../lib/time.ts';
import { confirmAction } from '../telegram/actions.ts';
import { Badge, Button, Chip, cx, EmptyState, ErrorState, Notice, Spinner } from '../ui/kit.tsx';
import type { TablerIcon } from '../ui/icons.tsx';
import { Page } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { toast } from '../ui/toast.tsx';
import { COUNSELING_CLOSED, COUNSELING_KEY, COUNSELING_UNREGISTERED, counselingTitle, participantApi, SEMINARS_KEY, signupClosedText, useMeData } from './api.ts';
import { usePollInterval } from '../api/realtime.ts';

const SCHEDULE_CACHE = 'sof:schedule';
const PERSON_KEY = 'sof:schedule-person';

const scheduleQuery = queryOptions({
  queryKey: ['schedule'] as const,
  queryFn: async () => {
    const data = await participantApi.schedule();
    local.setJSON(SCHEDULE_CACHE, { at: Date.now(), data });
    return data;
  },
  // Во время конференции программу правят на ходу (перенос, место, открыли запись) - пока экран открыт,
  // сверяемся раз в минуту; в свёрнутом приложении опрос останавливается сам.
  staleTime: 30_000,
  refetchInterval: 60_000,
  initialData: () => local.getJSON<{ at: number; data: ActivityView[] }>(SCHEDULE_CACHE)?.data,
  initialDataUpdatedAt: () => local.getJSON<{ at: number; data: ActivityView[] }>(SCHEDULE_CACHE)?.at,
});

/** Отбор над списком: всё расписание или записи одного человека из аккаунта (его id). */
type Filter = 'all' | number;

const ms = (iso: string) => new Date(iso).getTime();
/** Записан ли этот человек (или в листе ожидания) на мероприятие. */
const isFor = (a: ActivityView, participantId: number) => a.my.some((m) => m.participantId === participantId);

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

function patchActivity(id: number, fn: (a: ActivityView) => ActivityView): void {
  queryClient.setQueryData<ActivityView[]>(scheduleQuery.queryKey, (old) => old?.map((a) => (a.id === id ? fn(a) : a)));
}

function replaceActivity(updated: ActivityView): void {
  patchActivity(updated.id, () => updated);
  // Сеансы семинаров живут ещё и в кэше семинаров.
  queryClient.setQueryData<SeminarsPublic>(SEMINARS_KEY, (old) =>
    old && { ...old, sessions: old.sessions.map((t) => (t.id === updated.id ? updated : t)) },
  );
}

/** «осталось 5 мест» / «мест нет» / «По записи». У мероприятий без записи подписи нет. */
function seatsText(a: ActivityView): string {
  if (a.registrationMode !== 'required') return '';
  if (a.capacity === null) return 'По записи';
  const left = Math.max(0, a.capacity - a.registeredCount);
  if (left > 0) return `осталось ${left} ${plural(left, ['место', 'места', 'мест'])}`;
  return a.waitlistEnabled ? `мест нет · в очереди ${a.waitlistCount}` : 'мест нет';
}

function registrationWindow(
  a: ActivityView,
  now: number,
  tz: string,
  signupOpen: boolean,
  closedNote: string,
): { open: boolean; note?: string } {
  if (a.status === 'cancelled') return { open: false, note: 'Эту активность отменили' };
  if (a.status !== 'published') return { open: false, note: 'Запись пока не открыта' };
  if (ms(a.startsAt) <= now) return { open: false, note: 'Уже началось' };
  // До конференции запись закрыта: организаторы откроют её на месте.
  if (!signupOpen) return { open: false, note: closedNote };
  if (a.registrationOpensAt && ms(a.registrationOpensAt) > now)
    return { open: false, note: `Запись с ${formatDateTime(a.registrationOpensAt, tz)}` };
  if (a.registrationClosesAt && ms(a.registrationClosesAt) <= now) return { open: false, note: 'Запись закрыта' };
  return { open: true };
}

function ageText(a: ActivityView): string | null {
  if (a.minAge !== null && a.maxAge !== null) return `Возраст: ${a.minAge}–${a.maxAge} лет`;
  if (a.minAge !== null) return `Возраст: от ${a.minAge} лет`;
  if (a.maxAge !== null) return `Возраст: до ${a.maxAge} лет`;
  return null;
}

function ageFits(a: ActivityView, p: MyParticipant): boolean {
  // Без даты рождения (гость на месте) возраст не знаем - не ограничиваем.
  if ((a.minAge === null && a.maxAge === null) || !p.birthDate) return true;
  const age = ageOn(p.birthDate, a.startsAt);
  return !((a.minAge !== null && age < a.minAge) || (a.maxAge !== null && age > a.maxAge));
}

// ---------- действия: запись, отмена, перезапись, «пойду» ----------

export function useActivityActions() {
  const me = useMeData();
  const tz = me.event.timezone;
  const family = me.participants.filter((p) => p.status === 'active');
  const [pending, setPending] = useState<Record<string, boolean>>({});

  /** «Вы» для одного человека в аккаунте, имя - когда записываем кого-то из семьи. */
  const who = (p: MyParticipant) => (family.length > 1 ? p.firstName : null);

  const run = async (key: string, fn: () => Promise<void>) => {
    if (pending[key]) return;
    setPending((s) => ({ ...s, [key]: true }));
    try {
      await fn();
    } finally {
      setPending((s) => ({ ...s, [key]: false }));
    }
  };

  const outcomeToast = (outcome: ActivityRegisterOutcome, a: ActivityView, p: MyParticipant) => {
    const name = who(p);
    switch (outcome) {
      case 'registered':
        haptic('success');
        toast.success(name ? `${name}: записали на «${a.title}»` : `Вы записаны на «${a.title}»`);
        break;
      case 'waitlist':
        haptic('warning');
        toast.info(`Мест нет, ${name ? `${name} в очереди` : 'вы в очереди'}. Если место освободится, придёт сообщение`, 5000);
        break;
      case 'already_registered':
        toast.info(name ? `${name} уже записан(а)` : 'Вы уже записаны');
        break;
      case 'already_waitlist':
        toast.info(name ? `${name} уже в очереди` : 'Вы уже в очереди');
        break;
      case 'full':
        haptic('error');
        toast.error('Мест больше нет');
        break;
      case 'closed':
        haptic('error');
        toast.error('Запись уже закрыта');
        break;
      case 'age_restricted':
        haptic('error');
        toast.error(name ? `${name}: не подходит по возрасту` : 'Не подходит по возрасту');
        break;
      case 'time_conflict':
        haptic('warning');
        toast.error('В это время уже есть другая запись');
        break;
      case 'not_open':
        haptic('warning');
        toast.info(signupClosedText(me));
        void refreshMe();
        break;
      case 'not_found':
        haptic('error');
        toast.error('Активность не найдена');
        break;
    }
  };

  /** Пересечение по времени: предлагаем перейти на новую активность одним нажатием. */
  const offerSwitch = async (a: ActivityView, p: MyParticipant, conflict: ActivityConflict) => {
    const name = who(p);
    const time = `${formatTime(conflict.startsAt, tz)}–${formatTime(conflict.endsAt, tz)}`;
    const ok = await confirmAction({
      title: 'Пересечение по времени',
      message: `${name ? `${name} уже записан(а)` : 'Вы уже записаны'} на «${conflict.title}» (${time}). Перейти на «${a.title}»?`,
      ok: 'Перейти',
    });
    if (!ok) return;
    try {
      const res = await participantApi.switchActivity(a.id, p.id, conflict.activityId);
      replaceActivity(res.activity);
      replaceActivity(res.fromActivity);
      switch (res.outcome) {
        case 'registered':
          haptic('success');
          toast.success(`${name ? `${name} теперь` : 'Теперь вы'} на «${a.title}»`);
          break;
        case 'already_registered':
          toast.info(name ? `${name} уже записан(а)` : 'Вы уже записаны');
          break;
        case 'closed':
          haptic('warning');
          toast.info(`Запись на «${a.title}» закрыта. Запись на «${conflict.title}» осталась`, 5000);
          break;
        case 'age_restricted':
          haptic('warning');
          toast.info(`Не подходит по возрасту. Запись на «${conflict.title}» осталась`, 5000);
          break;
        case 'time_conflict':
          haptic('warning');
          toast.info('В это время есть ещё одна запись, ничего не изменили', 5000);
          break;
        case 'not_open':
          haptic('warning');
          toast.info(`${signupClosedText(me)}. Запись на «${conflict.title}» осталась`, 5000);
          void refreshMe();
          break;
        default:
          // full, waitlist и прочее: новой записи нет, старая на месте.
          haptic('warning');
          toast.info(`Мест нет. Запись на «${conflict.title}» осталась`, 5000);
      }
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      void queryClient.invalidateQueries({ queryKey: scheduleQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: SEMINARS_KEY });
    }
  };

  const register = (a: ActivityView, p: MyParticipant) =>
    run(`${a.id}:${p.id}`, async () => {
      const before = a;
      patchActivity(a.id, (x) => {
        const full = x.capacity !== null && x.registeredCount >= x.capacity;
        const status = full ? ('waitlist' as const) : ('registered' as const);
        return {
          ...x,
          my: [...x.my.filter((m) => m.participantId !== p.id), { participantId: p.id, status }],
          registeredCount: x.registeredCount + (full ? 0 : 1),
          waitlistCount: x.waitlistCount + (full ? 1 : 0),
        };
      });
      try {
        const res = await participantApi.registerActivity(a.id, p.id);
        replaceActivity(res.activity);
        if (res.outcome === 'time_conflict' && res.conflict) await offerSwitch(res.activity, p, res.conflict);
        else outcomeToast(res.outcome, a, p);
      } catch (err) {
        patchActivity(a.id, () => before);
        haptic('error');
        toast.error(errorMessage(err));
      }
    });

  const cancel = (a: ActivityView, p: MyParticipant) =>
    run(`${a.id}:${p.id}`, async () => {
      const name = who(p);
      const ok = await confirmAction({
        title: 'Отменить запись?',
        message: `${name ? `${name} больше не будет` : 'Вы больше не будете'} записан${name ? '(а)' : 'ы'} на «${a.title}».`,
        ok: 'Отменить запись',
        destructive: true,
      });
      if (!ok) return;
      const before = a;
      patchActivity(a.id, (x) => {
        const mine = x.my.find((m) => m.participantId === p.id);
        return {
          ...x,
          my: x.my.filter((m) => m.participantId !== p.id),
          registeredCount: x.registeredCount - (mine?.status === 'registered' ? 1 : 0),
          waitlistCount: x.waitlistCount - (mine?.status === 'waitlist' ? 1 : 0),
        };
      });
      try {
        replaceActivity(await participantApi.cancelActivity(a.id, p.id));
        haptic('success');
        toast.info('Запись отменена');
      } catch (err) {
        patchActivity(a.id, () => before);
        haptic('error');
        toast.error(errorMessage(err));
      }
    });

  return {
    family,
    pending,
    register,
    cancel,
    signupOpen: me.features.activitySignup,
    closedNote: signupClosedText(me),
  };
}

export type Actions = ReturnType<typeof useActivityActions>;

function InfoLine({ icon: Icon, children }: { icon: TablerIcon; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2.5">
      <Icon size={19} className="mt-px text-hint" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// ---------- кнопка записи для выбранного человека ----------

export function RegisterButton({
  a,
  person,
  actions,
  now,
  tz,
  solo,
}: {
  a: ActivityView;
  person: MyParticipant | undefined;
  actions: Actions;
  now: number;
  tz: string;
  solo: boolean;
}) {
  // Без записи («просто приходите») - ни кнопки, ни подписи.
  if (a.status === 'cancelled' || a.registrationMode !== 'required') return null;
  if (!person) return null;
  const mine = a.my.find((m) => m.participantId === person.id);
  const busy = Boolean(actions.pending[`${a.id}:${person.id}`]);
  const started = ms(a.startsAt) <= now;
  if (mine) {
    return (
      <Button
        size="sm"
        variant={mine.status === 'registered' ? 'success' : 'outline'}
        loading={busy}
        disabled={started}
        onClick={() => void actions.cancel(a, person)}
      >
        {!busy && (mine.status === 'registered' ? <IconCheck size={18} /> : <IconHourglass size={18} />)}
        {mine.status === 'registered' ? (solo ? 'Вы записаны' : 'Записан(а)') : 'В очереди'}
      </Button>
    );
  }
  // У тем семинаров - свой выключатель блока.
  const win = registrationWindow(a, now, tz, a.block ? a.block.registrationOpen : actions.signupOpen, actions.closedNote);
  if (!win.open) return <span className="text-[13px] text-hint">{win.note}</span>;
  if (!ageFits(a, person)) return <span className="text-[13px] text-hint">Не подходит по возрасту</span>;
  return (
    <Button size="sm" loading={busy} onClick={() => void actions.register(a, person)}>
      {solo ? 'Записаться' : 'Записать'}
    </Button>
  );
}

/** Карточка блока в расписании: «Семинар 1 · выберите тему» или выбранная тема с залом. */
/** Темы одного блока семинаров в расписании показываем одной карточкой блока. */
function seminarBlocks(items: ActivityView[]): [NonNullable<ActivityView['block']>, ActivityView[]][] {
  const map = new Map<number, [NonNullable<ActivityView['block']>, ActivityView[]]>();
  for (const a of items) {
    if (!a.block) continue;
    const entry = map.get(a.block.id) ?? [a.block, []];
    entry[1].push(a);
    map.set(a.block.id, entry);
  }
  return [...map.values()];
}

/** Сколько карточек в группе: блок семинаров - одна. */
const shownCount = (items: ActivityView[]) => items.filter((a) => !a.block).length + seminarBlocks(items).length;

function SeminarBlockCard({
  block,
  topics,
  person,
  tz,
}: {
  block: NonNullable<ActivityView['block']>;
  topics: ActivityView[];
  person: MyParticipant | undefined;
  tz: string;
}) {
  const [, navigate] = useLocation();
  const first = topics[0]!;
  const mine = topics.find((t) => t.my.some((m) => m.participantId === person?.id));
  return (
    <button
      type="button"
      onClick={() => navigate('/seminars')}
      className="flex w-full items-center gap-3 rounded-2xl bg-section p-3.5 text-left active:opacity-80"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-semibold leading-snug">{block.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[14px] text-subtle">
          <span className="inline-flex items-center gap-1">
            <IconClock size={15} />
            {formatTime(first.startsAt, tz)}–{formatTime(first.endsAt, tz)}
          </span>
          <span>
            {topics.length} {plural(topics.length, ['тема', 'темы', 'тем'])}
          </span>
        </span>
        {mine ? (
          <span className="mt-1.5 block text-[14px] font-semibold text-ok-fg">
            {mine.title}
            {mine.location ? ` · ${mine.location}` : ''}
          </span>
        ) : (
          <span className="mt-1.5 block text-[14px] font-semibold text-accent">{block.registrationOpen ? 'Выберите темы' : 'Без семинара в этом потоке'}</span>
        )}
      </span>
      <IconChevronRight size={20} className="shrink-0 text-hint" />
    </button>
  );
}

/** Душепопечение в этот день: общее окно всех служителей и записи семьи. */
function counselingOn(data: CounselingPublic | undefined, day: string | null, tz: string) {
  if (!data || !day) return null;
  const list = data.counselors.filter((c) => dayKey(c.startsAt, tz) === day);
  if (list.length === 0) return null;
  const ids = new Set(list.map((c) => c.id));
  return {
    startsAt: list.reduce((min, c) => (ms(c.startsAt) < ms(min) ? c.startsAt : min), list[0]!.startsAt),
    endsAt: list.reduce((max, c) => (ms(c.endsAt) > ms(max) ? c.endsAt : max), list[0]!.endsAt),
    counselors: list,
    open: data.open,
    my: data.my.filter((m) => ids.has(m.counselorId)),
  };
}

function CounselingCard({
  day,
  person,
  tz,
}: {
  day: NonNullable<ReturnType<typeof counselingOn>>;
  person: MyParticipant | undefined;
  tz: string;
}) {
  const me = useMeData();
  const [, navigate] = useLocation();
  const mine = day.my.find((m) => m.participantId === person?.id);
  const counselor = mine ? day.counselors.find((c) => c.id === mine.counselorId) : undefined;
  return (
    <button
      type="button"
      onClick={() => navigate('/counseling')}
      className="flex w-full items-center gap-3 rounded-2xl bg-section p-3.5 text-left active:opacity-80"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-semibold leading-snug">{counselingTitle(me)}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[14px] text-subtle">
          <span className="inline-flex items-center gap-1">
            <IconClock size={15} />
            {formatTime(day.startsAt, tz)}–{formatTime(day.endsAt, tz)}
          </span>
          <span>
            {day.counselors.length} {plural(day.counselors.length, ['служитель', 'служителя', 'служителей'])}
          </span>
        </span>
        {mine && counselor ? (
          <span className="mt-1.5 block text-[14px] font-semibold text-ok-fg">
            {formatTime(mine.slotStart, tz)} · {counselor.name}
            {counselor.place ? ` · ${counselor.place}` : ''}
          </span>
        ) : (
          <span className="mt-1.5 block text-[14px] font-semibold text-accent">
            {!person ? COUNSELING_UNREGISTERED : day.open ? 'Выберите время' : COUNSELING_CLOSED}
          </span>
        )}
      </span>
      <IconChevronRight size={20} className="shrink-0 text-hint" />
    </button>
  );
}

// ---------- подробности ----------

function ActivitySheet({ activity, onClose, now, actions }: { activity: ActivityView | null; onClose: () => void; now: number; actions: Actions }) {
  const me = useMeData();
  const tz = me.event.timezone;
  if (!activity) return null;
  const a = activity;
  const age = ageText(a);
  const solo = actions.family.length <= 1;

  return (
    <Sheet open onClose={onClose} title={a.title}>
      {a.status === 'cancelled' && (
        <div className="mb-3">
          <Badge tone="red">Отменено</Badge>
        </div>
      )}
      <div className="mb-4 space-y-2 text-[15px]">
        <InfoLine icon={IconClock}>
          {formatDayKey(dayKey(a.startsAt, tz), { weekday: 'long', day: 'numeric', month: 'long' })}, {formatTime(a.startsAt, tz)}–
          {formatTime(a.endsAt, tz)}
        </InfoLine>
        {a.location && <InfoLine icon={IconMapPin}>{a.location}</InfoLine>}
        {a.host && <InfoLine icon={IconMicrophone2}>{a.host}</InfoLine>}
        {age && <InfoLine icon={IconMoodKid}>{age}</InfoLine>}
        {a.registrationMode === 'required' && <InfoLine icon={IconTicket}>{seatsText(a)}</InfoLine>}
      </div>
      {a.description && <p className="mb-4 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-subtle">{a.description}</p>}

      {a.registrationMode === 'required' ? (
        actions.family.length === 0 ? (
          <Notice tone="gray">Записаться можно после регистрации на конференцию.</Notice>
        ) : (
          <div className="rounded-2xl bg-fill px-3 py-1">
            {actions.family.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
                <span className="min-w-0 font-medium leading-snug">{solo ? 'Вы' : p.fullName}</span>
                <RegisterButton a={a} person={p} actions={actions} now={now} tz={tz} solo={solo} />
              </div>
            ))}
          </div>
        )
      ) : null}
    </Sheet>
  );
}

// ---------- экран ----------

export default function Schedule() {
  const me = useMeData();
  const tz = me.event.timezone;
  const q = useQuery({ ...scheduleQuery, refetchInterval: usePollInterval(60_000) });
  // Запись открывают и закрывают на ходу - пока расписание открыто, сверяем и «me» (флаги записи).
  useQuery({ ...meQuery, refetchInterval: usePollInterval(30_000) });
  const now = useNow(30_000);
  const actions = useActivityActions();
  const family = actions.family;
  const solo = family.length <= 1;
  const [day, setDay] = useState<string | null>(() => session.get('sof:schedule-day'));
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const [personId, setPersonId] = useState<number | null>(() => Number(session.get(PERSON_KEY)) || null);
  const person = family.find((p) => p.id === personId) ?? family[0];

  const activities = useMemo(() => q.data ?? [], [q.data]);
  // Душепопечение - отдельной карточкой в своё время. Расписание скрыто (пусто) - и его не показываем.
  const counseling = useQuery({ queryKey: COUNSELING_KEY, queryFn: () => participantApi.counseling(), staleTime: 60_000 });
  const days = useMemo(() => {
    const counselingDays = activities.length ? (counseling.data?.counselors ?? []).map((c) => dayKey(c.startsAt, tz)) : [];
    return [...new Set([...activities.map((a) => dayKey(a.startsAt, tz)), ...counselingDays])].sort();
  }, [activities, counseling.data, tz]);
  const today = dayKey(new Date(now), tz);
  const selectedDay = day && days.includes(day) ? day : days.includes(today) ? today : (days[0] ?? null);
  // Отбор «чьи записи»: кнопка на каждого человека, у кого есть хоть одна запись (мероприятие, тема семинара,
  // душепопечение). «Моё» - для самого себя или если в аккаунте один человек; у остальных - имя.
  const myCounseling = activities.length ? (counseling.data?.my ?? []) : [];
  const owners = family
    .map((p) => ({
      id: p.id,
      label: solo || p.relation === 'self' ? 'Моё' : p.firstName,
      count: activities.filter((a) => isFor(a, p.id)).length + myCounseling.filter((m) => m.participantId === p.id).length,
    }))
    .filter((o) => o.count > 0);
  // Выбранный человек отменил последнюю запись - снова всё расписание.
  const activeFilter: Filter = filter !== 'all' && owners.some((o) => o.id === filter) ? filter : 'all';
  const counselingDay = activities.length ? counselingOn(counseling.data, selectedDay, tz) : null;
  const showCounseling =
    counselingDay !== null && (activeFilter === 'all' || counselingDay.my.some((m) => m.participantId === activeFilter));

  const visible = activities
    .filter((a) => dayKey(a.startsAt, tz) === selectedDay)
    .filter((a) => (activeFilter === 'all' ? true : isFor(a, activeFilter)))
    .sort((x, y) => ms(x.startsAt) - ms(y.startsAt) || x.title.localeCompare(y.title, 'ru'));

  // Группы по времени начала: параллельные активности видны сразу; душепопечение - в группе своего начала.
  const groups = (() => {
    const map = new Map<string, { at: number; items: ActivityView[]; counseling: boolean }>();
    const group = (iso: string) => {
      const key = formatTime(iso, tz);
      const g = map.get(key) ?? { at: ms(iso), items: [], counseling: false };
      map.set(key, g);
      return g;
    };
    for (const a of visible) group(a.startsAt).items.push(a);
    if (showCounseling) group(counselingDay.startsAt).counseling = true;
    return [...map.entries()].sort((x, y) => x[1].at - y[1].at);
  })();

  const live = activities.filter((a) => a.status !== 'cancelled');
  const nextStart = live.filter((a) => ms(a.startsAt) > now).reduce((min, a) => Math.min(min, ms(a.startsAt)), Number.POSITIVE_INFINITY);
  const openActivity = openId !== null ? (activities.find((a) => a.id === openId) ?? null) : null;

  const chooseDay = (d: string) => {
    setDay(d);
    session.set('sof:schedule-day', d);
  };
  const choosePerson = (id: number) => {
    setPersonId(id);
    session.set(PERSON_KEY, String(id));
  };

  if (!q.data) {
    return (
      <Page title="Расписание" back="/">
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

  return (
    <Page title="Расписание" back="/">
      {days.length === 0 ? (
        <EmptyState icon={IconCalendarEvent} hue="violet" title="Программа скоро будет">
          Программу опубликуем позже.
        </EmptyState>
      ) : (
        <>
          <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
            {days.map((d) => (
              <Chip key={d} active={d === selectedDay} onClick={() => chooseDay(d)}>
                {formatDayKey(d).replace(/^./, (c) => c.toUpperCase())}
                {d === today ? ' · сегодня' : ''}
              </Chip>
            ))}
          </div>
          {/* Пока ни у кого нет записей, отбирать нечего - кнопок нет, видно всё расписание. */}
          {owners.length > 0 && (
            <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
              <Chip active={activeFilter === 'all'} onClick={() => setFilter('all')}>
                Всё расписание
              </Chip>
              {owners.map((o) => (
                <Chip key={o.id} active={activeFilter === o.id} onClick={() => setFilter(o.id)}>
                  <span className="inline-flex items-center gap-1">
                    <IconStar size={16} />
                    {o.label} ({o.count})
                  </span>
                </Chip>
              ))}
            </div>
          )}

          {!solo && person && (
            <div className="mb-4 rounded-2xl bg-section px-3 py-2.5">
              <p className="mb-2 text-[13px] text-subtle">Кого записываем:</p>
              <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1">
                {family.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => choosePerson(p.id)}
                    className={cx(
                      'min-h-10 shrink-0 rounded-full px-4 text-[15px] font-semibold transition',
                      p.id === person.id ? 'bg-btn text-btn-fg' : 'bg-fill text-fg',
                    )}
                  >
                    {p.firstName}
                  </button>
                ))}
              </div>
            </div>
          )}

          {groups.length === 0 ? (
            <EmptyState
              icon={activeFilter === 'all' ? IconCalendarOff : IconStar}
              hue={activeFilter === 'all' ? 'gray' : 'orange'}
              title={activeFilter === 'all' ? 'В этот день ничего нет' : 'В этот день записей нет'}
            >
              {activeFilter === 'all' ? 'Выберите другой день.' : 'Выберите другой день или «Всё расписание».'}
            </EmptyState>
          ) : (
            groups.map(([time, { items, counseling: withCounseling }]) => {
              const isNow = items.some((a) => a.status !== 'cancelled' && ms(a.startsAt) <= now && now < ms(a.endsAt));
              const isNext = items.some((a) => ms(a.startsAt) === nextStart);
              const count = shownCount(items) + (withCounseling ? 1 : 0);
              return (
                <section key={time} className="mb-5">
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <h2 className="text-lg font-bold">
                      {time}
                      {count > 1 && (
                        <span className="font-semibold text-subtle">
                          {' '}
                          · {count} {plural(count, ['активность', 'активности', 'активностей'])}
                        </span>
                      )}
                    </h2>
                    {isNow && <Badge tone="green">Сейчас</Badge>}
                    {!isNow && isNext && <Badge tone="blue">Далее</Badge>}
                  </div>
                  <div className="space-y-2">
                    {withCounseling && counselingDay && <CounselingCard day={counselingDay} person={person} tz={tz} />}
                    {seminarBlocks(items).map(([block, topics]) => (
                      <SeminarBlockCard key={`block-${block.id}`} block={block} topics={topics} person={person} tz={tz} />
                    ))}
                    {items.filter((a) => !a.block).map((a) => {
                      const cancelled = a.status === 'cancelled';
                      const past = ms(a.endsAt) <= now;
                      const others = solo ? [] : a.my.filter((m) => m.participantId !== person?.id);
                      return (
                        <div
                          key={a.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setOpenId(a.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setOpenId(a.id);
                          }}
                          className={cx('cursor-pointer rounded-2xl bg-section p-3.5 active:opacity-80', past && 'opacity-60')}
                        >
                          <p className={cx('text-[17px] font-semibold leading-snug', cancelled && 'text-hint line-through')}>{a.title}</p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[14px] text-subtle">
                            <span className="inline-flex items-center gap-1">
                              <IconClock size={15} />
                              {formatTime(a.startsAt, tz)}–{formatTime(a.endsAt, tz)}
                            </span>
                            {a.location && (
                              <span className="inline-flex min-w-0 items-center gap-1">
                                <IconMapPin size={15} />
                                {a.location}
                              </span>
                            )}
                          </p>
                          {others.length > 0 && (
                            <p className="mt-1 flex items-center gap-1 text-[13px] text-ok-fg">
                              <IconCheck size={14} />
                              {others
                                .map((m) => family.find((p) => p.id === m.participantId)?.firstName)
                                .filter(Boolean)
                                .join(', ')}
                            </p>
                          )}
                          {/* Мероприятие без записи - только название, время и место: ни «свободного входа», ни кнопки. */}
                          {(cancelled || a.registrationMode === 'required') && (
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <span className={cx('text-[13px]', cancelled ? 'text-bad-fg' : 'text-hint')}>
                                {cancelled ? 'Отменено' : seatsText(a)}
                              </span>
                              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
                                <RegisterButton a={a} person={person} actions={actions} now={now} tz={tz} solo={solo} />
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
          {q.isError && (
            <Notice tone="yellow" className="mt-4">
              Не получилось обновить. Показываем сохранённое расписание.
            </Notice>
          )}
        </>
      )}

      <ActivitySheet activity={openActivity} onClose={() => setOpenId(null)} now={now} actions={actions} />
    </Page>
  );
}
