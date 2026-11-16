import {
  Alert,
  Affix,
  Button,
  Card,
  Collapse,
  ColorInput,
  Fieldset,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
  Transition,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { BRACELET_LABELS, BRACELET_MEANING, DEFAULT_TIERS, TIERS, isFreeTier, settingsSchema, textOn, type Bracelet, type Settings, type Tier } from '@sof/shared';
import { IconAlertTriangle, IconDeviceFloppy, IconInfoCircle, IconLock } from '@tabler/icons-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useSaveSettings, useSettingsQuery } from '../../api/settings.ts';
import { EventDateTimeInput, TzHint } from '../../components/dates.tsx';
import { AppLink } from '../../components/AppLink.tsx';
import { CopyValue } from '../../components/CopyValue.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { ProgramSwitches } from '../../components/ProgramSwitches.tsx';
import { useCan } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, ErrorState } from '../../components/states.tsx';
import { notifySuccess } from '../../lib/notify.tsx';
import { isoToWall, isValidTimeZone, offsetLabel, safeTimeZone, timeZoneList, wallToIso } from '../../lib/tz.ts';
import { emptyToNull, numberOrNull, schemaErrors, serverErrors } from '../../lib/validation.ts';

const BOT = import.meta.env.VITE_BOT_USERNAME?.replace(/^@/, '');
/** Экран «Конец «Шага веры»» в боте - посмотреть, как выглядит, до включения. */
const END_PREVIEW = BOT ? `https://t.me/${BOT}?startapp=end` : null;

interface Values {
  eventName: string;
  eventTimezone: string;
  eventStartsAt: string | null;
  eventEndsAt: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  onSiteRegistration: boolean;
  maxParticipantsPerAccount: number | string;
  totalCapacity: number | string;
  activityRegistrationOpen: boolean;
  scheduleVisible: boolean;
  counselingOpen: boolean;
  seminarAutoPlan: boolean;
  /** Правится на странице «Душепопечение»; здесь только переносим, чтобы форма не сбросила. */
  counselingTitle: string;
  transfersEnabled: boolean;
  paymentInstructions: string;
  cashInstructions: string;
  tiers: Record<
    Tier,
    { label: string; short: string; description: string; amount: number | string; color: string; limit: number | string; enabled: boolean; bracelet: Bracelet }
  >;
  breakfast: { amount: number | string; limit: number | string; description: string; enabled: boolean };
  paymentsEnabled: boolean;
  allowUnpaidEntry: boolean;
  softPaymentLabels: boolean;
  consentDocumentVersion: string;
  consentDocumentUrl: string;
  photoConsentEnabled: boolean;
  welcomeText: string;
  supportContact: string;
  /** Правятся в «Мерч» → «Настройки»; здесь только переносим, чтобы форма не сбросила. */
  merchVisible: boolean;
  merchAdminsOnly: boolean;
  merchSalesEnabled: boolean;
  merchSelfBooking: boolean;
  merchReservationHours: number | string;
  merchOnlinePayment: boolean;
  merchPaymentInstructions: string;
  // Правят в «Мерч» → «Настройки»; здесь только переносим как есть.
  merchConfirmAt: string | null;
  merchConfirmHours: number;
  merchConfirmDrop: boolean;
  merchNotify: Record<string, boolean>;
  chatNotify: Record<string, boolean>;
  // Правят в «Отзывах»; здесь только переносим.
  feedbackOpen: boolean;
  feedbackAdmins: boolean;
  feedbackWave: string;
  eventEnded: boolean;
  endTitle: string;
  endText: string;
}

