import { Badge, Button, Card, Checkbox, Collapse, Group, NumberInput, SimpleGrid, Stack, Switch, Text, Title } from '@mantine/core';
import type { MerchSettings, MerchSettingsView } from '@sof/shared';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useMerchSettings, useSaveMerchSettings } from '../../api/merch.ts';
import { EventDateTimeInput, TzHint } from '../../components/dates.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { isoToWall, wallToIso } from '../../lib/tz.ts';
import { numberOrNull } from '../../lib/validation.ts';

type Draft = Omit<MerchSettings, 'merchReservationHours' | 'merchConfirmAt' | 'merchConfirmHours'> & {
  merchReservationHours: number | string;
  /** Время вопроса по часам конференции («2026-11-06 13:30:00»). */
  merchConfirmAt: string | null;
  merchConfirmHours: number | string;
};

const toDraft = (s: MerchSettingsView, tz: string): Draft => ({
  merchVisible: s.merchVisible,
  merchAdminsOnly: s.merchAdminsOnly,
  merchSalesEnabled: s.merchSalesEnabled,
  merchSelfBooking: s.merchSelfBooking,
  merchReservationHours: s.merchReservationHours ?? '',
  merchOnlinePayment: s.merchOnlinePayment,
  merchPaymentInstructions: s.merchPaymentInstructions,
  merchConfirmAt: isoToWall(s.merchConfirmAt, tz),
  merchConfirmHours: s.merchConfirmHours,
  merchConfirmDrop: s.merchConfirmDrop,
  merchNotify: s.merchNotify,
});

const toSettings = (d: Draft, tz: string): MerchSettings => ({
  ...d,
  merchReservationHours: numberOrNull(d.merchReservationHours),
  merchConfirmAt: wallToIso(d.merchConfirmAt, tz),
  merchConfirmHours: numberOrNull(d.merchConfirmHours) ?? 3,
});

