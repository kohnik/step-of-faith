import { Group, Input, Text } from '@mantine/core';
import { DateInput, DatePickerInput, TimePicker, type DateInputProps } from '@mantine/dates';
import { IconCalendar, IconClock, IconWorld } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { offsetLabel } from '../lib/tz.ts';
import { useEventTz } from './EventProvider.tsx';

const pad = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** «12.05.1990», «12/5/90», «12051990», «1990-05-12» → `1990-05-12`. */
function parseRuDate(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  let m = /^(\d{1,2})[.\/\-\s](\d{1,2})[.\/\-\s](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (m[3]!.length === 2) {
      const current = new Date().getFullYear() % 100;
      y += y > current ? 1900 : 2000;
    }
    return validYmd(y, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{2})(\d{2})(\d{4})$/.exec(s);
  if (m) return validYmd(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/** Дата без времени (`YYYY-MM-DD`) с ручным вводом ДД.ММ.ГГГГ. */
export function DateField(props: Omit<DateInputProps, 'dateParser' | 'valueFormat'>) {
  return (
    <DateInput
      valueFormat="DD.MM.YYYY"
      dateParser={parseRuDate}
      placeholder="ДД.ММ.ГГГГ"
      leftSection={<IconCalendar size={16} />}
      {...props}
    />
  );
}

export interface EventDateTimeInputProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  /** Подсказка в пустом поле даты («Сразу», «К началу»). */
  placeholder?: string;
  /** `YYYY-MM-DD HH:mm:ss` по часам события или пусто. */
  value?: string | null;
  onChange?: (value: string | null) => void;
  /** Раньше этой даты выбрать нельзя (например, отложенная рассылка). */
  minDate?: Date | string;
  onFocus?: () => void;
  onBlur?: () => void;
}

/** Время, если его ещё не выбрали: начало дня конференции, а не полночь. */
const DEFAULT_TIME = '10:00';

/**
 * Дата и время по часам события двумя полями: дата - календарём, время - списком часов и минут
 * (шаг 5 минут) или с клавиатуры. Значение - строка `YYYY-MM-DD HH:mm:ss` («настенное» время);
 * в ISO переводим при отправке через `wallToIso`. Смена даты время не сбрасывает.
 * Подсказку о поясе показывает `TzHint` - одну на группу полей.
 */
export function EventDateTimeInput({
  label,
  description,
  error,
  required,
  clearable,
  disabled,
  placeholder,
  value,
  onChange,
  minDate,
  onFocus,
  onBlur,
}: EventDateTimeInputProps) {
  const date = value ? value.slice(0, 10) : null;
  const time = value ? value.slice(11, 16) : '';
  // Время выбрали раньше даты - запоминаем и подставим, когда появится дата.
  const [pendingTime, setPendingTime] = useState(DEFAULT_TIME);
  const emit = (d: string | null, t: string) => onChange?.(d ? `${d} ${t || DEFAULT_TIME}:00` : null);

  return (
    <Input.Wrapper label={label} description={description} error={error} required={required} onFocus={onFocus} onBlur={onBlur}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <DatePickerInput
          style={{ flex: 1.4, minWidth: 0 }}
          value={date}
          valueFormat="DD.MM.YYYY"
          placeholder={placeholder ?? 'Дата'}
          leftSection={<IconCalendar size={16} />}
          clearable={clearable}
          disabled={disabled}
          minDate={minDate}
          error={Boolean(error)}
          popoverProps={{ withinPortal: true }}
          onChange={(d) => emit(d ? String(d).slice(0, 10) : null, time || pendingTime)}
        />
        <TimePicker
          style={{ flex: 1, minWidth: 0 }}
          value={time || (date ? '' : pendingTime)}
          format="24h"
          withDropdown
          minutesStep={5}
          leftSection={<IconClock size={16} />}
          disabled={disabled}
          error={Boolean(error)}
          popoverProps={{ withinPortal: true }}
          onChange={(t) => {
            // Пока время введено не полностью, TimePicker отдаёт пустую строку - прежнее не стираем.
            const hm = t.slice(0, 5);
            if (!/^\d{2}:\d{2}$/.test(hm)) return;
            if (date) emit(date, hm);
            else setPendingTime(hm);
          }}
        />
      </Group>
    </Input.Wrapper>
  );
}

/** «Время - по часам конференции: Europe/Minsk (UTC+3)». */
export function TzHint({ tz: tzProp }: { tz?: string }) {
  const eventTz = useEventTz();
  const tz = tzProp ?? eventTz;
  return (
    <Group gap={6} wrap="nowrap">
      <IconWorld size={14} color="var(--mantine-color-dimmed)" />
      <Text size="xs" c="dimmed">
        Время - по часам конференции: {tz} ({offsetLabel(tz)})
      </Text>
    </Group>
  );
}