function toValues(s: Settings): Values {
  const tz = safeTimeZone(s.eventTimezone);
  return {
    eventName: s.eventName,
    eventTimezone: s.eventTimezone,
    eventStartsAt: isoToWall(s.eventStartsAt, tz),
    eventEndsAt: isoToWall(s.eventEndsAt, tz),
    registrationOpensAt: isoToWall(s.registrationOpensAt, tz),
    registrationClosesAt: isoToWall(s.registrationClosesAt, tz),
    onSiteRegistration: s.onSiteRegistration,
    maxParticipantsPerAccount: s.maxParticipantsPerAccount,
    totalCapacity: s.totalCapacity ?? '',
    activityRegistrationOpen: s.activityRegistrationOpen,
    scheduleVisible: s.scheduleVisible,
    counselingOpen: s.counselingOpen,
    seminarAutoPlan: s.seminarAutoPlan,
    counselingTitle: s.counselingTitle,
    transfersEnabled: s.transfersEnabled,
    paymentInstructions: s.paymentInstructions,
    cashInstructions: s.cashInstructions,
    tiers: Object.fromEntries(TIERS.map((t) => [t, { ...s.tiers[t], limit: s.tiers[t].limit ?? '' }])) as Values['tiers'],
    breakfast: { ...s.breakfast, limit: s.breakfast.limit ?? '' },
    paymentsEnabled: s.paymentsEnabled,
    allowUnpaidEntry: s.allowUnpaidEntry,
    softPaymentLabels: s.softPaymentLabels,
    consentDocumentVersion: s.consentDocumentVersion,
    consentDocumentUrl: s.consentDocumentUrl ?? '',
    photoConsentEnabled: s.photoConsentEnabled,
    welcomeText: s.welcomeText,
    supportContact: s.supportContact ?? '',
    merchVisible: s.merchVisible,
    merchAdminsOnly: s.merchAdminsOnly,
    merchSalesEnabled: s.merchSalesEnabled,
    merchSelfBooking: s.merchSelfBooking,
    merchReservationHours: s.merchReservationHours ?? '',
    merchOnlinePayment: s.merchOnlinePayment,
    merchPaymentInstructions: s.merchPaymentInstructions,
    merchConfirmAt: s.merchConfirmAt,
    merchConfirmHours: s.merchConfirmHours,
    merchConfirmDrop: s.merchConfirmDrop,
    merchNotify: s.merchNotify,
    chatNotify: s.chatNotify,
    feedbackOpen: s.feedbackOpen,
    feedbackAdmins: s.feedbackAdmins,
    feedbackWave: s.feedbackWave,
    eventEnded: s.eventEnded,
    endTitle: s.endTitle,
    endText: s.endText,
  };
}

/** Поля, которые отличаются от исходных (сравниваем уже готовые к отправке значения). */
function changedFields(next: Settings, base: Settings): Partial<Settings> {
  const out: Partial<Record<keyof Settings, unknown>> = {};
  for (const k of Object.keys(next) as (keyof Settings)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) out[k] = next[k];
  }
  return out as Partial<Settings>;
}

