/**
 * Название конференции для страниц, где данных с сервера ещё нет (вход сканера, «откройте в Telegram»).
 * Совпадает с DEFAULT_SETTINGS.eventName из @sof/shared; там, где есть `me.event.name`,
 * `session.event.name` или `ticket.eventName`, берём название оттуда.
 */
export const DEFAULT_EVENT_NAME = 'Шаг веры 2026';
