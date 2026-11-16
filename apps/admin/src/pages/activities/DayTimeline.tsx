import { Popover, Text } from '@mantine/core';
import type { ActivityView, RoomView } from '@sof/shared';
import { useMemo, useState } from 'react';
import { formatTime } from '../../lib/format.ts';
import { activityKindColor } from '../../lib/labels.ts';
import { dayKey, minutesOfDay, todayKey } from '../../lib/tz.ts';
import { ActivityDetails } from './ActivityDetails.tsx';

const PX_PER_MIN = 1.3;
/** Отступ сверху и снизу, чтобы подпись первого часа не обрезалась. */
const PAD = 12;
const NO_PLACE = 'Без места';

/** Не мероприятие, а сводный блок (душепопечение): своя подпись, нажатие - свой обработчик. */
export interface TimelineExtra {
  key: string;
  place: string;
  startsAt: string;
  endsAt: string;
  title: string;
  subtitle?: string;
  /** Цвет Mantine: «pink», «grape»… */
  color: string;
  onClick: () => void;
}

interface Item {
  activity: ActivityView | null;
  extra: TimelineExtra | null;
  start: number;
  end: number;
  place: string;
}

interface Placed extends Item {
  lane: number;
  lanes: number;
}

/** Раскладка пересекающихся по времени активностей одной колонки по «дорожкам». */
function placeColumn(items: Item[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const laneEnds: number[] = [];
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    placed.push(...cluster);
    cluster = [];
    laneEnds.length = 0;
  };
  for (const item of sorted) {
    if (cluster.length && item.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else laneEnds[lane] = item.end;
    cluster.push({ ...item, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) flush();
  return placed;
}

/**
 * Таймлайн дня: колонки - места, блоки - активности по времени.
 * Нажатие на блок показывает подробности (на телефоне наведения нет, поэтому не подсказка, а всплывающее окно).
 */
export function DayTimeline({
  activities,
  extras = [],
  day,
  tz,
  canEdit,
  onEdit,
  onRegs,
  rooms = [],
}: {
  activities: ActivityView[];
  /** Сводные блоки (душепопечение) - в своей колонке. */
  extras?: TimelineExtra[];
  day: string;
  tz: string;
  /** Залы из справочника: колонки есть у каждого (видно свободные), в шапке - вместимость. */
  rooms?: RoomView[];
  canEdit: (activity: ActivityView) => boolean;
  onEdit: (activity: ActivityView) => void;
  onRegs: (activity: ActivityView) => void;
}) {
  const [openedId, setOpenedId] = useState<number | null>(null);
  const layout = useMemo(() => {
    const span = (startsAt: string, endsAt: string) => {
      const start = minutesOfDay(startsAt, tz);
      // Закончилось на следующий день - рисуем до полуночи.
      const endSameDay = dayKey(endsAt, tz) === day;
      return { start, end: endSameDay ? Math.max(start + 15, minutesOfDay(endsAt, tz)) : 24 * 60 };
    };
    const items: Item[] = [
      ...activities.map((a) => ({ activity: a, extra: null, ...span(a.startsAt, a.endsAt), place: a.location?.trim() || NO_PLACE })),
      ...extras.map((x) => ({ activity: null, extra: x, ...span(x.startsAt, x.endsAt), place: x.place })),
    ];
    // Сначала залы справочника в их порядке (и пустые - видно, где свободно), потом прочие места.
    const roomNames = rooms.map((r) => r.name);
    const others = [...new Set(items.map((i) => i.place))]
      .filter((p) => !roomNames.some((n) => n.toLowerCase() === p.toLowerCase()))
      .sort((a, b) => {
        if (a === NO_PLACE) return 1;
        if (b === NO_PLACE) return -1;
        const fa = Math.min(...items.filter((i) => i.place === a).map((i) => i.start));
        const fb = Math.min(...items.filter((i) => i.place === b).map((i) => i.start));
        return fa - fb || a.localeCompare(b, 'ru');
      });
    const places = [...roomNames, ...others];
    const placeOf = (p: string) => roomNames.find((n) => n.toLowerCase() === p.toLowerCase()) ?? p;
    for (const i of items) i.place = placeOf(i.place);
    // Пустой день (например, только блок семинаров без тем): Math.min() без аргументов - Infinity,
    // и цикл часов ниже никогда не заканчивался. Показываем обычный день 09:00–21:00 с пустыми залами.
    const from = items.length ? Math.max(0, Math.floor(Math.min(...items.map((i) => i.start)) / 60) * 60) : 9 * 60;
    const to = items.length ? Math.min(24 * 60, Math.ceil(Math.max(...items.map((i) => i.end)) / 60) * 60) : 21 * 60;
    const capacity = new Map(rooms.map((r) => [r.name, r.capacity]));
    const columns = places.map((place) => ({
      place,
      capacity: capacity.get(place) ?? null,
      blocks: placeColumn(items.filter((i) => i.place === place)),
    }));
    return { from, to: Math.max(to, from + 60), columns };
  }, [activities, extras, day, tz]);

  const height = (layout.to - layout.from) * PX_PER_MIN + PAD * 2;
  const hours: number[] = [];
  // В сутках не больше 25 отметок часов - ограничение страхует от зависания при любых данных.
  for (let m = layout.from; m <= layout.to && hours.length < 25; m += 60) hours.push(m);
  const isToday = todayKey(tz) === day;
  const nowMin = minutesOfDay(new Date(), tz);
  const showNow = isToday && nowMin >= layout.from && nowMin <= layout.to;

  return (
    <div
      className="sof-timeline"
      style={{ gridTemplateColumns: `56px repeat(${layout.columns.length}, minmax(180px, 1fr))` }}
      role="region"
      aria-label="Таймлайн дня"
    >
      <div className="sof-timeline-head sof-timeline-corner" />
      {layout.columns.map((c) => (
        <div key={c.place} className="sof-timeline-head" title={c.place}>
          {c.place}
          {c.capacity !== null && <span className="sof-timeline-cap"> · {c.capacity}</span>}
        </div>
      ))}

      <div className="sof-timeline-times" style={{ height }}>
        {hours.map((m) => (
          <div key={m} className="sof-timeline-label" style={{ top: (m - layout.from) * PX_PER_MIN + PAD }}>
            {String(Math.floor(m / 60)).padStart(2, '0')}:00
          </div>
        ))}
      </div>

      {layout.columns.map((c) => (
        <div key={c.place} className="sof-timeline-col" style={{ height }}>
          {hours.map((m) => (
            <div key={m} className="sof-timeline-hour" style={{ top: (m - layout.from) * PX_PER_MIN + PAD }} />
          ))}
          {showNow && <div className="sof-timeline-now" style={{ top: (nowMin - layout.from) * PX_PER_MIN + PAD }} />}
          {c.blocks.map((b) => {
            const top = (b.start - layout.from) * PX_PER_MIN + PAD;
            const h = Math.max(26, (b.end - b.start) * PX_PER_MIN - 2);
            const width = 100 / b.lanes;
            const x = b.extra;
            if (x) {
              return (
                <button
                  key={x.key}
                  type="button"
                  className="sof-timeline-block"
                  style={{
                    top,
                    height: h,
                    left: `calc(${b.lane * width}% + 3px)`,
                    width: `calc(${width}% - 6px)`,
                    ['--block-color' as string]: `var(--mantine-color-${x.color}-6)`,
                  }}
                  onClick={x.onClick}
                >
                  <Text span size="xs" fw={700} display="block" truncate>
                    {formatTime(x.startsAt, tz)} {x.title}
                  </Text>
                  {h > 40 && x.subtitle && (
                    <Text span size="xs" c="dimmed" display="block" truncate>
                      {x.subtitle}
                    </Text>
                  )}
                </button>
              );
            }
            const a = b.activity!;
            const color = activityKindColor(a.kind);
            // Два мероприятия в одном зале в одно время - подсвечиваем (кроме «Без места» и отменённых).
            const clash = b.lanes > 1 && c.place !== NO_PLACE && a.status !== 'cancelled';
            const className = [
              'sof-timeline-block',
              a.status === 'cancelled' ? 'sof-cancelled' : '',
              a.status === 'draft' ? 'sof-draft' : '',
              clash ? 'sof-clash' : '',
            ]
              .filter(Boolean)
              .join(' ');
            const regText =
              a.registrationMode === 'required' ? `записано ${a.registeredCount}${a.capacity ? `/${a.capacity}` : ''}` : null;
            return (
              <Popover
                key={a.id}
                opened={openedId === a.id}
                onDismiss={() => setOpenedId(null)}
                width={300}
                position="bottom-start"
                withArrow
                shadow="md"
                radius="md"
              >
                <Popover.Target>
                  <button
                    type="button"
                    className={className}
                    style={{
                      top,
                      height: h,
                      left: `calc(${b.lane * width}% + 3px)`,
                      width: `calc(${width}% - 6px)`,
                      ['--block-color' as string]: `var(--mantine-color-${color}-6)`,
                    }}
                    aria-expanded={openedId === a.id}
                    onClick={() => setOpenedId((id) => (id === a.id ? null : a.id))}
                  >
                    <Text span size="xs" fw={700} display="block" truncate>
                      {formatTime(a.startsAt, tz)} {a.title}
                    </Text>
                    {h > 40 && (
                      <Text span size="xs" c="dimmed" display="block" truncate>
                        {[a.host, regText].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </button>
                </Popover.Target>
                <Popover.Dropdown>
                  <ActivityDetails
                    activity={a}
                    tz={tz}
                    editable={canEdit(a)}
                    onEdit={() => {
                      setOpenedId(null);
                      onEdit(a);
                    }}
                    onRegs={() => {
                      setOpenedId(null);
                      onRegs(a);
                    }}
                  />
                </Popover.Dropdown>
              </Popover>
            );
          })}
        </div>
      ))}
    </div>
  );
}
