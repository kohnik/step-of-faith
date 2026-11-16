import type { SessionInfo } from '@sof/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from './client.ts';
import { qk } from './keys.ts';

/** Текущая сессия. `null` - не вошли (или сессия истекла). */
export function useSessionQuery() {
  return useQuery({
    queryKey: qk.session,
    queryFn: async ({ signal }) => {
      try {
        return await api.get<SessionInfo>('/api/auth/session', { signal, skipAuthRedirect: true });
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
  });
}

export function useLoginToken() {
  return useMutation({
    mutationFn: (token: string) =>
      api.post<SessionInfo>('/api/auth/login-token', { token, mode: 'cookie' }, { skipAuthRedirect: true }),
    meta: { silent: true },
  });
}

export interface PasswordLoginInput {
  login: string;
  password: string;
  totp: string;
}

export function usePasswordLogin() {
  return useMutation({
    mutationFn: (input: PasswordLoginInput) => api.post<SessionInfo>('/api/auth/password', input, { skipAuthRedirect: true }),
    meta: { silent: true },
  });
}

export function useLogoutMutation() {
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/logout', undefined, { skipAuthRedirect: true }),
    meta: { silent: true },
  });
}
