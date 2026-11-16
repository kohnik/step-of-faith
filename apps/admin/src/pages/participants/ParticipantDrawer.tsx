import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  DataList,
  Drawer,
  Group,
  Skeleton,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  CATEGORY_LABELS,
  REG_PAYMENT_METHOD_LABELS,
  textOn,
  tierShort,
  type AdminParticipantDetail,
  type AdminParticipantRow,
  type TicketView,
} from '@sof/shared';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconBrandTelegram,
  IconExternalLink,
  IconHeart,
  IconHistory,
  IconRobot,
  IconMessageCircle,
  IconPhoto,
  IconPrinter,
  IconReceipt2,
  IconRefresh,
  IconSend,
  IconQrcode,
  IconShieldCheck,
  IconUser,
  IconUsers,
  IconDoorEnter,
  IconCalendarEvent,
  IconTrash,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { useRevokeCheckIn } from '../../api/checkin.ts';
import { useDeleteParticipant, useParticipant, useReissueTicket, useResendTicket } from '../../api/participants.ts';
import { CategoryBadge, ParticipantStatusBadge, PaymentBadge, TierBadge, TierBracelet, Under16Badge } from '../../components/badges.tsx';
import { useParticipantBotMessages } from '../../api/botlog.ts';
import { MessageCard } from '../broadcasts/BotLogPage.tsx';
import { useInternalLink } from '../../components/AppLink.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { useParticipantDrawer } from '../../components/ParticipantDrawerProvider.tsx';
import { CopyIconButton, CopyValue } from '../../components/CopyValue.tsx';
import { useEvent, useEventTz } from '../../components/EventProvider.tsx';
import { JsonDiff } from '../../components/JsonDiff.tsx';
import { PrintSheet, printSheet, QrPrintCard } from '../../components/PrintSheet.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { useCan, usePaymentsEnabled, useSession, useTiers } from '../../components/SessionProvider.tsx';
import { BlockSkeleton, EmptyBlock, ErrorState } from '../../components/states.tsx';
import { formatDate, formatDateTime, formatMoney, formatTicket, telegramUrl, countLabel } from '../../lib/format.ts';
import {
  auditActionLabel,
  CHECKIN_METHOD_LABELS,
  CONSENT_KIND_LABELS,
  GENDER_LABELS,
  REGISTRATION_STATUS_COLORS,
  REGISTRATION_STATUS_LABELS,
  relationLabel,
} from '../../lib/labels.ts';
import { notifySuccess } from '../../lib/notify.tsx';
import { ReceiptCard } from '../payments/ReceiptCard.tsx';
import { AcceptPaymentCard } from './AcceptPaymentCard.tsx';
import { ParticipantEditForm } from './ParticipantEditForm.tsx';
import { AppModal, ModalActions } from '../../components/AppModal.tsx';
import { StaffName } from '../../components/StaffName.tsx';

const YEARS: [string, string, string] = ['год', 'года', 'лет'];


interface Props {
  participantId: number;
  opened: boolean;
  onClose: () => void;
  onClosed: () => void;
  onOpenParticipant: (id: number) => void;
}

function Count({ n }: { n: number }) {
  if (!n) return null;
  return (
    <Badge size="xs" variant="light" color="gray" circle={n < 10}>
      {n}
    </Badge>
  );
}

