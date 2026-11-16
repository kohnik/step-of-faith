import { canUseAdminWeb, ROLE_LABELS } from '@sof/shared';
import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  IconBuildingBank,
  IconCalendarEvent,
  IconCash,
  IconChartBar,
  IconChevronRight,
  IconCloudUpload,
  IconDeviceDesktop,
  IconScan,
  IconShirt,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client.ts';
import { useEnv } from '../app/env.ts';
import { haptic } from '../lib/feedback.ts';
import { confirmAction, openExternal } from '../telegram/actions.ts';
import { Button, cx, Notice, Spinner } from '../ui/kit.tsx';
import { IconChip, type Hue, type TablerIcon } from '../ui/icons.tsx';
import { Page } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { useOutbox } from './outbox.ts';
import { can, logoutBrowser, useStaff } from './session.ts';
import { useBeforeEvent } from './common.ts';
import { SessionExpiredNotice } from './SessionExpired.tsx';

function BigTile({
  icon,
  hue,
  title,
  subtitle,
  onClick,
  busy,
  accent,
}: {
  icon: TablerIcon;
  hue: Hue;
  title: string;
  subtitle: string;
  onClick: () => void;
  busy?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cx(
        'flex min-h-28 w-full items-center gap-4 rounded-3xl px-4 py-4 text-left transition active:scale-[0.98] active:opacity-80',
        accent ? 'bg-btn text-btn-fg' : 'bg-section',
      )}
    >
      <IconChip icon={icon} hue={hue} size="lg" onAccent={accent} />
      <span className="min-w-0 flex-1">
        <span className="block text-[22px] font-bold leading-tight">{title}</span>
        <span className={cx('mt-1 block text-[14px] leading-snug', accent ? 'opacity-85' : 'text-subtle')}>{subtitle}</span>
      </span>
      {busy ? <Spinner className="size-6" /> : <IconChevronRight size={22} className={accent ? 'opacity-70' : 'text-hint'} />}
    </button>
  );
}

