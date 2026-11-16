import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  Drawer,
  Group,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { DatePickerInput, TimePicker } from '@mantine/dates';
import { COUNSELOR_AUDIENCE_LABELS, type CounselingBookingRow, type CounselorAdminView, type CounselorAudience } from '@sof/shared';
import {
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconHeartHandshake,
  IconInfoCircle,
  IconPencil,
  IconPlus,
  IconPrinter,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import {
  useCancelCounselingBooking,
  useCounseling,
  useDeleteCounselor,
  useSaveCounselor,
} from '../../api/counseling.ts';
import { useRooms } from '../../api/seminars.ts';
import { useInternalLink } from '../../components/AppLink.tsx';
import { AppModal, ModalActions, useIsMobile } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { TzHint } from '../../components/dates.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { PrintSheet, printSheet } from '../../components/PrintSheet.tsx';
import { ProgramSwitches } from '../../components/ProgramSwitches.tsx';
import { BlockSkeleton } from '../../components/states.tsx';
import { capitalizeFirst, countLabel, formatDayLong, formatTime } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { dayKey, isoToWall, wallToIso } from '../../lib/tz.ts';

const SLOTS: [string, string, string] = ['окошко', 'окошка', 'окошек'];
const BOOKINGS: [string, string, string] = ['запись', 'записи', 'записей'];
export const COUNSELORS: [string, string, string] = ['служитель', 'служителя', 'служителей'];

/** Служители прошлого года - чтобы не вбивать заново. */
export const LAST_YEAR = [
  { name: 'Савчук Александр', place: '231 ауд. ТИ, 2-й этаж' },
  { name: 'Кот Евгений', place: '504 каб. церкви, 5-й этаж' },
  { name: 'Кисляк Демид', place: '503 каб. церкви' },
  { name: 'Трофимчик Владимир', place: '403 каб. церкви, 4-й этаж' },
  { name: 'Милькота Кирилл', place: '505 каб. церкви' },
  { name: 'Бадей Павел', place: '506 каб. церкви' },
  { name: 'Сонич Владимир', place: '327 ауд. ТИ, 3-й этаж' },
  { name: 'Цвор Вадим', place: '233 ауд. ТИ, 2-й этаж' },
];

// ---------- окно приёма ----------

export interface WindowValue {
  day: string | null;
  from: string;
  to: string;
  minutes: number | string;
}

export const DEFAULT_WINDOW: WindowValue = { day: null, from: '16:00', to: '18:00', minutes: 20 };

export function windowOf(c: CounselorAdminView, tz: string): WindowValue {
  return {
    day: dayKey(c.startsAt, tz),
    from: isoToWall(c.startsAt, tz)?.slice(11, 16) ?? DEFAULT_WINDOW.from,
    to: isoToWall(c.endsAt, tz)?.slice(11, 16) ?? DEFAULT_WINDOW.to,
    minutes: c.slotMinutes,
  };
}

function windowIso(w: WindowValue, tz: string): { startsAt: string | null; endsAt: string | null } {
  const at = (hm: string) => (w.day && /^\d{2}:\d{2}$/.test(hm) ? wallToIso(`${w.day} ${hm}:00`, tz) : null);
  return { startsAt: at(w.from), endsAt: at(w.to) };
}

/** Окошки, как их считает сервер: последнее целиком помещается в окно. */
function previewSlots(startsAt: string | null, endsAt: string | null, minutes: number): string[] {
  if (!startsAt || !endsAt || !Number.isInteger(minutes) || minutes < 5) return [];
  const out: string[] = [];
  const step = minutes * 60_000;
  const end = new Date(endsAt).getTime();
  for (let t = new Date(startsAt).getTime(); t + step <= end && out.length < 96; t += step) out.push(new Date(t).toISOString());
  return out;
}

/** Ошибка окна для формы или null. */
function windowError(w: WindowValue, tz: string): string | null {
  const { startsAt, endsAt } = windowIso(w, tz);
  const minutes = Number(w.minutes);
  if (!startsAt || !endsAt) return 'Укажите день и время';
  if (new Date(endsAt) <= new Date(startsAt)) return 'Окончание раньше начала';
  if (!Number.isInteger(minutes) || minutes < 5) return 'Окошко - от 5 минут';
  if (previewSlots(startsAt, endsAt, minutes).length === 0) return 'В окно не помещается ни одного окошка';
  return null;
}

/** Окно: «16:00–18:00». */
export const windowText = (c: { startsAt: string; endsAt: string }, tz: string) => `${formatTime(c.startsAt, tz)}–${formatTime(c.endsAt, tz)}`;

function WindowFields({ value, onChange }: { value: WindowValue; onChange: (v: WindowValue) => void }) {
  const time = (key: 'from' | 'to') => (t: string) => {
    // Пока время введено не полностью, TimePicker отдаёт пустую строку - прежнее не стираем.
    const hm = t.slice(0, 5);
    if (/^\d{2}:\d{2}$/.test(hm)) onChange({ ...value, [key]: hm });
  };
  return (
    <>
      <DatePickerInput
        label="День"
        required
        placeholder="Выберите день"
        valueFormat="dddd, D MMMM"
        leftSection={<IconCalendar size={16} />}
        value={value.day}
        onChange={(d) => onChange({ ...value, day: d ? String(d).slice(0, 10) : null })}
        popoverProps={{ withinPortal: true }}
      />
      <SimpleGrid cols={3} spacing="xs">
        <TimePicker
          label="С"
          required
          format="24h"
          withDropdown
          minutesStep={5}
          leftSection={<IconClock size={16} />}
          value={value.from}
          onChange={time('from')}
          popoverProps={{ withinPortal: true }}
        />
        <TimePicker
          label="До"
          required
          format="24h"
          withDropdown
          minutesStep={5}
          leftSection={<IconClock size={16} />}
          value={value.to}
          onChange={time('to')}
          popoverProps={{ withinPortal: true }}
        />
        <NumberInput
          label="Окошко, мин"
          required
          min={5}
          max={240}
          step={5}
          allowDecimal={false}
          value={value.minutes}
          onChange={(m) => onChange({ ...value, minutes: m })}
        />
      </SimpleGrid>
    </>
  );
}

function SlotsHint({ w, tz }: { w: WindowValue; tz: string }) {
  const { startsAt, endsAt } = windowIso(w, tz);
  const slots = previewSlots(startsAt, endsAt, Number(w.minutes));
  return (
    <Text size="sm" c="dimmed">
      {slots.length
        ? `${capitalizeFirst(countLabel(slots.length, SLOTS))}: ${slots.map((s) => formatTime(s, tz)).join(', ')}`
        : 'Окошек нет - проверьте время'}
    </Text>
  );
}

// ---------- служитель ----------

export function CounselorModal({
  counselor,
  defaults,
  opened,
  onClose,
}: {
  counselor: CounselorAdminView | null;
  defaults: WindowValue;
  opened: boolean;
  onClose: () => void;
}) {
  const tz = useEventTz();
  const rooms = useRooms();
  const save = useSaveCounselor();
  const [name, setName] = useState(counselor?.name ?? '');
  const [place, setPlace] = useState(counselor?.place ?? '');
  const [audience, setAudience] = useState<CounselorAudience>(counselor?.audience ?? 'all');
  const [tags, setTags] = useState<string[]>(counselor?.tags ?? []);
  const [win, setWin] = useState<WindowValue>(() => (counselor ? windowOf(counselor, tz) : defaults));
  const [error, setError] = useState<string | null>(null);
  const { startsAt, endsAt } = windowIso(win, tz);
  const slots = previewSlots(startsAt, endsAt, Number(win.minutes));
  // Записи, которые не попадут в новые окошки, сервер отменит и сообщит людям.
  const lost = counselor ? counselor.bookings.filter((b) => !slots.includes(b.slotStart)).length : 0;
  // Стал принимать только девушек (или парней) - записи другого пола сервер отменит и сообщит людям.
  const misfit = counselor && audience !== 'all' ? counselor.bookings.filter((b) => b.gender !== audience && slots.includes(b.slotStart)).length : 0;
  // Сменили место - остальным записанным (чьё окошко ещё впереди) сервер пришлёт новое место.
  const placeChanged = counselor ? (place.trim() || null) !== (counselor.place ?? null) : false;
  const toNotify = counselor
    ? counselor.bookings.filter((b) => slots.includes(b.slotStart) && new Date(b.slotStart).getTime() > Date.now()).length
    : 0;
  const placeOptions = [...new Set((rooms.data ?? []).map((r) => r.name))];

  const submit = () => {
    if (!name.trim()) return setError('Как зовут служителя?');
    const bad = windowError(win, tz);
    if (bad) return setError(bad);
    save.mutate(
      {
        id: counselor?.id ?? null,
        input: { name: name.trim(), place: place.trim() || null, startsAt: startsAt!, endsAt: endsAt!, slotMinutes: Number(win.minutes), audience, tags },
      },
      {
        onSuccess: () => {
          notifySuccess(counselor ? 'Сохранено' : 'Служитель добавлен', name.trim());
          onClose();
        },
        onError: (err) => notifyError(err),
      },
    );
  };

  return (
    <AppModal opened={opened} onClose={onClose} size="lg" title={<Text fw={700}>{counselor ? 'Изменить служителя' : 'Новый служитель'}</Text>}>
      <Stack gap="sm">
        <TextInput label="Имя" placeholder="Кот Евгений" required value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Autocomplete
          label="Место"
          description="Где служитель принимает - участники увидят это в записи"
          placeholder="504 каб. церкви, 5-й этаж"
          data={placeOptions}
          value={place}
          onChange={setPlace}
          comboboxProps={{ withinPortal: true }}
        />
        <div>
          <Text size="sm" fw={500} mb={4}>
            Кого принимает
          </Text>
          <SegmentedControl
            fullWidth
            value={audience}
            onChange={(v) => setAudience(v as CounselorAudience)}
            data={[
              { value: 'all', label: 'Всех' },
              { value: 'f', label: 'Только девушек' },
              { value: 'm', label: 'Только парней' },
            ]}
          />
          <Text size="xs" c="dimmed" mt={4}>
            {audience === 'all'
              ? 'Записаться может любой.'
              : `У служителя будет метка «${COUNSELOR_AUDIENCE_LABELS[audience]}». ${audience === 'f' ? 'Парни' : 'Девушки'} видят время, но записаться не могут.`}
          </Text>
        </div>
        <TagsInput
          label="Свои метки"
          description="Просто подпись у служителя, ни на что не влияет: «на русском», «для пар». Enter - добавить."
          placeholder={tags.length ? '' : 'Например: для пар'}
          maxTags={4}
          value={tags}
          onChange={(v) => setTags(v.map((t) => t.trim().slice(0, 24)).filter(Boolean))}
          comboboxProps={{ withinPortal: true }}
        />
        <WindowFields value={win} onChange={setWin} />
        <TzHint />
        <SlotsHint w={win} tz={tz} />
        {misfit > 0 && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            {capitalizeFirst(countLabel(misfit, BOOKINGS))} - {audience === 'f' ? 'парни' : 'девушки'}: они отменятся, людям придёт сообщение.
          </Alert>
        )}
        {lost > 0 && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            {capitalizeFirst(countLabel(lost, BOOKINGS))} не попадут в новые окошки - они отменятся, людям придёт сообщение.
          </Alert>
        )}
        {placeChanged && toNotify > 0 && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            Место изменено - записанным ({countLabel(toNotify, BOOKINGS)}) придёт сообщение с новым местом.
          </Alert>
        )}
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Сохранить
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

