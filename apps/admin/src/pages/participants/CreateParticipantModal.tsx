import {
  Alert,
  Button,
  Card,
  Group,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import {
  adminParticipantCreateSchema,
  DEFAULT_CITY,
  REG_PAYMENT_METHOD_LABELS,
  REG_PAYMENT_METHODS,
  TIERS,
  isFreeTier,
  breakfastAllowed,
  formatRub,
  priceOf,
  type AdminParticipantRow,
  type Category,
  type Gender,
  type PaymentStatus,
  type Relation,
  type RegPaymentMethod,
  type Tier,
} from '@sof/shared';
import { IconCheck, IconExternalLink, IconInfoCircle, IconPrinter, IconUser } from '@tabler/icons-react';
import { useState } from 'react';
import { useCreateParticipant } from '../../api/participants.ts';
import { CopyIconButton } from '../../components/CopyValue.tsx';
import { DateField } from '../../components/dates.tsx';
import { useEvent } from '../../components/EventProvider.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { PrintSheet, printSheet, QrPrintCard } from '../../components/PrintSheet.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { useBreakfast, usePaymentsEnabled, useTiers } from '../../components/SessionProvider.tsx';
import { formatTicket, normalizeMoneyInput } from '../../lib/format.ts';
import { CATEGORY_OPTIONS, PAYMENT_STATUS_OPTIONS, RELATION_OPTIONS } from '../../lib/labels.ts';
import { emptyToNull, schemaErrors, serverErrors } from '../../lib/validation.ts';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { notifyWarning } from '../../lib/notify.tsx';

interface Values {
  lastName: string;
  firstName: string;
  middleName: string;
  birthDate: string | null;
  gender: Gender | null;
  city: string;
  church: string;
  phone: string;
  telegramUsername: string;
  tier: Tier;
  breakfast: boolean;
  paymentMethod: RegPaymentMethod | '';
  relation: Relation;
  category: Category;
  paymentStatus: PaymentStatus;
  amountDue: string;
  note: string;
}

const INITIAL: Values = {
  lastName: '',
  firstName: '',
  middleName: '',
  birthDate: null,
  gender: null,
  city: DEFAULT_CITY,
  church: '',
  phone: '',
  telegramUsername: '',
  tier: 'fee10',
  breakfast: false,
  paymentMethod: 'cash',
  relation: 'self',
  category: 'participant',
  paymentStatus: 'unpaid',
  amountDue: '',
  note: '',
};

function toPayload(v: Values) {
  return {
    lastName: v.lastName.trim(),
    firstName: v.firstName.trim(),
    middleName: emptyToNull(v.middleName),
    birthDate: v.birthDate ?? undefined,
    gender: v.gender ?? undefined,
    city: v.city.trim(),
    church: emptyToNull(v.church),
    phone: emptyToNull(v.phone),
    telegramUsername: emptyToNull(v.telegramUsername.replace(/^@/, '')),
    tier: v.tier,
    breakfast: v.breakfast && breakfastAllowed(v.tier),
    paymentMethod: isFreeTier(v.tier) ? null : v.paymentMethod || null,
    relation: v.relation,
    category: v.category,
    paymentStatus: v.paymentStatus,
    amountDue: normalizeMoneyInput(v.amountDue),
    note: emptyToNull(v.note),
  };
}


/** Ручная регистрация - для людей без Telegram. Сервер создаёт отдельный аккаунт и QR-код. */
export function CreateParticipantModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const paymentsEnabled = usePaymentsEnabled();
  const tiers = useTiers();
  const breakfast = useBreakfast();
  const create = useCreateParticipant();
  const [created, setCreated] = useState<AdminParticipantRow | null>(null);
  const { openParticipant } = useParticipantDrawer();
  const { eventName } = useEvent();

  const form = useForm<Values>({
    mode: 'controlled',
    initialValues: INITIAL,
    validate: (values) => schemaErrors(adminParticipantCreateSchema, toPayload(values)),
  });

  const close = () => {
    onClose();
  };

  const reset = () => {
    setCreated(null);
    form.reset();
    create.reset();
  };

  const submit = form.onSubmit((values) => {
    const payload = adminParticipantCreateSchema.parse(toPayload(values));
    create.mutate(payload, {
      onSuccess: (row) => {
        setCreated(row);
        if (row.warning) notifyWarning(row.warning);
      },
      onError: (err) => form.setErrors(serverErrors(err)),
    });
  });

  return (
    <AppModal
      opened={opened}
      onClose={close}
      onExitTransitionEnd={reset}
      title={<Text fw={700}>{created ? 'Готово, участник добавлен' : 'Добавить участника'}</Text>}
      size="lg"
    >
      {created ? (
        <Stack gap="md">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon color="green" radius="xl" size="lg" variant="light">
              <IconCheck size={20} />
            </ThemeIcon>
            <div>
              <Text fw={700}>{created.fullName}</Text>
              <Text size="sm" c="dimmed">
                Зарегистрирован(а), QR-код для входа уже работает.
              </Text>
            </div>
          </Group>
          {created.ticketCode ? (
            <Card withBorder padding="md" radius="md">
              <Group gap="lg" wrap="wrap" align="center">
                <QrCode value={created.ticketCode} level="Q" size={128} label="QR-код для входа" />
                <Stack gap={6}>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                    QR-код
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <Text className="sof-mono" fw={800} fz={22}>
                      {formatTicket(created.ticketCode)}
                    </Text>
                    <CopyIconButton value={created.ticketCode} label="Скопировать код" />
                  </Group>
                  <Text size="xs" c="dimmed">
                    У человека нет Telegram - распечатайте QR-код или просто продиктуйте код: на входе его можно ввести
                    вручную.
                  </Text>
                </Stack>
              </Group>
            </Card>
          ) : (
            <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
              QR-код не выпустился - откройте карточку участника и нажмите «Перевыпустить QR-код».
            </Alert>
          )}
          <Group gap="xs" wrap="wrap">
            {created.ticketCode && (
                <Button variant="default" leftSection={<IconPrinter size={16} />} onClick={printSheet}>
                  Распечатать QR-код
                </Button>
              )}
              {created.ticketWebUrl && (
                <Button
                  variant="default"
                  component="a"
                  href={created.ticketWebUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  leftSection={<IconExternalLink size={16} />}
                >
                  Веб-страница QR-кода
                </Button>
              )}
              <Button
                variant="default"
                leftSection={<IconUser size={16} />}
                onClick={() => {
                  openParticipant(created.id);
                  close();
                }}
              >
                Открыть карточку
              </Button>
          </Group>
          <ModalActions>
            <Button variant="light" onClick={reset}>
              Добавить ещё
            </Button>
            <Button onClick={close}>Готово</Button>
          </ModalActions>
          {opened && created.ticketCode && (
            <PrintSheet>
              <QrPrintCard eventName={eventName} fullName={created.fullName} code={created.ticketCode} category={created.category} />
            </PrintSheet>
          )}
        </Stack>
      ) : (
        <form onSubmit={submit} noValidate>
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Для тех, у кого нет Telegram. Заполните данные - сразу после сохранения покажем QR-код для входа, его можно
              распечатать.
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              <TextInput label="Фамилия" required data-autofocus {...form.getInputProps('lastName')} />
              <TextInput label="Имя" required {...form.getInputProps('firstName')} />
              <TextInput label="Отчество" {...form.getInputProps('middleName')} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              <DateField label="Дата рождения" required maxDate={new Date()} {...form.getInputProps('birthDate')} />
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Пол <span style={{ color: 'var(--mantine-color-error)' }}>*</span>
                </Text>
                <SegmentedControl
                  fullWidth
                  value={form.values.gender ?? ''}
                  onChange={(v) => form.setFieldValue('gender', v as Gender)}
                  data={[
                    { value: 'm', label: 'Мужской' },
                    { value: 'f', label: 'Женский' },
                  ]}
                />
                {form.errors.gender && (
                  <Text size="xs" c="red">
                    {form.errors.gender}
                  </Text>
                )}
              </Stack>
              <TextInput label="Населённый пункт" required {...form.getInputProps('city')} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput label="Церковь" placeholder="например, «Благодать»" {...form.getInputProps('church')} />
              <TextInput label="Ник в Telegram" placeholder="@username - по желанию" {...form.getInputProps('telegramUsername')} />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label="Вариант участия"
                data={TIERS.map((t) => ({ value: t, label: `${tiers[t].short}` }))}
                allowDeselect={false}
                leftSection={<span style={{ width: 12, height: 12, borderRadius: 999, background: tiers[form.values.tier].color }} />}
                description={(() => {
                  const sum = priceOf({ tiers, breakfast }, form.values.tier, form.values.breakfast);
                  return sum > 0 ? `К оплате: ${formatRub(sum)}` : 'Без взноса';
                })()}
                {...form.getInputProps('tier')}
              />
              {!isFreeTier(form.values.tier) && (
                <Select
                  label="Как платит"
                  data={REG_PAYMENT_METHODS.map((m) => ({ value: m, label: REG_PAYMENT_METHOD_LABELS[m] }))}
                  allowDeselect={false}
                  {...form.getInputProps('paymentMethod')}
                />
              )}
            </SimpleGrid>
            {breakfastAllowed(form.values.tier) && (
              <Switch
                label={breakfast.amount > 0 ? `Завтрак (+${formatRub(breakfast.amount)})` : 'Завтрак'}
                description={breakfast.description || undefined}
                {...form.getInputProps('breakfast', { type: 'checkbox' })}
              />
            )}
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              <TextInput label="Телефон" placeholder="+375 29 123-45-67" inputMode="tel" {...form.getInputProps('phone')} />
              <Select label="Кем приходится" data={RELATION_OPTIONS} allowDeselect={false} {...form.getInputProps('relation')} />
              <Select label="Категория" data={CATEGORY_OPTIONS} allowDeselect={false} {...form.getInputProps('category')} />
            </SimpleGrid>
            {paymentsEnabled && (
              <>
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
                  <Select label="Оплата" data={PAYMENT_STATUS_OPTIONS} allowDeselect={false} {...form.getInputProps('paymentStatus')} />
                  <TextInput label="К оплате, руб." placeholder="по варианту" inputMode="decimal" {...form.getInputProps('amountDue')} />
                </SimpleGrid>
                <Textarea
                  label="Комментарий к оплате"
                  autosize
                  minRows={2}
                  maxRows={5}
                  placeholder="Например: оплатит на месте наличными"
                  {...form.getInputProps('note')}
                />
              </>
            )}
            <ModalActions>
              <Button variant="default" onClick={close}>
                Отмена
              </Button>
              <Button type="submit" loading={create.isPending}>
                Добавить
              </Button>
            </ModalActions>
          </Stack>
        </form>
      )}
    </AppModal>
  );
}
