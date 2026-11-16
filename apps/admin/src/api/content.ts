import type { AnnouncementInput, AnnouncementView, InfoPageInput, InfoPageView, InfoResponse } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

export function useContent(enabled = true) {
  return useQuery({
    queryKey: qk.content,
    queryFn: ({ signal }) => api.get<InfoResponse>('/api/admin/content', { signal }),
    enabled,
  });
}

function useInvalidateContent() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: qk.content });
}

export function useSavePage() {
  const invalidate = useInvalidateContent();
  return useMutation({
    mutationFn: ({ slug, input }: { slug: string; input: InfoPageInput }) =>
      api.put<InfoPageView>(`/api/admin/info-pages/${encodeURIComponent(slug)}`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeletePage() {
  const invalidate = useInvalidateContent();
  return useMutation({
    mutationFn: (slug: string) => api.delete<{ ok: true }>(`/api/admin/info-pages/${encodeURIComponent(slug)}`),
    onSuccess: () => invalidate(),
  });
}

export function useCreateAnnouncement() {
  const invalidate = useInvalidateContent();
  return useMutation({
    mutationFn: (input: AnnouncementInput) => api.post<AnnouncementView>('/api/admin/announcements', input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateAnnouncement() {
  const invalidate = useInvalidateContent();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<AnnouncementInput> }) =>
      api.patch<AnnouncementView>(`/api/admin/announcements/${id}`, patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAnnouncement() {
  const invalidate = useInvalidateContent();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/api/admin/announcements/${id}`),
    onSuccess: () => invalidate(),
  });
}
