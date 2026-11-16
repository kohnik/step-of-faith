import { DEFAULT_BREAKFAST, DEFAULT_TIERS, type BreakfastConfig, type Permission, type SessionInfo, type TiersConfig } from '@sof/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { qk } from '../api/keys.ts';
import { useLogoutMutation } from '../api/session.ts';
import { hasAny } from '../lib/permissions.ts';

interface SessionContextValue {
  session: SessionInfo;
  /** Есть хотя бы одно из прав. */
  can: (...anyOf: Permission[]) => boolean;
  /**
   * Приём оплаты включён в настройках. Пока выключен - прячем всё про оплату:
   * раздел «Оплаты», колонки, фильтры, статусы, чеки. Код остаётся на случай включения.
   */
  paymentsEnabled: boolean;
  logout: () => Promise<void>;
  loggingOut: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ session, children }: { session: SessionInfo; children: ReactNode }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { mutateAsync: logoutRequest, isPending: loggingOut } = useLogoutMutation();

  const can = useCallback((...anyOf: Permission[]) => hasAny(session.permissions, anyOf), [session.permissions]);
  // Старый сервер без `features` - считаем, что оплата выключена (так же по умолчанию в настройках).
  const paymentsEnabled = session.features?.payments ?? false;

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      /* даже если сервер недоступен - локально выходим */
    }
    navigate('/login', { replace: true });
    qc.clear();
    qc.setQueryData(qk.session, null);
  }, [logoutRequest, qc, navigate]);

  const value = useMemo(
    () => ({ session, can, paymentsEnabled, logout, loggingOut }),
    [session, can, paymentsEnabled, logout, loggingOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() вне SessionProvider');
  return value;
}

export function useCan(): SessionContextValue['can'] {
  return useSession().can;
}

/** Варианты участия (цены и цвета бейджей) - из сессии; у старого сервера - по умолчанию. */
export function useTiers(): TiersConfig {
  return useSession().session.tiers ?? DEFAULT_TIERS;
}

/** Завтрак (доплата и лимит) - из сессии; у старого сервера - по умолчанию. */
export function useBreakfast(): BreakfastConfig {
  return useSession().session.breakfast ?? DEFAULT_BREAKFAST;
}

/** Включён ли приём оплаты (статусы, чеки, касса). */
export function usePaymentsEnabled(): boolean {
  return useSession().paymentsEnabled;
}
