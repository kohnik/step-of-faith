import type { MyParticipant, SeminarsPublic } from '@sof/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { IconCheck, IconClock, IconLink, IconMapPin, IconMicrophone2, IconSchool } from '@tabler/icons-react';
import { useLocation } from 'wouter';
import { errorMessage } from '../api/client.ts';
import { haptic } from '../lib/feedback.ts';
import { session } from '../lib/storage.ts';
import { formatTime } from '../lib/time.ts';
import { copyText } from '../telegram/actions.ts';
import { Button, cx, EmptyState, ErrorState, Notice, Section, Spinner } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { toast } from '../ui/toast.tsx';
import { AFTER_REGISTER_KEY, participantApi, SEMINARS_KEY, sessionsOf, topicsWord, useMeData, votesOf } from './api.ts';
import { PersonPicker, usePerson } from './PersonPicker.tsx';
import { usePollInterval } from '../api/realtime.ts';

export function useSeminars() {
  return useQuery({ queryKey: SEMINARS_KEY, queryFn: () => participantApi.seminars(), staleTime: 15_000, refetchInterval: usePollInterval(30_000) });
}

function TopicCard({
  t,
  chosen,
  disabled,
  onToggle,
}: {
  t: SeminarsPublic['topics'][number];
  chosen: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('rounded-2xl bg-section p-4 transition', chosen && 'ring-2 ring-[var(--color-ok)]')}>
      <button type="button" onClick={onToggle} disabled={disabled} className="flex w-full items-start gap-3 text-left disabled:opacity-100">
        <span
          aria-hidden
          className={cx(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full transition',
            chosen ? 'bg-[var(--color-ok)] text-white' : 'bg-fill text-hint',
          )}
        >
          <IconCheck size={16} className={chosen ? undefined : 'opacity-40'} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold leading-snug">{t.title}</span>
          {t.host && (
            <span className="mt-1 flex items-center gap-1 text-[14px] text-subtle">
              <IconMicrophone2 size={15} />
              {t.host}
            </span>
          )}
        </span>
      </button>
      {t.description && (
        <div className="pl-10">
          {open && <p className="mt-2 whitespace-pre-line text-[15px] leading-snug">{t.description}</p>}
          <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 text-[14px] font-medium text-accent">
            {open ? 'Свернуть' : 'Описание'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Свои семинары после публикации: время, тема, зал. */
function MySessions({ data, family, tz }: { data: SeminarsPublic; family: MyParticipant[]; tz: string }) {
  return (
    <Section title="Ваши семинары">
      <div className="space-y-2">
        {family.map((p) => {
          const list = sessionsOf(data, p.id);
          return (
            <div key={p.id} className="rounded-2xl bg-section p-4">
              {family.length > 1 && <p className="mb-2 text-[15px] font-semibold">{p.firstName}</p>}
              {data.waiting.includes(p.id) && (
                <p className="mb-2 text-[14px] leading-snug text-accent">
                  Новый выбор получили. Пока места прежние - организаторы пересадят и пришлют новое время и зал.
                </p>
              )}
              {list.length === 0 ? (
                <p className="text-[15px] text-subtle">Без семинара - подойдите к организаторам.</p>
              ) : (
                <div className="space-y-3">
                  {list.map((s) => (
                    <div key={s.id}>
                      <p className="text-[17px] font-semibold leading-snug">{s.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[14px] text-subtle">
                        <span className="inline-flex items-center gap-1">
                          <IconClock size={15} />
                          {formatTime(s.startsAt, tz)}–{formatTime(s.endsAt, tz)}
                        </span>
                        {s.location && (
                          <span className="inline-flex items-center gap-1 font-semibold text-fg">
                            <IconMapPin size={15} />
                            {s.location}
                          </span>
                        )}
                        {s.host && (
                          <span className="inline-flex items-center gap-1">
                            <IconMicrophone2 size={15} />
                            {s.host}
                          </span>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const BOT = import.meta.env.VITE_BOT_USERNAME?.replace(/^@/, '');
/** Ссылка для канала: открывает бота и сразу приложение на семинарах. */
export const SEMINARS_LINK = BOT ? `https://t.me/${BOT}?startapp=seminars` : null;

/** Команде: скопировать ссылку на семинары, чтобы выложить в канал. */
function CopyLink() {
  if (!SEMINARS_LINK) return null;
  return (
    <div className="mb-5 rounded-2xl bg-section p-4">
      <p className="text-[15px] font-semibold">Ссылка для канала</p>
      <p className="mt-0.5 text-[14px] leading-snug text-subtle">
        По ней откроется бот и сразу этот экран. Видят только организаторы.
      </p>
      <p className="mt-2 break-all text-[14px] text-link">{SEMINARS_LINK}</p>
      <Button
        variant="secondary"
        block
        className="mt-3"
        onClick={() =>
          void copyText(SEMINARS_LINK).then((ok) => {
            haptic(ok ? 'success' : 'error');
            if (ok) toast.success('Ссылка скопирована');
            else toast.error('Не получилось скопировать - выделите ссылку вручную');
          })
        }
      >
        <IconLink size={18} className="mr-1.5 inline" aria-hidden />
        Скопировать ссылку
      </Button>
    </div>
  );
}

/** Семинары - только для зарегистрированных: сначала регистрация, потом сразу обратно сюда. */
function RegisterFirst() {
  const me = useMeData();
  const [, navigate] = useLocation();
  return (
    <Page title="Семинары" back="/">
      <EmptyState icon={IconSchool} hue="violet" title="Сначала регистрация">
        Выбирать семинары могут только зарегистрированные участники.
        {me.registration.open ? ' Зарегистрируйтесь - и сразу вернётесь к выбору.' : ' Регистрация сейчас закрыта.'}
      </EmptyState>
      {me.registration.open && (
        <Button
          size="lg"
          block
          onClick={() => {
            session.set(AFTER_REGISTER_KEY, '/seminars');
            navigate('/register');
          }}
        >
          Зарегистрироваться
        </Button>
      )}
      <Button variant="plain" block className="mt-2" onClick={() => navigate('/')}>
        На главную
      </Button>
    </Page>
  );
}

/**
 * Семинары: пока выбор открыт - отметить нужное число тем за себя и за каждого из семьи (сохраняется сразу).
 * После публикации - свои семинары с временем и залами.
 */
export function SeminarsScreen() {
  const me = useMeData();
  const tz = me.event.timezone;
  const qc = useQueryClient();
  const q = useSeminars();
  const family = me.participants.filter((p) => p.status === 'active');
  const { person, choose } = usePerson(family);
  const [busy, setBusy] = useState(false);
  const data = q.data;
  const picks = data?.picks ?? 0;
  const mine = votesOf(data, person?.id);

  const toggle = async (topicId: number) => {
    if (!data || !person || busy) return;
    const next = mine.includes(topicId) ? mine.filter((t) => t !== topicId) : [...mine, topicId];
    if (next.length > picks) {
      haptic('warning');
      toast.info(`Можно выбрать ${topicsWord(picks)} - сначала снимите одну`);
      return;
    }
    const before = data;
    // Сразу показываем выбор; не сохранилось - возвращаем как было.
    qc.setQueryData<SeminarsPublic>(SEMINARS_KEY, {
      ...data,
      votes: [...data.votes.filter((v) => v.participantId !== person.id), { participantId: person.id, topicIds: next }],
    });
    haptic('selection');
    setBusy(true);
    try {
      qc.setQueryData(SEMINARS_KEY, await participantApi.seminarVotes({ participantId: person.id, topicIds: next }));
      // Сохраняем каждую отметку: одной темы тоже достаточно.
      if (next.length > 0) {
        const msg = next.length < picks ? 'Сохранено. Можно выбрать ещё или оставить так' : 'Выбор сохранён';
        toast.success(family.length > 1 ? `${person.firstName}: ${msg.charAt(0).toLowerCase()}${msg.slice(1)}` : msg);
      }
    } catch (err) {
      qc.setQueryData(SEMINARS_KEY, before);
      haptic('error');
      toast.error(errorMessage(err));
      void q.refetch();
    } finally {
      setBusy(false);
    }
  };

  if (family.length === 0) return <RegisterFirst />;
  const staff = me.roles.some((r) => r === 'admin' || r === 'superadmin');

  return (
    <Page title="Семинары" back="/">
      {staff && <CopyLink />}
      {q.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-9 text-btn" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : data!.topics.length === 0 ? (
        <EmptyState icon={IconSchool} hue="violet" title="Семинаров пока нет">
          Темы появятся ближе к конференции.
        </EmptyState>
      ) : (
        <>
          {data!.published && <MySessions data={data!} family={family} tz={tz} />}
          {data!.open ? (
            <Section title={data!.published ? 'Выбор тем' : undefined}>
              <PersonPicker family={family} person={person} onChoose={choose} label="За кого выбираем:" />
              <p className="mb-3 px-1 text-[15px] leading-snug text-subtle">
                {data!.published ? (
                  <>
                    Хотите на другой семинар - снимите отметку и выберите другой. Место останется прежним, пока организаторы не пересадят, новое
                    время и зал пришлём в чат с ботом.
                  </>
                ) : (
                  <>
                    Выберите {topicsWord(picks)}
                    {picks > 1 ? ` - семинаров будет ${picks} потока, и вы попадёте на каждую из выбранных` : ''}. Передумали - снимите отметку и
                    выберите другую. Интересна только одна - отметьте одну, этого достаточно. Время и зал пришлём в чат с ботом.
                  </>
                )}
              </p>
              <p className="mb-2 px-1 text-[14px] font-semibold">
                {mine.length === picks ? (
                  <span className="text-ok-fg">Выбрано {mine.length} из {picks} - готово</span>
                ) : mine.length > 0 ? (
                  <span className="text-ok-fg">
                    Выбрано {mine.length} из {picks} - сохранено, можно добавить ещё
                  </span>
                ) : (
                  <span className="text-accent">
                    Выбрано {mine.length} из {picks}
                  </span>
                )}
              </p>
              <div className="space-y-3">
                {data!.topics.map((t) => (
                  <TopicCard
                    key={t.id}
                    t={t}
                    chosen={mine.includes(t.id)}
                    disabled={busy}
                    onToggle={() => void toggle(t.id)}
                  />
                ))}
              </div>
            </Section>
          ) : (
            !data!.published && (
              <>
                {family.some((p) => votesOf(data, p.id).length > 0) ? (
                  <Notice tone="green" className="mb-4">
                    Выбор принят. Распределение по залам пришлём в чат с ботом.
                  </Notice>
                ) : (
                  <Notice tone="gray" className="mb-4">
                    Выбор тем сейчас закрыт.
                  </Notice>
                )}
                <Section title="Темы">
                  <div className="space-y-2">
                    {data!.topics.map((t) => (
                      <div key={t.id} className="rounded-2xl bg-section p-4">
                        <p className="text-[17px] font-semibold leading-snug">{t.title}</p>
                        {t.host && <p className="mt-1 text-[14px] text-subtle">{t.host}</p>}
                        {family.some((p) => votesOf(data, p.id).includes(t.id)) && (
                          <p className="mt-1 text-[14px] font-semibold text-ok-fg">
                            Выбрали:{' '}
                            {family
                              .filter((p) => votesOf(data, p.id).includes(t.id))
                              .map((p) => p.firstName)
                              .join(', ')}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              </>
            )
          )}
        </>
      )}
    </Page>
  );
}