/** «16:30» и «6 ноября» по часам конференции. */
const clock = (d: Date, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
const dayLabel = (d: Date, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long' }).format(d);

/** Поля, которые отличаются от сохранённых. */
function changed(next: MerchSettings, base: MerchSettings): Partial<MerchSettings> {
  const out: Partial<Record<keyof MerchSettings, unknown>> = {};
  // Отметки «кому копии» - объект: сравниваем содержимое.
  for (const k of Object.keys(next) as (keyof MerchSettings)[]) if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) out[k] = next[k];
  return out as Partial<MerchSettings>;
}

/** Показ витрины, бронь и оплата: продавец управляет ими сам, как админ. Черновик и одна кнопка «Сохранить». */
export default function SettingsPanel() {
  const settings = useMerchSettings();
  if (settings.isPending) return <BlockSkeleton rows={2} height={140} />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  return <SettingsForm settings={settings.data} />;
}

function SettingsForm({ settings }: { settings: MerchSettingsView }) {
  const tz = useEventTz();
  const save = useSaveMerchSettings();
  const [draft, setDraft] = useState(() => toDraft(settings, tz));
  const patch = changed(toSettings(draft, tz), toSettings(toDraft(settings, tz), tz));
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // Настройки поменял кто-то другой - подтягиваем, пока здесь ничего не правят.
  useEffect(() => {
    if (!dirty) setDraft(toDraft(settings, tz));
    // Зависимость - только новые настройки с сервера.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const hours = numberOrNull(draft.merchReservationHours);
  const badHours = hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 1440);
  const askHours = numberOrNull(draft.merchConfirmHours);
  const badAsk = askHours === null || !Number.isInteger(askHours) || askHours < 1 || askHours > 48;
  const askAt = wallToIso(draft.merchConfirmAt, tz);
  const askBy = askAt && !badAsk ? new Date(Date.parse(askAt) + askHours! * 3600_000) : null;

  return (
    <Card>
      <Stack gap="md">
        <div>
          <Title order={4} fz="md">
            Витрина и бронь
          </Title>
          <Text size="sm" c="dimmed">
            Пока витрина выключена - её не видит никто, даже команда. Вещи, фото и 3D - на вкладке «Товары».
          </Text>
        </div>
        <Switch label="Показывать витрину" checked={draft.merchVisible} onChange={(e) => set('merchVisible', e.currentTarget.checked)} />
        <Switch
          label="Только администраторам"
          description="Витрину (и бронь, если включена) видят только админы и продавцы - проверить всё перед показом участникам. Снимите галочку, чтобы открыть всем."
          disabled={!draft.merchVisible}
          checked={draft.merchAdminsOnly}
          onChange={(e) => set('merchAdminsOnly', e.currentTarget.checked)}
        />
        <Switch
          label="Бронь и продажа"
          description={
            draft.merchAdminsOnly
              ? 'Пока стоит «Только администраторам» - бронировать и оплачивать могут только админы и продавцы: проверьте всё до открытия участникам.'
              : 'Выключено - только витрина.'
          }
          disabled={!draft.merchVisible}
          checked={draft.merchSalesEnabled}
          onChange={(e) => set('merchSalesEnabled', e.currentTarget.checked)}
        />
        <Collapse expanded={draft.merchVisible && draft.merchSalesEnabled}>
          <Switch
            mb="sm"
            label="Бронь сами в приложении"
            description={
              draft.merchSelfBooking
                ? 'Кнопка «Забронировать»: бронь сразу, остаток уменьшается.'
                : 'Выбирают размер и нажимают «Забронировать / спросить» - заявка приходит в переписку «Мерч». Бронирует команда мерча, остаток уменьшается только тогда.'
            }
            checked={draft.merchSelfBooking}
            onChange={(e) => set('merchSelfBooking', e.currentTarget.checked)}
          />
          <Switch
            mb="sm"
            label="Оплата переводом в приложении"
            description={
              settings.transfersEnabled
                ? 'Реквизиты - те же, что для взноса. Выключите - останется только бронь: оплата наличными или картой у стола мерча.'
                : 'Переводы выключены в общих «Настройках» - пока за мерч платят только на месте.'
            }
            disabled={!settings.transfersEnabled}
            checked={draft.merchOnlinePayment}
            onChange={(e) => set('merchOnlinePayment', e.currentTarget.checked)}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <NumberInput
              label="Снять неоплаченную бронь через, часов"
              description="Пусто - не снимать"
              min={1}
              max={1440}
              allowDecimal={false}
              placeholder="Не снимать"
              error={badHours ? 'От 1 до 1440 часов' : undefined}
              value={draft.merchReservationHours}
              onChange={(v) => set('merchReservationHours', v)}
            />
          </SimpleGrid>
          <Title order={5} fz="sm" mt="md">
            «Точно заберёте?»
          </Title>
          <Text size="sm" c="dimmed" mb="xs">
            В это время всем с неоплаченной бронью (и своей, и сделанной командой в переписке) придёт сообщение в бот, а в приложении на главной - вопрос с
            отсчётом. Нажали «Да, заберу» - вопрос пропадает. Оплаченным, но не забранным - напоминание забрать.
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <EventDateTimeInput
              label="Когда спросить"
              description="Пусто - не спрашивать"
              clearable
              value={draft.merchConfirmAt}
              onChange={(v) => set('merchConfirmAt', v)}
            />
            <NumberInput
              label="Сколько часов на ответ"
              min={1}
              max={48}
              allowDecimal={false}
              error={badAsk ? 'От 1 до 48 часов' : undefined}
              value={draft.merchConfirmHours}
              onChange={(v) => set('merchConfirmHours', v)}
            />
          </SimpleGrid>
          <Switch
            mt="sm"
            label="Не ответили вовремя - снять бронь"
            description={
              draft.merchConfirmDrop
                ? 'Вещи вернутся в витрину. Подтверждённые раньше брони не снимаем.'
                : 'Бронь остаётся - только напоминаем.'
            }
            checked={draft.merchConfirmDrop}
            onChange={(e) => set('merchConfirmDrop', e.currentTarget.checked)}
          />
          {askAt && askBy && (
            <Text size="sm" mt={6}>
              {dayLabel(new Date(askAt), tz)}: спросим в <b>{clock(new Date(askAt), tz)}</b>, ответить - до <b>{clock(askBy, tz)}</b>.
              {askBy.getTime() < Date.now() ? ' Это время уже прошло.' : ''}
            </Text>
          )}
          <TzHint tz={tz} />
        </Collapse>
        <NotifyPeople
          people={settings.merchNotifyPeople}
          value={draft.merchNotify}
          onChange={(userId, on) => set('merchNotify', { ...draft.merchNotify, [String(userId)]: on })}
        />
        <Group justify="flex-end">
          {dirty && (
            <Button variant="subtle" color="gray" onClick={() => setDraft(toDraft(settings, tz))}>
              Отменить
            </Button>
          )}
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            disabled={!dirty || badHours || badAsk}
            loading={save.isPending}
            onClick={() =>
              save.mutate(patch, {
                onSuccess: (data) => {
                  setDraft(toDraft(data, tz));
                  notifySuccess('Настройки мерча сохранили');
                },
                onError: (e) => notifyError(e),
              })
            }
          >
            Сохранить
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

const ROLE_SHORT: Record<string, string> = { seller: 'Продавец', admin: 'Админ', superadmin: 'Суперадмин' };

/** Кому копии сообщений из папки «Мерч» в бот: продавцы - по умолчанию да, админы - нет. */
function NotifyPeople({
  people,
  value,
  onChange,
}: {
  people: MerchSettingsView['merchNotifyPeople'];
  value: Record<string, boolean>;
  onChange: (userId: number, on: boolean) => void;
}) {
  if (people.length === 0) return null;
  return (
    <div>
      <Title order={4} fz="md">
        Копии сообщений из «Мерча» в бот
      </Title>
      <Text size="sm" c="dimmed" mb="xs">
        Написали в папку «Мерч» - копия приходит в бот с кнопкой «Открыть переписку».
      </Text>
      <Stack gap={6}>
        {people.map((p) => (
          <Checkbox
            key={p.userId}
            checked={value[String(p.userId)] ?? p.on}
            onChange={(e) => onChange(p.userId, e.currentTarget.checked)}
            label={
              <Group gap={4}>
                <Text size="sm">{p.name}</Text>
                {p.roles.map((r) => (
                  <Badge key={r} size="xs" variant="light" color={r === 'seller' ? 'pink' : 'gray'}>
                    {ROLE_SHORT[r] ?? r}
                  </Badge>
                ))}
              </Group>
            }
          />
        ))}
      </Stack>
    </div>
  );
}
