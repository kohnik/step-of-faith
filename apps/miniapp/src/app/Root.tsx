import { QueryClientProvider } from '@tanstack/react-query';
import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Route, Switch } from 'wouter';
import { IconMoodSad, IconWifiOff } from '@tabler/icons-react';
import { IconChip } from '../ui/icons.tsx';
import { queryClient } from '../api/queries.ts';
import { telegramReady } from '../telegram/sdk.ts';
import { Button, FullScreenLoader } from '../ui/kit.tsx';
import { OfflineBanner, Toaster } from '../ui/toast.tsx';
import { EnvContext, type AppEnv } from './env.ts';
import { NotInTelegram } from './NotInTelegram.tsx';

// Три независимые части приложения - отдельные чанки.
const ParticipantApp = lazy(() => import('../participant/ParticipantApp.tsx'));
const StaffApp = lazy(() => import('../staff/StaffApp.tsx'));
const PublicTicketPage = lazy(() => import('../browser/PublicTicketPage.tsx'));
const StaffLoginPage = lazy(() => import('../browser/StaffLoginPage.tsx'));

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const chunkFailed = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(
      this.state.error.message,
    );
    return (
      <div className="flex min-h-app flex-col items-center justify-center px-6 text-center">
        <IconChip icon={chunkFailed ? IconWifiOff : IconMoodSad} hue={chunkFailed ? 'gray' : 'orange'} size="xl" className="mb-4" />
        <p className="text-lg font-semibold">{chunkFailed ? 'Не удалось загрузить экран' : 'Что-то сломалось'}</p>
        <p className="mt-2 text-[15px] text-subtle">
          {chunkFailed ? 'Проверьте связь и попробуйте ещё раз.' : 'Попробуйте перезагрузить приложение.'}
        </p>
        <Button className="mt-5" onClick={() => window.location.reload()}>
          Перезагрузить
        </Button>
      </div>
    );
  }
}

export function Root({ env }: { env: AppEnv }) {
  // Первый кадр уже отрисован (наш индикатор загрузки) - убираем заставку Telegram.
  useEffect(() => {
    telegramReady();
  }, []);

  return (
    <EnvContext.Provider value={env}>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <OfflineBanner />
          <Toaster />
          <Suspense fallback={<FullScreenLoader />}>
            <Switch>
              <Route path="/t/:token">{(params) => <PublicTicketPage token={params.token} />}</Route>
              <Route path="/staff/login">
                <StaffLoginPage />
              </Route>
              <Route path="/staff" nest>
                <StaffApp />
              </Route>
              <Route>{env.mode === 'telegram' ? <ParticipantApp /> : <NotInTelegram />}</Route>
            </Switch>
          </Suspense>
        </ErrorBoundary>
      </QueryClientProvider>
    </EnvContext.Provider>
  );
}