export default function ParticipantDrawer({ participantId, opened, onClose, onClosed, onOpenParticipant }: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const detail = useParticipant(participantId);
  const paymentsEnabled = usePaymentsEnabled();
  const tiers = useTiers();
  const [pickedTab, setTab] = useState<string>('data');
  const d = detail.data;
  // Вкладку «Согласия» показываем, только если они есть; «Оплату» - только при включённом приёме оплаты.
  const showConsents = !!d && d.consents.length > 0;
  const tab =
    (pickedTab === 'payment' && !paymentsEnabled) || (pickedTab === 'consents' && !showConsents) ? 'data' : pickedTab;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      onExitTransitionEnd={onClosed}
      position="right"
      size={isMobile ? '100%' : 780}
      title={
        <Group gap="xs">
          <IconUser size={18} />
          <Text fw={700}>Карточка участника</Text>
          <Text c="dimmed" size="sm">
            #{participantId}
          </Text>
        </Group>
      }
    >
      {detail.isPending ? (
        <Stack gap="md">
          <Skeleton height={32} width="60%" />
          <Skeleton height={20} width="40%" />
          <Skeleton height={120} />
          <Skeleton height={300} />
        </Stack>
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : d ? (
        <Stack gap="lg">
          <Header detail={d} opened={opened} refreshing={detail.isFetching} onRefresh={() => void detail.refetch()} />
          <Tabs value={tab} onChange={(v) => setTab(v ?? 'data')} keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="data" leftSection={<IconUser size={14} />}>
                Данные
              </Tabs.Tab>
              <Tabs.Tab value="family" leftSection={<IconUsers size={14} />} rightSection={<Count n={d.family.length} />}>
                Семья
              </Tabs.Tab>
              {paymentsEnabled && (
                <Tabs.Tab value="payment" leftSection={<IconReceipt2 size={14} />} rightSection={<Count n={d.receipts.length} />}>
                  Оплата
                </Tabs.Tab>
              )}
              <Tabs.Tab value="checkins" leftSection={<IconDoorEnter size={14} />} rightSection={<Count n={d.checkIns.length} />}>
                Отметки
              </Tabs.Tab>
              <Tabs.Tab value="activities" leftSection={<IconCalendarEvent size={14} />} rightSection={<Count n={d.activities.length} />}>
                Активности
              </Tabs.Tab>
              {showConsents && (
                <Tabs.Tab value="consents" leftSection={<IconShieldCheck size={14} />}>
                  Согласия
                </Tabs.Tab>
              )}
              <Tabs.Tab value="bot" leftSection={<IconRobot size={14} />}>
                Бот
              </Tabs.Tab>
              <Tabs.Tab value="history" leftSection={<IconHistory size={14} />} rightSection={<Count n={d.audit.length} />}>
                История
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="data" pt="md">
              <DataTab detail={d} />
            </Tabs.Panel>
            <Tabs.Panel value="family" pt="md">
              <FamilyTab detail={d} onOpenParticipant={onOpenParticipant} />
            </Tabs.Panel>
            {paymentsEnabled && (
              <Tabs.Panel value="payment" pt="md">
                <PaymentTab detail={d} />
              </Tabs.Panel>
            )}
            <Tabs.Panel value="checkins" pt="md">
              <CheckInsTab detail={d} />
            </Tabs.Panel>
            <Tabs.Panel value="activities" pt="md">
              <ActivitiesTab detail={d} />
            </Tabs.Panel>
            {showConsents && (
              <Tabs.Panel value="consents" pt="md">
                <ConsentsTab detail={d} />
              </Tabs.Panel>
            )}
            <Tabs.Panel value="bot" pt="md">
              <BotTab participantId={d.participant.id} />
            </Tabs.Panel>
            <Tabs.Panel value="history" pt="md">
              <HistoryTab detail={d} />
            </Tabs.Panel>
          </Tabs>
          <DeleteParticipant detail={d} onDeleted={onClose} />
        </Stack>
      ) : null}
    </Drawer>
  );
}

// ---------- удаление ----------

