import type {
  AuditEntry,
  MemberLinkView,
  Role,
  ScannerCardResponse,
  StaffInviteResponse,
  StaffMember,
  StaffPasswordResponse,
} from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client.ts';
import { qk } from './keys.ts';

export function useStaff(enabled = true) {
  return useQuery({
    queryKey: qk.staff,
    queryFn: ({ signal }) => api.get<StaffMember[]>('/api/admin/staff', { signal }),
    enabled,
  });
}

export function useSetRoles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, roles }: { userId: number; roles: Role[] }) =>
      api.post<StaffMember>(`/api/admin/staff/${userId}/roles`, { roles }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.staff }),
  });
}

export function useCreateInvite() {
  return useMutation({
    mutationFn: (input: { role: Role; expiresInHours: number }) =>
      api.post<StaffInviteResponse>('/api/admin/staff/invites', input),
  });
}

const memberLinkKey = [...qk.staff, 'member-link'] as const;

/** Многоразовая ссылка «Участник команды» (null - не создана или отключена). */
export function useMemberLink(enabled = true) {
  return useQuery({
    queryKey: memberLinkKey,
    queryFn: ({ signal }) => api.get<{ link: MemberLinkView | null }>('/api/admin/staff/member-link', { signal }).then((r) => r.link),
    enabled,
  });
}

export function useMakeMemberLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reset: boolean) => api.post<MemberLinkView>('/api/admin/staff/member-link', { reset }),
    onSuccess: (view) => qc.setQueryData(memberLinkKey, view),
  });
}

export function useDisableMemberLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ ok: true }>('/api/admin/staff/member-link'),
    onSuccess: () => qc.setQueryData(memberLinkKey, null),
  });
}

export function useCreateScannerCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; role: 'scanner' | 'cashier'; expiresInHours: number }) =>
      api.post<ScannerCardResponse>('/api/admin/staff/scanner-cards', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.staff }),
  });
}

export function useSetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, login, password }: { userId: number; login: string; password: string }) =>
      api.post<StaffPasswordResponse>(`/api/admin/staff/${userId}/password`, { login, password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.staff }),
  });
}

export function useAudit(entity: string, entityId: string, enabled = true) {
  return useQuery({
    queryKey: qk.audit(entity, entityId),
    queryFn: ({ signal }) => api.get<AuditEntry[]>(withQuery('/api/admin/audit', { entity, entityId }), { signal }),
    enabled,
  });
}
