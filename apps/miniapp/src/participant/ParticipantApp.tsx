import { lazy, Suspense, useEffect } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { meQuery, useMe } from '../api/queries.ts';
import { usePollInterval, useRealtime } from '../api/realtime.ts';
import { useQuery } from '@tanstack/react-query';
import { startParam } from '../telegram/sdk.ts';
import { ErrorState, FullScreenLoader } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { MeContext, paymentsOn } from './api.ts';
import Home from './Home.tsx';
import EndScreen from './feedback/EndScreen.tsx';
import { prefetchMerch } from './merch/prefetch.ts';

const loadRegister = () => import('./Register.tsx');
const loadTickets = () => import('./Tickets.tsx');
const loadEdit = () => import('./EditParticipant.tsx');
const loadPayment = () => import('./Payment.tsx');
const loadSchedule = () => import('./Schedule.tsx');
const loadInfo = () => import('./Info.tsx');
const loadMessages = () => import('./Messages.tsx');
const loadSeminars = () => import('./Seminars.tsx');
const loadCounseling = () => import('./Counseling.tsx');
const loadMerch = () => import('./merch/Merch.tsx');
const loadGame = () => import('./game/Game.tsx');
const loadFeedback = () => import('./feedback/Feedback.tsx');

const Register = lazy(loadRegister);
const Tickets = lazy(loadTickets);
const EditParticipant = lazy(loadEdit);
const Payment = lazy(loadPayment);
const Schedule = lazy(loadSchedule);
const Info = lazy(loadInfo);
const Messages = lazy(loadMessages);
const SeminarsScreen = lazy(() => loadSeminars().then((m) => ({ default: m.SeminarsScreen })));
const Counseling = lazy(loadCounseling);
const InfoPage = lazy(() => import('./Info.tsx').then((m) => ({ default: m.InfoPageScreen })));
const MerchCatalog = lazy(() => loadMerch().then((m) => ({ default: m.MerchCatalog })));
const MerchProductScreen = lazy(() => loadMerch().then((m) => ({ default: m.MerchProductScreen })));
const MerchOrders = lazy(() => loadMerch().then((m) => ({ default: m.MerchOrders })));
const Game = lazy(loadGame);
const Feedback = lazy(loadFeedback);

/** Прямые ссылки вида t.me/<bot>/<app>?startapp=tickets */
const START_ROUTES: Record<string, string> = {
  tickets: '/tickets',
  ticket: '/tickets',
  schedule: '/schedule',
  info: '/info',
  ask: '/questions',
  seminars: '/seminars',
  counseling: '/counseling',
  questions: '/questions',
  pay: '/payment',
  merch: '/merch',
  game: '/game',
  shop: '/merch',
  payment: '/payment',
  register: '/register',
  staff: '~/staff',
  scanner: '~/staff/scan',
  feedback: '/feedback',
  otzyv: '/feedback',
  end: '/end',
};

/** «Конец «Шага веры»»: участникам остаются только экран благодарности, отзыв и переписка. */
const ENDED_ROUTES = ['/', '/feedback', '/questions', '/end'];

let startParamHandled = false;
let merchPrefetched = false;

export default function ParticipantApp() {
  const me = useMe();
  // Живые обновления: оплата, записи, выключатели - без перезагрузки. Без потока «me» сверяем раз в минуту.
  useRealtime();
  useQuery({ ...meQuery, refetchInterval: usePollInterval(60_000) });
  const [location, navigate] = useLocation();

  const payments = me.data ? paymentsOn(me.data) : false;

  useEffect(() => {
    if (startParamHandled || !me.data) return;
    startParamHandled = true;
    const target = START_ROUTES[startParam() ?? ''];
    if (target === '/payment' && !payments) return;
    if (target && location === '/') navigate(target, { replace: true });
  }, [location, navigate, me.data, payments]);

  // Остальные экраны подгружаем в фоне, чтобы переходы были мгновенными. Форму регистрации (с zod) -
  // только тем, кто ещё не зарегистрирован: остальным она почти не нужна.
  const needsRegistration = me.data ? !me.data.participants.some((p) => p.status === 'active') : false;
  const merch = me.data?.features.merch ?? false;
  useEffect(() => {
    const t = window.setTimeout(() => {
      const loaders: (() => Promise<unknown>)[] = [loadTickets, loadSchedule, loadInfo];
      if (payments) loaders.push(loadPayment);
      if (needsRegistration) loaders.push(loadRegister);
      if (merch) loaders.push(loadMerch);
      if (me.data?.features.game) loaders.push(loadGame);
      if (me.data?.feedback?.visible) loaders.push(loadFeedback);
      for (const load of loaders) load().catch(() => undefined);
      // Мерч - целиком (каталог, фото, 3D), чтобы витрина открывалась мгновенно.
      if (merch && !merchPrefetched) {
        merchPrefetched = true;
        void prefetchMerch();
      }
    }, 1200);
    return () => window.clearTimeout(t);
  }, [needsRegistration, payments, merch]);

  if (!me.data) {
    if (me.isPending) return <FullScreenLoader />;
    return (
      <Page>
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </Page>
    );
  }

  const ended = me.data.event.ended === true;
  // Конец конференции: всё остальное участникам скрыто (команде - доступно, ей ещё работать).
  if (ended && me.data.roles.length === 0 && !ENDED_ROUTES.includes(location)) return <Redirect to="/" replace />;

  return (
    <MeContext.Provider value={me.data}>
      <Suspense fallback={<FullScreenLoader />}>
        <Switch>
          <Route path="/">{ended ? <EndScreen /> : <Home />}</Route>
          {/* Обычная главная - команде, когда включён «Конец». */}
          <Route path="/home">
            <Home />
          </Route>
          <Route path="/end">
            <EndScreen preview={!ended} />
          </Route>
          <Route path="/feedback">
            <Feedback />
          </Route>
          <Route path="/register">
            <Register />
          </Route>
          <Route path="/tickets">
            <Tickets />
          </Route>
          <Route path="/participants/:id/edit">{(p) => <EditParticipant id={Number(p.id)} />}</Route>
          <Route path="/payment">{payments ? <Payment /> : <Redirect to="/" replace />}</Route>
          <Route path="/schedule">
            <Schedule />
          </Route>
          <Route path="/info">
            <Info />
          </Route>
          <Route path="/info/:slug">{(p) => <InfoPage slug={p.slug} />}</Route>
          {/* Старые ссылки на поток (/seminars/6) ведут туда же. */}
          <Route path="/seminars/:id?">
            <SeminarsScreen />
          </Route>
          <Route path="/counseling">
            <Counseling />
          </Route>
          <Route path="/game">
            <Game />
          </Route>
          <Route path="/merch">
            <MerchCatalog />
          </Route>
          <Route path="/merch/orders">
            <MerchOrders />
          </Route>
          <Route path="/merch/:id">{(p) => <MerchProductScreen id={Number(p.id)} />}</Route>
          <Route path="/questions">
            <Messages />
          </Route>
          <Route>
            <Page title="Раздел не найден" back="/">
              <p className="text-subtle">Вернитесь на главную.</p>
            </Page>
          </Route>
        </Switch>
      </Suspense>
    </MeContext.Provider>
  );
}