/** «Удалить участника» - внизу карточки, только тем, кто может менять участников (админ, суперадмин). */
function DeleteParticipant({ detail, onDeleted }: { detail: AdminParticipantDetail; onDeleted: () => void }) {
  const p = detail.participant;
  const can = useCan();
  const confirm = useConfirm();
  const remove = useDeleteParticipant();
  if (!can('participants:write')) return null;
  const paid = Number(p.amountPaid ?? 0);
  // С оплатой или чеком удалить нельзя (сервер тоже не даст) - деньги и чеки не должны пропасть.
  const locked = paid > 0 || p.paymentStatus === 'pending';
  const doDelete = async () => {
    const ok = await confirm({
      title: `Удалить ${p.fullName}?`,
      message: (
        <Stack gap="xs">
          <Text size="sm">
            Человек исчезнет из таблицы, QR-код перестанет работать, записи на мероприятия и душепопечение освободятся. Вернуть
            удалённого нельзя - только зарегистрировать заново.
          </Text>
          <Text size="sm" c="dimmed">
            Человеку ничего не придёт. Все данные карточки сохранятся в «Истории изменений». Если нужно, чтобы человек узнал об
            отмене и регистрацию можно было вернуть, лучше поставьте статус «Отменён».
          </Text>
        </Stack>
      ),
      confirmLabel: 'Удалить навсегда',
      danger: true,
      typeToConfirm: 'удалить',
    });
    if (!ok) return;
    remove.mutate(p.id, {
      onSuccess: () => {
        notifySuccess('Участник удалён', p.fullName);
        onDeleted();
      },
    });
  };
  return (
    <Group justify="flex-end" pt="md" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
      {locked && (
        <Text size="xs" c="dimmed">
          Есть оплата или чек - только статус «Отменён»
        </Text>
      )}
      <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} disabled={locked} loading={remove.isPending} onClick={() => void doDelete()}>
        Удалить участника
      </Button>
    </Group>
  );
}

// ---------- шапка ----------

