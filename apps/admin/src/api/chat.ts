import type { ChatMark, ChatMessageView, ChatPerson, ChatSearchHit, ChatThreadRow, ChatThreadView, ChatTopic } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client.ts';
import { qk } from './keys.ts';

export type ChatFilter = 'all' | 'unread' | 'marked';
/** Папка: все переписки, «Мерч» или всё, кроме мерча. */
export type ChatFolder = 'all' | 'merch' | 'other';

/** Переписки: последние сверху; обновляем каждые 15 секунд, пока страница открыта. */
export function useChatThreads(search: string, filter: ChatFilter, folder: ChatFolder = 'all') {
  return useQuery({
    queryKey: [...qk.chats, 'list', search, filter, folder],
    queryFn: ({ signal }) =>
      api.get<ChatThreadRow[]>(
        withQuery('/api/admin/chats', {
          q: search || null,
          unread: filter === 'unread' ? 1 : null,
          marked: filter === 'marked' ? 1 : null,
          folder: folder === 'all' ? null : folder,
        }),
        { signal },
      ),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
}

/** Поиск по тексту сообщений (от 2 букв). */
export function useChatSearch(search: string) {
  return useQuery({
    queryKey: [...qk.chats, 'search', search],
    queryFn: ({ signal }) => api.get<ChatSearchHit[]>(withQuery('/api/admin/chats/search', { q: search }), { signal }),
    enabled: search.length >= 2,
    placeholderData: (prev) => prev,
  });
}

/** Сколько переписок с непрочитанным - для счётчика в меню. */
export function useChatUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: [...qk.chats, 'count'],
    queryFn: ({ signal }) => api.get<{ unread: number }>('/api/admin/chats/count', { signal }),
    enabled,
    refetchInterval: 30_000,
  });
}

/** Открытая переписка: последние сообщения, обновляем каждые 5 секунд. */
export function useChatThread(userId: number | null) {
  return useQuery({
    queryKey: [...qk.chats, 'thread', userId],
    queryFn: ({ signal }) => api.get<ChatThreadView>(`/api/admin/chats/${userId}`, { signal }),
    enabled: userId !== null,
    refetchInterval: 5_000,
  });
}

/** Сообщения раньше `before` - листаем вверх. */
export const loadEarlier = (userId: number, before: number) => api.get<ChatThreadView>(withQuery(`/api/admin/chats/${userId}`, { before }));

export function useMarkChatRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.post<{ ok: true }>(`/api/admin/chats/${userId}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chats }),
  });
}

/** «Отметить непрочитанным»: переписка снова в непрочитанных и в счётчике меню. */
export function useMarkChatUnread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.post<{ ok: true }>(`/api/admin/chats/${userId}/unread`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chats }),
  });
}

/** Перенести в папку «Мерч» или вернуть в общие (null). */
export function useSetChatTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, topic }: { userId: number; topic: ChatTopic | null }) => api.put<{ ok: true }>(`/api/admin/chats/${userId}/topic`, { topic }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chats }),
  });
}

/** Отметка-смайлик переписки; null - снять. */
export function useSetChatMark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, mark }: { userId: number; mark: ChatMark | null }) => api.put<{ ok: true }>(`/api/admin/chats/${userId}/mark`, { mark }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chats }),
  });
}

export function useSendChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, text, photo }: { userId: number; text: string | null; photo: string | null }) =>
      api.post<ChatMessageView>(`/api/admin/chats/${userId}/messages`, { text, photo }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chats }),
  });
}

/** Картинка к сообщению: загружаем сразу, отправляем потом вместе с текстом. */
export function uploadChatPhoto(file: File) {
  const form = new FormData();
  form.append('file', file);
  return api.post<{ photo: string }>('/api/admin/chats/upload', form);
}

/** Кому написать первым. */
export function useChatPeople(search: string) {
  return useQuery({
    queryKey: [...qk.chats, 'people', search],
    queryFn: ({ signal }) => api.get<ChatPerson[]>(withQuery('/api/admin/chats/people', { q: search }), { signal }),
    enabled: search.trim().length >= 2,
    placeholderData: (prev) => prev,
  });
}

export const chatPhotoUrl = (messageId: number, thumb = false) => `/api/admin/chats/photo/${messageId}${thumb ? '?thumb=1' : ''}`;
export const chatAvatarUrl = (userId: number) => `/api/admin/chats/avatar/${userId}`;
/** Превью загруженной, но ещё не отправленной картинки. */
export const chatUploadUrl = (photo: string) => `/api/admin/chats/upload/${photo.replace(/^chat\//, '').replace(/\.webp$/, '')}`;