function toPayload(v: Values): Settings {
  const tz = safeTimeZone(v.eventTimezone);
  return {
    eventName: v.eventName.trim(),
    eventTimezone: v.eventTimezone.trim(),
    eventStartsAt: wallToIso(v.eventStartsAt, tz),
    eventEndsAt: wallToIso(v.eventEndsAt, tz),
    registrationOpensAt: wallToIso(v.registrationOpensAt, tz),
    registrationClosesAt: wallToIso(v.registrationClosesAt, tz),
    onSiteRegistration: v.onSiteRegistration,
    maxParticipantsPerAccount: numberOrNull(v.maxParticipantsPerAccount) ?? Number.NaN,
    totalCapacity: numberOrNull(v.totalCapacity),
    activityRegistrationOpen: v.activityRegistrationOpen,
    scheduleVisible: v.scheduleVisible,
    counselingOpen: v.counselingOpen,
    seminarAutoPlan: v.seminarAutoPlan,
    counselingTitle: v.counselingTitle,
    transfersEnabled: v.transfersEnabled,
    paymentInstructions: v.paymentInstructions,
    cashInstructions: v.cashInstructions,
    tiers: Object.fromEntries(
      TIERS.map((t) => {
        const x = v.tiers[t];
        return [
          t,
          {
            label: x.label.trim(),
            short: x.short.trim(),
            description: x.description.trim(),
            amount: numberOrNull(x.amount) ?? Number.NaN,
            color: x.color,
            limit: numberOrNull(x.limit),
            enabled: x.enabled,
            bracelet: x.bracelet,
          },
        ];
      }),
    ) as Settings['tiers'],
    breakfast: {
      amount: numberOrNull(v.breakfast.amount) ?? Number.NaN,
      limit: numberOrNull(v.breakfast.limit),
      description: v.breakfast.description.trim(),
      enabled: v.breakfast.enabled,
    },
    paymentsEnabled: v.paymentsEnabled,
    allowUnpaidEntry: v.allowUnpaidEntry,
    softPaymentLabels: v.softPaymentLabels,
    consentDocumentVersion: v.consentDocumentVersion.trim(),
    consentDocumentUrl: emptyToNull(v.consentDocumentUrl),
    photoConsentEnabled: v.photoConsentEnabled,
    welcomeText: v.welcomeText,
    supportContact: emptyToNull(v.supportContact),
    merchVisible: v.merchVisible,
    merchAdminsOnly: v.merchAdminsOnly,
    merchSalesEnabled: v.merchSalesEnabled,
    merchSelfBooking: v.merchSelfBooking,
    merchReservationHours: numberOrNull(v.merchReservationHours),
    merchOnlinePayment: v.merchOnlinePayment,
    merchPaymentInstructions: v.merchPaymentInstructions,
    merchConfirmAt: v.merchConfirmAt,
    merchConfirmHours: v.merchConfirmHours,
    merchConfirmDrop: v.merchConfirmDrop,
    merchNotify: v.merchNotify,
    chatNotify: v.chatNotify,
    feedbackOpen: v.feedbackOpen,
    feedbackAdmins: v.feedbackAdmins,
    feedbackWave: v.feedbackWave,
    eventEnded: v.eventEnded,
    endTitle: v.endTitle.trim(),
    endText: v.endText,
  };
}