export default function StaffHome() {
  const staff = useStaff();
  const env = useEnv();
  const [, navigate] = useLocation();
  const outbox = useOutbox();
  const canScan = can(staff, 'checkin:write');
  const canActs = can(staff, 'activities:own') || can(staff, 'activities:all');
  const canAdmin = canUseAdminWeb(staff.roles);
  const canCash = can(staff, 'payments:write') && staff.features?.payments !== false;
  const canStats = can(staff, 'dashboard:read');
  const canBank = can(staff, 'money:manage');
  const canMerch = can(staff, 'merch:sell');
  const canGame = can(staff, 'game:manage');
  const payMode = useBeforeEvent();
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminUrl, setAdminUrl] = useState<string | null>(null);
  const qc = useQueryClient();
  const [wiping, setWiping] = useState(false);

  // Только на время разработки и только для тех, кому сервер разрешил (features.devTools).
  const wipe = async () => {
    if (wiping) return;
    const first = await confirmAction({
      title: 'Очистить всю базу?',
      message:
        'Удалятся регистрации, QR-коды, отметки и аккаунты (кроме вашего и главных админов). Переписка с ботом очистится за 48 часов - старше Telegram удалить не даёт. Всем придёт сообщение зарегистрироваться заново.',
      ok: 'Очистить',
      destructive: true,
    });
    if (!first) return;
    const second = await confirmAction({ title: 'Точно?', message: 'Вернуть данные можно только из бэкапа на сервере.', ok: 'Да, удалить всё', destructive: true });
    if (!second) return;
    setWiping(true);
    try {
      const res = await staffApi.devWipe();
      haptic('success');
      toast.success(`Готово: удалено людей ${res.participants}, аккаунтов ${res.accounts}. Сообщение уходит ${res.notifying} получателям.`);
      await qc.invalidateQueries();
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setWiping(false);
    }
  };

  const openAdmin = async () => {
    if (adminBusy) return;
    setAdminBusy(true);
    try {
      const { url } = await staffApi.adminLink();
      haptic('light');
      setAdminUrl(url);
      openExternal(url);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setAdminBusy(false);
    }
  };

  return (
    <Page
      title="Команда"
      subtitle={`${staff.user.name} · ${staff.roles.map((r) => ROLE_LABELS[r]).join(', ')}`}
      back={env.mode === 'telegram' ? '~/' : null}
    >
      <SessionExpiredNotice />
      {outbox.count > 0 && (
        <Notice tone="yellow" className="mb-4 flex items-center gap-2">
          <IconCloudUpload size={20} />
          Ждут отправки: {outbox.count}. Уйдут сами, когда появится связь.
        </Notice>
      )}
      <div className="space-y-3">
        {canScan && (
          <BigTile
            icon={IconScan}
            hue="blue"
            title="Сканер"
            subtitle={
              payMode
                ? canCash
                  ? 'До начала конференции - приём взносов по QR-коду'
                  : 'До начала конференции - проверка оплаты по QR-коду'
                : 'Отметка на входе и поиск по фамилии'
            }
            onClick={() => navigate('/scan')}
            accent
          />
        )}
        {canCash && (
          <BigTile
            icon={IconCash}
            hue="green"
            title="Касса"
            subtitle="Принять взнос: по QR-коду или фамилии"
            onClick={() => navigate('/cash')}
          />
        )}
        {canBank && (
          <BigTile
            icon={IconBuildingBank}
            hue="orange"
            title="Банк"
            subtitle="Выдать и принять деньги, сколько должно остаться"
            onClick={() => navigate('/bank')}
          />
        )}
        {canMerch && (
          <BigTile
            icon={IconShirt}
            hue="pink"
            title="Мерч"
            subtitle="Продать, выдать бронь, долги"
            onClick={() => navigate('/merch')}
            accent={!canScan}
          />
        )}
        {canGame && (
          <BigTile
            icon={IconWorld}
            hue="blue"
            title="Игра · пульт"
            subtitle="Команды, задания, кто на сцене, голосование"
            onClick={() => navigate('/game')}
            accent={!canScan && !canMerch}
          />
        )}
        {canStats && (
          <BigTile
            icon={IconChartBar}
            hue="orange"
            title="Статистика"
            subtitle="Регистрации, оплата, питание, кто на месте"
            onClick={() => navigate('/stats')}
          />
        )}
        {canActs && (
          <BigTile
            icon={IconCalendarEvent}
            hue="violet"
            title={can(staff, 'activities:all') ? 'Активности' : 'Мои активности'}
            subtitle="Создать, изменить, кто записался"
            onClick={() => navigate('/activities')}
          />
        )}
        {canAdmin && (
          <BigTile
            icon={IconDeviceDesktop}
            hue="teal"
            title="Админка"
            subtitle="Участники, сводка, расписание - в браузере"
            onClick={() => void openAdmin()}
            busy={adminBusy}
          />
        )}
      </div>

      {adminUrl && (
        <Notice tone="gray" className="mt-4">
          <p>Админка не открылась? Нажмите ещё раз - ссылка действует несколько минут.</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => openExternal(adminUrl)}>
            Открыть админку
          </Button>
        </Notice>
      )}

      {!canScan && !canActs && !canAdmin && !canMerch && !canGame && <Notice tone="gray">Для вашей роли здесь пока ничего нет.</Notice>}

      {staff.features?.devTools && (
        <Button variant="danger" block className="mt-8" loading={wiping} onClick={() => void wipe()}>
          <IconTrash size={18} /> Очистить всю базу (разработка)
        </Button>
      )}

      {env.mode === 'browser' && (
        <Button
          variant="plain"
          block
          className="mt-6"
          onClick={() => {
            void logoutBrowser().then(() => window.location.assign('/staff/login'));
          }}
        >
          Выйти
        </Button>
      )}
    </Page>
  );
}
