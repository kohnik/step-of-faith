import { DEFAULT_SETTINGS, type Settings } from '@sof/shared';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useSettingsQuery } from '../api/settings.ts';
import { cachedEventName, rememberEventName } from '../lib/eventName.ts';
import { SETTINGS_READ } from '../lib/permissions.ts';
import { safeTimeZone } from '../lib/tz.ts';
import { useCan, useSession } from './SessionProvider.tsx';

interface EventContextValue {
  /** Часовой пояс конференции - все даты показываем и вводим в нём. */
  tz: string;
  /** Название конференции (из настроек, иначе из сессии). */
  eventName: string;
  /** Настройки, если текущей роли их можно читать. */
  settings: Settings | null;
  /** Пояс известен (из настроек или сессии), а не запасной по умолчанию. */
  tzKnown: boolean;
}

const EventContext = createContext<EventContextValue>({
  tz: DEFAULT_SETTINGS.eventTimezone,
  eventName: DEFAULT_SETTINGS.eventName,
  settings: null,
  tzKnown: false,
});

export function EventProvider({ children }: { children: ReactNode }) {
  const can = useCan();
  const { session } = useSession();
  const readable = can(...SETTINGS_READ);
  const { data } = useSettingsQuery(readable);
  // Роли без доступа к настройкам (например, организатор) берут пояс и название из сессии.
  const fromSession = session.event;
  const value = useMemo<EventContextValue>(
    () => ({
      tz: safeTimeZone(data?.eventTimezone ?? fromSession?.timezone),
      eventName: data?.eventName || fromSession?.name || cachedEventName(),
      settings: data ?? null,
      tzKnown: !!data || !!fromSession?.timezone,
    }),
    [data, fromSession?.timezone, fromSession?.name],
  );

  // Запоминаем название - им подписаны страница входа и вкладка браузера до входа.
  const knownName = data?.eventName || fromSession?.name;
  useEffect(() => {
    if (knownName) rememberEventName(knownName);
  }, [knownName]);

  return <EventContext.Provider value={value}>{children}</EventContext.Provider>;
}

export function useEvent(): EventContextValue {
  return useContext(EventContext);
}

/** Часовой пояс конференции. */
export function useEventTz(): string {
  return useContext(EventContext).tz;
}
