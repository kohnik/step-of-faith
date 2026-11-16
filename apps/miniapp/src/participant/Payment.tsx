import { useRef, useState } from 'react';
import { formatRub, type MyParticipant, type TiersConfig } from '@sof/shared';
import { IconAlertTriangle, IconCheck, IconCopy, IconMessageCircle, IconPencil, IconReceipt } from '@tabler/icons-react';
import { errorMessage } from '../api/client.ts';
import { haptic } from '../lib/feedback.ts';
import { useLocation } from 'wouter';
import { copyText, openExternal } from '../telegram/actions.ts';
import { closeMiniApp, isTelegram } from '../telegram/sdk.ts';
import { Button, Card, Notice, Section } from '../ui/kit.tsx';
import { ListGroup } from '../ui/List.tsx';
import { Page } from '../ui/Page.tsx';
import { tierColor } from '../ui/TierBadge.tsx';
import { toast } from '../ui/toast.tsx';
import { canAddBreakfast, canChangeTier, canRemoveBreakfast, leftToPay, participantApi, PAY_TONE_CLASS, paymentState, useMeData } from './api.ts';
import { canChangeMethod, PaymentMethodSwitch } from './PaymentMethodSwitch.tsx';
import { CopyableText } from './CopyableText.tsx';

function PersonPayRow({ p, tiers, transfers }: { p: MyParticipant; tiers: TiersConfig; transfers: boolean }) {
  const me = useMeData();
  const [, navigate] = useLocation();
  // Вариант, которого уже нет в настройках (данные с телефона до обновления), - как без варианта.
  const tier = (p.tier && tiers[p.tier]) || null;
  const pay = paymentState(p, me.features.softPaymentLabels);
  const canSwitch = transfers && tier !== null && canChangeMethod(p, tier.amount);
  return (
    <div className="group flex items-stretch gap-3 pl-4">
      <span aria-hidden className="my-3 w-1 shrink-0 rounded-full" style={{ background: tierColor(p.tier, tiers) ?? 'var(--color-line)' }} />
      <div className="min-w-0 flex-1 border-b border-line py-3 pr-4 group-last:border-b-0">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 truncate text-[16px] font-semibold">{p.fullName}</p>
          {p.paymentStatus !== 'exempt' && <p className={`shrink-0 text-[15px] ${PAY_TONE_CLASS[pay.tone]}`}>{pay.text}</p>}
        </div>
        {tier && (
          <p className="flex items-center gap-1 text-[14px] text-subtle">
            {tier.label}
            {p.breakfast ? ' + завтрак' : ''}
            {canChangeTier(me, p) && (
              <button
                type="button"
                aria-label="Сменить вариант"
                onClick={() => navigate(`/participants/${p.id}/edit?focus=tier`)}
                className="-my-1.5 flex size-8 items-center justify-center rounded-full text-accent active:bg-fill"
              >
                <IconPencil size={15} />
              </button>
            )}
            {canAddBreakfast(me, p) && (
              <button
                type="button"
                onClick={() => navigate(`/participants/${p.id}/edit?focus=breakfast`)}
                className="-my-1 ml-1 rounded-full bg-fill px-2.5 py-1 text-[13px] font-bold text-accent active:opacity-70"
              >
                Докупить завтрак
              </button>
            )}
            {canRemoveBreakfast(me, p) && (
              <button
                type="button"
                onClick={() => navigate(`/participants/${p.id}/edit?focus=breakfast`)}
                className="-my-1 ml-1 rounded-full bg-fill px-2.5 py-1 text-[13px] font-bold text-accent active:opacity-70"
              >
                Убрать завтрак
              </button>
            )}
          </p>
        )}
        {canSwitch && <PaymentMethodSwitch participant={p} className="mt-2.5" />}
      </div>
    </div>
  );
}

