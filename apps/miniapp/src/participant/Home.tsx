import { CATEGORY_LABELS, formatRub, type MeResponse, type MerchOrderView, type MyParticipant, type TiersConfig } from '@sof/shared';
import {
  IconCalendarEvent,
  IconChevronRight,
  IconCreditCard,
  IconHeartHandshake,
  IconInfoCircle,
  IconMessageQuestion,
  IconSchool,
  IconShirt,
  IconWorld,
  IconQrcode,
  IconTools,
  IconUserPlus,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { errorMessage } from '../api/client.ts';
import { haptic } from '../lib/feedback.ts';
import { toast } from '../ui/toast.tsx';
import { Countdown, debtLeft, ORDERS_KEY, useOrders } from './merch/orders.tsx';
import { formatDateTime, formatEventRange, formatTime, formatWhen, isToday, plural } from '../lib/time.ts';
import type { TablerIcon } from '../ui/icons.tsx';
import { Button, Card, cx, Notice } from '../ui/kit.tsx';
import { ListGroup, ListRow } from '../ui/List.tsx';
import { Page } from '../ui/Page.tsx';
import { tierColor } from '../ui/TierBadge.tsx';
import {
  COUNSELING_KEY,
  PAY_TONE_CLASS,
  SEMINARS_KEY,
  UNREAD_KEY,
  counselingTitle,
  feedbackOf,
  freeSlots,
  hasSelf,
  leftToPay,
  participantApi,
  paymentState,
  paymentsOn,
  useMeData,
} from './api.ts';
import { useClaim } from './Claim.tsx';
import { FeedbackCard, FeedbackPrompt } from './feedback/Promo.tsx';
import { usePollInterval } from '../api/realtime.ts';

/**
 * «Точно заберёте?» по брони мерча - прямо на главной, с отсчётом. «Да, заберу» - и карточка уходит.
 */
function MerchAsk({ o, tz }: { o: MerchOrderView; tz: string }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      const updated = await participantApi.merchConfirm(o.id);
      qc.setQueryData<MerchOrderView[]>(ORDERS_KEY, (list) => list?.map((x) => (x.id === updated.id ? updated : x)));
      haptic('success');
      toast.success('Спасибо, ждём вас!');
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
      void qc.invalidateQueries({ queryKey: ORDERS_KEY });
    } finally {
      setBusy(false);
    }
  };
  const until = formatTime(o.confirmBy!, tz);
  return (
    <Card className="mb-6 bg-warn-soft">
      <p className="text-[12px] font-bold uppercase tracking-wider text-warn-fg">Бронь мерча · {o.code}</p>
      <p className="mt-1 text-[19px] font-semibold leading-snug">Точно заберёте?</p>
      <p className="mt-1 text-[14px] leading-snug text-subtle">{o.items.map((i) => `${i.title}${i.qty > 1 ? ` × ${i.qty}` : ''}`).join(', ')}</p>
      <p className="mt-2 text-[14px] leading-snug">
        {o.confirmDrops ? `Ответьте до ${until} - иначе бронь снимется и вещи вернутся в витрину.` : `Ответьте, пожалуйста, до ${until}.`}
      </p>
      <div className="mt-2">
        <Countdown until={o.confirmBy!} drops={o.confirmDrops} />
      </div>
      <div className="mt-3 flex gap-2">
        <Button className="flex-1" loading={busy} onClick={() => void confirm()}>
          Да, заберу
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => navigate('/merch/orders')}>
          Мои заказы
        </Button>
      </div>
    </Card>
  );
}

/** Строка о регистрации: до какого числа и сколько мест. null - сказать нечего. */
function registrationLine(me: MeResponse): { text: string; closed: boolean } | null {
  const r = me.registration;
  const tz = me.event.timezone;
  if (!r.open) {
    if (r.opensAt && new Date(r.opensAt).getTime() > Date.now()) {
      return { text: `Регистрация откроется ${formatDateTime(r.opensAt, tz)}`, closed: true };
    }
    return { text: 'Регистрация закрыта', closed: true };
  }
  if (r.capacityLeft === 0) return { text: 'Мест больше нет', closed: true };
  const parts: string[] = [];
  if (r.closesAt) parts.push(`до ${formatDateTime(r.closesAt, tz)}`);
  if (r.capacityLeft !== null) parts.push(`осталось ${r.capacityLeft} ${plural(r.capacityLeft, ['место', 'места', 'мест'])}`);
  return parts.length ? { text: `Регистрация открыта ${parts.join(', ')}`, closed: false } : null;
}

