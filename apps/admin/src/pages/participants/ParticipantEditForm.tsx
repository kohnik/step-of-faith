import {
  Alert,
  Button,
  Fieldset,
  Group,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import {
  REG_PAYMENT_METHOD_LABELS,
  REG_PAYMENT_METHODS,
  TIERS,
  adminParticipantUpdateSchema,
  breakfastAllowed,
  formatRub,
  type AdminParticipantRow,
  type AdminParticipantUpdate,
  type Category,
  type Gender,
  type ParticipantStatus,
  type PaymentStatus,
  type RegPaymentMethod,
  type Tier,
} from '@sof/shared';
import { IconAlertTriangle, IconDeviceFloppy } from '@tabler/icons-react';
import { useUpdateParticipant } from '../../api/participants.ts';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { DateField } from '../../components/dates.tsx';
import { useBreakfast, usePaymentsEnabled, useTiers } from '../../components/SessionProvider.tsx';
import { normalizeMoneyInput } from '../../lib/format.ts';
import { CATEGORY_OPTIONS, PAYMENT_STATUS_OPTIONS } from '../../lib/labels.ts';
import { notifySuccess, notifyWarning } from '../../lib/notify.tsx';
import { emptyToNull, schemaErrors, serverErrors } from '../../lib/validation.ts';

interface Values {
  lastName: string;
  firstName: string;
  middleName: string;
  birthDate: string | null;
  gender: Gender;
  city: string;
  church: string;
  phone: string;
  telegramUsername: string;
  tier: Tier | '';
  breakfast: boolean;
  paymentMethod: RegPaymentMethod | '';
  category: Category;
  status: ParticipantStatus;
  paymentStatus: PaymentStatus;
  amountDue: string;
  amountPaid: string;
  paymentNote: string;
  sponsorOffer: boolean;
}

function toValues(p: AdminParticipantRow): Values {
  return {
    lastName: p.lastName,
    firstName: p.firstName,
    middleName: p.middleName ?? '',
    birthDate: p.birthDate,
    gender: p.gender,
    city: p.city ?? '',
    church: p.church ?? '',
    phone: p.phone ?? '',
    telegramUsername: p.telegramUsername ?? '',
    tier: p.tier ?? '',
    breakfast: p.breakfast,
    paymentMethod: p.paymentMethod ?? '',
    category: p.category,
    status: p.status,
    paymentStatus: p.paymentStatus,
    amountDue: p.amountDue ?? '',
    amountPaid: p.amountPaid,
    paymentNote: p.paymentNote ?? '',
    sponsorOffer: p.sponsorOffer,
  };
}

/** Значения формы → тело PATCH (все поля; потом оставим только изменённые). */
function toPayload(v: Values): AdminParticipantUpdate {
  return {
    lastName: v.lastName.trim(),
    firstName: v.firstName.trim(),
    middleName: emptyToNull(v.middleName),
    birthDate: v.birthDate ?? undefined,
    gender: v.gender,
    // У гостя на месте города может не быть - пустое не отправляем.
    city: v.city.trim() || undefined,
    church: emptyToNull(v.church),
    phone: emptyToNull(v.phone),
    telegramUsername: emptyToNull(v.telegramUsername.replace(/^@/, '')),
    tier: v.tier || undefined,
    // К «Без взноса» завтрак не ставится - сервер снимет его и сам, но в форме считаем так же.
    breakfast: v.breakfast && breakfastAllowed(v.tier),
    paymentMethod: v.paymentMethod || null,
    category: v.category,
    status: v.status,
    paymentStatus: v.paymentStatus,
    amountDue: normalizeMoneyInput(v.amountDue),
    amountPaid: normalizeMoneyInput(v.amountPaid) ?? '0',
    paymentNote: emptyToNull(v.paymentNote),
    sponsorOffer: v.sponsorOffer,
  };
}

const sameMoney = (a: string | null | undefined, b: string | null | undefined) => {
  if (a == null || b == null) return a == b;
  return Number(a) === Number(b);
};

/** Только изменённые поля - чтобы не перетереть чужие правки. */
function diff(before: AdminParticipantUpdate, after: AdminParticipantUpdate): AdminParticipantUpdate {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof AdminParticipantUpdate)[]) {
    const a = after[key];
    const b = before[key];
    const equal = key === 'amountDue' || key === 'amountPaid' ? sameMoney(a as string | null, b as string | null) : a === b;
    if (!equal) out[key] = a;
  }
  return out as AdminParticipantUpdate;
}

