import {
  Alert,
  Autocomplete,
  Button,
  Collapse,
  Divider,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import {
  activityInputSchema,
  activityKindLabel,
  activityKindOptions,
  type ActivityInput,
  type ActivityKind,
  type ActivityStatus,
  type ActivityUpdate,
  type ActivityView,
  type Meal,
  type RegistrationMode,
  MEAL_LABELS,
  MEALS,
} from '@sof/shared';
import { IconAlertTriangle, IconChevronDown, IconInfoCircle } from '@tabler/icons-react';
import type { ComboboxItem, OptionsFilter } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useActivities, useCreateActivity, useUpdateActivity } from '../../api/activities.ts';
import { activityAudience, useActivityDelete } from './rowActions.tsx';
import { useRooms } from '../../api/seminars.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { EventDateTimeInput, TzHint } from '../../components/dates.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { addMinutesToWall, isoToWall, sameInstant, wallToIso } from '../../lib/tz.ts';
import { emptyToNull, numberOrNull, schemaErrors, serverErrors } from '../../lib/validation.ts';

interface Values {
  title: string;
  description: string;
  location: string;
  host: string;
  kind: ActivityKind;
  startsAt: string | null;
  endsAt: string | null;
  registrationMode: RegistrationMode;
  capacity: number | string;
  waitlistEnabled: boolean;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  minAge: number | string;
  maxAge: number | string;
  status: ActivityStatus;
  /** '' - не питание. */
  meal: Meal | '';
}

function toValues(a: ActivityView | null, tz: string, defaults?: { day?: string | null }): Values {
  if (!a) {
    return {
      title: '',
      description: '',
      location: '',
      host: '',
      kind: 'Семинар',
      startsAt: defaults?.day ? `${defaults.day} 10:00:00` : null,
      endsAt: defaults?.day ? `${defaults.day} 11:00:00` : null,
      registrationMode: 'none',
      capacity: '',
      waitlistEnabled: true,
      registrationOpensAt: null,
      registrationClosesAt: null,
      minAge: '',
      maxAge: '',
      status: 'published',
      meal: '',
    };
  }
  return {
    title: a.title,
    description: a.description ?? '',
    location: a.location ?? '',
    host: a.host ?? '',
    kind: activityKindLabel(a.kind),
    startsAt: isoToWall(a.startsAt, tz),
    endsAt: isoToWall(a.endsAt, tz),
    registrationMode: a.registrationMode,
    capacity: a.capacity ?? '',
    waitlistEnabled: a.waitlistEnabled,
    registrationOpensAt: isoToWall(a.registrationOpensAt, tz),
    registrationClosesAt: isoToWall(a.registrationClosesAt, tz),
    minAge: a.minAge ?? '',
    maxAge: a.maxAge ?? '',
    status: a.status,
    meal: a.meal ?? '',
  };
}

function toPayload(v: Values, tz: string): ActivityInput {
  const required = v.registrationMode === 'required';
  return {
    title: v.title.trim(),
    description: emptyToNull(v.description),
    location: emptyToNull(v.location),
    host: emptyToNull(v.host),
    kind: v.kind.trim(),
    startsAt: wallToIso(v.startsAt, tz) ?? '',
    endsAt: wallToIso(v.endsAt, tz) ?? '',
    registrationMode: v.registrationMode,
    capacity: required ? numberOrNull(v.capacity) : null,
    waitlistEnabled: v.waitlistEnabled,
    registrationOpensAt: required ? wallToIso(v.registrationOpensAt, tz) : null,
    registrationClosesAt: required ? wallToIso(v.registrationClosesAt, tz) : null,
    minAge: numberOrNull(v.minAge),
    maxAge: numberOrNull(v.maxAge),
    status: v.status,
    // Личное напоминание о питании - только у пунктов без записи (им напоминание уходит всем).
    meal: required || !v.meal ? null : v.meal,
  };
}

/**
 * Подсказки для «Тип» и «Ведущий»: пока значение совпадает с вариантом из списка - показываем весь
 * список (можно выбрать другой), иначе - подходящие по введённому тексту. Новое значение просто вводится.
 */
const suggestAll: OptionsFilter = ({ options, search }) => {
  const q = search.trim().toLowerCase();
  const items = options as ComboboxItem[];
  if (!q || items.some((o) => o.label.toLowerCase() === q)) return options;
  return items.filter((o) => o.label.toLowerCase().includes(q));
};

const DATE_KEYS = new Set(['startsAt', 'endsAt', 'registrationOpensAt', 'registrationClosesAt']);

