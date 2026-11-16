import type { BotLogOverview, BotMessageRow, BotRunDetail, BotUnreachableRow } from '@sof/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './client.ts';

/** Сообщения бота: сводка, запуски, что дальше. Обновляем раз в 30 секунд, пока страница открыта. */
export function useBotLog() {
  return useQuery({
    queryKey: ['bot-log'],
    queryFn: ({ signal }) => api.get<BotLogOverview>('/api/admin/bot-log', { signal }),
    refetchInterval: 30_000,
  });
}

export function useBotRun(key: string | null) {
  return useQuery({
    queryKey: ['bot-log', 'run', key],
    queryFn: ({ signal }) => api.get<BotRunDetail>(`/api/admin/bot-log/runs/${encodeURIComponent(key!)}`, { signal }),
    enabled: key !== null,
  });
}

export function useBotUnreachable(enabled: boolean) {
  return useQuery({
    queryKey: ['bot-log', 'unreachable'],
    queryFn: ({ signal }) => api.get<BotUnreachableRow[]>('/api/admin/bot-log/unreachable', { signal }),
    enabled,
  });
}

/** Что бот отправил участнику - для карточки. */
export function useParticipantBotMessages(participantId: number | null, enabled = true) {
  return useQuery({
    queryKey: ['bot-log', 'participant', participantId],
    queryFn: ({ signal }) => api.get<BotMessageRow[]>(`/api/admin/participants/${participantId}/bot-messages`, { signal }),
    enabled: enabled && participantId !== null,
  });
}