/**
 * Душепопечение одним действием: день и время для всех, кого добавить - служители прошлого года галочками
 * и новые имена (место им можно указать потом). `onDone` получает день - расписание откроет его настройку.
 */
export function CounselingSetupModal({
  existing,
  defaults,
  opened,
  onClose,
  onDone,
}: {
  existing: string[];
  defaults: WindowValue;
  opened: boolean;
  onClose: () => void;
  onDone?: (day: string) => void;
}) {
  const tz = useEventTz();
  const save = useSaveCounselor();
  const fresh = LAST_YEAR.filter((c) => !existing.includes(c.name));
  const [picked, setPicked] = useState<string[]>(fresh.map((c) => c.name));
  const [others, setOthers] = useState<string[]>([]);
  const [win, setWin] = useState<WindowValue>(defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const list = [
      ...fresh.filter((x) => picked.includes(x.name)),
      ...others.map((n) => n.trim()).filter((n) => n && !existing.includes(n)).map((name) => ({ name, place: null as string | null })),
    ];
    if (list.length === 0) return setError('Отметьте или впишите, кого добавить');
    const bad = windowError(win, tz);
    if (bad) return setError(bad);
    const { startsAt, endsAt } = windowIso(win, tz);
    setBusy(true);
    let added = 0;
    try {
      for (const c of list) {
        await save.mutateAsync({
          id: null,
          input: { name: c.name, place: c.place, startsAt: startsAt!, endsAt: endsAt!, slotMinutes: Number(win.minutes), hidden: false, audience: 'all', tags: [] },
        });
        added += 1;
      }
      notifySuccess(`Добавлено служителей: ${added}`, 'Душепопечение');
      onClose();
      onDone?.(win.day!);
    } catch (err) {
      notifyError(err, added ? `Добавлено ${added}, дальше не получилось` : 'Не получилось');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal opened={opened} onClose={onClose} size="lg" title={<Text fw={700}>Душепопечение</Text>}>
      <Stack gap="sm">
        <WindowFields value={win} onChange={setWin} />
        <TzHint />
        <SlotsHint w={win} tz={tz} />
        <Checkbox.Group label="Служители прошлого года" value={picked} onChange={setPicked}>
          <Stack gap={6} mt="xs">
            {LAST_YEAR.map((c) => {
              const added = existing.includes(c.name);
              return (
                <Checkbox key={c.name} value={c.name} disabled={added} label={`${c.name} - ${c.place}${added ? ' (уже есть)' : ''}`} />
              );
            })}
          </Stack>
        </Checkbox.Group>
        <TagsInput
          label="Другие служители"
          description="Имя и Enter. Место укажете потом в карточке служителя."
          placeholder="Например: Иванов Пётр"
          value={others}
          onChange={setOthers}
          clearable
        />
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Добавить
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

/** Сдвинуть время сразу всем служителям дня: записи, которые не попадут в новые окошки, отменятся с сообщением. */
function BulkTimeModal({ counselors, opened, onClose }: { counselors: CounselorAdminView[]; opened: boolean; onClose: () => void }) {
  const tz = useEventTz();
  const save = useSaveCounselor();
  const [win, setWin] = useState<WindowValue>(() => (counselors[0] ? windowOf(counselors[0], tz) : DEFAULT_WINDOW));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { startsAt, endsAt } = windowIso(win, tz);
  const slots = previewSlots(startsAt, endsAt, Number(win.minutes));
  const lost = counselors.reduce((sum, c) => sum + c.bookings.filter((b) => !slots.includes(b.slotStart)).length, 0);

  const submit = async () => {
    const bad = windowError(win, tz);
    if (bad) return setError(bad);
    setBusy(true);
    try {
      for (const c of counselors) {
        await save.mutateAsync({ id: c.id, input: { startsAt: startsAt!, endsAt: endsAt!, slotMinutes: Number(win.minutes) } });
      }
      notifySuccess('Время обновлено у всех служителей', windowText({ startsAt: startsAt!, endsAt: endsAt! }, tz));
      onClose();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal opened={opened} onClose={onClose} size="lg" title={<Text fw={700}>Время для всех служителей</Text>}>
      <Stack gap="sm">
        <WindowFields value={win} onChange={setWin} />
        <TzHint />
        <SlotsHint w={win} tz={tz} />
        {lost > 0 && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            {capitalizeFirst(countLabel(lost, BOOKINGS))} не попадут в новые окошки - они отменятся, людям придёт сообщение.
          </Alert>
        )}
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <ModalActions>
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Сохранить для {countLabel(counselors.length, COUNSELORS)}
          </Button>
        </ModalActions>
      </Stack>
    </AppModal>
  );
}

// ---------- список для служителя ----------

const dayLine = (c: CounselorAdminView, tz: string) => `${capitalizeFirst(formatDayLong(dayKey(c.startsAt, tz)))}, ${windowText(c, tz)}`;

/** Текст, который админ пересылает служителю: время - имя, телефон. */
function listText(c: CounselorAdminView, tz: string): string {
  const byStart = new Map(c.bookings.map((b) => [b.slotStart, b]));
  const head = [`Душепопечение - ${c.name}`, c.place, dayLine(c, tz)].filter(Boolean);
  const lines = c.slots.map((s) => {
    const b = byStart.get(s);
    return `${formatTime(s, tz)} - ${b ? [b.fullName, b.phone].filter(Boolean).join(', ') : 'свободно'}`;
  });
  return [...head, '', ...lines].join('\n');
}

function PrintList({ counselors, tz }: { counselors: CounselorAdminView[]; tz: string }) {
  return (
    <>
      {counselors.map((c) => {
        const byStart = new Map(c.bookings.map((b) => [b.slotStart, b]));
        return (
          <section key={c.id} className="sof-print-page">
            <h2 className="sof-print-title">Душепопечение - {c.name}</h2>
            <p className="sof-print-sub">{[c.place, dayLine(c, tz)].filter(Boolean).join(' · ')}</p>
            <table className="sof-print-table">
              <tbody>
                {c.slots.map((s) => {
                  const b = byStart.get(s);
                  return (
                    <tr key={s}>
                      <td className="sof-print-time">{formatTime(s, tz)}</td>
                      <td>{b?.fullName ?? ''}</td>
                      <td>{b?.phone ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </>
  );
}

/** Печать списков: лист рисуется синхронно, печатается и убирается. */
export function usePrintLists() {
  const tz = useEventTz();
  const [printing, setPrinting] = useState<CounselorAdminView[] | null>(null);
  const print = (list: CounselorAdminView[]) => {
    flushSync(() => setPrinting(list));
    printSheet();
    setPrinting(null);
  };
  const sheet = printing ? (
    <PrintSheet>
      <PrintList counselors={printing} tz={tz} />
    </PrintSheet>
  ) : null;
  return { print, sheet };
}

/**
 * Служитель: записанные - строками с телефоном и отменой, свободные окошки - одной строкой.
 * Так карточка короткая и на телефоне, а полный список уходит служителю кнопками ниже.
 */
/** Метки служителя: «Для девушек» / «Для парней» (проверяются при записи) и свои - просто подпись. */
export function CounselorBadges({ c, mt }: { c: Pick<CounselorAdminView, 'audience' | 'tags'>; mt?: number }) {
  if (c.audience === 'all' && c.tags.length === 0) return null;
  return (
    <Group gap={6} mt={mt}>
      {c.audience !== 'all' && (
        <Badge color={c.audience === 'f' ? 'pink' : 'blue'} variant="filled" radius="xl">
          {COUNSELOR_AUDIENCE_LABELS[c.audience]}
        </Badge>
      )}
      {c.tags.map((t) => (
        <Badge key={t} color="gray" variant="light" radius="xl">
          {t}
        </Badge>
      ))}
    </Group>
  );
}

export function CounselorCard({ c, onEdit, onPrint }: { c: CounselorAdminView; onEdit: () => void; onPrint: () => void }) {
  const tz = useEventTz();
  const remove = useDeleteCounselor();
  const save = useSaveCounselor();
  const toggleHidden = () =>
    save.mutate(
      { id: c.id, input: { hidden: !c.hidden } },
      {
        onSuccess: () => notifySuccess(c.hidden ? 'Служитель снова виден участникам' : 'Служитель скрыт от участников', c.name),
        onError: (err) => notifyError(err),
      },
    );
  const cancel = useCancelCounselingBooking();
  const confirm = useConfirm();
  const booked = new Set(c.bookings.map((b) => b.slotStart));
  const free = c.slots.filter((s) => !booked.has(s));
  const full = c.slots.length > 0 && free.length === 0;

  const del = async () => {
    const ok = await confirm({
      title: 'Удалить служителя?',
      message: c.bookings.length
        ? `К нему записано ${countLabel(c.bookings.length, ['человек', 'человека', 'человек'])} - их записи отменятся, придёт сообщение.`
        : `«${c.name}» пропадёт из записи.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (ok) remove.mutate(c.id, { onSuccess: () => notifySuccess('Служитель удалён', c.name), onError: (err) => notifyError(err) });
  };

  const cancelBooking = async (b: CounselingBookingRow) => {
    const ok = await confirm({
      title: 'Отменить запись?',
      message: `${b.fullName}, ${formatTime(b.slotStart, tz)}. Человеку придёт сообщение, что запись отменили организаторы.`,
      confirmLabel: 'Отменить запись',
      danger: true,
    });
    if (ok) cancel.mutate(b.id, { onSuccess: () => notifySuccess('Запись отменена', b.fullName), onError: (err) => notifyError(err) });
  };

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
        <div style={{ minWidth: 0 }}>
          <Text fw={700} size="lg" lh={1.25}>
            {c.name}
          </Text>
          <Text size="sm" c={c.place ? undefined : 'red'}>
            {c.place ?? 'Место не указано'}
          </Text>
          <Text size="sm" c="dimmed">
            {dayLine(c, tz)} · по {c.slotMinutes} мин
          </Text>
          <CounselorBadges c={c} mt={6} />
        </div>
        <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
          {c.hidden && (
            <Badge color="gray" variant="outline" mr={4}>
              скрыт
            </Badge>
          )}
          <Badge color={full ? 'red' : c.bookings.length ? 'teal' : 'gray'} variant="light" mr={4}>
            {c.bookings.length} из {c.slots.length}
          </Badge>
          <Tooltip label={c.hidden ? 'Скрыт от участников - показать' : 'Виден участникам - скрыть'}>
            <ActionIcon
              variant="subtle"
              color={c.hidden ? 'gray' : undefined}
              loading={save.isPending}
              onClick={toggleHidden}
              aria-label={c.hidden ? `Показать участникам: ${c.name}` : `Скрыть от участников: ${c.name}`}
            >
              {c.hidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Изменить">
            <ActionIcon variant="subtle" onClick={onEdit} aria-label={`Изменить: ${c.name}`}>
              <IconPencil size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Удалить">
            <ActionIcon variant="subtle" color="red" onClick={() => void del()} loading={remove.isPending} aria-label={`Удалить: ${c.name}`}>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {c.bookings.length > 0 && (
        <Stack gap={0} mt="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
          {c.bookings.map((b) => (
            <Group
              key={b.id}
              gap="sm"
              wrap="nowrap"
              py={6}
              style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
            >
              <Text size="sm" fw={700} w={44} className="sof-tabular" style={{ flexShrink: 0 }}>
                {formatTime(b.slotStart, tz)}
              </Text>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Text size="sm" fw={500} truncate>
                  {b.fullName}
                </Text>
                {(b.phone || b.telegramUsername) && (
                  <Text size="xs" c="dimmed" truncate>
                    {[b.phone, b.telegramUsername ? `@${b.telegramUsername}` : null].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </div>
              <Tooltip label="Отменить запись">
                <ActionIcon color="red" variant="subtle" onClick={() => void cancelBooking(b)} aria-label={`Отменить запись: ${b.fullName}`}>
                  <IconX size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
        </Stack>
      )}
      <Text size="sm" c="dimmed" mt="sm">
        {free.length === 0
          ? 'Свободных окошек нет'
          : `${free.length === c.slots.length ? 'Все свободны' : `Свободно ${free.length}`}: ${free.map((s) => formatTime(s, tz)).join(' · ')}`}
      </Text>

      <Group gap="xs" mt="sm">
        <CopyButton value={listText(c, tz)} timeout={1500}>
          {({ copied, copy }) => (
            <Button
              size="xs"
              variant="light"
              color={copied ? 'teal' : undefined}
              leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              onClick={copy}
            >
              {copied ? 'Скопировано' : 'Скопировать список'}
            </Button>
          )}
        </CopyButton>
        <Button size="xs" variant="default" leftSection={<IconPrinter size={14} />} onClick={onPrint}>
          Печать
        </Button>
      </Group>
    </Card>
  );
}

// ---------- из расписания ----------

/** Душепопечение одного дня в боковой панели расписания: общая запись, время для всех, служители. */
export function CounselingDrawer({ day, opened, onClose }: { day: string | null; opened: boolean; onClose: () => void }) {
  const tz = useEventTz();
  const mobile = useIsMobile();
  const q = useCounseling(opened);
  const [edit, setEdit] = useState<{ opened: boolean; counselor: CounselorAdminView | null; key: number }>({ opened: false, counselor: null, key: 0 });
  const [bulk, setBulk] = useState({ opened: false, key: 0 });
  const [setup, setSetup] = useState({ opened: false, key: 0 });
  const allLink = useInternalLink('/counseling', onClose);
  const list = (q.data?.counselors ?? []).filter((c) => day !== null && dayKey(c.startsAt, tz) === day);
  const booked = list.reduce((s, c) => s + c.bookings.length, 0);
  const slots = list.reduce((s, c) => s + c.slots.length, 0);
  const defaults = list[0] ? windowOf(list[0], tz) : { ...DEFAULT_WINDOW, day };
  const from = list.reduce<string | null>((m, c) => (!m || c.startsAt < m ? c.startsAt : m), null);
  const to = list.reduce<string | null>((m, c) => (!m || c.endsAt > m ? c.endsAt : m), null);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={mobile ? '100%' : 520}
      title={
        <Group gap="xs">
          <IconHeartHandshake size={18} />
          <Text fw={700}>Душепопечение</Text>
        </Group>
      }
    >
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : (
        <Stack gap="md">
          <div>
            <Text fw={700} size="lg">
              {day ? capitalizeFirst(formatDayLong(day)) : ''}
              {from && to ? `, ${windowText({ startsAt: from, endsAt: to }, tz)}` : ''}
            </Text>
            <Text size="sm" c="dimmed">
              {countLabel(list.length, COUNSELORS)} · записано {booked} из {slots}
            </Text>
          </div>
          <ProgramSwitches only={['counseling']} card={false} />
          <Group gap="xs" grow={mobile}>
            {list.length > 0 && (
              <Button variant="default" leftSection={<IconClock size={16} />} onClick={() => setBulk((s) => ({ opened: true, key: s.key + 1 }))}>
                Время для всех
              </Button>
            )}
            <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setEdit((s) => ({ opened: true, counselor: null, key: s.key + 1 }))}>
              Служитель
            </Button>
            {LAST_YEAR.some((x) => !(q.data?.counselors ?? []).some((c) => c.name === x.name)) && (
              <Button variant="subtle" onClick={() => setSetup((s) => ({ opened: true, key: s.key + 1 }))}>
                Прошлого года
              </Button>
            )}
          </Group>

          {list.length === 0 ? (
            <Text c="dimmed" size="sm">
              В этот день служителей нет.
            </Text>
          ) : (
            <Stack gap={0} style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
              {list.map((c) => (
                <UnstyledButton
                  key={c.id}
                  onClick={() => setEdit((s) => ({ opened: true, counselor: c, key: s.key + 1 }))}
                  py="sm"
                  style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
                >
                  <Group gap="sm" wrap="nowrap">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Text fw={600} size="sm" truncate>
                        {c.name}
                      </Text>
                      <Text size="xs" c={c.place ? 'dimmed' : 'red'} truncate>
                        {c.place ?? 'Место не указано'} · {windowText(c, tz)}
                      </Text>
                      <CounselorBadges c={c} mt={4} />
                    </div>
                    <Badge variant="light" color={c.bookings.length >= c.slots.length ? 'red' : c.bookings.length ? 'teal' : 'gray'} style={{ flexShrink: 0 }}>
                      {c.bookings.length} из {c.slots.length}
                    </Badge>
                    <IconChevronRight size={16} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
                  </Group>
                </UnstyledButton>
              ))}
            </Stack>
          )}

          <Button component="a" variant="subtle" rightSection={<IconArrowRight size={16} />} {...allLink}>
            Списки записавшихся и печать
          </Button>
        </Stack>
      )}
      <CounselorModal
        key={`c-${edit.key}`}
        counselor={edit.counselor}
        defaults={defaults}
        opened={edit.opened}
        onClose={() => setEdit((s) => ({ ...s, opened: false }))}
      />
      <BulkTimeModal key={`b-${bulk.key}`} counselors={list} opened={bulk.opened} onClose={() => setBulk((s) => ({ ...s, opened: false }))} />
      <CounselingSetupModal
        key={`s-${setup.key}`}
        existing={(q.data?.counselors ?? []).map((c) => c.name)}
        defaults={defaults}
        opened={setup.opened}
        onClose={() => setSetup((s) => ({ ...s, opened: false }))}
      />
    </Drawer>
  );
}
