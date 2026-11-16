import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useCan } from './SessionProvider.tsx';

const ParticipantDrawer = lazy(() => import('../pages/participants/ParticipantDrawer.tsx'));

interface DrawerContextValue {
  /** Открыть карточку участника (из любой страницы). */
  openParticipant: (id: number) => void;
  /** Закрыть карточку (например, перешли в другой раздел). */
  closeParticipant: () => void;
  /** Можно ли открыть карточку при текущих правах. */
  canOpen: boolean;
}

const DrawerContext = createContext<DrawerContextValue>({ openParticipant: () => {}, closeParticipant: () => {}, canOpen: false });

/** Одна карточка участника на всё приложение: из таблицы, журнала отметок, чеков, дублей… */
export function ParticipantDrawerProvider({ children }: { children: ReactNode }) {
  const can = useCan();
  const canOpen = can('participants:read');
  const [state, setState] = useState<{ id: number | null; opened: boolean }>({ id: null, opened: false });

  const openParticipant = useCallback((id: number) => setState({ id, opened: true }), []);
  const closeParticipant = useCallback(() => setState((s) => ({ ...s, opened: false })), []);
  const value = useMemo(() => ({ openParticipant, closeParticipant, canOpen }), [openParticipant, closeParticipant, canOpen]);

  return (
    <DrawerContext.Provider value={value}>
      {children}
      {canOpen && state.id !== null && (
        <Suspense fallback={null}>
          <ParticipantDrawer
            participantId={state.id}
            opened={state.opened}
            onClose={() => setState((s) => ({ ...s, opened: false }))}
            onClosed={() => setState({ id: null, opened: false })}
            onOpenParticipant={openParticipant}
          />
        </Suspense>
      )}
    </DrawerContext.Provider>
  );
}

export function useParticipantDrawer(): DrawerContextValue {
  return useContext(DrawerContext);
}
