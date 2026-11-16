/**
 * Создание и правка активности - без системных всплывающих календарей:
 * день - чипсами из дат конференции, время - маской ЧЧ:ММ, длительность - чипсами.
 * Всё время понимается в часовом поясе конференции и уходит на сервер в ISO со смещением.
 */
import {
  activityInputSchema,
  activityKindLabel,
  activityKindOptions,
  type ActivityInput,
  type ActivityKind,
  type ActivityStatus,
  type ActivityUpdate,
  type ActivityView,
  type RegistrationMode,
} from '@sof/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { IconClock } from '@tabler/icons-react';
import { errorMessage } from '../api/client.ts';
import { meQuery } from '../api/queries.ts';
import { useEnv } from '../app/env.ts';
import { haptic } from '../lib/feedback.ts';
import {
  formatMinutes,
  maskDayMonth,
  maskDayMonthTime,
  maskTime,
  parseDayMonth,
  parseDayMonthTime,
  parseTime,
} from '../lib/masks.ts';
import { dayKey, formatDayKey, isoToZonedLocal, zonedLocalToIso } from '../lib/time.ts';
import { confirmAction } from '../telegram/actions.ts';
import { useMainButton } from '../telegram/main-button.ts';
import { Button, Card, Checkbox, Chip, cx, Field, FullScreenLoader, Notice, Segmented, TextArea, TextInput } from '../ui/kit.tsx';
import { Page, StickyFooter } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { ACTIVITY_STATUS_LABELS as STATUS_LABELS, staffActivitiesQuery, useEventTimezone } from './common.ts';

type Duration = 30 | 60 | 90 | 120 | 'other';
const DURATIONS: { value: Duration; label: string }[] = [
  { value: 30, label: '30 мин' },
  { value: 60, label: '1 ч' },
  { value: 90, label: '1,5 ч' },
  { value: 120, label: '2 ч' },
  { value: 'other', label: 'другое' },
];
const DAY_MIN = 24 * 60;

interface FormState {
  /** Выбранный день `YYYY-MM-DD` из чипсов; пусто - вводится вручную. */
  day: string;
  customDay: string;
  start: string;
  duration: Duration;
  end: string;
  title: string;
  location: string;
  host: string;
  description: string;
  registrationMode: RegistrationMode;
  capacity: string;
  kind: ActivityKind;
  minAge: string;
  maxAge: string;
  opens: string;
  closes: string;
  waitlistEnabled: boolean;
  status: ActivityStatus;
}

type FormKey = keyof FormState;
type Errors = Partial<Record<FormKey, string>>;
const ADVANCED: FormKey[] = ['kind', 'minAge', 'maxAge', 'opens', 'closes', 'waitlistEnabled', 'status'];

const pad = (n: number) => String(n).padStart(2, '0');

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Дни конференции (в поясе события), не больше двух недель. */
function eventDays(startsAt: string | null | undefined, endsAt: string | null | undefined, tz: string): string[] {
  if (!startsAt) return [];
  const first = dayKey(startsAt, tz);
  const last = endsAt ? dayKey(endsAt, tz) : first;
  const days: string[] = [];
  for (let d = first; d <= last && days.length < 14; d = addDays(d, 1)) days.push(d);
  return days;
}

/** `YYYY-MM-DDTHH:mm` → «ДД.ММ ЧЧ:ММ». */
function localToDayMonthTime(local: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  return m ? `${m[2]}.${m[1]} ${m[3]}:${m[4]}` : '';
}