function Header({
  detail,
  opened,
  refreshing,
  onRefresh,
}: {
  detail: AdminParticipantDetail;
  opened: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const p = detail.participant;
  const { can, paymentsEnabled } = useSession();
  const tiers = useTiers();
  const confirm = useConfirm();
  const tz = useEventTz();
  const { eventName } = useEvent();
  const reissue = useReissueTicket();
  const resend = useResendTicket();
  const [reissued, setReissued] = useState<TicketView | null>(null);
  const canWrite = can('participants:write');
  const active = p.status === 'active';
  // QR-код бот присылает держателю (кому передали) или владельцу аккаунта - если у них есть Telegram.
  const botRecipient = p.holderName ?? (p.ownerTgId !== null ? `владельцу аккаунта (${p.ownerName})` : null);

  const doReissue = async () => {
    const ok = await confirm({
      title: 'Перевыпустить QR-код?',
      message: (
        <Stack gap="xs">
          <Text size="sm">
            Старый код <b className="sof-mono">{formatTicket(p.ticketCode)}</b> сразу перестанет работать - сканер на входе
            покажет «QR-код отключён».
          </Text>
          <Text size="sm">
            {botRecipient
              ? `Новый QR-код бот сам пришлёт в Telegram: ${botRecipient}.`
              : 'У участника нет Telegram - после перевыпуска распечатайте новый QR-код или отправьте ссылку на веб-билет.'}
          </Text>
        </Stack>
      ),
      confirmLabel: 'Перевыпустить',
      danger: true,
    });
    if (!ok) return;
    reissue.mutate(p.id, { onSuccess: (ticket) => setReissued(ticket) });
  };

  const doResend = () =>
    resend.mutate(p.id, {
      onSuccess: () => notifySuccess(`Скоро бот пришлёт QR-код в чат: ${botRecipient ?? 'владельцу аккаунта'}`, p.fullName),
    });

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Title order={3} lh={1.2} td={active ? undefined : 'line-through'}>
            {p.fullName}
          </Title>
          {p.tier && tiers[p.tier] && (
            <div
              style={{
                background: tiers[p.tier].color,
                color: textOn(tiers[p.tier].color),
                borderRadius: 10,
                padding: '6px 12px',
                fontWeight: 700,
              }}
            >
              {tierShort(tiers[p.tier], p.breakfast)}
              {p.paymentMethod ? ` · ${REG_PAYMENT_METHOD_LABELS[p.paymentMethod].toLowerCase()}` : ''}
            </div>
          )}
          <Group gap={6}>
            <ParticipantStatusBadge status={p.status} />
            {paymentsEnabled && <PaymentBadge status={p.paymentStatus} />}
            {p.category !== 'participant' && <CategoryBadge category={p.category} />}
            {p.under16 && <Under16Badge />}
            {p.possibleDuplicate && (
              <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
                возможный дубль
              </Badge>
            )}
            {p.onSite && (
              <Badge color="grape" variant="light">
                короткая анкета
              </Badge>
            )}
            {p.sponsorOffer && (
              <Badge color="pink" variant="light" leftSection={<IconHeart size={12} />}>
                готов(а) оплатить за другого
              </Badge>
            )}
            {p.arrivedAt && (
              <Badge color="teal" variant="light">
                пришёл(ла) {formatDateTime(p.arrivedAt, tz)}
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {[
              p.age === null ? 'гость на месте' : countLabel(p.age, YEARS),
              p.birthDate ? formatDate(p.birthDate) : null,
              GENDER_LABELS[p.gender].toLowerCase(),
              p.city,
              p.phone,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {(p.church || p.telegramUsername || p.holderName) && (
            <Text size="sm" c="dimmed">
              {p.church ? `Церковь: ${p.church}` : ''}
              {p.church && p.telegramUsername ? ' · ' : ''}
              {p.telegramUsername ? `@${p.telegramUsername}` : ''}
              {p.holderName ? ` · QR-код также у: ${p.holderName}` : ''}
            </Text>
          )}
        </Stack>
        <Tooltip label="Обновить">
          <ActionIcon variant="default" onClick={onRefresh} loading={refreshing} aria-label="Обновить карточку">
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Card padding="sm" radius="md" bg="var(--mantine-color-default-hover)" withBorder={false}>
        <Group justify="space-between" gap="sm" wrap="wrap">
          <Group gap="xs" wrap="nowrap">
            <IconQrcode size={18} color="var(--mantine-color-dimmed)" />
            {p.ticketCode ? (
              <>
                <Text className="sof-mono" fw={700}>
                  {formatTicket(p.ticketCode)}
                </Text>
                <CopyIconButton value={p.ticketCode} label="Скопировать код" />
              </>
            ) : (
              <Text size="sm" c="dimmed">
                {active ? 'QR-кода пока нет' : 'QR-код отключён - участие отменено'}
              </Text>
            )}
          </Group>
          <Group gap="xs">
            {p.ticketCode && (
              <Button size="xs" variant="default" leftSection={<IconPrinter size={14} />} onClick={printSheet}>
                Распечатать
              </Button>
            )}
            {p.ticketWebUrl && (
              <Button size="xs" variant="default" component="a" href={p.ticketWebUrl} target="_blank" rel="noopener noreferrer" leftSection={<IconExternalLink size={14} />}>
                Веб-страница QR-кода
              </Button>
            )}
            {canWrite && active && (
              <>
                {botRecipient && (
                  <Tooltip label={`Бот пришлёт QR-код в чат: ${botRecipient}`} multiline w={260}>
                    <Button size="xs" variant="default" leftSection={<IconSend size={14} />} loading={resend.isPending} onClick={doResend}>
                      Отправить QR-код в чат
                    </Button>
                  </Tooltip>
                )}
                <Button size="xs" variant="light" color="red" leftSection={<IconArrowBackUp size={14} />} loading={reissue.isPending} onClick={() => void doReissue()}>
                  Перевыпустить QR-код
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Card>

      {opened && p.ticketCode && (
        <PrintSheet>
          <QrPrintCard eventName={eventName} fullName={p.fullName} code={p.ticketCode} category={p.category} />
        </PrintSheet>
      )}

      <AppModal opened={!!reissued} onClose={() => setReissued(null)} title={<Text fw={700}>Новый QR-код готов</Text>} size="md">
        {reissued && (
          <Stack gap="md">
            <Group gap="lg" wrap="wrap">
              <QrCode value={reissued.code} level="Q" size={132} />
              <Stack gap={6}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  Новый код
                </Text>
                <Group gap={4} wrap="nowrap">
                  <Text className="sof-mono" fw={800} fz={20}>
                    {reissued.displayCode}
                  </Text>
                  <CopyIconButton value={reissued.code} />
                </Group>
                <Text size="xs" c="dimmed">
                  Старый код уже не работает. Новый бот пришлёт владельцу аккаунта.
                </Text>
              </Stack>
            </Group>
            <Group gap="xs" wrap="wrap">
              <Button component="a" href={reissued.webUrl} target="_blank" rel="noopener noreferrer" variant="default" leftSection={<IconExternalLink size={16} />}>
                Веб-страница QR-кода
              </Button>
              <Button component="a" href={reissued.imageUrl} target="_blank" rel="noopener noreferrer" variant="default" leftSection={<IconPhoto size={16} />}>
                Картинка QR-кода
              </Button>
              <CopyIconButton value={reissued.webUrl} label="Скопировать ссылку на страницу QR-кода" size="md" />
            </Group>
            <ModalActions>
              <Button onClick={() => setReissued(null)}>Готово</Button>
            </ModalActions>
          </Stack>
        )}
      </AppModal>
    </Stack>
  );
}

// ---------- вкладки ----------

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue>{children}</DataList.ItemValue>
    </DataList.Item>
  );
}

/** «Написать» - переписка с этим аккаунтом в «Сообщениях» (карточка закрывается). */
function MessageLink({ userId }: { userId: number }) {
  const { closeParticipant } = useParticipantDrawer();
  const link = useInternalLink(`/messages/${userId}`, closeParticipant);
  return (
    <Button component="a" size="compact-xs" variant="light" leftSection={<IconMessageCircle size={14} />} {...link}>
      Написать
    </Button>
  );
}

function DataTab({ detail }: { detail: AdminParticipantDetail }) {
  const p = detail.participant;
  const { can, paymentsEnabled } = useSession();
  const tiers = useTiers();
  const tz = useEventTz();
  const tg = telegramUrl(p.ownerUsername);
  return (
    <Stack gap="lg">
      {can('participants:write') ? (
        <ParticipantEditForm key={`${p.id}:${p.updatedAt}`} participant={p} />
      ) : (
        <Card padding="md" radius="md">
          <DataList labelWidth={170} withDivider>
            <Info label="ФИО">{p.fullName}</Info>
            <Info label="Дата рождения">
              {p.age === null ? 'не указана (гость на месте)' : `${formatDate(p.birthDate)} (${countLabel(p.age, YEARS)})`}
            </Info>
            <Info label="Пол">{GENDER_LABELS[p.gender]}</Info>
            <Info label="Населённый пункт">{p.city ?? '-'}</Info>
            <Info label="Церковь">{p.church ?? '-'}</Info>
            <Info label="Телефон">{p.phone ?? '-'}</Info>
            <Info label="Ник в Telegram">{p.telegramUsername ? `@${p.telegramUsername}` : '-'}</Info>
            <Info label="Вариант">
              <TierBadge tier={p.tier} tiers={tiers} breakfast={p.breakfast} />
            </Info>
            {p.status === 'active' && p.tier && (
              <Info label="Браслет">
                <TierBracelet tier={p.tier} tiers={tiers} />
              </Info>
            )}
            <Info label="Категория">{CATEGORY_LABELS[p.category]}</Info>
            <Info label="Статус">
              <ParticipantStatusBadge status={p.status} />
            </Info>
          </DataList>
        </Card>
      )}
      <Card padding="md" radius="md">
        <Text fw={700} mb="sm">
          Кто регистрировал и когда
        </Text>
        <DataList labelWidth={170} withDivider size="sm">
          <Info label="Аккаунт">
            <Group gap={6}>
              <Text size="sm">{p.ownerName}</Text>
              {tg && (
                <Anchor href={tg} target="_blank" rel="noopener noreferrer" size="sm">
                  <Group gap={2} wrap="nowrap">
                    <IconBrandTelegram size={14} />@{p.ownerUsername}
                  </Group>
                </Anchor>
              )}
              {p.ownerTgId === null && (
                <Badge size="xs" color="gray" variant="outline">
                  без Telegram
                </Badge>
              )}
              {can('content:write') && <MessageLink userId={p.chatUserId} />}
            </Group>
          </Info>
          <Info label="Телефон аккаунта">{p.ownerPhone ?? '-'}</Info>
          <Info label="Кем приходится">{relationLabel(p.relation)}</Info>
          {paymentsEnabled && (
            <Info label="Код оплаты">
              <CopyValue value={p.paymentRef} mono fw={700} />
            </Info>
          )}
          <Info label="В семье">{p.familySize} чел.</Info>
          <Info label="ID">{p.id}</Info>
          <Info label="Зарегистрирован">{formatDateTime(p.createdAt, tz)}</Info>
          <Info label="Изменён">{formatDateTime(p.updatedAt, tz)}</Info>
        </DataList>
      </Card>
    </Stack>
  );
}

function FamilyTab({ detail, onOpenParticipant }: { detail: AdminParticipantDetail; onOpenParticipant: (id: number) => void }) {
  const tz = useEventTz();
  const paymentsEnabled = usePaymentsEnabled();
  const tiers = useTiers();
  const p = detail.participant;
  if (detail.family.length === 0) {
    return (
      <EmptyBlock
        icon={<IconUsers size={28} />}
        title="Больше никого нет"
        description={`«${p.ownerName}» зарегистрировал(а) только этого человека.`}
      />
    );
  }
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Зарегистрировал(а): {p.ownerName}
        {paymentsEnabled && (
          <>
            {' '}
            · код оплаты <b className="sof-mono">{p.paymentRef}</b>
          </>
        )}{' '}
        · всего вместе: {p.familySize}
      </Text>
      <Table.ScrollContainer minWidth={620} type="native">
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>ФИО</Table.Th>
              <Table.Th>Кто</Table.Th>
              <Table.Th>Возраст</Table.Th>
              <Table.Th>Вариант</Table.Th>
              {paymentsEnabled && <Table.Th>Оплата</Table.Th>}
              <Table.Th>Пришёл</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {detail.family.map((f: AdminParticipantRow) => (
              <Table.Tr
                key={f.id}
                className="sof-row-link"
                tabIndex={0}
                onClick={() => onOpenParticipant(f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onOpenParticipant(f.id);
                }}
              >
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Anchor component="span" size="sm" fw={600} td={f.status === 'cancelled' ? 'line-through' : undefined}>
                      {f.fullName}
                    </Anchor>
                    {f.status === 'cancelled' && (
                      <Badge size="xs" color="gray">
                        отменён
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{relationLabel(f.relation)}</Text>
                </Table.Td>
                <Table.Td>{f.age}</Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <TierBadge tier={f.tier} tiers={tiers} breakfast={f.breakfast} size="xs" />
                    {f.status === 'active' && <TierBracelet tier={f.tier} tiers={tiers} size="xs" />}
                  </Group>
                </Table.Td>
                {paymentsEnabled && (
                  <Table.Td>
                    <PaymentBadge status={f.paymentStatus} size="xs" />
                  </Table.Td>
                )}
                <Table.Td>
                  <Text size="sm" c={f.arrivedAt ? undefined : 'dimmed'}>
                    {f.arrivedAt ? formatDateTime(f.arrivedAt, tz) : '-'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

function PaymentTab({ detail }: { detail: AdminParticipantDetail }) {
  const p = detail.participant;
  const can = useCan();
  const tz = useEventTz();
  return (
    <Stack gap="md">
      {can('payments:write') && p.status === 'active' && <AcceptPaymentCard key={p.id} participant={p} />}
      <Card padding="md" radius="md">
        <DataList labelWidth={170} withDivider size="sm">
          <Info label="Статус">
            <PaymentBadge status={p.paymentStatus} />
          </Info>
          <Info label="К оплате">{formatMoney(p.amountDue)}</Info>
          <Info label="Оплачено">{formatMoney(p.amountPaid)}</Info>
          <Info label="Когда оплачено">{formatDateTime(p.paidAt, tz)}</Info>
          <Info label="Комментарий">
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {p.paymentNote || '-'}
            </Text>
          </Info>
        </DataList>
      </Card>
      {detail.payments.length > 0 && (
        <>
          <Text fw={700}>История оплат</Text>
          <Card padding="xs" radius="md">
            <Table verticalSpacing={6} withRowBorders={false}>
              <Table.Tbody>
                {detail.payments.map((m) => (
                  <Table.Tr key={m.id} style={{ opacity: m.undoneAt ? 0.5 : 1 }}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(m.createdAt, tz)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={600} td={m.undoneAt ? 'line-through' : undefined}>
                        {m.kind === 'donation' ? 'Пожертвование' : 'Взнос'} · {m.method === 'cash' ? 'наличные' : m.method === 'transfer' ? 'перевод' : 'карта'}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {m.acceptedByName ?? '-'}
                        {m.receiptId ? ` · чек №${m.receiptId}` : ''}
                        {m.undoneAt ? ' · отменено' : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" fw={700} style={{ whiteSpace: 'nowrap' }}>
                      {formatMoney(m.amount)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        </>
      )}
      <Text fw={700}>Чеки ({detail.receipts.length})</Text>
      {detail.receipts.length === 0 ? (
        <EmptyBlock icon={<IconReceipt2 size={28} />} title="Чеков пока нет" description="Через бота чек не присылали." />
      ) : (
        <Stack gap="sm">
          {detail.receipts.map((r) => (
            <ReceiptCard key={r.id} receipt={r} canReview={can('payments:write')} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function CheckInsTab({ detail }: { detail: AdminParticipantDetail }) {
  const tz = useEventTz();
  const can = useCan();
  const confirm = useConfirm();
  const revoke = useRevokeCheckIn();
  if (detail.checkIns.length === 0) {
    return <EmptyBlock icon={<IconDoorEnter size={28} />} title="Отметок пока нет" description="Человека ещё не отмечали ни на входе, ни на других точках." />;
  }
  const doRevoke = async (id: number, checkpoint: string) => {
    const ok = await confirm({
      title: 'Отменить отметку?',
      message: `Уберём отметку на точке «${checkpoint}». Если это вход - человек снова будет считаться «не пришёл».`,
      confirmLabel: 'Отменить отметку',
      danger: true,
    });
    if (ok) revoke.mutate(id, { onSuccess: () => notifySuccess('Отметка отменена') });
  };
  return (
    <Table.ScrollContainer minWidth={640} type="native">
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Когда</Table.Th>
            <Table.Th>Точка</Table.Th>
            <Table.Th>Кто отметил</Table.Th>
            <Table.Th>Как</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {detail.checkIns.map((c) => (
            <Table.Tr key={c.id} style={{ opacity: c.revokedAt ? 0.6 : 1 }}>
              <Table.Td>
                <Text size="sm" td={c.revokedAt ? 'line-through' : undefined}>
                  {formatDateTime(c.at, tz)}
                </Text>
              </Table.Td>
              <Table.Td>{c.checkpointName}</Table.Td>
              <Table.Td>
                <StaffName name={c.byName} username={c.byUsername} />
              </Table.Td>
              <Table.Td>
                <Group gap={4}>
                  <Text size="sm">{CHECKIN_METHOD_LABELS[c.method]}</Text>
                  {c.offline && (
                    <Badge size="xs" color="gray" variant="outline">
                      офлайн
                    </Badge>
                  )}
                </Group>
              </Table.Td>
              <Table.Td ta="right">
                {c.revokedAt ? (
                  <Tooltip label={`Отменена ${formatDateTime(c.revokedAt, tz)}`}>
                    <Badge color="gray" size="sm">
                      отменена
                    </Badge>
                  </Tooltip>
                ) : can('checkin:revoke') ? (
                  <Button size="compact-xs" variant="subtle" color="red" loading={revoke.isPending && revoke.variables === c.id} onClick={() => void doRevoke(c.id, c.checkpointName)}>
                    Отменить
                  </Button>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function ActivitiesTab({ detail }: { detail: AdminParticipantDetail }) {
  const tz = useEventTz();
  if (detail.activities.length === 0) {
    return <EmptyBlock icon={<IconCalendarEvent size={28} />} title="На активности не записан(а)" />;
  }
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Активность</Table.Th>
          <Table.Th>Начало</Table.Th>
          <Table.Th>Запись</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {detail.activities.map((a) => {
          const status = a.status as keyof typeof REGISTRATION_STATUS_LABELS;
          return (
            <Table.Tr key={a.activityId}>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {a.title}
                </Text>
              </Table.Td>
              <Table.Td>{formatDateTime(a.startsAt, tz)}</Table.Td>
              <Table.Td>
                <Badge color={REGISTRATION_STATUS_COLORS[status] ?? 'gray'} size="sm">
                  {REGISTRATION_STATUS_LABELS[status] ?? a.status}
                </Badge>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

function ConsentsTab({ detail }: { detail: AdminParticipantDetail }) {
  const tz = useEventTz();
  if (detail.consents.length === 0) {
    return (
      <EmptyBlock
        icon={<IconShieldCheck size={28} />}
        title="Согласий нет"
        description="Обычно так бывает у участников, добавленных вручную: согласие берут на бумаге."
      />
    );
  }
  return (
    <Stack gap="sm">
      {detail.consents.map((c, i) => (
        <Card key={`${c.kind}-${i}`} padding="sm" radius="md">
          <Group justify="space-between" gap="sm">
            <Group gap="xs">
              <IconShieldCheck size={18} color="var(--mantine-color-green-6)" />
              <Text size="sm" fw={600}>
                {CONSENT_KIND_LABELS[c.kind]}
              </Text>
            </Group>
            <Badge variant="outline" color="gray">
              версия {c.documentVersion}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            {formatDateTime(c.givenAt, tz)} · дал(а): {c.givenByName}
          </Text>
        </Card>
      ))}
    </Stack>
  );
}

/** Что бот отправил этому человеку: напоминания, вопросы, QR-коды - и дошло ли. */
function BotTab({ participantId }: { participantId: number }) {
  const tz = useEventTz();
  const q = useParticipantBotMessages(participantId);
  if (q.isPending) return <BlockSkeleton rows={3} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data.length === 0) {
    return <EmptyBlock icon={<IconRobot size={28} />} title="Бот ему ещё ничего не отправлял" description="Журнал ведётся с 6 ноября." />;
  }
  // Карточки: ящик участника узкий и на компьютере.
  return (
    <Stack gap={6}>
      {q.data.map((r) => (
        <MessageCard key={r.id} r={r} tz={tz} showKind />
      ))}
    </Stack>
  );
}

function HistoryTab({ detail }: { detail: AdminParticipantDetail }) {
  const tz = useEventTz();
  if (detail.audit.length === 0) {
    return <EmptyBlock icon={<IconHistory size={28} />} title="Изменений пока не было" />;
  }
  return (
    <Accordion variant="separated" radius="md" chevronPosition="left">
      {detail.audit.map((a) => (
        <Accordion.Item key={a.id} value={String(a.id)}>
          <Accordion.Control>
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text size="sm" fw={600}>
                {auditActionLabel(a.action)}
              </Text>
              <Text size="xs" c="dimmed" ta="right">
                {a.actorName ?? 'система'} · {formatDateTime(a.createdAt, tz)}
              </Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <JsonDiff before={a.before} after={a.after} />
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}
