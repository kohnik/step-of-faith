import { CATEGORY_LABELS, braceletOf, formatRub, textOn, tierShort, type MyParticipant } from '@sof/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import { IconBrandTelegram, IconChevronRight, IconCircleCheck, IconCopy, IconDots, IconDownload, IconLink, IconPencil, IconQrcode, IconSend, IconShare3, IconUserX, IconWorld } from '@tabler/icons-react';
import { errorMessage } from '../api/client.ts';
import { setMe } from '../api/queries.ts';
import { haptic } from '../lib/feedback.ts';
import { formatDateTime, formatTime } from '../lib/time.ts';
import { confirmAction, copyText, openExternal, saveFile, shareLink } from '../telegram/actions.ts';
import { isTelegram } from '../telegram/sdk.ts';
import { Button, cx, EmptyState, Notice, Spinner } from '../ui/kit.tsx';
import type { TablerIcon } from '../ui/icons.tsx';
import { Page } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { TicketQr } from '../ui/TicketQr.tsx';
import { toast } from '../ui/toast.tsx';
import { canAddBreakfast, canChangeTier, canRemoveBreakfast, leftToPay, participantApi, paymentState, paymentsOn, useMeData } from './api.ts';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
import { canChangeMethod, PaymentMethodSwitch } from './PaymentMethodSwitch.tsx';

function ActionRow({ icon: Icon, children, onClick, danger, busy }: { icon: TablerIcon; children: ReactNode; onClick: () => void; danger?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cx(
        'flex min-h-12 w-full items-center gap-3 border-b border-line px-1 text-left text-[16px] last:border-b-0 active:opacity-70 disabled:opacity-50',
        danger ? 'text-danger' : 'text-accent',
      )}
    >
      <Icon size={21} aria-hidden />
      <span className="flex-1">{children}</span>
      {busy && <Spinner className="size-5" />}
    </button>
  );
}

