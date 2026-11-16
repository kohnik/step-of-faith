import { Alert, Button, Card, Flex, Loader, Radio, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import type { Role, StaffInviteResponse } from '@sof/shared';
import { IconBrandTelegram, IconLink, IconRefresh, IconShare, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';
import { useCreateInvite, useDisableMemberLink, useMakeMemberLink, useMemberLink } from '../../api/staff.ts';
import { AppModal, ModalActions, useIsMobile } from '../../components/AppModal.tsx';
import { useConfirm } from '../../components/ConfirmProvider.tsx';
import { CopyIconButton } from '../../components/CopyValue.tsx';
import { useEventTz } from '../../components/EventProvider.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { useSession } from '../../components/SessionProvider.tsx';
import { formatDateTime } from '../../lib/format.ts';
import { notifyError, notifySuccess } from '../../lib/notify.tsx';
import { assignableRoles, TEAM_ROLE_HINTS, TEAM_ROLE_LABELS } from '../../lib/labels.ts';

const DURATIONS = [
  { value: '24', label: 'Сутки' },
  { value: '72', label: '3 дня' },
  { value: '168', label: 'Неделя' },
  { value: '720', label: 'Месяц' },
  { value: '2160', label: '3 месяца' },
];

/** `onlyCashier` - банкир: приглашает только кассиров. */
export function InviteModal({ opened, onClose, onlyCashier = false }: { opened: boolean; onClose: () => void; onlyCashier?: boolean }) {
  return (
    <AppModal opened={opened} onClose={onClose} title={<Text fw={700}>{onlyCashier ? 'Пригласить кассира' : 'Пригласить в команду'}</Text>} size="lg">
      <InviteForm onDone={onClose} onlyCashier={onlyCashier} />
    </AppModal>
  );
}

function InviteForm({ onDone, onlyCashier }: { onDone: () => void; onlyCashier: boolean }) {
  const tz = useEventTz();
  const mobile = useIsMobile();
  const { session } = useSession();
  const invite = useCreateInvite();
  const [role, setRole] = useState<Role>(onlyCashier ? 'cashier' : 'scanner');
  const [hours, setHours] = useState('72');
  const [result, setResult] = useState<StaffInviteResponse | null>(null);
  const roles: Role[] = onlyCashier ? ['cashier', 'member'] : assignableRoles(session.roles.includes('superadmin'));

  if (result) {
    return (
      <Stack gap="md">
        <Alert color="green" variant="light" icon={<IconBrandTelegram size={18} />}>
          Готово! Отправьте ссылку человеку: он откроет бота, нажмёт «Старт» и сразу станет «{TEAM_ROLE_LABELS[role]}».
          Ссылка сработает один раз.
        </Alert>
        <LinkCard
          link={result.link}
          note={`Действует до ${formatDateTime(result.expiresAt, tz)}. Можно показать QR с экрана - человек наведёт на него камеру телефона.`}
        />
        <ModalActions>
          <Button variant="default" onClick={() => setResult(null)}>
            Ещё приглашение
          </Button>
          <Button onClick={onDone}>Готово</Button>
        </ModalActions>
      </Stack>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        invite.mutate({ role, expiresInHours: Number(hours) }, { onSuccess: setResult });
      }}
    >
      <Stack gap="md">
        <Radio.Group label="Кем будет" value={role} onChange={(v) => setRole(v as Role)}>
          <Stack gap="sm" mt="xs">
            {roles.map((r) => (
              <Radio key={r} value={r} label={TEAM_ROLE_LABELS[r]} description={TEAM_ROLE_HINTS[r]} />
            ))}
          </Stack>
        </Radio.Group>
        {role === 'member' ? (
          <MemberLinkPanel onDone={onDone} />
        ) : (
          <>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Ссылка действует
              </Text>
              <SegmentedControl value={hours} onChange={setHours} data={DURATIONS} fullWidth={mobile} style={{ alignSelf: mobile ? undefined : 'flex-start' }} />
            </Stack>
            {!onlyCashier && (
              <Text size="sm" c="dimmed">
                Волонтёру без Telegram сделайте карточку: «Команда» → «Дополнительно» → «Карточка волонтёра».
              </Text>
            )}
            <ModalActions>
              <Button variant="default" onClick={onDone}>
                Отмена
              </Button>
              <Button type="submit" loading={invite.isPending}>
                Создать ссылку
              </Button>
            </ModalActions>
          </>
        )}
      </Stack>
    </form>
  );
}

const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/** QR, ссылка с копированием и «Отправить». */
function LinkCard({ link, note }: { link: string; note: string }) {
  const mobile = useIsMobile();
  return (
    <Card withBorder padding="md" radius="md">
      <Flex direction={mobile ? 'column' : 'row'} gap="lg" align="center">
        <QrCode value={link} size={mobile ? 220 : 150} label="QR-код приглашения" />
        <Stack gap="xs" w="100%" style={{ minWidth: 0, flex: 1 }}>
          <TextInput
            value={link}
            readOnly
            leftSection={<IconLink size={16} />}
            rightSection={<CopyIconButton value={link} label="Скопировать ссылку" />}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Ссылка-приглашение"
          />
          {canShare() && (
            <Button
              variant="light"
              leftSection={<IconShare size={16} />}
              onClick={() => void navigator.share({ title: 'Приглашение в команду', url: link }).catch(() => undefined)}
            >
              Отправить ссылку
            </Button>
          )}
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        </Stack>
      </Flex>
    </Card>
  );
}

/** «Участник команды» - одна многоразовая ссылка на всех: создать, показать снова, сменить, отключить. */
function MemberLinkPanel({ onDone }: { onDone: () => void }) {
  const tz = useEventTz();
  const confirm = useConfirm();
  const q = useMemberLink();
  const make = useMakeMemberLink();
  const disable = useDisableMemberLink();
  const view = q.data;

  const reset = async () => {
    const ok = await confirm({
      title: 'Сменить ссылку?',
      message: 'Старая ссылка сразу перестанет работать. Те, кто уже вступил, останутся в команде.',
      confirmLabel: 'Сменить',
    });
    if (ok) make.mutate(true, { onSuccess: () => notifySuccess('Ссылка новая, старая больше не работает'), onError: (err) => notifyError(err) });
  };
  const off = async () => {
    const ok = await confirm({
      title: 'Отключить ссылку?',
      message: 'По ней больше никто не вступит. Те, кто уже вступил, останутся в команде.',
      confirmLabel: 'Отключить',
      danger: true,
    });
    if (ok) disable.mutate(undefined, { onSuccess: () => notifySuccess('Ссылка отключена'), onError: (err) => notifyError(err) });
  };

  if (q.isPending) return <Loader size="sm" />;

  return (
    <Stack gap="md">
      <Alert color="cyan" variant="light" icon={<IconUsers size={18} />}>
        Одна ссылка на всех: её можно скинуть в общий чат команды. Каждый, кто откроет её и нажмёт «Старт» в боте, станет «Участником
        команды». Ссылка работает, пока вы её не смените или не отключите.
      </Alert>
      {view ? (
        <LinkCard
          link={view.link}
          note={`Создана ${formatDateTime(view.createdAt, tz)}. По ней вступили: ${view.uses}.`}
        />
      ) : (
        <Text size="sm" c="dimmed">
          Ссылки пока нет.
        </Text>
      )}
      <ModalActions>
        {view ? (
          <>
            <Button variant="subtle" color="red" onClick={() => void off()} loading={disable.isPending}>
              Отключить
            </Button>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void reset()} loading={make.isPending}>
              Сменить ссылку
            </Button>
            <Button onClick={onDone}>Готово</Button>
          </>
        ) : (
          <>
            <Button variant="default" onClick={onDone}>
              Отмена
            </Button>
            <Button onClick={() => make.mutate(false, { onError: (err) => notifyError(err) })} loading={make.isPending}>
              Создать ссылку
            </Button>
          </>
        )}
      </ModalActions>
    </Stack>
  );
}
