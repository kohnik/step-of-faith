import { DEFAULT_SETTINGS } from '@sof/shared';
import { readStored, writeStored } from './storage.ts';

/**
 * Название конференции берём из настроек/сессии. До входа (страница логина,
 * заголовок вкладки) их ещё нет - показываем последнее известное название.
 * Тот же ключ читает inline-скрипт в index.html.
 */
const KEY = 'event.name';

export function cachedEventName(): string {
  const value = readStored<unknown>(KEY, null);
  return typeof value === 'string' && value.trim() ? value : DEFAULT_SETTINGS.eventName;
}

export function rememberEventName(name: string): void {
  if (name.trim()) writeStored(KEY, name.trim());
}
