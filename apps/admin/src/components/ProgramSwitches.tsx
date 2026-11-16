import { Card, Stack, Switch } from '@mantine/core';
import type { ReactNode } from 'react';
import { useActivitySignup, useSetActivitySignup } from '../api/activities.ts';
import { useCounseling, useSetCounselingOpen } from '../api/counseling.ts';
import { useSeminars, useSetAllSeminarsRegistration } from '../api/seminars.ts';
import { useSaveSettings, useSettingsQuery } from '../api/settings.ts';
import { SETTINGS_READ } from '../lib/permissions.ts';
import { notifyError, notifySuccess } from '../lib/notify.tsx';
import { useCan } from './SessionProvider.tsx';

export type ProgramSwitchKind = 'schedule' | 'activities' | 'seminars' | 'counseling';

const ALL: ProgramSwitchKind[] = ['schedule', 'activities', 'seminars', 'counseling'];

/**
 * Выключатели программы - одинаковые в «Настройках», «Расписании», «Семинарах» и «Душепопечении».
 * Подпись всегда называет, что включено («… открыта», «Показывать …»), а состояние показывает сам выключатель.
 * Срабатывают сразу, без «Сохранить». Нет права менять - выключатель серый.
 */
export function ProgramSwitches({
  only = ALL,
  card = true,
  hints = true,
}: {
  only?: ProgramSwitchKind[];
  card?: boolean;
  /** false - только подписи, без пояснений под ними. */
  hints?: boolean;
}) {
  const can = useCan();
  const canAll = can('activities:all');
  const canSignup = can('activities:own', 'activities:all');
  const show = (k: ProgramSwitchKind) => only.includes(k);

  // Кассир видит «Настройки» без прав на расписание: запись на мероприятия и душепопечение показываем ему из настроек.
  const settings = useSettingsQuery(
    can(...SETTINGS_READ) && (show('schedule') || (show('activities') && !canSignup) || (show('counseling') && !canAll)),
  );
  const saveSettings = useSaveSettings();
  const signup = useActivitySignup(show('activities') && canSignup);
  const setSignup = useSetActivitySignup();
  const seminars = useSeminars(show('seminars') && canAll);
  const setSeminars = useSetAllSeminarsRegistration();
  const counseling = useCounseling(show('counseling') && canAll);
  const setCounseling = useSetCounselingOpen();

  const done = (title: string, text: string) => notifySuccess(text, title);
  const rows: ReactNode[] = [];

  if (show('schedule') && settings.data) {
    const on = settings.data.scheduleVisible;
    rows.push(
      <Switch
        key="schedule"
        label="Показывать расписание участникам"
        description="Выключено - участники видят «Программа скоро будет», кнопки расписания в боте нет. Команда видит всё."
        checked={on}
        disabled={!can('settings:write') || saveSettings.isPending}
        onChange={(e) =>
          saveSettings.mutate(
            { scheduleVisible: e.currentTarget.checked },
            {
              onSuccess: (s) => done('Расписание', s.scheduleVisible ? 'Видно участникам' : 'Скрыто от участников'),
              onError: (err) => notifyError(err),
            },
          )
        }
      />,
    );
  }

  const activitiesOpen = signup.data?.open ?? settings.data?.activityRegistrationOpen;
  if (show('activities') && activitiesOpen !== undefined) {
    rows.push(
      <Switch
        key="activities"
        label="Запись на мероприятия открыта"
        description="Выключено - вместо «Записаться» участники видят «Запись откроется на конференции». Волонтёры записывать могут всегда."
        checked={activitiesOpen}
        disabled={!canAll || setSignup.isPending}
        onChange={(e) =>
          setSignup.mutate(e.currentTarget.checked, {
            onSuccess: (d) => done('Мероприятия', d.open ? 'Запись открыта' : 'Запись закрыта'),
            onError: (err) => notifyError(err),
          })
        }
      />,
    );
  }

  if (show('seminars') && seminars.data && seminars.data.length > 0) {
    const blocks = seminars.data;
    // Включён, если выбор открыт хоть в одном потоке; переключение открывает или закрывает все потоки сразу.
    const on = blocks.some((b) => b.registrationOpen);
    rows.push(
      <Switch
        key="seminars"
        label="Выбор семинаров открыт"
        description={hints ? 'Участники выбирают темы в приложении и могут передумать. После публикации выбор остаётся открытым, пока не выключите.' : undefined}
        checked={on}
        disabled={!canAll || setSeminars.isPending}
        onChange={(e) =>
          setSeminars.mutate(e.currentTarget.checked, {
            onSuccess: (list) => done('Семинары', list.some((b) => b.registrationOpen) ? 'Выбор тем открыт' : 'Выбор тем закрыт'),
            onError: (err) => notifyError(err),
          })
        }
      />,
    );
  }

  const counselingOpen = counseling.data?.open ?? settings.data?.counselingOpen;
  if (show('counseling') && counselingOpen !== undefined) {
    rows.push(
      <Switch
        key="counseling"
        label="Запись на душепопечение открыта"
        description="Выключено - участники видят служителей, но записаться не могут."
        checked={counselingOpen}
        disabled={!canAll || setCounseling.isPending}
        onChange={(e) =>
          setCounseling.mutate(e.currentTarget.checked, {
            onSuccess: (d) => done('Душепопечение', d.open ? 'Запись открыта' : 'Запись закрыта'),
            onError: (err) => notifyError(err),
          })
        }
      />,
    );
  }

  if (rows.length === 0) return null;
  const list = <Stack gap="md">{rows}</Stack>;
  return card ? <Card padding="md">{list}</Card> : list;
}
