import { activityKindLabel, type ActivityView } from '@sof/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { IconCalendarPlus, IconPencil, IconUsers } from '@tabler/icons-react';
import { dayKey, formatDayKey, formatTime } from '../lib/time.ts';
import { Badge, Button, Card, EmptyState, ErrorState, Spinner } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { ACTIVITY_STATUS_LABELS as STATUS_LABELS, staffActivitiesQuery, useEventTimezone } from './common.ts';
import { can, useStaff } from './session.ts';

function counts(a: ActivityView): string {
  if (a.registrationMode === 'required') {
    const parts = [a.capacity !== null ? `Записано ${a.registeredCount}/${a.capacity}` : `Записано ${a.registeredCount}`];
    if (a.waitlistCount) parts.push(`ожидают ${a.waitlistCount}`);
    return parts.join(' · ');
  }
  return a.interestCount ? `Собираются: ${a.interestCount}` : 'Свободный вход';
}

export default function Activities() {
  const staff = useStaff();
  const tz = useEventTimezone();
  const [, navigate] = useLocation();
  const q = useQuery(staffActivitiesQuery);
  const list = [...(q.data ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const groups = new Map<string, ActivityView[]>();
  for (const a of list) {
    const key = dayKey(a.startsAt, tz);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  return (
    <Page
      title={can(staff, 'activities:all') ? 'Активности' : 'Мои активности'}
      back="/"
      headerRight={
        <Button size="sm" onClick={() => navigate('/activities/new')}>
          ＋ Новая
        </Button>
      }
    >
      {q.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-9 text-btn" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={IconCalendarPlus} hue="violet" title="Активностей пока нет">
          Создайте семинар, мастер-класс или игру - участники смогут записаться в расписании.
        </EmptyState>
      ) : (
        [...groups.entries()].map(([day, items]) => (
          <section key={day} className="mb-5">
            <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-head">
              {formatDayKey(day, { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            {items.map((a) => (
              <Card key={a.id} className="mb-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[17px] font-semibold leading-snug">{a.title}</p>
                  <Badge tone={STATUS_LABELS[a.status].tone} className="shrink-0">
                    {STATUS_LABELS[a.status].text}
                  </Badge>
                </div>
                <p className="mt-1 text-[14px] text-subtle">
                  {formatTime(a.startsAt, tz)}–{formatTime(a.endsAt, tz)} · {activityKindLabel(a.kind)}
                  {a.location ? ` · ${a.location}` : ''}
                </p>
                <p className="mt-1 text-[14px]">{counts(a)}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => navigate(`/activities/${a.id}/edit`)}>
                    <IconPencil size={18} />
                    Изменить
                  </Button>
                  {a.registrationMode === 'required' && (
                    <Button size="sm" variant="secondary" onClick={() => navigate(`/activities/${a.id}/registrations`)}>
                      <IconUsers size={18} />
                      Записавшиеся
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </section>
        ))
      )}
    </Page>
  );
}