function diff(before: ActivityInput, after: ActivityInput): ActivityUpdate {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof ActivityInput)[]) {
    const a = after[key];
    const b = before[key];
    const equal = DATE_KEYS.has(key) ? sameInstant(a as string | null, b as string | null) : a === b;
    if (!equal) out[key] = a;
  }
  return out as ActivityUpdate;
}

export function ActivityFormModal({
  opened,
  onClose,
  activity,
  defaultDay,
}: {
  opened: boolean;
  onClose: () => void;
  /** null - новая активность. */
  activity: ActivityView | null;
  defaultDay?: string | null;
}) {
  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      size="xl"
      title={<Text fw={700}>{activity ? 'Изменить активность' : 'Новая активность'}</Text>}
    >
      {/* Модалка размонтирует содержимое после закрытия - форма каждый раз стартует с актуальных значений. */}
      <ActivityForm key={activity?.id ?? 'new'} activity={activity} defaultDay={defaultDay ?? null} onDone={onClose} />
    </AppModal>
  );
}

function ActivityForm({ activity, defaultDay, onDone }: { activity: ActivityView | null; defaultDay: string | null; onDone: () => void }) {
  const tz = useEventTz();
  const confirm = useConfirm();
  const create = useCreateActivity();
  const update = useUpdateActivity();
  const removeActivity = useActivityDelete();
  const all = useActivities();
  // Типы и ведущие запоминаются: в списке - основные и все, что уже встречались в расписании.
  const kindOptions = useMemo(() => activityKindOptions((all.data ?? []).map((a) => a.kind)), [all.data]);
  const rooms = useRooms();
  // Место: залы из справочника (с вместимостью в подсказке ниже) и уже встречавшиеся места.
  const placeOptions = useMemo(
    () => [
      ...new Set([
        ...(rooms.data ?? []).map((r) => r.name),
        ...(all.data ?? []).map((a) => a.location?.trim()).filter((l): l is string => Boolean(l)),
      ]),
    ],
    [rooms.data, all.data],
  );
  const hostOptions = useMemo(
    () => [...new Set((all.data ?? []).map((a) => a.host?.trim()).filter((h): h is string => Boolean(h)))].sort((a, b) => a.localeCompare(b, 'ru')),
    [all.data],
  );
  const initial = toValues(activity, tz, { day: defaultDay });

  const form = useForm<Values>({
    mode: 'controlled',
    initialValues: initial,
    validate: (values) => {
      const payload = toPayload(values, tz);
      const errors = schemaErrors(activityInputSchema, payload);
      if (!values.startsAt) errors.startsAt = 'Укажите начало';
      if (!values.endsAt) errors.endsAt = 'Укажите окончание';
      if (payload.startsAt && payload.endsAt && new Date(payload.endsAt) < new Date(payload.startsAt)) {
        errors.endsAt = 'Окончание раньше начала';
      }
      if (payload.minAge != null && payload.maxAge != null && payload.minAge > payload.maxAge) {
        errors.maxAge = 'Меньше минимального';
      }
      if (
        payload.registrationOpensAt &&
        payload.registrationClosesAt &&
        new Date(payload.registrationClosesAt) <= new Date(payload.registrationOpensAt)
      ) {
        errors.registrationClosesAt = 'Раньше открытия записи';
      }
      return errors;
    },
  });

  const v = form.values;
  const people = activity ? activity.registeredCount + activity.waitlistCount : 0;
  // Сообщения об отмене, переносе и смене места получают записавшиеся, очередь и отметившие «Пойду».
  const audience = activity ? activityAudience(activity) : null;
  const locationChanged = activity ? (v.location.trim() || null) !== (activity.location ?? null) : false;
  // «Дополнительно» раскрыто сразу, если там что-то уже заполнено не по умолчанию.
  const [extrasOpened, setExtrasOpened] = useState(
    () =>
      initial.minAge !== '' ||
      initial.maxAge !== '' ||
      initial.status !== 'published' ||
      !initial.waitlistEnabled ||
      !!initial.registrationOpensAt ||
      !!initial.registrationClosesAt,
  );
  const extrasHaveErrors = ['minAge', 'maxAge', 'status', 'registrationOpensAt', 'registrationClosesAt'].some((k) => !!form.errors[k]);
  const showExtras = extrasOpened || extrasHaveErrors;
  const startsChanged = activity ? !sameInstant(wallToIso(v.startsAt, tz), activity.startsAt) : false;
  const willCancel = !!activity && v.status === 'cancelled' && activity.status !== 'cancelled';

  const submit = form.onSubmit(async (values) => {
    const payload = toPayload(values, tz);
    if (!activity) {
      create.mutate(payload, {
        onSuccess: (a) => {
          notifySuccess(`«${a.title}» добавлена в расписание`);
          onDone();
        },
        onError: (err) => form.setErrors(serverErrors(err)),
      });
      return;
    }
    const patch = diff(toPayload(initial, tz), payload);
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    if (patch.status === 'cancelled') {
      const ok = await confirm({
        title: 'Отменить активность?',
        message: audience ? `${audience} получат сообщение об отмене в Telegram.` : 'Активность исчезнет из расписания участников.',
        confirmLabel: 'Отменить активность',
        danger: true,
      });
      if (!ok) return;
    } else if (patch.startsAt && activity.status === 'published' && (payload.status ?? activity.status) === 'published' && audience) {
      const ok = await confirm({
        title: 'Перенести время?',
        message: `${audience} получат сообщение о переносе.`,
        confirmLabel: 'Перенести',
      });
      if (!ok) return;
    } else if (
      patch.location !== undefined &&
      locationChanged &&
      activity.status === 'published' &&
      (payload.status ?? activity.status) === 'published' &&
      new Date(activity.endsAt).getTime() > Date.now() &&
      audience
    ) {
      const ok = await confirm({
        title: 'Сменить место?',
        message: `${audience} получат сообщение о новом месте.`,
        confirmLabel: 'Сменить',
      });
      if (!ok) return;
    }
    update.mutate(
      { id: activity.id, patch },
      {
        onSuccess: (a) => {
          notifySuccess('Изменения сохранены', a.title);
          onDone();
        },
        onError: (err) => form.setErrors(serverErrors(err)),
      },
    );
  });

  const onDelete = () => {
    if (activity) void removeActivity.run(activity, onDone);
  };

  const onStartChange = (value: string | null) => {
    const prevStart = form.values.startsAt;
    const prevEnd = form.values.endsAt;
    form.setFieldValue('startsAt', value);
    if (!value) return;
    // Сохраняем длительность (или ставим час по умолчанию).
    let duration = 60;
    if (prevStart && prevEnd) {
      const a = wallToIso(prevStart, 'UTC');
      const b = wallToIso(prevEnd, 'UTC');
      if (a && b) duration = Math.max(15, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000));
    }
    if (!prevEnd || prevStart) form.setFieldValue('endsAt', addMinutesToWall(value, duration));
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          <TextInput label="Название" required data-autofocus className="sof-span-2" {...form.getInputProps('title')} />
          <Autocomplete
            label="Тип"
            placeholder="Семинар, служение…"
            data={kindOptions}
            filter={suggestAll}
            maxLength={40}
            {...form.getInputProps('kind')}
          />
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <EventDateTimeInput label="Начало" required value={v.startsAt} onChange={onStartChange} error={form.errors.startsAt} />
          <EventDateTimeInput label="Окончание" required {...form.getInputProps('endsAt')} />
        </SimpleGrid>
        <TzHint />
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Autocomplete
            label="Место"
            placeholder="Зал из списка или свой текст"
            description={(() => {
              const r = (rooms.data ?? []).find((x) => x.name.toLowerCase() === v.location.trim().toLowerCase());
              return r ? `Зал на ${r.capacity} мест${r.note ? ` · ${r.note}` : ''}` : undefined;
            })()}
            data={placeOptions}
            filter={suggestAll}
            {...form.getInputProps('location')}
          />
          <Autocomplete label="Ведущий" placeholder="Кто проводит" data={hostOptions} filter={suggestAll} {...form.getInputProps('host')} />
        </SimpleGrid>
        <Textarea label="Описание" autosize minRows={2} maxRows={8} {...form.getInputProps('description')} />
        {v.status !== 'cancelled' && (
          <Switch
            label="Показывать участникам"
            description="Выключено - мероприятие видит только команда"
            checked={v.status === 'published'}
            onChange={(e) => form.setFieldValue('status', e.currentTarget.checked ? 'published' : 'draft')}
          />
        )}

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Вход
          </Text>
          <SegmentedControl
            value={v.registrationMode}
            onChange={(m) => form.setFieldValue('registrationMode', m as RegistrationMode)}
            data={[
              { value: 'none', label: 'Свободный вход' },
              { value: 'required', label: 'По записи' },
            ]}
          />
        </Stack>
        <Collapse expanded={v.registrationMode === 'none'}>
          <Select
            label="Питание"
            description="За 15 минут всем участникам придёт напоминание, а тем, у кого есть это питание, - личное: «Вы в списке»"
            data={[{ value: '', label: 'Нет' }, ...MEALS.map((m) => ({ value: m, label: MEAL_LABELS[m] }))]}
            value={v.meal}
            onChange={(m) => form.setFieldValue('meal', (m ?? '') as Meal | '')}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
        </Collapse>
        <Collapse expanded={v.registrationMode === 'required'}>
          <Stack gap="sm">
            <NumberInput
              label="Мест"
              placeholder="Без ограничения"
              min={1}
              max={100000}
              allowDecimal={false}
              maw={260}
              {...form.getInputProps('capacity')}
            />
            {activity && numberOrNull(v.capacity) !== null && activity.registeredCount > (numberOrNull(v.capacity) ?? 0) && (
              <Alert color="yellow" variant="light" p="xs" icon={<IconInfoCircle size={16} />}>
                <Text size="sm">
                  Уже записано {activity.registeredCount} - больше нового лимита. Записанные останутся, новых записей не будет.
                </Text>
              </Alert>
            )}
          </Stack>
        </Collapse>

        <div>
          <Divider />
          <UnstyledButton onClick={() => setExtrasOpened((o) => !o)} py="sm" w="100%" aria-expanded={showExtras}>
            <Group justify="space-between" wrap="nowrap">
              <div>
                <Text size="sm" fw={600}>
                  Дополнительно
                </Text>
                <Text size="xs" c="dimmed">
                  Возраст, {v.registrationMode === 'required' ? 'когда открыть запись, лист ожидания, ' : ''}отмена
                </Text>
              </div>
              <IconChevronDown
                size={18}
                style={{ transform: showExtras ? 'rotate(180deg)' : undefined, transition: 'transform 150ms', flexShrink: 0 }}
              />
            </Group>
          </UnstyledButton>
          <Collapse expanded={showExtras}>
            <Stack gap="md" pt={4}>
              <SimpleGrid cols={2} spacing="sm" maw={420}>
                <NumberInput label="Возраст от" min={0} max={120} allowDecimal={false} {...form.getInputProps('minAge')} />
                <NumberInput label="Возраст до" min={0} max={120} allowDecimal={false} {...form.getInputProps('maxAge')} />
              </SimpleGrid>
              {v.registrationMode === 'required' && (
                <>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                    <EventDateTimeInput label="Запись открывается" clearable placeholder="Сразу" {...form.getInputProps('registrationOpensAt')} />
                    <EventDateTimeInput label="Запись закрывается" clearable placeholder="К началу" {...form.getInputProps('registrationClosesAt')} />
                  </SimpleGrid>
                  <Switch
                    label="Лист ожидания, когда места кончатся"
                    description="Если кто-то откажется, место получит следующий в очереди"
                    {...form.getInputProps('waitlistEnabled', { type: 'checkbox' })}
                  />
                </>
              )}
              <Stack gap={6}>
                <Text size="sm" fw={500}>
                  Статус
                </Text>
                <SegmentedControl
                  value={v.status}
                  onChange={(s) => form.setFieldValue('status', s as ActivityStatus)}
                  color={v.status === 'cancelled' ? 'red' : v.status === 'draft' ? 'gray' : undefined}
                  data={[
                    { value: 'draft', label: 'Скрыто' },
                    { value: 'published', label: 'Показано' },
                    { value: 'cancelled', label: 'Отменено' },
                  ]}
                />
                <Text size="xs" c="dimmed">
                  Скрытое видит только команда. Если отменить, перенести или сменить место у показанного мероприятия,
                  записавшимся и отметившим «Пойду» придёт сообщение.
                </Text>
              </Stack>
            </Stack>
          </Collapse>
          <Divider />
        </div>

        {willCancel && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
            <Text size="sm">
              {audience ? `${audience} получат сообщение об отмене.` : 'Активность пропадёт из расписания участников.'}
            </Text>
          </Alert>
        )}
        {!willCancel && startsChanged && activity?.status === 'published' && audience && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
            <Text size="sm">Время начала изменено - {audience.charAt(0).toLowerCase() + audience.slice(1)} получат сообщение о переносе.</Text>
          </Alert>
        )}
        {!willCancel && !startsChanged && locationChanged && activity?.status === 'published' && audience && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
            <Text size="sm">Место изменено - {audience.charAt(0).toLowerCase() + audience.slice(1)} получат сообщение о новом месте.</Text>
          </Alert>
        )}

        <ModalActions justify={activity ? 'space-between' : 'flex-end'}>
          {activity && (
            <Button variant="subtle" color="red" onClick={onDelete} loading={removeActivity.pending}>
              Удалить
            </Button>
          )}
          <Group gap="sm">
            <Button variant="default" onClick={onDone}>
              Отмена
            </Button>
            <Button type="submit" loading={create.isPending || update.isPending}>
              {activity ? 'Сохранить' : 'Создать'}
            </Button>
          </Group>
        </ModalActions>
      </Stack>
    </form>
  );
}
