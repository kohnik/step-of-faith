import { canUseAdminWeb } from '@sof/shared';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Redirect, Route, Switch } from 'wouter';
import { ApiError } from '../api/client.ts';
import { useEnv } from '../app/env.ts';
import { DEFAULT_EVENT_NAME } from '../app/brand.ts';
import { injectStaffManifest, registerServiceWorker } from '../browser/sw.ts';
import { ErrorState, FullScreenLoader, Notice } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { startManifestLoop } from './manifest.ts';
import { startOutboxLoop } from './outbox.ts';
import Scanner from './Scanner.tsx';
import { can, StaffContext, startStaffSession, useStaffSessionState } from './session.ts';
import StaffHome from './StaffHome.tsx';

const Activities = lazy(() => import('./Activities.tsx'));
const ActivityForm = lazy(() => import('./ActivityForm.tsx'));
const Registrations = lazy(() => import('./Registrations.tsx'));
const Cash = lazy(() => import('./Cash.tsx'));
const Stats = lazy(() => import('./Stats.tsx'));
const Bank = lazy(() => import('./Bank.tsx'));
const MerchDesk = lazy(() => import('./MerchDesk.tsx'));
const GameDesk = lazy(() => import('./GameDesk.tsx'));

function LoginNeeded({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError && error.code !== 'no_session'
      ? error.message
      : 'Чтобы работать сканером в браузере, нужен вход по карточке.';
  return (
    <Page title="Вход для команды">
      <Notice tone="yellow" className="mb-4">
        {message}
      </Notice>
      <p className="text-[15px] leading-relaxed text-subtle">
        Отсканируйте камерой телефона QR-код на своей карточке сканера (или откройте ссылку входа, которую прислали
        организаторы). Сканер откроется сам. Участники и организаторы с Telegram могут открыть сканер из бота: кнопка «Команда».
      </p>
    </Page>
  );
}

export default function StaffApp() {
  const env = useEnv();
  const session = useQuery({
    queryKey: ['staff-session', env.mode],
    queryFn: () => startStaffSession(env.mode),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const live = useStaffSessionState();
  // В Telegram сессия пересоздаётся сама; в браузере потеря сессии = нужен новый вход.
  const staff = env.mode === 'telegram' ? (live ?? session.data ?? null) : session.isSuccess ? live : null;

  useEffect(() => {
    if (!staff) return;
    startOutboxLoop();
    if (can(staff, 'checkin:write')) startManifestLoop();
  }, [staff]);

  const eventName = staff?.event?.name ?? DEFAULT_EVENT_NAME;
  useEffect(() => {
    if (env.mode !== 'browser') return;
    document.title = `${eventName} - сканер`;
    injectStaffManifest();
    registerServiceWorker('/staff');
  }, [env.mode, eventName]);

  if (session.isPending) return <FullScreenLoader label="Входим в команду…" />;

  if (!staff) {
    if (env.mode === 'browser') return <LoginNeeded error={session.error} />;
    const forbidden = session.error instanceof ApiError && session.error.status === 403;
    return (
      <Page title="Команда" back="~/">
        <ErrorState
          error={session.error}
          title={forbidden ? 'Вы не в команде' : 'Не удалось войти'}
          onRetry={forbidden ? undefined : () => void session.refetch()}
        />
      </Page>
    );
  }

  const canScan = can(staff, 'checkin:write');
  const canActs = can(staff, 'activities:own') || can(staff, 'activities:all');
  const canCash = can(staff, 'payments:write') && staff.features?.payments !== false;
  const canStats = can(staff, 'dashboard:read');
  const canBank = can(staff, 'money:manage');
  const canMerch = can(staff, 'merch:sell');
  const canGame = can(staff, 'game:manage');
  // Только сканер и ничего больше - домашний экран не нужен.
  const onlyScanner = canScan && !canActs && !canCash && !canUseAdminWeb(staff.roles);

  return (
    <StaffContext.Provider value={staff}>
      <Suspense fallback={<FullScreenLoader />}>
        <Switch>
          <Route path="/">{onlyScanner ? <Redirect to="/scan" replace /> : <StaffHome />}</Route>
          <Route path="/scan">{canScan ? <Scanner /> : <Redirect to="/" replace />}</Route>
          <Route path="/cash">{canCash ? <Cash /> : <Redirect to="/" replace />}</Route>
          <Route path="/stats">{canStats ? <Stats /> : <Redirect to="/" replace />}</Route>
          <Route path="/bank">{canBank ? <Bank /> : <Redirect to="/" replace />}</Route>
          <Route path="/merch">{canMerch ? <MerchDesk /> : <Redirect to="/" replace />}</Route>
          <Route path="/game">{canGame ? <GameDesk /> : <Redirect to="/" replace />}</Route>
          <Route path="/activities">{canActs ? <Activities /> : <Redirect to="/" replace />}</Route>
          <Route path="/activities/new">{canActs ? <ActivityForm /> : <Redirect to="/" replace />}</Route>
          <Route path="/activities/:id/edit">{(p) => (canActs ? <ActivityForm id={Number(p.id)} /> : <Redirect to="/" replace />)}</Route>
          <Route path="/activities/:id/registrations">
            {(p) => (canActs ? <Registrations id={Number(p.id)} /> : <Redirect to="/" replace />)}
          </Route>
          <Route>
            <Redirect to="/" replace />
          </Route>
        </Switch>
      </Suspense>
    </StaffContext.Provider>
  );
}
