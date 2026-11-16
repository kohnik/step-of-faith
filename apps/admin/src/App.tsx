import { Button, Card, Center, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { canUseAdminWeb, type Permission } from '@sof/shared';
import { useQueryClient } from '@tanstack/react-query';
import { IconBrandTelegram, IconCashOff, IconLogout, IconMoodSmile, IconScan } from '@tabler/icons-react';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { setUnauthorizedHandler } from './api/client.ts';
import { qk } from './api/keys.ts';
import { useSessionQuery } from './api/session.ts';
import { AppLayout } from './components/AppLayout.tsx';
import { AppLink } from './components/AppLink.tsx';
import { ConfirmProvider } from './components/ConfirmProvider.tsx';
import { EventProvider } from './components/EventProvider.tsx';
import { firstAllowedHref } from './components/nav.ts';
import { ParticipantDrawerProvider } from './components/ParticipantDrawerProvider.tsx';
import { SessionProvider, useCan, useSession } from './components/SessionProvider.tsx';
import { EmptyBlock, ErrorState, NoAccess, PageLoader } from './components/states.tsx';
import { ACTIVITIES_ANY, SETTINGS_READ } from './lib/permissions.ts';
import { rememberNextPath } from './lib/nextPath.ts';
import { LoginPage } from './pages/LoginPage.tsx';

const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage.tsx'));
const ParticipantsPage = lazy(() => import('./pages/participants/ParticipantsPage.tsx'));
const DuplicatesPage = lazy(() => import('./pages/participants/DuplicatesPage.tsx'));
const ConfirmedPage = lazy(() => import('./pages/participants/ConfirmedPage.tsx'));
const ListsPage = lazy(() => import('./pages/participants/ListsPage.tsx'));
const PaymentsPage = lazy(() => import('./pages/payments/PaymentsPage.tsx'));
const MoneyPage = lazy(() => import('./pages/money/MoneyPage.tsx'));
const CheckInPage = lazy(() => import('./pages/checkin/CheckInPage.tsx'));
const ActivitiesPage = lazy(() => import('./pages/activities/ActivitiesPage.tsx'));
const BroadcastsPage = lazy(() => import('./pages/broadcasts/BroadcastsPage.tsx'));
const BotLogPage = lazy(() => import('./pages/broadcasts/BotLogPage.tsx'));
const ContentPage = lazy(() => import('./pages/content/ContentPage.tsx'));
const MerchPage = lazy(() => import('./pages/merch/MerchPage.tsx'));
const GamePage = lazy(() => import('./pages/game/GamePage.tsx'));
const GameScreen = lazy(() => import('./pages/game/GameScreen.tsx'));
const MessagesPage = lazy(() => import('./pages/questions/MessagesPage.tsx'));
const FeedbackPage = lazy(() => import('./pages/feedback/FeedbackPage.tsx'));
const SeminarsPage = lazy(() => import('./pages/seminars/SeminarsPage.tsx'));
const RoomsPage = lazy(() => import('./pages/rooms/RoomsPage.tsx'));
const CounselingPage = lazy(() => import('./pages/counseling/CounselingPage.tsx'));
const StaffPage = lazy(() => import('./pages/staff/StaffPage.tsx'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage.tsx'));
const AuditPage = lazy(() => import('./pages/audit/AuditPage.tsx'));

export function App() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  // Любой 401 от API - сессия истекла: запоминаем, где были, и ведём на вход.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const path = window.location.pathname + window.location.search;
      if (window.location.pathname.startsWith('/login')) return;
      rememberNextPath(path);
      qc.setQueryData(qk.session, null);
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [qc, navigate]);

  return (
    <Switch>
      <Route path="/login">
        <LoginPage />
      </Route>
      {/* Большой экран игры - для проектора, без входа (секретная ссылка). */}
      <Route path="/screen/:token">
        {(p) => (
          <Suspense fallback={<PageLoader />}>
            <GameScreen token={p.token} />
          </Suspense>
        )}
      </Route>
      <Route>
        <AuthenticatedApp />
      </Route>
    </Switch>
  );
}

function AuthenticatedApp() {
  const session = useSessionQuery();
  const [location] = useLocation();

  if (session.isPending) return <PageLoader label="Проверяем вход…" />;
  if (session.isError && !session.data) {
    return (
      <Center mih="100dvh" p="md">
        <Stack maw={480} w="100%">
          <ErrorState error={session.error} title="Сервер недоступен" onRetry={() => void session.refetch()} />
        </Stack>
      </Center>
    );
  }
  if (!session.data) {
    rememberNextPath(location);
    return <Redirect to="/login" replace />;
  }
  if (!canUseAdminWeb(session.data.roles)) {
    return (
      <SessionProvider session={session.data}>
        <ScannerOnly />
      </SessionProvider>
    );
  }
  return (
    <SessionProvider session={session.data}>
      <EventProvider>
        <ConfirmProvider>
          <ParticipantDrawerProvider>
            <AppLayout>
              <Suspense fallback={<PageLoader />}>
                <AppRoutes />
              </Suspense>
            </AppLayout>
          </ParticipantDrawerProvider>
        </ConfirmProvider>
      </EventProvider>
    </SessionProvider>
  );
}

function Guard({ anyOf, children }: { anyOf: readonly Permission[]; children: ReactNode }) {
  const can = useCan();
  return can(...anyOf) ? <>{children}</> : <NoAccess />;
}

function HomeRedirect() {
  const { can, paymentsEnabled } = useSession();
  const href = firstAllowedHref({ can, paymentsEnabled });
  if (href && href !== '/') return <Redirect to={href} replace />;
  return (
    <EmptyBlock
      icon={<IconMoodSmile size={28} />}
      title="Здесь для вас пока ничего нет"
      description="Для вашей роли в админке сейчас нет разделов. Отмечать гостей на входе можно в мини-приложении бота («Сканер»). Если нужен доступ к чему-то ещё - напишите организаторам."
    />
  );
}

/** Раздел «Оплаты», пока приём оплаты выключен в настройках. */
function PaymentsGuard({ children }: { children: ReactNode }) {
  const { can, paymentsEnabled } = useSession();
  if (!can('payments:write')) return <NoAccess />;
  if (!paymentsEnabled) {
    return (
      <EmptyBlock
        icon={<IconCashOff size={28} />}
        title="Приём оплаты сейчас выключен"
        description={
          can('settings:write')
            ? 'Чтобы работать с чеками и статусами оплаты, включите «Приём оплаты» в настройках.'
            : 'Когда организаторы включат приём оплаты, здесь появятся чеки от участников.'
        }
        action={
          can('settings:write') ? (
            <AppLink href="/settings" fw={600}>
              Открыть настройки →
            </AppLink>
          ) : undefined
        }
      />
    );
  }
  return <>{children}</>;
}

function AppRoutes() {
  const can = useCan();
  return (
    <Switch>
      <Route path="/">{can('dashboard:read') ? <DashboardPage /> : <HomeRedirect />}</Route>
      <Route path="/participants">
        <Guard anyOf={['participants:read']}>
          <ParticipantsPage />
        </Guard>
      </Route>
      <Route path="/participants/confirmed">
        <Guard anyOf={['participants:read']}>
          <ConfirmedPage />
        </Guard>
      </Route>
      <Route path="/participants/lists">
        <Guard anyOf={['participants:read']}>
          <ListsPage />
        </Guard>
      </Route>
      <Route path="/participants/duplicates">
        <Guard anyOf={['participants:read']}>
          <DuplicatesPage />
        </Guard>
      </Route>
      <Route path="/payments">
        <PaymentsGuard>
          <PaymentsPage />
        </PaymentsGuard>
      </Route>
      <Route path="/money">
        <Guard anyOf={['money:manage']}>
          <MoneyPage />
        </Guard>
      </Route>
      <Route path="/checkin">
        <Guard anyOf={['participants:read']}>
          <CheckInPage />
        </Guard>
      </Route>
      <Route path="/activities">
        <Guard anyOf={ACTIVITIES_ANY}>
          <ActivitiesPage />
        </Guard>
      </Route>
      <Route path="/broadcasts">
        <Guard anyOf={['broadcasts:send']}>
          <BroadcastsPage />
        </Guard>
      </Route>
      <Route path="/bot-log">
        <Guard anyOf={['broadcasts:send']}>
          <BotLogPage />
        </Guard>
      </Route>
      <Route path="/content">
        <Guard anyOf={['content:write']}>
          <ContentPage />
        </Guard>
      </Route>
      <Route path="/merch">
        <Guard anyOf={['merch:stock', 'merch:sell', 'merch:stats']}>
          <MerchPage />
        </Guard>
      </Route>
      <Route path="/game">
        <Guard anyOf={['game:manage']}>
          <GamePage />
        </Guard>
      </Route>
      <Route path="/seminars">
        <Guard anyOf={['activities:all']}>
          <SeminarsPage />
        </Guard>
      </Route>
      <Route path="/counseling">
        <Guard anyOf={['activities:all']}>
          <CounselingPage />
        </Guard>
      </Route>
      <Route path="/rooms">
        <Guard anyOf={['activities:own', 'activities:all']}>
          <RoomsPage />
        </Guard>
      </Route>
      <Route path="/messages/:id?">
        <Guard anyOf={['content:write', 'merch:sell']}>
          <MessagesPage />
        </Guard>
      </Route>
      <Route path="/feedback">
        <Guard anyOf={['feedback:read']}>
          <FeedbackPage />
        </Guard>
      </Route>
      {/* Старый адрес раздела «Вопросы». */}
      <Route path="/questions">
        <Redirect to="/messages" replace />
      </Route>
      <Route path="/staff">
        <Guard anyOf={['staff:manage', 'staff:invite_cashier']}>
          <StaffPage />
        </Guard>
      </Route>
      <Route path="/settings">
        <Guard anyOf={SETTINGS_READ}>
          <SettingsPage />
        </Guard>
      </Route>
      <Route path="/audit">
        <Guard anyOf={['audit:read']}>
          <AuditPage />
        </Guard>
      </Route>
      <Route>
        <EmptyBlock title="Такой страницы нет" description="Возможно, ссылка устарела. Выберите нужный раздел в меню слева." />
      </Route>
    </Switch>
  );
}

/** Роль «Сканер»: админка не нужна, работа - в мини-приложении бота. */
function ScannerOnly() {
  const { session, logout, loggingOut } = useSession();
  return (
    <Center mih="100dvh" p="md">
      <Card maw={520} w="100%" padding="xl" shadow="md">
        <Stack gap="md" align="center" ta="center">
          <ThemeIcon size={64} radius="xl" variant="light" color="cyan">
            <IconScan size={34} />
          </ThemeIcon>
          <Title order={3}>Сканер - в Telegram</Title>
          <Text c="dimmed">
            {session.user.name}, вы в команде как «Сканер». Отмечать гостей на входе удобнее всего в мини-приложении бота:
            откройте бота конференции и нажмите «Сканер». Админка для этого не нужна.
          </Text>
          <Group gap="xs" c="dimmed" wrap="nowrap">
            <IconBrandTelegram size={18} style={{ flexShrink: 0 }} />
            <Text size="sm">Есть карточка волонтёра? Откройте ссылку с неё на телефоне - сканер запустится в браузере.</Text>
          </Group>
          <Button variant="default" leftSection={<IconLogout size={16} />} onClick={() => void logout()} loading={loggingOut}>
            Выйти
          </Button>
        </Stack>
      </Card>
    </Center>
  );
}
