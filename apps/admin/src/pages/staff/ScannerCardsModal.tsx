import { ActionIcon, Alert, Button, Group, SegmentedControl, SimpleGrid, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconPrinter, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { useCreateScannerCard } from '../../api/staff.ts';
import { AppModal, ModalActions, useIsMobile } from '../../components/AppModal.tsx';
import { CopyIconButton } from '../../components/CopyValue.tsx';
import { useEvent } from '../../components/EventProvider.tsx';
import { PrintSheet, printSheet } from '../../components/PrintSheet.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { formatDateTime } from '../../lib/format.ts';
import { notifySuccess } from '../../lib/notify.tsx';

export interface GeneratedCard {
  userId: number;
  name: string;
  role: 'scanner' | 'cashier';
  loginUrl: string;
  expiresAt: string;
}

const ROLE_LINE: Record<GeneratedCard['role'], string> = {
  scanner: 'Волонтёр на входе - сканирует QR-коды',
  cashier: 'Касса - сканирует QR-коды и принимает оплату',
};

const DURATIONS = [
  { value: '24', label: 'Сутки' },
  { value: '72', label: '3 дня' },
  { value: '168', label: 'Неделя' },
];

/** Карточка волонтёра: QR-ссылка входа в браузерный сканер, без Telegram. */
export function VolunteerCard({ card, eventName, tz }: { card: GeneratedCard; eventName: string; tz: string }) {
  return (
    <div className="sof-volunteer-card">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Text size="xs" tt="uppercase" fw={700} c="gray.7">
            {eventName} · карточка волонтёра
          </Text>
          <Text fw={800} fz={20} lh={1.2}>
            {card.name}
          </Text>
          <Text size="sm" fw={600}>
            {ROLE_LINE[card.role]}
          </Text>
          <Text size="xs" c="gray.7" mt={4}>
            Наведите камеру телефона на этот QR - откроется сканер. Пожалуйста, не передавайте карточку и не выкладывайте
            её фото.
          </Text>
          <Text size="xs" fw={700}>
            Действует до {formatDateTime(card.expiresAt, tz)}
          </Text>
        </Stack>
        <QrCode value={card.loginUrl} size={150} level="M" label={`QR входа для ${card.name}`} />
      </Group>
    </div>
  );
}

export function ScannerCardsModal({
  opened,
  onClose,
  cards,
  onCreated,
  onClear,
  onRemove,
  tz,
}: {
  opened: boolean;
  onClose: () => void;
  cards: GeneratedCard[];
  onCreated: (card: GeneratedCard) => void;
  onClear: () => void;
  onRemove: (userId: number) => void;
  tz: string;
}) {
  const { eventName } = useEvent();
  const create = useCreateScannerCard();
  const mobile = useIsMobile();
  const [name, setName] = useState('');
  const [hours, setHours] = useState('72');
  const [touched, setTouched] = useState(false);

  const nameError = touched && !name.trim() ? 'Напишите имя волонтёра' : name.trim().length > 80 ? 'Не длиннее 80 символов' : null;

  const submit = () => {
    setTouched(true);
    if (!name.trim() || name.trim().length > 80) return;
    const trimmed = name.trim();
    // Карточки только для сканера: кассира больше не выдаём.
    create.mutate(
      { name: trimmed, role: 'scanner', expiresInHours: Number(hours) },
      {
        onSuccess: (res) => {
          onCreated({ userId: res.userId, name: trimmed, role: 'scanner', loginUrl: res.loginUrl, expiresAt: res.expiresAt });
          notifySuccess(`Карточка для «${trimmed}» готова - можно печатать`);
          setName('');
          setTouched(false);
        },
      },
    );
  };

  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>Карточки волонтёров</Text>} size="xl">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Для волонтёров без Telegram: на карточке QR-ссылка, по которой сканер откроется прямо в браузере телефона.
          Создайте карточки для всех и распечатайте одним листом.
        </Text>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Stack gap="sm">
            <TextInput
              label="Имя волонтёра"
              placeholder="Например: Аня Смирнова"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={nameError}
            />
            <Group gap="sm" align="flex-end" wrap="wrap">
              <Stack gap={4} style={{ flex: mobile ? '1 1 100%' : undefined }}>
                <Text size="sm" fw={500}>
                  Карточка действует
                </Text>
                <SegmentedControl value={hours} onChange={setHours} data={DURATIONS} fullWidth={mobile} />
              </Stack>
              <Button type="submit" loading={create.isPending} fullWidth={mobile}>
                Создать карточку
              </Button>
            </Group>
          </Stack>
        </form>

        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
          <Text size="sm">
            Ссылка на карточке - это вход в сканер. Карточки видны только здесь, пока открыто окно: распечатайте их сразу.
          </Text>
        </Alert>

        {cards.length > 0 && (
          <Stack gap="sm">
            <Text fw={700}>Готово к печати: {cards.length}</Text>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
              {cards.map((c) => (
                <div key={c.userId} style={{ position: 'relative' }}>
                  <VolunteerCard card={c} eventName={eventName} tz={tz} />
                  <Group gap={2} style={{ position: 'absolute', top: 6, right: 6 }}>
                    <CopyIconButton value={c.loginUrl} label="Скопировать ссылку входа" variant="default" />
                    <Tooltip label="Убрать из списка">
                      <ActionIcon size="sm" color="red" variant="default" onClick={() => onRemove(c.userId)} aria-label="Убрать карточку">
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </div>
              ))}
            </SimpleGrid>
          </Stack>
        )}

        <ModalActions>
          {cards.length > 0 && (
            <Button variant="subtle" color="red" onClick={onClear}>
              Очистить
            </Button>
          )}
          {cards.length > 0 ? (
            <Button leftSection={<IconPrinter size={16} />} onClick={printSheet}>
              Печать ({cards.length})
            </Button>
          ) : (
            <Button variant="default" onClick={onClose}>
              Закрыть
            </Button>
          )}
        </ModalActions>
      </Stack>
      {opened && cards.length > 0 && (
        <PrintSheet>
          <div className="sof-print-grid">
            {cards.map((c) => (
              <VolunteerCard key={c.userId} card={c} eventName={eventName} tz={tz} />
            ))}
          </div>
        </PrintSheet>
      )}
    </AppModal>
  );
}