/** Человек: полоска цвета варианта, имя, вариант и статус взноса. Нажатие - его QR-код. */
function PersonRow({
  p,
  tz,
  payments,
  soft,
  tiers,
  onOpen,
}: {
  p: MyParticipant;
  tz: string;
  payments: boolean;
  /** Дни конференции: мягкие подписи оплаты. */
  soft: boolean;
  tiers: TiersConfig;
  onOpen: () => void;
}) {
  const color = tierColor(p.tier, tiers);
  // Название варианта без цены: сумма и так в статусе взноса («к оплате 35 руб.»).
  const cfg = p.tier ? tiers[p.tier] : undefined;
  const tier = cfg ? `${cfg.label}${p.breakfast ? ' + завтрак' : ''}` : p.category !== 'participant' ? CATEGORY_LABELS[p.category] : null;
  // «Без взноса» уже сказано вариантом - второй раз не пишем.
  const pay = payments && p.paymentStatus !== 'exempt' ? paymentState(p, soft) : null;
  // «На месте» - только про сегодня: на 2-й и 3-й день вчерашний приход не в счёт.
  const arrivedToday = p.lastArrivedAt && isToday(p.lastArrivedAt, tz) ? p.lastArrivedAt : null;
  const note = arrivedToday
    ? `на месте с ${formatTime(arrivedToday, tz)}`
    : p.transferredToMe && p.registeredBy
      ? `записал(а) ${p.registeredBy}`
      : null;
  return (
    <button type="button" onClick={onOpen} className="group flex w-full items-stretch gap-3 pl-4 text-left active:bg-fill">
      <span aria-hidden className="my-3 w-1 shrink-0 rounded-full" style={{ background: color ?? 'var(--color-line)' }} />
      <span className="flex min-w-0 flex-1 items-center gap-2 border-b border-line py-3 pr-3 group-last:border-b-0">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold leading-snug">{p.fullName}</span>
          {(tier || pay) && (
            <span className="mt-0.5 block text-[14px] leading-snug text-subtle">
              {tier}
              {tier && pay && ' · '}
              {pay && <span className={PAY_TONE_CLASS[pay.tone]}>{pay.text}</span>}
            </span>
          )}
          {note && <span className={cx('mt-0.5 block text-[13px] leading-snug', arrivedToday ? 'text-ok-fg' : 'text-hint')}>{note}</span>}
        </span>
        <IconChevronRight size={18} className="shrink-0 text-hint" aria-hidden />
      </span>
    </button>
  );
}

/** Открытая запись на семинары или душепопечение - заметной плиткой над меню (пока запись идёт). */
function SignupTile({ icon: Icon, title, status, done, onClick }: { icon: TablerIcon; title: string; status: string; done: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl bg-section p-3.5 text-left ring-1 ring-brand/35 transition active:scale-[0.99] active:opacity-80"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/12 text-brand" aria-hidden>
        <Icon size={22} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-semibold leading-snug">{title}</span>
        <span className={cx('mt-0.5 line-clamp-2 text-[14px] leading-snug', done ? 'text-ok-fg' : 'text-brand')}>{status}</span>
      </span>
      <IconChevronRight size={20} className="shrink-0 text-hint" aria-hidden />
    </button>
  );
}