export default function Payment() {
  const me = useMeData();
  const tiers = me.registration.tiers;
  const active = me.participants.filter((p) => p.status === 'active');
  const open = active.filter((p) => p.paymentStatus === 'unpaid' || p.paymentStatus === 'partial');
  const pending = active.filter((p) => p.paymentStatus === 'pending');
  const left = open.reduce((sum, p) => sum + leftToPay(p), 0);
  // Переводы выключены - всем показываем наличные.
  const byTransfer = me.payment.transfers ? open.filter((p) => p.paymentMethod !== 'cash') : [];
  const byCash = me.payment.transfers ? open.filter((p) => p.paymentMethod === 'cash') : open;
  const many = active.length > 1;

  // В комментарий к переводу - ФИО тех, кто платит переводом: так админ поймёт, за кого деньги.
  const transferNames = byTransfer.map((p) => p.fullName).join(', ');
  const copyNames = async () => {
    if (await copyText(transferNames)) toast.success('Скопировано');
    else toast.error('Не получилось скопировать');
  };

  return (
    <Page title="Оплата" back="/">
      {open.length > 0 ? (
        <Card className="mb-5">
          <p className="text-[14px] text-subtle">Осталось внести</p>
          <p className="mt-0.5 font-display text-[28px] font-semibold leading-tight">{formatRub(left)}</p>
          <p className="mt-1 text-[14px] text-subtle">
            {/* Конференция уже идёт - «до начала» больше не верно. */}
            {me.event.startsAt && new Date() >= new Date(me.event.startsAt) ? 'На кассе у входа или переводом' : 'До начала конференции'}
          </p>
        </Card>
      ) : active.length > 0 ? (
        <Notice tone={pending.length && !me.features.softPaymentLabels ? 'yellow' : 'green'} className="mb-5">
          {pending.length
            ? me.features.softPaymentLabels
              ? 'Чек получен. Спасибо!'
              : 'Чек на проверке. Когда проверим, придёт сообщение в чат.'
            : many
              ? 'Взнос внесён за всех. Спасибо.'
              : 'Взнос внесён. Спасибо.'}
        </Notice>
      ) : null}

      {active.length > 0 && (
        <Section title={many ? 'Участники' : undefined}>
          <ListGroup>
            {active.map((p) => (
              <PersonPayRow key={p.id} p={p} tiers={tiers} transfers={me.payment.transfers} />
            ))}
          </ListGroup>
          {many && open.length > 0 && (
            <p className="mt-2 px-1 text-[13px] leading-snug text-hint">
              За каждого можно заплатить отдельно и в разное время.
            </p>
          )}
        </Section>
      )}

      {byTransfer.length > 0 && (
        <Section title="Переводом">
          <Card>
            <p className="whitespace-pre-wrap break-words text-[16px] leading-relaxed">
              <CopyableText text={me.payment.instructions} />
            </p>
            <p className="mt-3 border-t border-line pt-3 text-[15px] leading-snug">
              {byTransfer.length > 1 ? 'В комментарии укажите фамилии и имена:' : 'В комментарии укажите фамилию и имя:'}
            </p>
            <button
              type="button"
              onClick={() => void copyNames()}
              className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl bg-fill px-3 py-2.5 text-left active:opacity-70"
            >
              <span className="min-w-0 text-[15px] font-medium">{transferNames}</span>
              <IconCopy size={18} className="shrink-0 text-accent" aria-label="Скопировать" />
            </button>
            {/* Самый важный шаг - без чека оплату не засчитать. Выделяем, чтобы не потерялся в инструкции. */}
            <div className="mt-3 flex gap-2.5 rounded-xl border-2 border-danger bg-danger/10 px-3 py-2.5">
              <IconAlertTriangle size={22} className="mt-0.5 shrink-0 text-danger" />
              <p className="text-[16px] font-bold leading-snug text-danger">
                Обязательно: после перевода отправьте боту фото, скриншот или PDF чека
                {open.length > 1 ? ' - бот спросит, за кого этот чек.' : '.'}
                <span className="mt-1 block text-[14px] font-medium">Без чека оплату не засчитаем.</span>
                {open.length > 1 && (
                  <span className="mt-1 block text-[14px] font-medium">Переводов несколько - пришлите все чеки подряд, они соберутся в один.</span>
                )}
              </p>
            </div>
            <p className="mt-2 px-1 text-[13px] leading-snug text-hint">Взнос, оплаченный переводом, не возвращается.</p>
            {isTelegram() && (
              <Button variant="secondary" block className="mt-3" onClick={openBotChat}>
                <IconMessageCircle size={20} />
                Открыть чат с ботом
              </Button>
            )}
          </Card>
        </Section>
      )}

      {byCash.length > 0 && (
        <Section title="Наличными">
          <Card>
            <p className="whitespace-pre-wrap break-words text-[16px] leading-relaxed">{me.payment.cash}</p>
          </Card>
        </Section>
      )}

      {me.payment.transfers && <Donation instructions={me.payment.otherInstructions} />}
    </Page>
  );
}

/** Пожертвование: реквизиты те же, чек - файлом сюда; он уходит на проверку отдельным видом, не за взнос. */
function Donation({ instructions }: { instructions: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    setBusy(true);
    try {
      await participantApi.donationReceipt(f);
      setSent(true);
      haptic('success');
      toast.success('Чек отправлен. Спасибо!');
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Пожертвование">
      <Card>
        {!open ? (
          <Button variant="secondary" block onClick={() => setOpen(true)}>
            💝 Сделать пожертвование
          </Button>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words text-[16px] leading-relaxed">
              <CopyableText text={instructions} />
            </p>
            <p className="mt-3 border-t border-line pt-3 text-[15px] leading-snug">В комментарии к переводу напишите «Пожертвование».</p>
            <input
              ref={file}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (f) void upload(f);
              }}
            />
            {sent ? (
              <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-ok-fg">
                <IconCheck size={18} /> Чек отправлен, спасибо!
              </p>
            ) : (
              <Button block className="mt-3" loading={busy} onClick={() => file.current?.click()}>
                <IconReceipt size={18} /> Прикрепить чек
              </Button>
            )}
          </>
        )}
      </Card>
    </Section>
  );
}

/**
 * «Открыть чат с ботом»: ссылкой на бота, а не закрытием приложения - закрытие возвращает туда, откуда
 * приложение открыли (из списка чатов или профиля бота это не переписка). Без имени бота в сборке - закрываем.
 */
function openBotChat() {
  const bot = import.meta.env.VITE_BOT_USERNAME?.replace(/^@/, '');
  if (bot) openExternal(`https://t.me/${bot}`);
  // Telegram открывает чат под приложением, но само приложение не сворачивает - закрываем его сами,
  // чуть погодя, чтобы переход успел начаться. Без имени бота - просто закрываем.
  window.setTimeout(closeMiniApp, bot ? 300 : 0);
}