export function ParticipantEditForm({ participant }: { participant: AdminParticipantRow }) {
  const paymentsEnabled = usePaymentsEnabled();
  const tiers = useTiers();
  const breakfast = useBreakfast();
  const update = useUpdateParticipant();
  const confirm = useConfirm();
  const initial = toValues(participant);
  const form = useForm<Values>({
    mode: 'controlled',
    initialValues: initial,
    validate: (values) => ({
      ...schemaErrors(adminParticipantUpdateSchema, toPayload(values)),
      // Гость на месте записывался без даты рождения и города - у него они необязательны.
      ...(values.birthDate || participant.onSite ? {} : { birthDate: 'Обязательное поле' }),
      ...(values.city.trim() || participant.onSite ? {} : { city: 'Обязательное поле' }),
    }),
  });

  const submit = form.onSubmit(async (values) => {
    const patch = diff(toPayload(initial), toPayload(values));
    if (Object.keys(patch).length === 0) {
      notifySuccess('Изменений нет - всё уже сохранено');
      return;
    }
    if (patch.status === 'cancelled') {
      const ok = await confirm({
        title: 'Отменить участие?',
        message:
          'QR-код сразу перестанет работать, а записи на активности отменятся - места перейдут тем, кто в листе ожидания. Если передумаете, участие можно вернуть: будет выпущен новый QR-код.',
        confirmLabel: 'Отменить участие',
        danger: true,
      });
      if (!ok) return;
    }
    update.mutate(
      { id: participant.id, patch },
      {
        onSuccess: (row) => {
          notifySuccess(
            patch.status === 'active' ? 'Участие вернули, выпущен новый QR-код' : 'Сохранено',
            row.fullName,
          );
          if (row.warning) notifyWarning(row.warning);
          form.resetDirty(toValues(row));
        },
        onError: (err) => form.setErrors(serverErrors(err)),
      },
    );
  });

  const statusChanged = form.values.status !== participant.status;

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        <Fieldset legend="Личные данные" radius="md">
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              <TextInput label="Фамилия" required {...form.getInputProps('lastName')} />
              <TextInput label="Имя" required {...form.getInputProps('firstName')} />
              <TextInput label="Отчество" {...form.getInputProps('middleName')} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              <DateField label="Дата рождения" required={!participant.onSite} maxDate={new Date()} {...form.getInputProps('birthDate')} />
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Пол
                </Text>
                <SegmentedControl
                  fullWidth
                  value={form.values.gender}
                  onChange={(v) => form.setFieldValue('gender', v as Gender)}
                  data={[
                    { value: 'm', label: 'М' },
                    { value: 'f', label: 'Ж' },
                  ]}
                />
              </Stack>
              <TextInput label="Населённый пункт" required={!participant.onSite} {...form.getInputProps('city')} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              <TextInput label="Телефон" inputMode="tel" placeholder="+375 29 123-45-67" {...form.getInputProps('phone')} />
              <TextInput label="Церковь" {...form.getInputProps('church')} />
              <TextInput label="Ник в Telegram" placeholder="@username" {...form.getInputProps('telegramUsername')} />
            </SimpleGrid>
          </Stack>
        </Fieldset>

        <Fieldset legend="Участие" radius="md">
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label="Вариант участия"
                description="Сменили вариант - сумма к оплате пересчитается (если ещё не оплачено)"
                data={TIERS.map((t) => ({ value: t, label: `${tiers[t].short}` }))}
                placeholder="не выбран"
                allowDeselect={false}
                leftSection={
                  form.values.tier ? (
                    <span style={{ width: 12, height: 12, borderRadius: 999, background: tiers[form.values.tier].color }} />
                  ) : undefined
                }
                {...form.getInputProps('tier')}
              />
              <Select
                label="Как платит"
                data={REG_PAYMENT_METHODS.map((m) => ({ value: m, label: REG_PAYMENT_METHOD_LABELS[m] }))}
                placeholder="-"
                clearable
                {...form.getInputProps('paymentMethod')}
                onChange={(v) => form.setFieldValue('paymentMethod', (v ?? '') as RegPaymentMethod | '')}
              />
            </SimpleGrid>
            <Switch
              label={breakfast.amount > 0 ? `Завтрак (+${formatRub(breakfast.amount)})` : 'Завтрак'}
              description={
                breakfastAllowed(form.values.tier)
                  ? 'Добавили или сняли - сумма к оплате пересчитается; уже оплатившему добавится доплата'
                  : 'Завтрак добавляется только к варианту со взносом'
              }
              disabled={!breakfastAllowed(form.values.tier)}
              checked={form.values.breakfast && breakfastAllowed(form.values.tier)}
              onChange={(e) => form.setFieldValue('breakfast', e.currentTarget.checked)}
            />
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select label="Категория" data={CATEGORY_OPTIONS} allowDeselect={false} {...form.getInputProps('category')} />
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Статус
                </Text>
                <SegmentedControl
                  fullWidth
                  value={form.values.status}
                  onChange={(v) => form.setFieldValue('status', v as ParticipantStatus)}
                  color={form.values.status === 'cancelled' ? 'red' : undefined}
                  data={[
                    { value: 'active', label: 'Активен' },
                    { value: 'cancelled', label: 'Отменён' },
                  ]}
                />
              </Stack>
            </SimpleGrid>
            {statusChanged && form.values.status === 'cancelled' && (
              <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
                <Text size="sm">После сохранения QR-код перестанет работать, а записи на активности отменятся.</Text>
              </Alert>
            )}
            {statusChanged && form.values.status === 'active' && (
              <Alert color="blue" variant="light" p="xs">
                <Text size="sm">После сохранения выпустим новый QR-код.</Text>
              </Alert>
            )}
          </Stack>
        </Fieldset>

        {paymentsEnabled && (
          <Fieldset legend="Оплата" radius="md">
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
                <Select label="Статус оплаты" data={PAYMENT_STATUS_OPTIONS} allowDeselect={false} {...form.getInputProps('paymentStatus')} />
                <TextInput label="К оплате, руб." inputMode="decimal" placeholder="не задано" {...form.getInputProps('amountDue')} />
                <TextInput label="Оплачено, руб." inputMode="decimal" {...form.getInputProps('amountPaid')} />
              </SimpleGrid>
              <Textarea label="Комментарий к оплате" autosize minRows={2} maxRows={6} {...form.getInputProps('paymentNote')} />
              <Switch
                label="Готов(а) оплатить регистрацию за другого"
                description="Отметка из анкеты: готов(а) оплатить за того, у кого нет финансовой возможности. В случае необходимости с ним свяжутся."
                {...form.getInputProps('sponsorOffer', { type: 'checkbox' })}
              />
            </Stack>
          </Fieldset>
        )}

        <Group justify="flex-end" gap="sm">
          <Button variant="default" disabled={!form.isDirty()} onClick={() => form.reset()}>
            Отменить правки
          </Button>
          <Button type="submit" loading={update.isPending} disabled={!form.isDirty()} leftSection={<IconDeviceFloppy size={16} />}>
            Сохранить
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
