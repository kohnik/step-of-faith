import type { GameAdminView, GameBotUser, GameCandidate, GameConfig, GameLaunch, GameScreenView, GameTaskInput, GameTeamUpdate } from '@sof/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { qk } from './keys.ts';

/** Пульт ведущего: обновляем каждые 2 секунды - голоса, таймер и состав меняются на глазах. */
export function useGameAdmin() {
  return useQuery({
    queryKey: qk.game,
    queryFn: ({ signal }) => api.get<GameAdminView>('/api/admin/game', { signal }),
    refetchInterval: 2000,
  });
}

/** Любое действие ведущего возвращает свежий пульт - подменяем без перезапроса. */
function useGameAction<V>(fn: (v: V) => Promise<GameAdminView>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (view) => qc.setQueryData(qk.game, view) });
}

export const useSaveGameConfig = () => useGameAction((config: GameConfig) => api.put<GameAdminView>('/api/admin/game/config', config));
export const useGameSignup = () => useGameAction((open: boolean) => api.post<GameAdminView>('/api/admin/game/signup', { open }));
export const useGameReinvite = () => useGameAction(() => api.post<GameAdminView>('/api/admin/game/reinvite', {}));
export const useGameDistribute = () =>
  useGameAction(async () => (await api.post<{ assigned: number; unassigned: number; view: GameAdminView }>('/api/admin/game/distribute', {})).view);
export const useGameResetDistribution = () => useGameAction(() => api.post<GameAdminView>('/api/admin/game/reset-distribution', {}));
export const useGameFlags = () =>
  useGameAction((flags: { designLocked?: boolean; resultsShown?: boolean }) => api.post<GameAdminView>('/api/admin/game/flags', flags));
export const useGameScreenToken = () => useGameAction(() => api.post<GameAdminView>('/api/admin/game/screen-token', {}));
export const useGameTeamCount = () => useGameAction((count: number) => api.post<GameAdminView>('/api/admin/game/teams/count', { count }));
export const useGameTeamUpdate = () =>
  useGameAction(({ id, patch }: { id: number; patch: GameTeamUpdate }) => api.patch<GameAdminView>(`/api/admin/game/teams/${id}`, patch));
export const useGameProposal = () =>
  useGameAction(({ id, approve }: { id: number; approve: boolean }) => api.post<GameAdminView>(`/api/admin/game/teams/${id}/proposal`, { approve }));
export const useGameRandomCaptain = () => useGameAction((id: number) => api.post<GameAdminView>(`/api/admin/game/teams/${id}/random-captain`, {}));
export const useGameOrder = () =>
  useGameAction((body: { ids?: number[]; shuffle?: boolean }) => api.post<GameAdminView>('/api/admin/game/teams/order', body));
export const useGameMove = () =>
  useGameAction((body: { participantId: number; teamId: number | null }) => api.post<GameAdminView>('/api/admin/game/players/move', body));
export const useGameOpenRound = () =>
  useGameAction((body: { teamId: number | null; seconds?: number | null }) => api.post<GameAdminView>('/api/admin/game/rounds', body));
export const useGameCloseRound = () => useGameAction(() => api.post<GameAdminView>('/api/admin/game/rounds/close', {}));
export const useGameExtendRound = () => useGameAction((seconds: number) => api.post<GameAdminView>('/api/admin/game/rounds/extend', { seconds }));
export const useGameLaunch = () =>
  useGameAction((body: { mode: GameLaunch; wipe: boolean; invite: boolean }) => api.post<GameAdminView>('/api/admin/game/launch', body));
export const useGameAddTester = () => useGameAction((userId: number) => api.post<GameAdminView>('/api/admin/game/testers', { userId }));
export const useGameRemoveTester = () => useGameAction((userId: number) => api.delete<GameAdminView>(`/api/admin/game/testers/${userId}`));
/** Записать всех тестировщиков в игру: возвращает, сколько записали, и свежий пульт. */
export function useGameEnrollTesters() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ enrolled: number; view: GameAdminView }>('/api/admin/game/testers/enroll', {}),
    onSuccess: (r) => qc.setQueryData(qk.game, r.view),
  });
}
export const useGameStart = () => useGameAction((started: boolean) => api.post<GameAdminView>('/api/admin/game/start', { started }));
export const useGameReveal = () =>
  useGameAction((body: { revealed: boolean; notify: boolean }) => api.post<GameAdminView>('/api/admin/game/reveal', body));
export const useGameStage = () => useGameAction((teamId: number | null) => api.post<GameAdminView>('/api/admin/game/stage', { teamId }));
export const useGameAssignTasks = () =>
  useGameAction(async () => (await api.post<{ assigned: number; left: number; view: GameAdminView }>('/api/admin/game/teams/assign-tasks', {})).view);
export const useGameTaskSave = () =>
  useGameAction(({ id, body }: { id: number | null; body: GameTaskInput }) =>
    id ? api.patch<GameAdminView>(`/api/admin/game/tasks/${id}`, body) : api.post<GameAdminView>('/api/admin/game/tasks', body),
  );
export const useGameTaskDelete = () => useGameAction((id: number) => api.delete<GameAdminView>(`/api/admin/game/tasks/${id}`));
export const useGameReset = () => useGameAction((scope: 'teams' | 'all') => api.post<GameAdminView>('/api/admin/game/reset', { scope }));
export const useGameResetVotes = () => useGameAction(() => api.post<GameAdminView>('/api/admin/game/reset-votes', {}));

/** Большой экран - без входа, по секретной ссылке; опрос чаще раза в секунду: голоса сохраняются по ходу нажатий. */
export function useGameScreen(token: string) {
  return useQuery({
    queryKey: ['game-screen', token],
    queryFn: ({ signal }) => api.get<GameScreenView>(`/api/game/screen/${encodeURIComponent(token)}`, { signal, skipAuthRedirect: true }),
    refetchInterval: 800,
    retry: 2,
  });
}

/** Поиск участника по ФИО - капитан или игрок, который не ответил сам. */
export function useGameCandidates(q: string) {
  return useQuery({
    queryKey: ['game-candidates', q],
    queryFn: ({ signal }) => api.get<GameCandidate[]>(`/api/admin/game/candidates?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
}

/** Аккаунты бота по @нику или имени - для тест-листа. */
export function useGameBotUsers(q: string) {
  return useQuery({
    queryKey: ['game-bot-users', q],
    queryFn: ({ signal }) => api.get<GameBotUser[]>(`/api/admin/game/bot-users?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.replace(/^@/, '').length >= 2,
    staleTime: 10_000,
  });
}