export default function Home() {
  const me = useMeData();
  const [, navigate] = useLocation();
  const tz = me.event.timezone;
  const payments = paymentsOn(me);
  const tiers = me.registration.tiers;
  const dates = formatEventRange(me.event.startsAt, me.event.endsAt, tz);
  const active = me.participants.filter((p) => p.status === 'active');
  const codes = active.filter((p) => p.ticket).length;
  const open = active.filter((p) => p.paymentStatus === 'unpaid' || p.paymentStatus === 'partial');
  const left = open.reduce((sum, p) => sum + leftToPay(p), 0);
  // Строка «Оплата»: долг, чек на проверке, без взноса или «внесено».
  const checking = active.some((p) => p.paymentStatus === 'pending');
  const allExempt = active.every((p) => p.paymentStatus === 'exempt');
  const soft = me.features.softPaymentLabels;
  const [payValue, payClass] = open.length
    ? // В дни конференции - та же сумма, но не красным: без тревоги.
      [formatRub(left), soft ? 'text-warn-fg' : 'text-bad-fg']
    : checking
      ? soft
        ? ['чек получен ✓', 'text-ok-fg']
        : ['чек на проверке', 'text-warn-fg']
      : allExempt
        ? ['без взноса', 'text-subtle']
        : ['внесено', 'text-ok-fg'];
  const slots = freeSlots(me);
  const reg = registrationLine(me);
  const canRegister = me.registration.open && slots > 0 && me.registration.capacityLeft !== 0;
  // Записали с чужого аккаунта без ника - находим по номеру из Telegram.
  const claim = useClaim();
  // «Семинары» - когда открыт выбор тем, опубликовано распределение или кто-то из семьи уже выбирал.
  // Выбор открывают и закрывают во время конференции - пока главная открыта, сверяемся раз в 30 секунд
  // (в свёрнутом приложении опрос сам останавливается).
  const poll = usePollInterval(30_000);
  const seminars = useQuery({ queryKey: SEMINARS_KEY, queryFn: () => participantApi.seminars(), staleTime: 15_000, refetchInterval: poll });
  const sem = seminars.data;
  const showSeminars = !!sem && sem.topics.length > 0 && (sem.open || sem.published || sem.votes.some((v) => v.topicIds.length > 0));
  // Непрочитанные сообщения организаторов - счётчик у «Написать организаторам».
  const unread = useQuery({ queryKey: UNREAD_KEY, queryFn: () => participantApi.messagesUnread(), staleTime: 15_000, refetchInterval: poll });
  // «Душепопечение» - когда запись открыта или кто-то из семьи уже записан.
  const counseling = useQuery({ queryKey: COUNSELING_KEY, queryFn: () => participantApi.counseling(), staleTime: 15_000, refetchInterval: poll });
  const showCounseling =
    !!counseling.data && counseling.data.counselors.length > 0 && (counseling.data.open || counseling.data.my.length > 0);
  const myCounseling = counseling.data?.my[0];

  const counselingLive = active.length > 0 && !!counseling.data?.open && counseling.data.counselors.length > 0;
  // Мерч: вопрос «Точно заберёте?» - карточкой наверху, долг - в строке «Мерч».
  const merchOrders = useOrders(me.features.merch, poll);
  const merchAsks = (merchOrders.data ?? []).filter((o) => o.confirmBy);
  const merchDebt = (merchOrders.data ?? []).reduce((sum, o) => sum + debtLeft(o), 0);
  const feedback = feedbackOf(me);
  const bookedCounselor = myCounseling ? counseling.data?.counselors.find((c) => c.id === myCounseling.counselorId) : undefined;

  return (
    <Page>
      <header className="mb-6 px-1 pt-1">
        <h1 className="font-display text-[28px] font-semibold uppercase leading-[1.1] tracking-wide">{me.event.name}</h1>
        {/* Даты - красными капителями, как на постерах. */}
        {dates && (
          <p className="mt-2 font-display text-[13px] font-medium uppercase tracking-wider text-brand">
            {/* Год уже в названии - «6–8 ноября», без «2026 г.». */}
            {dates.replace(/\s*\d{4}\s*г\.?$/, '')}
          </p>
        )}
      </header>

      {feedback.visible && <FeedbackCard mine={feedback.mine} />}

      {merchAsks.map((o) => (
        <MerchAsk key={o.id} o={o} tz={tz} />
      ))}

      {active.length === 0 ? (
        <Card className="mb-6">
          <p className="text-[18px] font-semibold">Регистрация</p>
          <p className="mt-1 text-[15px] leading-snug text-subtle">
            Запишите себя и тех, кто придёт с вами. QR-код для входа придёт в чат с ботом.
          </p>
          {/* После сбоя хостинга: регистрации после 29 октября не сохранились. */}
          {me.registration.restored && (
            <div className="mt-3 rounded-xl bg-fill px-3 py-2.5 text-[14px] leading-snug">
              <p>
                🙏 <b>Регистрировались после 29 октября?</b> Просим прощения: из-за сбоя сервиса эти регистрации не сохранились.
                Пожалуйста, зарегистрируйтесь ещё раз - это займёт пару минут.
              </p>
              <p className="mt-1.5 text-subtle">Регистрировались раньше - нажмите «Меня уже зарегистрировали», и мы найдём вас по номеру телефона.</p>
            </div>
          )}
          {reg && <p className={cx('mt-3 text-[14px]', reg.closed ? 'text-warn-fg' : 'text-hint')}>{reg.text}</p>}
          {canRegister && (
            <Button size="lg" block className="mt-4" onClick={() => navigate('/register')}>
              Зарегистрироваться
            </Button>
          )}
          {claim.available && (
            <Button variant="secondary" block className={canRegister ? 'mt-2' : 'mt-4'} loading={claim.busy} onClick={() => void claim.start()}>
              Меня уже зарегистрировали
            </Button>
          )}
        </Card>
      ) : (
        <section className="mb-6">
          <ListGroup>
            {active.map((p) => (
              <PersonRow key={p.id} p={p} tz={tz} payments={payments} soft={soft} tiers={tiers} onOpen={() => navigate(`/tickets?p=${p.id}`)} />
            ))}
          </ListGroup>
          {codes > 0 && (
            <Button size="lg" block className="mt-3" onClick={() => navigate('/tickets')}>
              <IconQrcode size={22} />
              {codes > 1 ? 'Показать QR-коды' : 'Показать QR-код'}
            </Button>
          )}
        </section>
      )}

      {counselingLive && (
        <section className="mb-6 space-y-2">
          {counselingLive && (
            <SignupTile
              icon={IconHeartHandshake}
              title={counselingTitle(me)}
              done={!!myCounseling}
              status={
                myCounseling
                  ? `Записаны: ${formatWhen(myCounseling.slotStart, tz)}${bookedCounselor ? `, ${bookedCounselor.name}` : ''}`
                  : 'Идёт запись - выберите время'
              }
              onClick={() => navigate('/counseling')}
            />
          )}
        </section>
      )}

      <ListGroup className="mb-6">
        {/* Расписание скрыто в настройках - участникам пункта нет, команде остаётся. */}
        {(me.features.schedule || me.roles.length > 0) && (
          <ListRow icon={IconCalendarEvent} title="Расписание" onClick={() => navigate('/schedule')} />
        )}
        {payments && active.length > 0 && (
          <ListRow
            icon={IconCreditCard}
            title="Оплата"
            value={payValue}
            valueClassName={payClass}
            onClick={() => navigate('/payment')}
          />
        )}
        {showSeminars && <ListRow icon={IconSchool} title="Семинары" onClick={() => navigate('/seminars')} />}
        {showCounseling && !counselingLive && (
          <ListRow
            icon={IconHeartHandshake}
            title={counselingTitle(me)}
            value={myCounseling && counseling.data!.my.length === 1 ? formatWhen(myCounseling.slotStart, tz) : undefined}
            valueClassName="text-ok-fg"
            onClick={() => navigate('/counseling')}
          />
        )}
        {/* Витрина мерча включается в настройках (сначала можно показать только администраторам). */}
        {me.features.game && <ListRow icon={IconWorld} title="Игра «Церкви»" onClick={() => navigate('/game')} />}
        {me.features.merch && (
          <ListRow
            icon={IconShirt}
            title="Мерч"
            value={merchDebt > 0 ? `долг ${formatRub(merchDebt)}` : undefined}
            valueClassName="text-warn-fg"
            onClick={() => navigate(merchDebt > 0 ? '/merch/orders' : '/merch')}
          />
        )}
        <ListRow icon={IconInfoCircle} title="О конференции" onClick={() => navigate('/info')} />
        <ListRow
          icon={IconMessageQuestion}
          title="Написать организаторам"
          value={unread.data?.unread ? <span className="rounded-full bg-btn px-2 py-0.5 text-[13px] font-semibold text-btn-fg">{unread.data.unread}</span> : undefined}
          onClick={() => navigate('/questions')}
        />
        {active.length > 0 && canRegister && (
          <ListRow icon={IconUserPlus} title="Записать ещё человека" onClick={() => navigate('/register')} />
        )}
        {me.roles.length > 0 && <ListRow icon={IconTools} title="Команда" onClick={() => navigate('~/staff')} />}
      </ListGroup>

      {/* Записал других, а себя - нет: возможно, его самого записал кто-то другой. Уже есть «Я» - искать незачем. */}
      {active.length > 0 && !hasSelf(me) && claim.available && (
        <button
          type="button"
          disabled={claim.busy}
          onClick={() => void claim.start()}
          className="mb-4 block w-full py-2 text-center text-[14px] font-medium text-accent active:opacity-70 disabled:opacity-50"
        >
          Вас записал кто-то другой? Найти по номеру
        </button>
      )}

      {me.event.supportContact && (
        <Notice tone="gray" className="text-center">
          Вопросы: <span className="font-semibold">{me.event.supportContact}</span>
        </Notice>
      )}
      {claim.sheet}
      {feedback.visible && feedback.prompt && <FeedbackPrompt />}
    </Page>
  );
}
