import { formatRub, type PaymentStatus, type StaffOverview } from '@sof/shared';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client.ts';
import { haptic } from '../lib/feedback.ts';
import { dayKey, formatDayKey, formatTime, plural } from '../lib/time.ts';
import { openExternal } from '../telegram/actions.ts';
import { Button, cx, ErrorState, Spinner } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { useStaff } from './session.ts';

const nf = new Intl.NumberFormat('ru-RU');
const num = (n: number) => nf.format(n);
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-section p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-subtle">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Big({ value, unit, note }: { value: ReactNode; unit?: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-display text-[34px] font-semibold leading-none">{value}</span>
      {unit && <span className="text-[16px] font-semibold text-subtle">{unit}</span>}
      {note && <span className="ml-auto text-[14px] font-semibold">{note}</span>}
    </div>
  );
}

function Progress({ value, total, color }: { value: number; total: number; color?: string }) {
  const w = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-fill">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: color ?? 'var(--color-ok)' }} />
    </div>
  );
}

/** Столбики без библиотеки: высота - от максимума, последний (сейчас) ярче. */
function Bars({ values, labels }: { values: number[]; labels: [string, string] }) {
  const max = Math.max(1, ...values);
  return (
    <div>
      <div className="flex h-16 items-end gap-[3px]" aria-hidden>
        {values.map((v, i) => (
          <div
            key={i}
            className={cx('flex-1 rounded-t-[3px] bg-btn', i === values.length - 1 ? 'opacity-100' : 'opacity-45')}
            style={{ height: v > 0 ? `${Math.max(6, (v / max) * 100)}%` : '2px' }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[12px] text-hint">
        <span>{labels[0]}</span>
        <span>{labels[1]}</span>
      </div>
    </div>
  );
}

function Row({ label, value, sub, danger }: { label: ReactNode; value: ReactNode; sub?: ReactNode; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <span className="min-w-0 leading-snug">
        {label}
        {sub && <span className="block text-[13px] text-subtle">{sub}</span>}
      </span>
      <span className={cx('shrink-0 font-semibold tabular-nums', danger && 'text-bad-fg')}>{value}</span>
    </div>
  );
}

/** Короткие подписи - в две колонки на узком экране. */
const METHOD_LABEL = { cash: 'Наличными', transfer: 'Переводом', card: 'Картой' } as const;
const PAY_ORDER: { status: PaymentStatus; label: string; color: string }[] = [
  { status: 'paid', label: 'Оплатили', color: 'var(--color-ok)' },
  { status: 'partial', label: 'Частично', color: 'var(--color-warn)' },
  { status: 'unpaid', label: 'Не оплатили', color: 'var(--color-bad)' },
  { status: 'exempt', label: 'Без взноса', color: 'var(--color-hint)' },
];

function Attention({ a, onAdmin, busy }: { a: StaffOverview['attention']; onAdmin: () => void; busy: boolean }) {
  const items = [
    { n: a.openQuestions, label: 'Непрочитанных переписок' },
    { n: a.pendingReceipts, label: 'Чеков ждут проверки' },
    { n: a.duplicates, label: 'Возможных дублей' },
  ].filter((x) => x.n > 0);
  if (items.length === 0) return null;
  return (
    <section className="rounded-2xl bg-section p-4 ring-2 ring-[var(--color-warn)]">
      <h2 className="mb-2 flex items-center gap-1.5 font-display text-[13px] font-semibold uppercase tracking-wider text-warn-fg">
        <IconAlertTriangle size={16} /> Требует внимания
      </h2>
      {items.map((x) => (
        <Row key={x.label} label={x.label} value={num(x.n)} />
      ))}
      <Button size="sm" variant="secondary" className="mt-3" loading={busy} onClick={onAdmin}>
        Разобрать в админке
      </Button>
    </section>
  );
}

function Arrival({ s, tz }: { s: StaffOverview['arrival']; tz: string }) {
  const lastHours = s.flow.reduce((sum, b) => sum + b.n, 0);
  // Пришли на конференцию - отметили на входе хоть раз: браслет выдают один раз, на 2-й день людей не сканируют.
  const value = s.arrived;
  return (
    <Card
      title="Пришли на конференцию"
      aside={<span className="text-[14px] font-semibold text-ok-fg">{pct(value, s.expected)}%</span>}
    >
      <Big value={num(value)} unit={`из ${num(s.expected)}`} />
      <div className="mt-3">
        <Progress value={value} total={s.expected} />
      </div>
      {s.eventDay && s.today > 0 && <p className="mt-2 text-[14px] text-subtle">Сегодня отсканировали: {num(s.today)}</p>}
      <p className="mt-4 mb-2 text-[14px] text-subtle">
        Вход за 3 часа: {num(lastHours)} {plural(lastHours, ['отметка', 'отметки', 'отметок'])}
      </p>
      <Bars values={s.flow.map((b) => b.n)} labels={[formatTime(s.flow[0]!.t, tz), 'сейчас']} />
      {s.scanners.length > 0 && (
        <p className="mt-3 text-[14px] leading-snug text-subtle">
          За сутки отметили: {s.scanners.map((x) => `${x.name} ${num(x.count)}`).join(' · ')}
        </p>
      )}
    </Card>
  );
}

/** Цвет завтрака на полоске - охра, как у прежнего варианта «с завтраком». */
const BREAKFAST_COLOR = '#a8701a';

/** Строка «сколько из скольки» с полоской и остатком - у вариантов и у завтрака. */
function LimitRow({ label, color, total, limit }: { label: string; color: string | null; total: number; limit: number | null }) {
  const left = limit !== null ? limit - total : null;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: color ?? 'var(--color-hint)' }} />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 font-semibold tabular-nums">
          {num(total)}
          {limit !== null && <span className="text-subtle"> / {num(limit)}</span>}
        </span>
      </div>
      {limit !== null && (
        <>
          <Progress value={total} total={limit} color={color ?? undefined} />
          <p className={cx('mt-1 text-[13px]', left !== null && left <= Math.max(10, limit * 0.1) ? 'font-semibold text-bad-fg' : 'text-subtle')}>
            {left !== null && left > 0 ? `осталось ${num(left)}` : left === 0 ? 'мест нет' : `сверх лимита на ${num(-left!)}`}
          </p>
        </>
      )}
    </div>
  );
}

export default function Stats() {
  const staff = useStaff();
  const tz = staff.event.timezone;
  const q = useQuery({
    queryKey: ['staff', 'overview'],
    queryFn: () => staffApi.overview(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const [adminBusy, setAdminBusy] = useState(false);

  const openAdmin = async () => {
    if (adminBusy) return;
    setAdminBusy(true);
    try {
      const { url } = await staffApi.adminLink();
      openExternal(url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdminBusy(false);
    }
  };

  const refresh = (
    <button
      type="button"
      aria-label="Обновить"
      onClick={() => {
        haptic('light');
        void q.refetch();
      }}
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-section text-accent active:opacity-70"
    >
      {q.isFetching ? <Spinner className="size-5" /> : <IconRefresh size={20} />}
    </button>
  );

  if (!q.data) {
    return (
      <Page title="Статистика" back="/" headerRight={refresh}>
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

  const s = q.data;
  const r = s.registrations;
  const live = s.arrival.arrived > 0;
  const people = s.people;
  const genderTotal = people.gender.m + people.gender.f;
  const ages = [
    { label: 'до 16', n: people.ages.under16 },
    { label: '16–17', n: people.ages.from16to17 },
    { label: '18–25', n: people.ages.from18to25 },
    { label: '26+', n: people.ages.over25 },
  ];

  return (
    <Page title="Статистика" subtitle={`Обновлено в ${formatTime(s.generatedAt, tz)}`} back="/" headerRight={refresh}>
      <div className="space-y-3">
        <Attention a={s.attention} onAdmin={() => void openAdmin()} busy={adminBusy} />

        {live && <Arrival s={s.arrival} tz={tz} />}

        <Card
          title="Регистрации"
          aside={r.today > 0 ? <span className="text-[14px] font-semibold text-ok-fg">+{num(r.today)} сегодня</span> : undefined}
        >
          <Big value={num(r.participants)} unit={plural(r.participants, ['человек', 'человека', 'человек'])} />
          <p className="mt-1.5 text-[14px] text-subtle">
            {num(r.accounts)} {plural(r.accounts, ['аккаунт', 'аккаунта', 'аккаунтов'])} · за 7 дней +{num(r.week)}
            {r.cancelled > 0 ? ` · отменили ${num(r.cancelled)}` : ''}
          </p>
          <div className="mt-4">
            <Bars values={r.byDay.map((d) => d.n)} labels={[formatDayKey(r.byDay[0]!.day, { day: 'numeric', month: 'short' }), 'сегодня']} />
          </div>
        </Card>

        {s.payments.enabled && (
          <Card title="Оплата" aside={<span className="text-[14px] font-semibold text-ok-fg">{pct(Number(s.payments.received), Number(s.payments.expected))}%</span>}>
            <Big value={formatRub(s.payments.received)} unit={`из ${formatRub(s.payments.expected)}`} />
            <div className="mt-3">
              <Progress value={Number(s.payments.received)} total={Number(s.payments.expected)} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[15px]">
              {PAY_ORDER.map(({ status, label, color }) => (
                <div key={status} className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="min-w-0 flex-1 truncate text-subtle">{label}</span>
                  <span className="font-semibold tabular-nums">{num(s.payments.byStatus[status] ?? 0)}</span>
                </div>
              ))}
            </div>
            {s.payments.byMethod.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {s.payments.byMethod.map((m) => (
                  <span key={m.method} className="rounded-full bg-fill px-3 py-1 text-[14px]">
                    <span className="text-subtle">{METHOD_LABEL[m.method]}</span> <span className="font-semibold tabular-nums">{formatRub(m.amount)}</span>
                  </span>
                ))}
              </div>
            )}
            {s.payments.donations.count > 0 && (
              <p className="mt-3 text-[15px]">
                <span className="text-subtle">Пожертвования:</span> <span className="font-semibold tabular-nums">{formatRub(s.payments.donations.amount)}</span>
                <span className="text-subtle"> · {num(s.payments.donations.count)} раз</span>
              </p>
            )}
            {s.payments.pendingReceipts > 0 && (
              <p className="mt-3 text-[14px] font-semibold text-warn-fg">Чеков ждут проверки: {num(s.payments.pendingReceipts)}</p>
            )}
          </Card>
        )}

        <Card title="Варианты и питание">
          {s.tiers.length === 0 ? (
            <p className="text-[15px] text-subtle">Пока никого.</p>
          ) : (
            <div className="space-y-3">
              {s.tiers.map((t) => (
                <LimitRow key={t.tier} label={t.label} color={t.color} total={t.total} limit={t.limit} />
              ))}
              {/* Завтрак - галочка к варианту, у него свой лимит. */}
              {(s.meals.breakfastLimit != null || s.meals.breakfast > 0) && (
                <LimitRow label="Завтрак" color={BREAKFAST_COLOR} total={s.meals.breakfast} limit={s.meals.breakfastLimit ?? null} />
              )}
            </div>
          )}
          <p className="mt-4 border-t border-line pt-3 text-[15px]">
            Обед и ужин: <b>{num(s.meals.lunchDinner)}</b> · завтрак: <b>{num(s.meals.breakfast)}</b>
          </p>
          {s.meals.bracelets && (
            // Браслеты: чёрный - с питанием, белый - без; «пришли» - уже отмечены на входе.
            <div className="mt-3 grid grid-cols-2 gap-2 text-[14px]">
              <div className="rounded-2xl bg-black p-3 text-white">
                <p className="font-bold">Чёрных: {num(s.meals.bracelets.black.total)}</p>
                <p className="opacity-80">пришли {num(s.meals.bracelets.black.arrived)}</p>
              </div>
              <div className="rounded-2xl border border-black/20 bg-white p-3 text-black">
                <p className="font-bold">Белых: {num(s.meals.bracelets.white.total)}</p>
                <p className="opacity-70">пришли {num(s.meals.bracelets.white.arrived)}</p>
              </div>
            </div>
          )}
        </Card>

        {s.bot && (
          // Сообщения бота: сколько дошло сегодня и что он отправит дальше (подробно - в админке, «Сообщения бота»).
          <Card title="Бот сегодня">
            <p className="text-[15px]">
              Дошло: <b>{num(s.bot.sent)}</b>
              {s.bot.failed > 0 && (
                <>
                  {' '}
                  · <span className="font-semibold text-bad-fg">не дошло: {num(s.bot.failed)}</span>
                </>
              )}
            </p>
            {s.bot.next.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-line pt-3 text-[14px]">
                <p className="text-subtle">Дальше по плану:</p>
                {s.bot.next.map((n) => (
                  <p key={`${n.name}:${n.at}`}>
                    <b className="tabular-nums">{formatTime(n.at, tz)}</b> · {n.label} <span className="text-subtle">· {n.recipients === null ? num(n.count) : n.recipients === 0 ? 'никому' : `${num(n.recipients)} чел.`}</span>
                  </p>
                ))}
              </div>
            )}
          </Card>
        )}

        <Card title="Кто едет">
          {genderTotal > 0 && (
            <>
              <div className="flex h-2 overflow-hidden rounded-full bg-fill">
                <div style={{ width: `${pct(people.gender.m, genderTotal)}%`, background: '#4B5DA5' }} />
                <div style={{ width: `${pct(people.gender.f, genderTotal)}%`, background: '#D0352C' }} />
              </div>
              <div className="mt-1.5 flex justify-between text-[14px]">
                <span>
                  <span className="text-subtle">Парни</span> <b>{num(people.gender.m)}</b>
                </span>
                <span>
                  <span className="text-subtle">Девушки</span> <b>{num(people.gender.f)}</b>
                </span>
              </div>
            </>
          )}
          <div className="mt-4 grid grid-cols-4 gap-2 text-center">
            {ages.map((x) => (
              <div key={x.label} className="rounded-xl bg-fill px-1 py-2">
                <div className="text-[18px] font-semibold tabular-nums">{num(x.n)}</div>
                <div className="text-[12px] text-subtle">{x.label}</div>
              </div>
            ))}
          </div>
          {people.cities.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-hint">Города</p>
              {people.cities.map((c) => (
                <Row key={c.name} label={c.name} value={num(c.n)} />
              ))}
              {people.citiesTotal > people.cities.length && (
                <p className="mt-1 text-[13px] text-subtle">и ещё {num(people.citiesTotal - people.cities.length)}</p>
              )}
            </div>
          )}
          {people.churches.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-hint">Церкви</p>
              {people.churches.map((c) => (
                <Row key={c.name} label={c.name} value={num(c.n)} />
              ))}
              {people.churchesTotal > people.churches.length && (
                <p className="mt-1 text-[13px] text-subtle">и ещё {num(people.churchesTotal - people.churches.length)}</p>
              )}
            </div>
          )}
        </Card>

        {s.seminars.map((b) => (
          <Card
            key={b.id}
            title={`${b.title} · ${formatTime(b.startsAt, tz)}`}
            aside={<span className="text-[13px] text-subtle">{b.registrationOpen ? 'запись открыта' : 'запись закрыта'}</span>}
          >
            <Big value={num(b.registered)} unit={b.capacity ? `из ${num(b.capacity)} мест` : 'записалось'} />
            <div className="mt-2">
              {b.topics.length === 0 ? (
                <p className="text-[15px] text-subtle">Тем пока нет.</p>
              ) : (
                b.topics.map((t) => (
                  <Row
                    key={t.id}
                    label={t.title}
                    sub={t.room ? (b.roomsPublished ? t.room : `${t.room} (не опубликован)`) : 'зала нет'}
                    value={t.overflow > 0 ? `${num(t.registered)} (+${num(t.overflow)})` : num(t.registered)}
                    danger={t.overflow > 0}
                  />
                ))
              )}
            </div>
          </Card>
        ))}

        {s.counseling && (
          <Card
            title="Душепопечение"
            aside={<span className="text-[13px] text-subtle">{s.counseling.open ? 'запись открыта' : 'запись закрыта'}</span>}
          >
            <Big value={num(s.counseling.booked)} unit={`из ${num(s.counseling.slots)} окошек`} />
            <div className="mt-3">
              <Progress value={s.counseling.booked} total={s.counseling.slots} color="var(--color-btn)" />
            </div>
            <div className="mt-2">
              {s.counseling.counselors.map((c) => (
                <Row key={c.name} label={c.name} value={`${num(c.booked)} / ${num(c.slots)}`} />
              ))}
            </div>
          </Card>
        )}

        {s.activities.length > 0 && (
          <Card title="Запись на мероприятия">
            {s.activities.map((a) => (
              <Row
                key={a.id}
                label={a.title}
                sub={`${formatDayKey(dayKey(a.startsAt, tz), { day: 'numeric', month: 'short' })}, ${formatTime(a.startsAt, tz)}${a.waitlist > 0 ? ` · очередь ${num(a.waitlist)}` : ''}`}
                value={a.capacity !== null ? `${num(a.registered)} / ${num(a.capacity)}` : num(a.registered)}
                danger={a.capacity !== null && a.registered >= a.capacity}
              />
            ))}
          </Card>
        )}

        {!live && (
          <Card title="На месте">
            <p className="text-[15px] text-subtle">Отметок на входе пока нет - блок оживёт в дни конференции.</p>
          </Card>
        )}

        <p className="px-1 pt-1 text-center text-[13px] text-hint">Обновляется само раз в минуту</p>
      </div>
    </Page>
  );
}