function TransferSheet({
  participant,
  eventName,
  tz,
  onClose,
}: {
  participant: MyParticipant | null;
  eventName: string;
  tz: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; link: string; expiresAt: string } | { status: 'error'; message: string }
  >({ status: 'loading' });
  const pid = participant?.id;

  useEffect(() => {
    if (!pid) return;
    let cancelled = false;
    setState({ status: 'loading' });
    participantApi
      .transferLink(pid)
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', link: res.link, expiresAt: res.expiresAt });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [pid]);

  return (
    <Sheet open={Boolean(participant)} onClose={onClose} title="Передать QR-код">
      {participant && (
        <>
          <p className="mb-3 text-[15px] leading-snug text-subtle">
            Отправьте ссылку человеку, который пойдёт по QR-коду <b className="text-fg">{participant.fullName}</b>. Когда он откроет
            её в Telegram, QR-код появится и у него. У вас он тоже останется.
          </p>
          {state.status === 'loading' && (
            <div className="flex justify-center py-6">
              <Spinner className="size-8 text-btn" />
            </div>
          )}
          {state.status === 'error' && <Notice tone="red">{state.message}</Notice>}
          {state.status === 'ready' && (
            <>
              <div className="mb-2 select-all break-all rounded-xl bg-fill p-3 font-mono text-sm">{state.link}</div>
              <p className="mb-4 px-1 text-[13px] text-hint">
                Ссылка сработает один раз, до {formatDateTime(state.expiresAt, tz)}.
              </p>
              <div className="grid gap-2">
                <Button
                  block
                  onClick={() => shareLink(state.link, `QR-код для входа на «${eventName}» - ${participant.fullName}`)}
                >
                  <IconBrandTelegram size={20} />
                  Отправить в Telegram
                </Button>
                <Button
                  variant="secondary"
                  block
                  onClick={async () => {
                    if (await copyText(state.link)) toast.success('Ссылка скопирована');
                    else toast.error('Не получилось скопировать');
                  }}
                >
                  <IconCopy size={20} />
                  Скопировать ссылку
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

function TicketCard({
  p,
  tz,
  editable,
  payments,
  onTransfer,
}: {
  p: MyParticipant;
  tz: string;
  editable: boolean;
  payments: boolean;
  onTransfer: () => void;
}) {
  const me = useMeData();
  const [, navigate] = useLocation();
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const t = p.ticket;
  const owned = !p.transferredToMe;

  const save = async () => {
    if (!t) return;
    setSaving(true);
    const res = await saveFile(t.imageUrl, `qr-${t.code}.png`);
    setSaving(false);
    if (res === 'downloading') toast.success('Сохраняем QR-код');
    else if (res === 'denied') return;
    else if (!isTelegram()) toast.info('Если картинка открылась, нажмите на неё и выберите «Сохранить»');
  };

  const cancel = async () => {
    const ok = await confirmAction({
      title: 'Отменить регистрацию?',
      message:
        `${p.fullName}: QR-код перестанет работать, записи на семинары отменятся. Вернуть можно только новой регистрацией.` +
        // Деньги сами не вернутся и к новой регистрации не перейдут - пусть человек знает это заранее.
        (Number(p.amountPaid) > 0 || p.paymentStatus === 'pending'
          ? p.paymentMethod === 'transfer'
            ? ' Взнос, оплаченный переводом, не возвращается.'
            : ' Внесённый взнос автоматически не возвращается - напишите организаторам через «Задать вопрос».'
          : ''),
      ok: 'Да, отменить',
      destructive: true,
    });
    if (!ok) return;
    setCancelling(true);
    try {
      const updated = await participantApi.cancelParticipant(p.id);
      setMe(updated);
      haptic('success');
      toast.success(`Регистрация ${p.fullName} отменена`);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  // Вариант, которого уже нет в настройках (данные с телефона до обновления), - как без варианта.
  const tier = (p.tier && me.registration.tiers[p.tier]) || null;
  const headBg = tier?.color ?? null;
  const headFg = headBg ? textOn(headBg) : undefined;
  // Браслет на входе (по нему кормят) - чтобы человек мог показать волонтёру, какой ему положен.
  const bracelet = p.status === 'active' ? braceletOf(me.registration.tiers, p.tier) : null;
  const showPay = payments && p.paymentStatus !== 'exempt';
  // Блок оплаты - пока взнос не внесён: сумма, «Как оплатить» и (если принимаем переводы) выбор способа.
  const payOpen = payments && tier !== null && canChangeMethod(p, tier.amount);
  const canSwitch = payOpen && me.payment.transfers;
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  // Плашки на шапке: тёмная подложка под белый текст, светлая - под тёмный; без варианта - как карточка.
  const pill = cx(
    'rounded-full px-2.5 py-0.5 text-[13px] font-semibold',
    !headBg ? 'bg-section text-fg' : headFg === '#ffffff' ? 'bg-black/20 text-white' : 'bg-white/45',
  );

  return (
    <div id={`ticket-${p.id}`} className="mb-5 scroll-mt-4">
      <div className="overflow-hidden rounded-3xl bg-section">
        {/* Шапка в цвет варианта участия - тот же цвет, что на картинке QR и у сканера */}
        <div
          className={cx('flex items-start gap-3 px-5 pb-4 pt-4', !headBg && 'bg-fill')}
          style={headBg ? { background: headBg, color: headFg } : undefined}
        >
          <div className="min-w-0 flex-1">
            <p className="font-display text-[19px] font-semibold leading-tight">{p.fullName}</p>
            {tier && (
              <p className="mt-0.5 flex items-center gap-1 text-[15px] font-semibold opacity-90">
                {tierShort(tier, p.breakfast)}
                {canChangeTier(me, p) && (
                  <button
                    type="button"
                    aria-label="Сменить вариант"
                    onClick={() => navigate(`/participants/${p.id}/edit?focus=tier`)}
                    className="-my-1.5 flex size-8 items-center justify-center rounded-full active:bg-black/15"
                  >
                    <IconPencil size={16} />
                  </button>
                )}
                {canAddBreakfast(me, p) && (
                  <button
                    type="button"
                    onClick={() => navigate(`/participants/${p.id}/edit?focus=breakfast`)}
                    className="-my-1 ml-1 rounded-full bg-black/15 px-2.5 py-1 text-[13px] font-bold active:bg-black/25"
                  >
                    Докупить завтрак
                  </button>
                )}
                {canRemoveBreakfast(me, p) && (
                  <button
                    type="button"
                    onClick={() => navigate(`/participants/${p.id}/edit?focus=breakfast`)}
                    className="-my-1 ml-1 rounded-full bg-black/15 px-2.5 py-1 text-[13px] font-bold active:bg-black/25"
                  >
                    Убрать завтрак
                  </button>
                )}
              </p>
            )}
            {(showPay || p.arrivedAt || p.category !== 'participant' || bracelet) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {bracelet && (
                  <span className={cx('rounded-full border px-2.5 py-0.5 text-[13px] font-semibold', bracelet === 'black' ? 'border-black bg-black text-white' : 'border-black/30 bg-white text-black')}>
                    {bracelet === 'black' ? 'Чёрный браслет' : 'Белый браслет'}
                  </span>
                )}
                {p.arrivedAt && (
                  <span className={cx('inline-flex items-center gap-1', pill)}>
                    <IconCircleCheck size={15} />
                    На месте с {formatTime(p.arrivedAt, tz)}
                  </span>
                )}
                {showPay && (
                  <span className={pill}>{capitalize(paymentState(p, me.features.softPaymentLabels).text)}</span>
                )}
                {p.category !== 'participant' && (
                  <span className={pill}>{CATEGORY_LABELS[p.category]}</span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Ещё действия"
            onClick={() => setMenuOpen(true)}
            className="-mr-2 -mt-1 flex size-10 shrink-0 items-center justify-center rounded-full active:bg-black/15"
          >
            <IconDots size={24} />
          </button>
        </div>

        <div className="px-5 pb-5 pt-5 text-center">
          {t ? (
            <>
              <TicketQr code={t.code} />
              <p className="mt-3 select-all font-mono text-[24px] font-bold tracking-wider">{t.displayCode}</p>
              <p className="mx-auto mt-1 max-w-xs text-[13px] leading-snug text-hint">
                Покажите на входе. Работает и без интернета.
              </p>
            </>
          ) : (
            <p className="py-8 text-subtle">QR-код ещё готовится. Загляните через минуту.</p>
          )}

          {payOpen && (
            <div className="mt-4 rounded-2xl bg-fill/60 p-3 text-left">
              <div className="flex items-center justify-between gap-3 px-1">
                <p className="text-[15px] font-medium">
                  Взнос {formatRub(leftToPay(p))}
                  {!me.payment.transfers && <span className="font-normal text-subtle">, наличными</span>}
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/payment')}
                  className="flex shrink-0 items-center gap-0.5 py-1 text-[15px] font-medium text-accent active:opacity-70"
                >
                  Как оплатить
                  <IconChevronRight size={17} />
                </button>
              </div>
              {canSwitch && <PaymentMethodSwitch participant={p} className="mt-2" />}
            </div>
          )}

          {t && (
            <Button block loading={saving} onClick={save} className="mt-4">
              {!saving && <IconDownload size={20} />}
              Сохранить в галерею
            </Button>
          )}
          {p.transferredToMe && (
            <p className="mt-3 text-[13px] text-hint">
              {p.registeredBy ? `Вас зарегистрировал(а) ${p.registeredBy}.` : 'Этот QR-код вам передали из другого Telegram.'}
            </p>
          )}
          {owned && !p.transferredAway && p.relation !== 'self' && p.relation !== 'child' && (
            <p className="mx-auto mt-3 max-w-xs text-[13px] leading-snug text-hint">
              {`Чтобы ${p.firstName} ${p.gender === 'f' ? 'сама записывалась' : 'сам записывался'} на семинары, `}
              {p.phone
                ? 'пусть откроет бота и нажмёт «Меня уже зарегистрировали». Или передайте QR-код через «⋯».'
                : `передайте ${p.gender === 'f' ? 'ей' : 'ему'} QR-код через «⋯».`}
            </p>
          )}
        </div>
      </div>

      <Sheet open={menuOpen} onClose={close} title={p.fullName}>
        <div className="overflow-hidden rounded-2xl bg-fill px-3">
          {t && (
            <ActionRow
              icon={IconWorld}
              onClick={() => {
                close();
                openExternal(t.webUrl);
              }}
            >
              Открыть в браузере
            </ActionRow>
          )}
          {t && (
            <ActionRow
              icon={IconLink}
              onClick={async () => {
                close();
                if (await copyText(t.webUrl)) toast.success('Ссылка скопирована. Она открывается и без Telegram');
              }}
            >
              Скопировать ссылку на QR-код
            </ActionRow>
          )}
          {owned && t && (
            <ActionRow
              icon={IconShare3}
              onClick={() => {
                close();
                onTransfer();
              }}
            >
              Передать QR-код
            </ActionRow>
          )}
          {owned && editable && (
            <ActionRow
              icon={IconPencil}
              onClick={() => {
                close();
                navigate(`/participants/${p.id}/edit`);
              }}
            >
              Изменить данные
            </ActionRow>
          )}
          {owned && editable && (
            <ActionRow
              icon={IconUserX}
              danger
              busy={cancelling}
              onClick={() => {
                close();
                void cancel();
              }}
            >
              Отменить регистрацию
            </ActionRow>
          )}
        </div>
        {me.registration.open === false && owned && (
          <p className="mt-3 text-center text-[13px] text-hint">Регистрация закрыта. Изменить данные можно через организаторов.</p>
        )}
      </Sheet>
    </div>
  );
}

export default function Tickets() {
  const me = useMeData();
  const [, navigate] = useLocation();
  const search = useSearch();
  const focusId = Number(new URLSearchParams(search).get('p')) || null;
  const [transferFor, setTransferFor] = useState<MyParticipant | null>(null);
  const [resending, setResending] = useState(false);
  const tz = me.event.timezone;
  const active = me.participants.filter((p) => p.status === 'active');
  const many = active.length > 1;

  useEffect(() => {
    if (!focusId) return;
    const t = window.setTimeout(() => document.getElementById(`ticket-${focusId}`)?.scrollIntoView({ block: 'start' }), 60);
    return () => window.clearTimeout(t);
  }, [focusId]);

  const resend = async () => {
    setResending(true);
    try {
      const res = await participantApi.resendTickets();
      if (res.queued) toast.success(many ? 'QR-коды отправлены в чат' : 'QR-код отправлен в чат');
      else if (res.reason === 'too_soon') toast.info('Уже отправили. Повторить можно через минуту');
      else toast.info('Пока нечего отправлять');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  if (active.length === 0) {
    return (
      <Page title="Мои QR-коды" back="/">
        <EmptyState icon={IconQrcode} title="QR-кодов пока нет">
          После регистрации QR-код для входа появится здесь и придёт в чат.
        </EmptyState>
        {me.registration.open && (
          <Button size="lg" block onClick={() => navigate('/register')}>
            Зарегистрироваться
          </Button>
        )}
      </Page>
    );
  }

  return (
    <Page title={many ? 'QR-коды' : 'QR-код'} back="/">
      {active.length > 1 && (
        <div className="-mx-4 mb-4 no-scrollbar flex gap-2 overflow-x-auto px-4 pb-1">
          {active.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => document.getElementById(`ticket-${p.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="min-h-9 shrink-0 rounded-full bg-section px-3.5 text-[15px] font-semibold"
            >
              {p.firstName}
            </button>
          ))}
        </div>
      )}

      {active.map((p) => (
        <TicketCard
          key={p.id}
          p={p}
          tz={tz}
          editable={me.registration.open}
          payments={paymentsOn(me)}
          onTransfer={() => setTransferFor(p)}
        />
      ))}

      <Button variant="secondary" block loading={resending} onClick={resend} className="mb-2">
        {!resending && <IconSend size={20} />}
        {many ? 'Прислать QR-коды в чат' : 'Прислать QR-код в чат'}
      </Button>
      <p className="px-1 text-center text-[13px] text-hint">{many ? 'Картинки удобно переслать тем, кто придёт с вами.' : 'Картинку можно сохранить или переслать.'}</p>

      <TransferSheet participant={transferFor} eventName={me.event.name} tz={tz} onClose={() => setTransferFor(null)} />
    </Page>
  );
}
