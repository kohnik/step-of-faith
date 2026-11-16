import type { Segment } from '@sof/shared';

/**
 * Ключи запросов. Префиксы подобраны так, чтобы инвалидация `['participants']`
 * обновляла и таблицу, и карточки, и дубли.
 */
export const qk = {
  session: ['session'] as const,
  settings: ['settings'] as const,
  dashboard: ['dashboard'] as const,
  participantsAll: ['participants'] as const,
  participants: ['participants', 'list'] as const,
  participant: (id: number) => ['participants', 'detail', id] as const,
  duplicates: ['participants', 'duplicates'] as const,
  counts: ['participants', 'counts'] as const,
  /** Списки участников («Россияне»): под префиксом участников - меняются вместе с таблицей. */
  lists: ['participants', 'groups'] as const,
  receiptsAll: ['receipts'] as const,
  payments: ['payments'] as const,
  money: ['money'] as const,
  receipts: (status: 'pending' | 'accepted' | 'rejected' | 'all') => ['receipts', status] as const,
  checkpoints: ['checkpoints'] as const,
  checkInsAll: ['check-ins'] as const,
  checkIns: (checkpointId: number | null) => ['check-ins', checkpointId ?? 'all'] as const,
  scanLog: (outcome: string | null) => ['scan-log', outcome ?? 'all'] as const,
  activities: ['activities'] as const,
  activitySignup: ['activity-signup'] as const,
  registrations: (activityId: number) => ['activities', activityId, 'registrations'] as const,
  broadcasts: ['broadcasts'] as const,
  broadcastPreview: (segment: Segment) => ['broadcasts', 'preview', segment] as const,
  content: ['content'] as const,
  merch: ['merch'] as const,
  game: ['game'] as const,
  merchOrders: ['merch', 'orders'] as const,
  merchStats: ['merch', 'stats'] as const,
  merchSettings: ['merch', 'settings'] as const,
  chats: ['chats'] as const,
  rooms: ['rooms'] as const,
  seminars: ['seminars'] as const,
  seminarTopics: ['seminars', 'topics'] as const,
  seminarUnplaced: (blockId: number) => ['seminars', 'unplaced', blockId] as const,
  counseling: ['counseling'] as const,
  staff: ['staff'] as const,
  audit: (entity: string, entityId: string) => ['audit', entity, entityId] as const,
};