export default function SettingsPage() {
  const settings = useSettingsQuery();
  return (
    <Stack gap="md">
      <PageHeader title="Настройки" description="Главное о конференции: название и время, регистрация, оплата и тексты бота." />
      {settings.isPending ? (
        <BlockSkeleton rows={4} height={180} />
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <SettingsForm settings={settings.data} />
      )}
    </Stack>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <Stack gap="md">
        <div>
          <Title order={4} fz="md">
            {title}
          </Title>
          {description && (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          )}
        </div>
        {children}
      </Stack>
    </Card>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
  const can = useCan();
  const readOnly = !can('settings:write');
  const save = useSaveSettings();
  const form = useForm<Values>({
    mode: 'controlled',
    initialValues: toValues(settings),
    validate: (v) => {
      const payload = toPayload(v);
      const errors = schemaErrors(settingsSchema, payload);
      if (!isValidTimeZone(v.eventTimezone)) errors.eventTimezone = 'Неизвестный часовой пояс';
      // Все варианты скрыты - зарегистрироваться было бы не на что.
      if (TIERS.every((t) => !v.tiers[t].enabled)) {
        for (const t of TIERS) errors[`tiers.${t}.enabled`] = 'Хотя бы один вариант должен показываться при регистрации';
      }
      if (payload.eventStartsAt && payload.eventEndsAt && new Date(payload.eventEndsAt) < new Date(payload.eventStartsAt)) {
        errors.eventEndsAt = 'Окончание раньше начала';
      }
      if (
        payload.registrationOpensAt &&
        payload.registrationClosesAt &&
        new Date(payload.registrationClosesAt) <= new Date(payload.registrationOpensAt)
      ) {
        errors.registrationClosesAt = 'Раньше открытия';
      }
      return errors;
    },
  });

  const tzOptions = useMemo(() => {
    const zones = timeZoneList();
    const list = zones.includes(settings.eventTimezone) ? zones : [settings.eventTimezone, ...zones];
    const now = new Date();
    return list.map((z) => ({ value: z, label: isValidTimeZone(z) ? `${z} (${offsetLabel(z, now)})` : z }));
  }, [settings.eventTimezone]);

  const formTz = safeTimeZone(form.values.eventTimezone);
  const tzChanged = form.values.eventTimezone !== settings.eventTimezone;
  const dirty = form.isDirty();

  const load = (s: Settings) => {
    const v = toValues(s);
    form.setInitialValues(v);
    form.setValues(v);
    form.resetDirty(v);
  };

  // Настройки поменялись на других страницах (выключатели записи и т. п.) - подтягиваем, если здесь ничего не правят.
  // Пока форма изменена, не трогаем: при сохранении уйдут только изменённые поля, чужое не откатится.
  useEffect(() => {
    if (!form.isDirty()) load(settings);
    // Зависимость - только новые настройки с сервера (form стабилен).
  }, [settings]);

  const submit = form.onSubmit((values) => {
    const patch = changedFields(toPayload(values), toPayload(form.getInitialValues()));
    if (Object.keys(patch).length === 0) return load(settings);
    save.mutate(patch, {
      onSuccess: (data) => {
        load(data);
        notifySuccess('Настройки сохранили');
      },
      onError: (err) => form.setErrors(serverErrors(err)),
    });
  });

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        {readOnly && (
          <Alert color="gray" variant="light" icon={<IconLock size={18} />} radius="lg">
            Здесь можно только посмотреть - менять настройки могут админ и суперадмин.
          </Alert>
        )}
        <Fieldset disabled={readOnly} variant="unstyled" p={0} m={0}>
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
              <Section title="Конференция" description="Название видно в боте, на QR-кодах и в шапке админки.">
                <TextInput label="Название конференции" required {...form.getInputProps('eventName')} />
                <Select
                  label="Часовой пояс конференции"
                  description="Все даты и время в админке, боте и сканере - по этому поясу"
                  data={tzOptions}
                  searchable
                  allowDeselect={false}
                  limit={80}
                  nothingFoundMessage="Нет такого пояса"
                  {...form.getInputProps('eventTimezone')}
                />
                {tzChanged && (
                  <Alert color="yellow" variant="light" p="xs" icon={<IconInfoCircle size={16} />}>
                    <Text size="sm">Даты на этой странице теперь понимаются по поясу {formTz}.</Text>
                  </Alert>
                )}
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <EventDateTimeInput label="Начало конференции" clearable {...form.getInputProps('eventStartsAt')} />
                  <EventDateTimeInput label="Окончание" clearable {...form.getInputProps('eventEndsAt')} />
                </SimpleGrid>
                <TzHint tz={formTz} />
              </Section>

              <Section title="Регистрация" description="Если даты не указаны, регистрация открыта всегда.">
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <EventDateTimeInput label="Регистрация открывается" clearable {...form.getInputProps('registrationOpensAt')} />
                  <EventDateTimeInput label="Регистрация закрывается" clearable {...form.getInputProps('registrationClosesAt')} />
                </SimpleGrid>
                <TzHint tz={formTz} />
                <Switch
                  label="Регистрация на месте (короткая анкета)"
                  description={`Для дня конференции: в боте вместо анкеты - короткая форма «Фамилия, имя, телефон, пол», вариант «${settings.tiers.fee10.label}» (${settings.tiers.fee10.amount} руб.), без питания и только за себя. Пока включено, регистрация открыта независимо от дат выше.`}
                  {...form.getInputProps('onSiteRegistration', { type: 'checkbox' })}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <NumberInput
                    label="Сколько человек в одной регистрации"
                    description="Столько людей можно записать с одного Telegram - себя, семью, друзей"
                    min={1}
                    max={50}
                    allowDecimal={false}
                    {...form.getInputProps('maxParticipantsPerAccount')}
                  />
                  <NumberInput
                    label="Всего мест"
                    description="Оставьте пустым, если мест сколько угодно"
                    min={1}
                    allowDecimal={false}
                    thousandSeparator=" "
                    {...form.getInputProps('totalCapacity')}
                  />
                </SimpleGrid>
              </Section>

              <Section
                title="Расписание и запись"
                description="До конференции запись закрыта, чтобы первые не заняли все места за месяц. Откройте её на месте. Выключатели срабатывают сразу, «Сохранить» не нужно - такие же есть в «Расписании», «Семинарах» и «Душепопечении»."
              >
                <ProgramSwitches card={false} />
              </Section>

              <Section
                title="Оплата"
                description={
                  form.values.paymentsEnabled
                    ? 'Участники видят статусы оплаты и реквизиты, кассир может отмечать оплату на месте.'
                    : 'Сейчас оплата выключена: ни бот, ни мини-приложение, ни сканер о ней не говорят.'
                }
              >
                <Switch
                  label="Приём оплаты (статусы, чеки, касса)"
                  description="Включите, когда начнёте принимать оплату - появятся раздел «Оплаты и чеки», статусы оплаты и касса в сканере"
                  {...form.getInputProps('paymentsEnabled', { type: 'checkbox' })}
                />
                {form.values.paymentsEnabled !== settings.paymentsEnabled && (
                  <Alert color="blue" variant="light" p="xs" icon={<IconInfoCircle size={16} />}>
                    <Text size="sm">
                      {form.values.paymentsEnabled
                        ? 'После сохранения оплата появится у всех: в админке, боте, мини-приложении и сканере.'
                        : 'После сохранения всё про оплату спрячется. Данные об оплатах не пропадут - их будет видно, если включить снова.'}
                    </Text>
                  </Alert>
                )}
                <Collapse expanded={form.values.paymentsEnabled}>
                  <Stack gap="md">
                    <Switch
                      label="Принимать переводы"
                      description="Выключено - взнос только наличными: в форме регистрации нет выбора способа, бот не просит чеки"
                      {...form.getInputProps('transfersEnabled', { type: 'checkbox' })}
                    />
                    <Collapse expanded={form.values.transfersEnabled}>
                    <Textarea
                      label="Реквизиты для перевода"
                      description="Участники, выбравшие «перевод», видят этот текст в боте и мини-приложении"
                      autosize
                      minRows={4}
                      maxRows={12}
                      maxLength={4000}
                      {...form.getInputProps('paymentInstructions')}
                    />
                    <Textarea
                      mt="sm"
                      label="Перевод за мерч и пожертвование"
                      description="Тот же счёт, но без шагов про взнос. Код брони или «Пожертвование» в комментарий подсказываем сами. Пусто - показываем текст для взноса"
                      autosize
                      minRows={3}
                      maxRows={10}
                      maxLength={4000}
                      {...form.getInputProps('merchPaymentInstructions')}
                    />
                    </Collapse>
                    <Textarea
                      label="Где и когда сдать наличные"
                      description="Для тех, кто выбрал «наличными»"
                      autosize
                      minRows={2}
                      maxRows={8}
                      maxLength={4000}
                      {...form.getInputProps('cashInstructions')}
                    />
                    <Switch
                      label="Пускать без оплаты"
                      description="Если выключено, сканер на входе остановит того, кто не оплатил (кассир может пропустить вручную)"
                      {...form.getInputProps('allowUnpaidEntry', { type: 'checkbox' })}
                    />
                    {form.values.allowUnpaidEntry && (
                      <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
                        <Text size="sm">Пускаем всех - сканер не будет останавливать тех, кто не оплатил.</Text>
                      </Alert>
                    )}
                    <Switch
                      label="Мягкие подписи оплаты (дни конференции)"
                      description="Участникам «чек получен ✓» вместо «чек на проверке» и «не забудьте оплатить» вместо «к оплате». Чеки проверяете как обычно, после - выключите."
                      {...form.getInputProps('softPaymentLabels', { type: 'checkbox' })}
                    />
                  </Stack>
                </Collapse>
              </Section>

              <Section
                title="Варианты участия"
                description="Цена, цвет и подписи. Цвет виден везде: у участника в приложении, на картинке QR-кода, в таблице и на экране сканера. Новая цена сразу применится к тем, кто ещё не платил. Завтрак - отдельная галочка к «Только взнос» и «Взнос и питание»."
              >
                <Stack gap="lg">
                  {TIERS.map((t) => {
                    const v = form.values.tiers[t];
                    return (
                      <Paper key={t} withBorder p="sm" radius="md" style={{ borderLeft: `6px solid ${v.color}`, opacity: v.enabled ? 1 : 0.75 }}>
                        <Group justify="space-between" mb="xs" wrap="nowrap">
                          <Text fw={600} size="sm">
                            {v.label || DEFAULT_TIERS[t].label}
                            {!v.enabled && (
                              <Text span size="xs" c="orange" fw={600} ml={8}>
                                скрыт при регистрации
                              </Text>
                            )}
                          </Text>
                          <Text
                            size="xs"
                            fw={700}
                            px={8}
                            py={2}
                            style={{ background: v.color, color: textOn(v.color), borderRadius: 999, whiteSpace: 'nowrap' }}
                          >
                            {v.short || '-'}
                          </Text>
                        </Group>
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                          <TextInput label="Название" {...form.getInputProps(`tiers.${t}.label`)} />
                          <TextInput label="Коротко (бейдж, сканер)" maxLength={40} {...form.getInputProps(`tiers.${t}.short`)} />
                          <NumberInput
                            label="Цена, руб."
                            min={0}
                            decimalScale={2}
                            disabled={isFreeTier(t)}
                            {...form.getInputProps(`tiers.${t}.amount`)}
                          />
                          <ColorInput
                            label="Цвет"
                            format="hex"
                            swatches={['#4b5da5', '#d0352c', '#a8701a', '#7a6e74', '#352937', '#2563eb', '#0d9488', '#16a34a']}
                            swatchesPerRow={8}
                            {...form.getInputProps(`tiers.${t}.color`)}
                          />
                        </SimpleGrid>
                        <Switch
                          mt="md"
                          mb="xs"
                          label="Показывать при регистрации"
                          {...form.getInputProps(`tiers.${t}.enabled`, { type: 'checkbox' })}
                        />
                        <Select
                          label="Браслет на входе"
                          description="По браслету кормят: чёрный - обед и ужин, белый - без питания. Завтрак не влияет."
                          allowDeselect={false}
                          data={(['black', 'white'] as const).map((b) => ({ value: b, label: `${b === 'black' ? '⚫️' : '⚪️'} ${BRACELET_LABELS[b]} - ${BRACELET_MEANING[b]}` }))}
                          {...form.getInputProps(`tiers.${t}.bracelet`)}
                        />
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" mt="xs">
                          <TextInput label="Что входит" maxLength={200} {...form.getInputProps(`tiers.${t}.description`)} />
                          <NumberInput
                            label="Мест"
                            description="Пусто - без ограничения"
                            min={1}
                            allowDecimal={false}
                            placeholder="Без ограничения"
                            {...form.getInputProps(`tiers.${t}.limit`)}
                          />
                        </SimpleGrid>
                      </Paper>
                    );
                  })}
                  <Paper withBorder p="sm" radius="md" style={{ borderLeft: '6px solid #a8701a' }}>
                    <Group justify="space-between" mb="xs" wrap="nowrap">
                      <Text fw={600} size="sm">
                        Завтрак
                      </Text>
                      <Text size="xs" c="dimmed">
                        галочка к варианту со взносом, на QR-коде - «+ завтрак»
                      </Text>
                    </Group>
                    <Switch
                      mt="xs"
                      mb="md"
                      label="Предлагать при регистрации"
                      {...form.getInputProps('breakfast.enabled', { type: 'checkbox' })}
                    />
                    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
                      <NumberInput label="Доплата, руб." min={0} decimalScale={2} {...form.getInputProps('breakfast.amount')} />
                      <NumberInput
                        label="Мест"
                        description="Пусто - без ограничения"
                        min={1}
                        allowDecimal={false}
                        placeholder="Без ограничения"
                        {...form.getInputProps('breakfast.limit')}
                      />
                      <TextInput label="Подсказка у галочки" maxLength={200} {...form.getInputProps('breakfast.description')} />
                    </SimpleGrid>
                  </Paper>
                </Stack>
              </Section>

              <Section title="Мерч" description="Показ витрины, бронь, оплата переводом и реквизиты за мерч - в разделе «Мерч», вкладка «Настройки». Там их меняют и продавцы.">
                <Group>
                  <AppLink href="/merch?tab=settings" size="sm" fw={600}>
                    Открыть настройки мерча
                  </AppLink>
                </Group>
              </Section>

              <Section title="Согласия" description="Согласие на обработку персональных данных обязательно при регистрации. Версия сохраняется вместе с согласием.">
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <TextInput
                    label="Версия документа"
                    description="Поменяйте, если изменили текст согласия"
                    required
                    {...form.getInputProps('consentDocumentVersion')}
                  />
                  <TextInput label="Ссылка на документ" placeholder="https://…" inputMode="url" {...form.getInputProps('consentDocumentUrl')} />
                </SimpleGrid>
                <Switch
                  label="Спрашивать согласие на фото- и видеосъёмку"
                  {...form.getInputProps('photoConsentEnabled', { type: 'checkbox' })}
                />
              </Section>

              <Section title="Бот">
                <Textarea
                  label="Приветствие"
                  description="Первое, что бот напишет новому человеку"
                  autosize
                  minRows={3}
                  maxRows={10}
                  maxLength={4000}
                  {...form.getInputProps('welcomeText')}
                />
                <TextInput
                  label="Контакт поддержки"
                  description="Куда писать, если что-то не получается: например, @username или номер телефона"
                  maxLength={200}
                  {...form.getInputProps('supportContact')}
                />
              </Section>

              <Section
                title="Конец «Шага веры»"
                description="Когда конференция прошла: вместо главной в приложении и в боте - красивый экран благодарности с кнопками «Оставить отзыв» и «Написать организаторам». Остальное участникам скрыто, команде - доступно."
              >
                <Switch
                  label={<Text fw={600}>Конференция завершилась - показать экран благодарности</Text>}
                  description="Включает и форму отзыва для всех зарегистрированных"
                  {...form.getInputProps('eventEnded', { type: 'checkbox' })}
                />
                <TextInput label="Заголовок" maxLength={120} {...form.getInputProps('endTitle')} />
                <Textarea label="Текст" autosize minRows={2} maxRows={8} maxLength={1500} {...form.getInputProps('endText')} />
                {END_PREVIEW && (
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                      Посмотреть до включения:
                    </Text>
                    <CopyValue value={END_PREVIEW} />
                  </Group>
                )}
              </Section>
            </SimpleGrid>
          </Stack>
        </Fieldset>

        {!readOnly && (
          <Group justify="flex-end" gap="sm">
            <Button variant="default" disabled={!dirty} onClick={() => form.reset()}>
              Отменить изменения
            </Button>
            <Button type="submit" leftSection={<IconDeviceFloppy size={16} />} loading={save.isPending} disabled={!dirty}>
              Сохранить
            </Button>
          </Group>
        )}
      </Stack>

      {!readOnly && (
        <Affix position={{ bottom: 20, right: 24 }}>
          <Transition transition="slide-up" mounted={dirty}>
            {(styles) => (
              <Paper shadow="lg" p="sm" radius="lg" withBorder style={styles}>
                <Group gap="sm">
                  <Text size="sm">Есть несохранённые изменения</Text>
                  <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={save.isPending} onClick={() => submit()}>
                    Сохранить
                  </Button>
                </Group>
              </Paper>
            )}
          </Transition>
        </Affix>
      )}
    </form>
  );
}