function initialState(a: ActivityView | undefined, tz: string, days: string[]): FormState {
  const start = isoToZonedLocal(a?.startsAt, tz);
  const end = isoToZonedLocal(a?.endsAt, tz);
  const day = start.slice(0, 10);
  const length = a ? Math.round((new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60_000) : 60;
  const preset = DURATIONS.find((d) => d.value === length)?.value;
  return {
    day: a ? (days.includes(day) ? day : '') : days.length === 1 ? days[0]! : '',
    customDay: a && !days.includes(day) ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : '',
    start: start ? start.slice(11, 16) : '',
    duration: preset ?? 'other',
    end: a && !preset ? end.slice(11, 16) : '',
    title: a?.title ?? '',
    location: a?.location ?? '',
    host: a?.host ?? '',
    description: a?.description ?? '',
    registrationMode: a?.registrationMode ?? 'none',
    capacity: a?.capacity != null ? String(a.capacity) : '',
    kind: a ? activityKindLabel(a.kind) : 'Семинар',
    minAge: a?.minAge != null ? String(a.minAge) : '',
    maxAge: a?.maxAge != null ? String(a.maxAge) : '',
    opens: localToDayMonthTime(isoToZonedLocal(a?.registrationOpensAt, tz)),
    closes: localToDayMonthTime(isoToZonedLocal(a?.registrationClosesAt, tz)),
    waitlistEnabled: a?.waitlistEnabled ?? true,
    status: a?.status ?? 'published',
  };
}

function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} ч ${m} мин`;
  return h ? `${h} ч` : `${m} мин`;
}

interface Timing {
  date: string | null;
  startMin: number | null;
  endMin: number | null;
  errors: Errors;
}

/** День + начало + длительность/конец → минуты от начала выбранного дня (конец может уйти за полночь). */
function computeTiming(f: FormState, year: number): Timing {
  const errors: Errors = {};
  let date: string | null = f.day || null;
  if (!date) {
    if (!f.customDay) errors.customDay = 'Выберите день';
    else {
      const r = parseDayMonth(f.customDay, year);
      if ('error' in r) errors.customDay = r.error;
      else date = r.date;
    }
  }
  let startMin: number | null = null;
  if (!f.start) errors.start = 'Во сколько начало?';
  else {
    const r = parseTime(f.start);
    if ('error' in r) errors.start = r.error;
    else startMin = r.minutes;
  }
  let endMin: number | null = null;
  if (startMin !== null) {
    if (f.duration !== 'other') endMin = startMin + f.duration;
    else if (!f.end) errors.end = 'Во сколько конец?';
    else {
      const r = parseTime(f.end);
      if ('error' in r) errors.end = r.error;
      else endMin = r.minutes > startMin ? r.minutes : r.minutes + DAY_MIN;
    }
  }
  return { date, startMin, endMin, errors };
}

const num = (v: string) => (v.trim() === '' ? null : Number(v.trim()));
const text = (v: string) => (v.trim() === '' ? null : v.trim());

const FIELD_MESSAGES: Partial<Record<FormKey, string>> = {
  title: 'Как называется? (до 120 символов)',
  capacity: 'Целое число больше нуля',
  minAge: 'Возраст - целое число от 0 до 120',
  maxAge: 'Возраст - целое число от 0 до 120',
  description: 'Слишком длинное описание',
  location: 'Слишком длинно',
  host: 'Слишком длинно',
  kind: 'Укажите тип (до 40 символов)',
};

/** Ключи схемы → поля формы. */
const SCHEMA_TO_FORM: Partial<Record<keyof ActivityInput, FormKey>> = {
  registrationOpensAt: 'opens',
  registrationClosesAt: 'closes',
};

function ActivityFormInner({ existing, tz, days, year }: { existing?: ActivityView; tz: string; days: string[]; year: number }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initialState(existing, tz, days));
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Типы: основные + уже использованные в других мероприятиях; «Свой…» - ввести новый.
  const all = useQuery(staffActivitiesQuery);
  const kindOptions = useMemo(() => activityKindOptions((all.data ?? []).map((a) => a.kind)), [all.data]);
  const [customKind, setCustomKind] = useState(() => !kindOptions.includes(form.kind));
  // «Другой день» выбран вручную (или день активности не попадает в дни конференции); без дат конференции - всегда поле.
  const [customDayChosen, setCustomDayOpen] = useState(() => Boolean(existing) && !form.day);
  const customDayOpen = days.length === 0 || customDayChosen;

  const set = <K extends FormKey>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const timing = computeTiming(form, year);
  const summary =
    timing.date && timing.startMin !== null && timing.endMin !== null
      ? `${formatDayKey(timing.date, { weekday: 'long', day: 'numeric', month: 'long' })}, ${formatMinutes(timing.startMin)}–${formatMinutes(timing.endMin)}${
          timing.endMin >= DAY_MIN ? ' (следующего дня)' : ''
        } · ${durationLabel(timing.endMin - timing.startMin)}`
      : null;

  const save = async () => {
    if (saving) return;
    const t = computeTiming(form, year);
    const nextErrors: Errors = { ...t.errors };
    const iso = (date: string | null, minutes: number | null) => {
      if (!date || minutes === null) return null;
      const d = addDays(date, Math.floor(minutes / DAY_MIN));
      return zonedLocalToIso(`${d}T${formatMinutes(minutes)}`, tz);
    };
    const required = form.registrationMode === 'required';
    const windowIso = (key: 'opens' | 'closes') => {
      if (!required || !form[key]) return null;
      const r = parseDayMonthTime(form[key], year);
      if ('error' in r) {
        nextErrors[key] = r.error;
        return null;
      }
      return zonedLocalToIso(r.local, tz);
    };
    const input = {
      title: form.title,
      description: text(form.description),
      location: text(form.location),
      host: text(form.host),
      kind: form.kind,
      startsAt: iso(t.date, t.startMin),
      endsAt: iso(t.date, t.endMin),
      registrationMode: form.registrationMode,
      capacity: required ? num(form.capacity) : null,
      waitlistEnabled: form.waitlistEnabled,
      registrationOpensAt: windowIso('opens'),
      registrationClosesAt: windowIso('closes'),
      minAge: num(form.minAge),
      maxAge: num(form.maxAge),
      status: form.status,
    };
    const parsed = activityInputSchema.safeParse(input);
    if (!parsed.success) {
      const timingBroken = Object.keys(t.errors).length > 0;
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof ActivityInput | undefined;
        if (!key) continue;
        if (key === 'startsAt' || key === 'endsAt') {
          if (!timingBroken) nextErrors.start ??= 'Проверьте время';
          continue;
        }
        const field = SCHEMA_TO_FORM[key] ?? (key as FormKey);
        if (!nextErrors[field]) nextErrors[field] = FIELD_MESSAGES[field] ?? 'Проверьте поле';
      }
    } else {
      const v = parsed.data;
      if (v.minAge != null && v.maxAge != null && v.minAge > v.maxAge) nextErrors.maxAge = 'Меньше, чем «от»';
      if (v.registrationOpensAt && v.registrationClosesAt && new Date(v.registrationClosesAt) <= new Date(v.registrationOpensAt))
        nextErrors.closes = 'Закрывается раньше, чем открывается';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !parsed.success) {
      if (ADVANCED.some((k) => nextErrors[k])) setAdvanced(true);
      haptic('error');
      return;
    }
    const body: ActivityInput = parsed.data;
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        const patch = changedFields(existing, body);
        if (Object.keys(patch).length > 0) await staffApi.updateActivity(existing.id, patch);
      } else await staffApi.createActivity(body);
      await qc.invalidateQueries({ queryKey: staffActivitiesQuery.queryKey });
      void qc.invalidateQueries({ queryKey: ['schedule'] });
      haptic('success');
      toast.success(existing ? 'Сохранено' : 'Активность создана');
      navigate('/activities');
    } catch (err) {
      haptic('error');
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing || deleting) return;
    const people = existing.registeredCount + existing.waitlistCount;
    const ok = await confirmAction({
      title: 'Удалить мероприятие?',
      message: `«${existing.title}» исчезнет из программы.${people ? ` Записалось ${people} - им придёт сообщение.` : ''}`,
      ok: 'Удалить',
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await staffApi.deleteActivity(existing.id);
      await qc.invalidateQueries({ queryKey: staffActivitiesQuery.queryKey });
      void qc.invalidateQueries({ queryKey: ['schedule'] });
      haptic('success');
      toast.success('Мероприятие удалено');
      navigate('/activities');
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const native = useMainButton({ text: existing ? 'Сохранить' : 'Создать активность', loading: saving, onClick: save });
  const deviceTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return tz;
    }
  }, [tz]);
  const advancedFilled =
    form.kind !== 'Семинар' || form.minAge || form.maxAge || form.opens || form.closes || !form.waitlistEnabled || form.status !== 'published';

  return (
    <Page title={existing ? 'Изменить активность' : 'Новая активность'} back="/activities" bottomInset={!native}>
      {/* Когда */}
      <Card className="mb-4">
        <Field label="День" htmlFor={customDayOpen ? 'a-day' : undefined} error={errors.customDay}>
          {days.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {days.map((d) => (
                <Chip
                  key={d}
                  active={form.day === d}
                  onClick={() => {
                    set('day', d);
                    set('customDay', '');
                    setCustomDayOpen(false);
                  }}
                >
                  {formatDayKey(d).replace(/^./, (c) => c.toUpperCase())}
                </Chip>
              ))}
              <Chip
                active={customDayOpen}
                onClick={() => {
                  set('day', '');
                  setCustomDayOpen(true);
                }}
              >
                Другой день
              </Chip>
            </div>
          )}
          {customDayOpen && (
            <TextInput
              id="a-day"
              inputMode="numeric"
              placeholder="ДД.ММ"
              autoComplete="off"
              className={cx('max-w-40', days.length > 0 && 'mt-2')}
              value={form.customDay}
              invalid={Boolean(errors.customDay)}
              onChange={(e) => set('customDay', maskDayMonth(e.target.value, form.customDay))}
            />
          )}
        </Field>
        <Field label="Начало" htmlFor="a-start" error={errors.start}>
          <TextInput
            id="a-start"
            inputMode="numeric"
            placeholder="ЧЧ:ММ"
            autoComplete="off"
            className="max-w-40"
            value={form.start}
            invalid={Boolean(errors.start)}
            onChange={(e) => set('start', maskTime(e.target.value, form.start))}
          />
        </Field>
        <Field label="Длительность">
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <Chip key={d.value} active={form.duration === d.value} onClick={() => set('duration', d.value)}>
                {d.label}
              </Chip>
            ))}
          </div>
        </Field>
        {form.duration === 'other' && (
          <Field label="Конец" htmlFor="a-end" error={errors.end}>
            <TextInput
              id="a-end"
              inputMode="numeric"
              placeholder="ЧЧ:ММ"
              autoComplete="off"
              className="max-w-40"
              value={form.end}
              invalid={Boolean(errors.end)}
              onChange={(e) => set('end', maskTime(e.target.value, form.end))}
            />
          </Field>
        )}
        {summary && (
          <p className="flex items-start gap-1.5 px-1 text-[14px] font-medium text-accent">
            <IconClock size={17} className="mt-px" />
            {summary.replace(/^./, (c) => c.toUpperCase())}
          </p>
        )}
        {deviceTz !== tz && <p className="mt-1 px-1 text-[13px] text-hint">Время - по часовому поясу конференции ({tz}).</p>}
      </Card>

      {/* Что и где */}
      <Card className="mb-4">
        <Field label="Название" htmlFor="a-title" error={errors.title}>
          <TextInput
            id="a-title"
            value={form.title}
            maxLength={120}
            invalid={Boolean(errors.title)}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
        <Field label="Место" optional htmlFor="a-loc" error={errors.location}>
          <TextInput id="a-loc" value={form.location} maxLength={120} placeholder="Например, малый зал" onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label="Ведущий" optional htmlFor="a-host" error={errors.host}>
          <TextInput id="a-host" value={form.host} maxLength={120} onChange={(e) => set('host', e.target.value)} />
        </Field>
        <Field label="Описание" optional htmlFor="a-desc" error={errors.description}>
          <TextArea id="a-desc" rows={3} value={form.description} maxLength={4000} onChange={(e) => set('description', e.target.value)} />
        </Field>
      </Card>

      {/* Запись */}
      <Card className="mb-4">
        <Segmented
          value={form.registrationMode}
          onChange={(v) => set('registrationMode', v)}
          options={[
            { value: 'none', label: 'Свободный вход' },
            { value: 'required', label: 'По записи' },
          ]}
        />
        {form.registrationMode === 'required' && (
          <div className="mt-3">
            <Field label="Мест" optional hint="Пусто - без ограничения" htmlFor="a-cap" error={errors.capacity}>
              <TextInput
                id="a-cap"
                inputMode="numeric"
                className="max-w-40"
                value={form.capacity}
                invalid={Boolean(errors.capacity)}
                onChange={(e) => set('capacity', e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </Field>
          </div>
        )}
      </Card>

      {/* Дополнительно */}
      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="mb-3 flex min-h-12 w-full items-center justify-between rounded-2xl bg-section px-4 text-left font-semibold active:opacity-80"
        aria-expanded={advanced}
      >
        <span>
          Дополнительно
          {!advanced && advancedFilled && <span className="font-normal text-hint"> · есть настройки</span>}
        </span>
        <span className={cx('text-hint transition-transform', advanced && 'rotate-90')}>›</span>
      </button>
      {advanced && (
        <Card className="mb-4">
          <Field label="Тип" error={errors.kind}>
            <div className="flex flex-wrap gap-2">
              {kindOptions.map((k) => (
                <Chip
                  key={k}
                  active={!customKind && form.kind === k}
                  onClick={() => {
                    setCustomKind(false);
                    set('kind', k);
                  }}
                >
                  {k}
                </Chip>
              ))}
              <Chip
                active={customKind}
                onClick={() => {
                  setCustomKind(true);
                  set('kind', '');
                }}
              >
                Свой…
              </Chip>
            </div>
            {customKind && (
              <TextInput
                className="mt-2"
                value={form.kind}
                placeholder="Например, «Молитва»"
                maxLength={40}
                invalid={Boolean(errors.kind)}
                onChange={(e) => set('kind', e.target.value)}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Возраст от" optional htmlFor="a-min" error={errors.minAge}>
              <TextInput
                id="a-min"
                inputMode="numeric"
                value={form.minAge}
                invalid={Boolean(errors.minAge)}
                onChange={(e) => set('minAge', e.target.value.replace(/\D/g, '').slice(0, 3))}
              />
            </Field>
            <Field label="Возраст до" optional htmlFor="a-max" error={errors.maxAge}>
              <TextInput
                id="a-max"
                inputMode="numeric"
                value={form.maxAge}
                invalid={Boolean(errors.maxAge)}
                onChange={(e) => set('maxAge', e.target.value.replace(/\D/g, '').slice(0, 3))}
              />
            </Field>
          </div>
          {form.registrationMode === 'required' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Запись с" optional htmlFor="a-ro" error={errors.opens}>
                  <TextInput
                    id="a-ro"
                    inputMode="numeric"
                    placeholder="ДД.ММ ЧЧ:ММ"
                    autoComplete="off"
                    value={form.opens}
                    invalid={Boolean(errors.opens)}
                    onChange={(e) => set('opens', maskDayMonthTime(e.target.value, form.opens))}
                  />
                </Field>
                <Field label="Запись до" optional htmlFor="a-rc" error={errors.closes}>
                  <TextInput
                    id="a-rc"
                    inputMode="numeric"
                    placeholder="ДД.ММ ЧЧ:ММ"
                    autoComplete="off"
                    value={form.closes}
                    invalid={Boolean(errors.closes)}
                    onChange={(e) => set('closes', maskDayMonthTime(e.target.value, form.closes))}
                  />
                </Field>
              </div>
              <Checkbox checked={form.waitlistEnabled} onChange={(v) => set('waitlistEnabled', v)}>
                Лист ожидания, когда места закончатся
              </Checkbox>
            </>
          )}
          {existing ? (
            <Field label="Статус">
              <Segmented
                value={form.status}
                onChange={(v) => set('status', v)}
                options={(['draft', 'published', 'cancelled'] as const).map((s) => ({ value: s, label: STATUS_LABELS[s].text }))}
              />
            </Field>
          ) : (
            <Checkbox checked={form.status !== 'draft'} onChange={(v) => set('status', v ? 'published' : 'draft')}>
              Показывать участникам
            </Checkbox>
          )}
          <p className="mt-1 px-1 text-[13px] text-hint">При переносе или отмене записавшимся придёт сообщение от бота.</p>
        </Card>
      )}

      {error && (
        <Notice tone="red" className="mb-3">
          {error}
        </Notice>
      )}
      {existing && (
        <Button variant="plain" block className="mb-4 text-danger" loading={deleting} onClick={() => void remove()}>
          Удалить мероприятие
        </Button>
      )}
      {!native && (
        <StickyFooter>
          <Button size="lg" block loading={saving} onClick={() => void save()}>
            {existing ? 'Сохранить' : 'Создать активность'}
          </Button>
        </StickyFooter>
      )}
    </Page>
  );
}

/**
 * Только изменённые поля. Форма могла долго быть открытой: если отправить её целиком, она откатила бы
 * чужие правки за это время (отмену мероприятия, перенос) и ушли бы ложные сообщения участникам.
 */
function changedFields(a: ActivityView, body: ActivityInput): ActivityUpdate {
  const norm = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).getTime() : (v ?? null));
  const before = a as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(body).filter(([k, v]) => norm(v) !== norm(before[k]))) as ActivityUpdate;
}

export default function ActivityForm({ id }: { id?: number }) {
  const env = useEnv();
  const tz = useEventTimezone();
  const q = useQuery({ ...staffActivitiesQuery, enabled: id !== undefined });
  const me = useQuery({ ...meQuery, enabled: env.mode === 'telegram' });
  const event = me.data?.event;
  const days = useMemo(() => eventDays(event?.startsAt, event?.endsAt, tz), [event?.startsAt, event?.endsAt, tz]);

  if (env.mode === 'telegram' && me.isPending) return <FullScreenLoader />;
  const existing = id !== undefined ? q.data?.find((a) => a.id === id) : undefined;
  const year = Number((existing?.startsAt ? dayKey(existing.startsAt, tz) : (days[0] ?? dayKey(new Date(), tz))).slice(0, 4));

  if (id === undefined) return <ActivityFormInner tz={tz} days={days} year={year} />;
  if (q.isPending) return <FullScreenLoader />;
  if (!existing) {
    return (
      <Page title="Активность не найдена" back="/activities">
        <p className="text-subtle">{q.isError ? errorMessage(q.error) : 'Возможно, у вас нет прав на эту активность.'}</p>
      </Page>
    );
  }
  return <ActivityFormInner key={existing.id} existing={existing} tz={tz} days={days} year={year} />;
}
