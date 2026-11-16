/**
 * Пульт ведущего игры «Церкви» с телефона: запись, команды, задания, «Начать игру», «Показать задания»,
 * кто выступает (флаг и задание на большом экране), голосование и итоги. Тексты и расписание - в веб-админке.
 */
import { COUNTRY_CODES, countryName, type GameAdminView, type GameTaskView, type GameTeamAdmin } from '@sof/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconCheck, IconChevronLeft, IconChevronRight, IconDeviceTv, IconDice5, IconEyeOff, IconPlus } from '@tabler/icons-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client.ts';
import { haptic } from '../lib/feedback.ts';
import { Flag } from '../participant/game/art.tsx';
import { confirmAction, openExternal } from '../telegram/actions.ts';
import { Badge, Button, Checkbox, cx, EmptyState, ErrorState, Field, Notice, Segmented, Select, Spinner, Switch, TextArea, TextInput } from '../ui/kit.tsx';
import { Page } from '../ui/Page.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { toast } from '../ui/toast.tsx';
import { staffApi } from './api.ts';
import { SessionExpiredNotice } from './SessionExpired.tsx';

const KEY = ['game-desk'] as const;
type Tab = 'run' | 'teams' | 'tasks';
type Team = GameTeamAdmin;

const COUNTRIES = [...COUNTRY_CODES].map((c) => ({ code: c, name: countryName(c) ?? c })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const label = (t: Team) => `${t.number}. ${t.title}`;

/** Запуск действия: ответ сервера - сразу в экран, ошибка - тостом. */
function useRun() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<GameAdminView>, ok?: string): Promise<GameAdminView | null> => {
    setBusy(key);
    try {
      const view = await fn();
      qc.setQueryData(KEY, view);
      haptic('success');
      if (ok) toast.success(ok);
      return view;
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

export default function GameDesk() {
  const [tab, setTab] = useState<Tab>('run');
  const q = useQuery({
    queryKey: KEY,
    queryFn: staffApi.game,
    refetchInterval: 2000,
  });
  const v = q.data;
  return (
    <Page title="Игра · пульт" subtitle="Миссия: церкви" back="/">
      <SessionExpiredNotice />
      {q.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : q.isError || !v ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Segmented
            value={tab}
            onChange={setTab}
            className="mb-4"
            options={[
              { value: 'run', label: 'Ход игры' },
              {
                value: 'teams',
                label: `Команды ${v.teams.length || ''}`.trim(),
              },
              {
                value: 'tasks',
                label: `Задания ${v.tasks.length || ''}`.trim(),
              },
            ]}
          />
          <TestToggle v={v} />
          {tab === 'run' && <RunTab v={v} />}
          {tab === 'teams' && <TeamsTab v={v} />}
          {tab === 'tasks' && <TasksTab v={v} />}
        </>
      )}
    </Page>
  );
}

/**
 * Тестовая игра или настоящая: все кнопки пульта работают в выбранном режиме.
 * Тест-лист и прочие настройки теста - в веб-админке.
 */
function TestToggle({ v }: { v: GameAdminView }) {
  const { busy, run } = useRun();
  const test = v.launch === 'test';
  const toggle = async (next: boolean) => {
    if (next) {
      const ok = await confirmAction({
        title: v.launch === 'off' ? 'Включить тестовую игру?' : 'Вернуться к тестовой игре?',
        message: 'Игру увидят только ведущие и тест-лист. Команды, ответы и голоса сохранятся.',
        ok: 'Тестовая игра',
      });
      if (ok) void run('launch', () => staffApi.gamePost('launch', { mode: 'test', wipe: false, invite: false }), 'Тестовая игра');
      return;
    }
    const ok = await confirmAction({
      title: 'Начать настоящую игру?',
      message:
        'Игру увидят все участники. Ответы, распределение и голоса теста сотрём - названия команд, страны и задания останутся. Затем откройте запись: приглашения уйдут всем.',
      ok: 'Настоящая игра',
    });
    if (ok) void run('launch', () => staffApi.gamePost('launch', { mode: 'live', wipe: v.launch === 'test', keepSetup: true, invite: false }), 'Настоящая игра');
  };
  return (
    <div className={cx('mb-4 rounded-2xl p-4', test ? 'bg-warn-soft' : 'bg-section')}>
      <Switch checked={test} disabled={busy !== null} onChange={(next) => void toggle(next)}>
        <span className="block text-[17px] font-bold">Тестовая игра</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-subtle">
          {test
            ? 'Видят только ведущие и тест-лист, приглашения - только им.'
            : v.launch === 'live'
              ? 'Игра настоящая: видят все участники.'
              : 'Игра скрыта ото всех - включите тест.'}
        </span>
      </Switch>
    </div>
  );
}

// ---------- ход игры ----------

function Step({ n, title, done, active, children }: { n: number; title: string; done?: boolean; active?: boolean; children: ReactNode }) {
  return (
    <section className={cx('mb-3 rounded-2xl bg-section p-4', active && 'shadow-[inset_0_0_0_2px_var(--color-btn)]')}>
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cx(
            'flex size-7 shrink-0 items-center justify-center rounded-full text-[14px] font-bold',
            done ? 'bg-ok text-white' : 'bg-fill text-subtle',
          )}
        >
          {done ? <IconCheck size={16} stroke={3} /> : n}
        </span>
        <h2 className="text-[17px] font-bold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** Секунды до конца раунда - тикают каждую секунду. */
function useLeft(closesAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!closesAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [closesAt]);
  return closesAt ? Math.max(0, Math.round((Date.parse(closesAt) - now) / 1000)) : null;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function RunTab({ v }: { v: GameAdminView }) {
  const { busy, run } = useRun();
  const qc = useQueryClient();
  const [distributing, setDistributing] = useState(false);
  const [notify, setNotify] = useState(v.config.notifyTasks);
  // Кто уже выступил - помним на этом телефоне.
  const [done, setDone] = useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem('game.performed') ?? '[]') as number[]);
    } catch {
      return new Set();
    }
  });
  const markDone = (id: number | null) => {
    if (id === null) return;
    setDone((s) => {
      const next = new Set(s).add(id);
      try {
        sessionStorage.setItem('game.performed', JSON.stringify([...next]));
      } catch {
        /* приватный режим */
      }
      return next;
    });
  };

  const teams = v.teams;
  const yes = v.players.filter((p) => p.answer === 'yes').length;
  const noTask = teams.filter((t) => !t.taskId).length;
  const noCountry = teams.filter((t) => !t.countryCode).length;
  const round = v.rounds.find((r) => r.status === 'open') ?? null;
  const roundTeam = round?.teamId ? teams.find((t) => t.id === round.teamId) : null;
  const left = useLeft(round?.closesAt ?? null);
  const stageIdx = teams.findIndex((t) => t.id === v.stageTeamId);
  const stageTeam = stageIdx >= 0 ? teams[stageIdx]! : null;

  const confirm = (title: string, message: string, ok: string) => confirmAction({ title, message, ok });

  const toStage = (teamId: number | null) => {
    markDone(v.stageTeamId);
    return run(`stage:${teamId}`, () => staffApi.gamePost('stage', { teamId }));
  };
  const step = (dir: 1 | -1) => {
    if (teams.length === 0) return;
    const from = stageIdx >= 0 ? stageIdx : dir === 1 ? -1 : teams.length;
    const next = teams[from + dir];
    if (next) void toStage(next.id);
  };

  return (
    <div className="pb-6">
      <Step n={1} title="Запись" done={!v.signupOpen && yes > 0}>
        <p className="mb-3 text-[15px] text-subtle">
          {v.signupOpen ? 'Запись открыта' : 'Запись закрыта'} · «Участвую»: <b className="text-fg">{yes}</b>
        </p>
        <Button
          variant={v.signupOpen ? 'secondary' : 'primary'}
          block
          loading={busy === 'signup'}
          onClick={() => void run('signup', () => staffApi.gamePost('signup', { open: !v.signupOpen }), v.signupOpen ? 'Запись закрыта' : 'Запись открыта')}
        >
          {v.signupOpen ? 'Закрыть запись' : 'Открыть запись'}
        </Button>
      </Step>

      <Step n={2} title="Команды и задания" done={!!v.distributedAt && noTask === 0 && noCountry === 0}>
        <p className="mb-3 text-[15px] text-subtle">
          Команд: <b className="text-fg">{teams.length}</b> · {v.distributedAt ? 'игроки распределены' : 'ещё не распределены'}
        </p>
        {teams.length === 0 && (
          <Notice tone="gray" className="mb-3">
            Создайте команды во вкладке «Команды».
          </Notice>
        )}
        {teams.length > 0 && (noTask > 0 || noCountry > 0) && (
          <Notice tone="yellow" className="mb-3">
            {noTask > 0 && <p>Без задания: {noTask}</p>}
            {noCountry > 0 && <p>Без страны: {noCountry}</p>}
          </Notice>
        )}
        {teams.length > 0 && (
          <Button
            variant={v.distributedAt ? 'secondary' : 'primary'}
            block
            loading={distributing}
            onClick={async () => {
              if (
                v.distributedAt &&
                !(await confirm('Распределить ещё раз?', 'Новых игроков добавим в команды, уже распределённые останутся на местах.', 'Распределить'))
              )
                return;
              void distribute();
            }}
          >
            {v.distributedAt ? 'Распределить новых' : 'Распределить по командам'}
          </Button>
        )}
      </Step>

      <Step n={3} title="Начать игру" done={!!v.startedAt} active={!v.startedAt && !!v.distributedAt}>
        {v.startedAt ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px] text-ok-fg">Игра начата</p>
            <Button
              variant="plain"
              size="sm"
              loading={busy === 'start'}
              onClick={() => void run('start', () => staffApi.gamePost('start', { started: false }))}
            >
              Отменить
            </Button>
          </div>
        ) : (
          <Button
            block
            size="lg"
            loading={busy === 'start'}
            onClick={async () => {
              if (!(await confirm('Начать игру?', 'Запись и оформление команд закроются. На экране - заставка игры, флаги пока скрыты.', 'Начать'))) return;
              void run('start', () => staffApi.gamePost('start', { started: true }), 'Игра начата');
            }}
          >
            Начать игру
          </Button>
        )}
      </Step>

      <Step n={4} title="Показать задания" done={!!v.tasksRevealedAt} active={!!v.startedAt && !v.tasksRevealedAt}>
        {v.tasksRevealedAt ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[15px] text-ok-fg">Задания и флаги открыты командам</p>
            <Button
              variant="plain"
              size="sm"
              loading={busy === 'reveal'}
              onClick={() =>
                void run('reveal', () =>
                  staffApi.gamePost('reveal', {
                    revealed: false,
                    notify: false,
                  }),
                )
              }
            >
              Скрыть
            </Button>
          </div>
        ) : (
          <>
            <p className="mb-2 text-[15px] text-subtle">Каждая команда увидит в мини-аппе свой контекст и задание, страну и флаг. На экране у команд появятся флаги.</p>
            <Checkbox checked={notify} onChange={setNotify}>
              Прислать каждой команде её задание в бот
            </Checkbox>
            <Button
              block
              size="lg"
              className="mt-2"
              loading={busy === 'reveal'}
              onClick={async () => {
                if (
                  !(await confirm(
                    'Показать задания?',
                    notify ? 'Командам откроются контекст, задания и флаги, бот пришлёт каждой её задание.' : 'Командам откроются контекст, задания и флаги.',
                    'Показать',
                  ))
                )
                  return;
                void run('reveal', () => staffApi.gamePost('reveal', { revealed: true, notify }), 'Задания открыты');
              }}
            >
              Показать задания
            </Button>
          </>
        )}
      </Step>

      <Step n={5} title="Выступления" active={!!v.tasksRevealedAt && !round && !v.resultsShown}>
        {teams.length === 0 ? (
          <p className="text-[15px] text-subtle">Команд пока нет.</p>
        ) : (
          <>
            {/* Кнопки - над списком и прилипают сверху: при 10+ командах до них не нужно листать. */}
            <div className="sticky top-[calc(var(--safe-top)+0.5rem)] z-10 -mx-1 mb-3 rounded-2xl bg-section/95 px-1 py-1 backdrop-blur">
              <p className="mb-2 px-1 text-[15px]">
                {stageTeam ? (
                  <>
                    На сцене: <b>{label(stageTeam)}</b>
                  </>
                ) : (
                  <span className="text-subtle">На экране заставка - нажмите команду ниже</span>
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" className="w-14" aria-label="Предыдущая команда" onClick={() => step(-1)} disabled={busy !== null}>
                  <IconChevronLeft size={22} />
                </Button>
                <Button
                  variant={stageTeam ? 'primary' : 'secondary'}
                  className="flex-1"
                  loading={busy === 'stage:null'}
                  disabled={!stageTeam}
                  onClick={() => void toStage(null)}
                >
                  <IconEyeOff size={18} /> Скрыть с экрана
                </Button>
                <Button variant="secondary" className="w-14" aria-label="Следующая команда" onClick={() => step(1)} disabled={busy !== null}>
                  <IconChevronRight size={22} />
                </Button>
              </div>
              {v.config.mode === 'per_team' && stageTeam && !round && (
                <Button
                  variant="success"
                  block
                  className="mt-2"
                  loading={busy === 'round'}
                  onClick={() => void run('round', () => staffApi.gamePost('rounds', { teamId: stageTeam.id }), 'Голосование открыто')}
                >
                  Голосовать за «{stageTeam.title}»
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              {teams.map((t) => {
                const on = t.id === v.stageTeamId;
                const task = v.tasks.find((x) => x.id === t.taskId);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => (on ? undefined : void toStage(t.id))}
                    className={cx(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition active:opacity-80',
                      on ? 'bg-btn text-btn-fg' : 'bg-fill',
                    )}
                  >
                    {t.countryCode ? (
                      <Flag code={t.countryCode} height={22} />
                    ) : (
                      <span className="size-[22px] shrink-0 rounded-full" style={{ background: t.color }} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{label(t)}</span>
                      <span className={cx('block truncate text-[13px]', on ? 'opacity-85' : 'text-subtle')}>{task ? task.title : 'без задания'}</span>
                    </span>
                    {on ? (
                      <span className="shrink-0 text-[12px] font-bold uppercase tracking-wider">На сцене</span>
                    ) : done.has(t.id) ? (
                      <IconCheck size={18} className="shrink-0 text-ok-fg" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Step>

      <Step n={6} title="Голосование" active={!!round}>
        {round ? (
          <>
            <p className="text-[15px]">
              {roundTeam ? (
                <>
                  Голосуем за <b>{label(roundTeam)}</b>
                </>
              ) : (
                <b>Общее голосование</b>
              )}
            </p>
            <div className="mt-2 flex items-end justify-between">
              <span className="font-display text-[34px] font-bold tabular-nums leading-none">{left !== null ? mmss(left) : '∞'}</span>
              <span className="text-[15px] text-subtle">
                проголосовали: <b className="text-fg">{round.voters}</b>
              </span>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                loading={busy === 'extend'}
                onClick={() => void run('extend', () => staffApi.gamePost('rounds/extend', { seconds: 60 }))}
              >
                +1 мин
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                loading={busy === 'close'}
                onClick={() => void run('close', () => staffApi.gamePost('rounds/close'), 'Голосование закрыто')}
              >
                Закрыть
              </Button>
            </div>
          </>
        ) : v.config.mode === 'budget' ? (
          <>
            <p className="mb-3 text-[15px] text-subtle">Когда выступят все команды - откройте общее голосование: каждый раздаёт {v.config.budget} «человек».</p>
            <Button
              variant="success"
              block
              size="lg"
              loading={busy === 'round'}
              onClick={async () => {
                if (!(await confirm('Открыть голосование?', 'На экране и в телефонах откроется общее голосование.', 'Открыть'))) return;
                void run('round', () => staffApi.gamePost('rounds', { teamId: null }), 'Голосование открыто');
              }}
            >
              Открыть общее голосование
            </Button>
          </>
        ) : (
          <p className="text-[15px] text-subtle">Голосование за команду - кнопкой «Голосовать за …» в «Выступлениях», когда команда на сцене.</p>
        )}
      </Step>

      <Step n={7} title="Итоги" done={v.resultsShown}>
        <ResultsTable teams={teams} />
        <Button
          variant={v.resultsShown ? 'secondary' : 'primary'}
          block
          className="mt-3"
          loading={busy === 'results'}
          onClick={async () => {
            if (!v.resultsShown && !(await confirm('Показать итоги?', 'На экране - пьедестал и конфетти, в телефонах - места.', 'Показать'))) return;
            void run('results', () => staffApi.gamePost('flags', { resultsShown: !v.resultsShown }));
          }}
        >
          {v.resultsShown ? 'Скрыть итоги' : 'Показать итоги на экране'}
        </Button>
      </Step>

      {v.screenUrl && (
        <Button variant="outline" block onClick={() => openExternal(v.screenUrl!)}>
          <IconDeviceTv size={18} /> Открыть большой экран
        </Button>
      )}
    </div>
  );

  async function distribute() {
    setDistributing(true);
    try {
      const res = await staffApi.gameDistribute();
      qc.setQueryData(KEY, res.view);
      haptic('success');
      toast.success(res.unassigned > 0 ? `Распределили ${res.assigned}, без места: ${res.unassigned}` : `Распределили: ${res.assigned}`);
    } catch (err) {
      haptic('error');
      toast.error(errorMessage(err));
    } finally {
      setDistributing(false);
    }
  }
}

function ResultsTable({ teams }: { teams: Team[] }) {
  const top = useMemo(() => [...teams].sort((a, b) => b.points - a.points), [teams]);
  if (top.every((t) => t.points === 0)) return <p className="text-[15px] text-subtle">Голосов пока нет.</p>;
  return (
    <div className="space-y-1">
      {top.map((t, i) => (
        <div key={t.id} className="flex items-center gap-2 text-[15px]">
          <span className="w-5 text-right font-bold text-subtle">{i + 1}</span>
          <span className="size-3 shrink-0 rounded-full" style={{ background: t.color }} />
          <span className="min-w-0 flex-1 truncate">{label(t)}</span>
          <b className="tabular-nums">{t.points}</b>
        </div>
      ))}
    </div>
  );
}

// ---------- команды ----------

function TeamsTab({ v }: { v: GameAdminView }) {
  const { busy, run } = useRun();
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [count, setCount] = useState(String(v.teams.length || 6));
  const teams = v.teams;
  const team = teams.find((t) => t.id === open) ?? null;

  const move = (i: number, dir: -1 | 1) => {
    const ids = teams.map((t) => t.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run('order', () => staffApi.gamePost('teams/order', { ids }));
  };

  return (
    <div className="pb-6">
      <section className="mb-3 rounded-2xl bg-section p-4">
        <Field label="Сколько команд">
          <div className="flex gap-2">
            <TextInput inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 2))} className="w-20" />
            <Button
              variant="secondary"
              className="flex-1"
              loading={busy === 'count'}
              disabled={!count || Number(count) === teams.length}
              onClick={async () => {
                const n = Number(count);
                if (
                  n < teams.length &&
                  !(await confirmAction({
                    title: `Оставить ${n} команд?`,
                    message: 'Последние команды удалятся, их игроки останутся без команды.',
                    ok: 'Удалить лишние',
                    destructive: true,
                  }))
                )
                  return;
                void run('count', () => staffApi.gamePost('teams/count', { count: n }));
              }}
            >
              {teams.length === 0 ? 'Создать команды' : 'Изменить'}
            </Button>
          </div>
        </Field>
        {teams.length > 0 && (
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              loading={busy === 'assign'}
              onClick={() =>
                void (async () => {
                  try {
                    const res = await staffApi.gameAssignTasks();
                    qc.setQueryData(KEY, res.view);
                    haptic('success');
                    toast.success(res.left > 0 ? `Раздали ${res.assigned}, не хватило на ${res.left}` : `Раздали заданий: ${res.assigned}`);
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                })()
              }
            >
              <IconDice5 size={18} /> Раздать задания
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              loading={busy === 'shuffle'}
              onClick={async () => {
                if (
                  !(await confirmAction({
                    title: 'Перемешать порядок?',
                    message: 'Команды выступят в случайном порядке.',
                    ok: 'Перемешать',
                  }))
                )
                  return;
                void run('shuffle', () => staffApi.gamePost('teams/order', { shuffle: true }));
              }}
            >
              Перемешать порядок
            </Button>
          </div>
        )}
      </section>

      {teams.length === 0 ? (
        <EmptyState title="Команд пока нет">Укажите, сколько команд, и нажмите «Создать команды».</EmptyState>
      ) : (
        <div className="space-y-2">
          <p className="px-1 text-[13px] text-hint">Порядок выступления - сверху вниз.</p>
          {teams.map((t, i) => {
            const task = v.tasks.find((x) => x.id === t.taskId);
            return (
              <div key={t.id} className="flex items-stretch gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(t.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl bg-section p-3 text-left active:opacity-80"
                >
                  {t.countryCode ? (
                    <Flag code={t.countryCode} height={26} />
                  ) : (
                    <span className="size-[26px] shrink-0 rounded-full" style={{ background: t.color }} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{label(t)}</span>
                    <span className="block truncate text-[13px] text-subtle">
                      {t.countryName ?? 'страна не выбрана'} · {task ? task.title : 'без задания'}
                    </span>
                    <span className="block text-[13px] text-hint">
                      {t.size} чел.
                      {t.captainName ? ` · капитан ${t.captainName}` : ''}
                    </span>
                  </span>
                </button>
                <div className="flex flex-col gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 px-2"
                    aria-label="Выше"
                    disabled={i === 0 || busy !== null}
                    onClick={() => move(i, -1)}
                  >
                    <IconArrowUp size={16} />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 px-2"
                    aria-label="Ниже"
                    disabled={i === teams.length - 1 || busy !== null}
                    onClick={() => move(i, 1)}
                  >
                    <IconArrowDown size={16} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Sheet open={team !== null} onClose={() => setOpen(null)} title={team ? label(team) : ''}>
        {team && <TeamForm key={team.id} team={team} v={v} onDone={() => setOpen(null)} />}
      </Sheet>
    </div>
  );
}

/** Команда: название, страна, задание, капитан. Черновик - одна кнопка «Сохранить». */
function TeamForm({ team, v, onDone }: { team: Team; v: GameAdminView; onDone: () => void }) {
  const { busy, run } = useRun();
  const [name, setName] = useState(team.placeholder ? '' : team.title);
  const [country, setCountry] = useState(team.countryCode ?? '');
  const [taskId, setTaskId] = useState(team.taskId ? String(team.taskId) : '');
  const task = v.tasks.find((x) => String(x.id) === taskId);
  const members = v.players.filter((p) => p.teamId === team.id && p.answer === 'yes');
  const changed =
    name.trim() !== (team.placeholder ? '' : team.title) || country !== (team.countryCode ?? '') || taskId !== (team.taskId ? String(team.taskId) : '');

  const save = async () => {
    const ok = await run(
      'save',
      () =>
        staffApi.gameTeam(team.id, {
          name: name.trim() || null,
          countryCode: country || null,
          taskId: taskId ? Number(taskId) : null,
        }),
      'Сохранено',
    );
    if (ok) onDone();
  };

  return (
    <div className="space-y-4">
      <Field label="Название церкви" hint={`Пусто - «Команда ${team.number}»`}>
        <TextInput value={name} maxLength={60} placeholder={`Команда ${team.number}`} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Задание">
        <Select
          value={taskId}
          onChange={(e) => {
            setTaskId(e.target.value);
            // У задания своя страна - ставим её сразу.
            const t = v.tasks.find((x) => String(x.id) === e.target.value);
            if (t?.countryCode) setCountry(t.countryCode);
          }}
        >
          <option value="">- без задания -</option>
          {v.tasks.map((t) => {
            const owner = t.teamId && t.teamId !== team.id ? v.teams.find((x) => x.id === t.teamId) : null;
            return (
              <option key={t.id} value={t.id}>
                {t.flag ? `${t.flag} ` : ''}
                {t.title}
                {owner ? ` (сейчас у команды ${owner.number})` : ''}
              </option>
            );
          })}
        </Select>
      </Field>
      <Field label="Страна" hint={task?.countryCode ? 'Страна задания - ставится сама' : undefined}>
        <Select value={country} disabled={!!task?.countryCode} onChange={(e) => setCountry(e.target.value)}>
          <option value="">- не выбрана -</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <div>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-sm font-medium text-subtle">Состав · {members.length}</span>
          <Button
            variant="plain"
            size="sm"
            loading={busy === 'captain'}
            disabled={members.length === 0}
            onClick={() => void run('captain', () => staffApi.gamePost(`teams/${team.id}/random-captain`), 'Капитан выбран')}
          >
            <IconDice5 size={16} /> Случайный капитан
          </Button>
        </div>
        <div className="max-h-48 overflow-y-auto rounded-xl bg-fill px-3 py-1">
          {members.length === 0 ? (
            <p className="py-2 text-[14px] text-hint">Пока никого</p>
          ) : (
            members.map((p) => (
              <div key={p.participantId} className="flex items-center justify-between border-b border-line py-2 text-[15px] last:border-b-0">
                <span className="truncate">{p.fullName}</span>
                {p.captain && <Badge tone="yellow">капитан</Badge>}
              </div>
            ))
          )}
        </div>
      </div>
      <Button block size="lg" loading={busy === 'save'} disabled={!changed} onClick={() => void save()}>
        Сохранить
      </Button>
    </div>
  );
}

// ---------- задания ----------

function TasksTab({ v }: { v: GameAdminView }) {
  const [open, setOpen] = useState<GameTaskView | 'new' | null>(null);
  return (
    <div className="pb-6">
      <Button block className="mb-3" onClick={() => setOpen('new')}>
        <IconPlus size={18} /> Добавить задание
      </Button>
      {v.tasks.length === 0 ? (
        <EmptyState title="Заданий пока нет">Добавьте задания заранее. У задания может быть страна: выбрали страну - получили это задание.</EmptyState>
      ) : (
        <div className="space-y-2">
          {v.tasks.map((t) => {
            const owner = t.teamId ? v.teams.find((x) => x.id === t.teamId) : null;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setOpen(t)}
                className="flex w-full items-start gap-3 rounded-2xl bg-section p-3 text-left active:opacity-80"
              >
                {t.countryCode ? (
                  <Flag code={t.countryCode} height={24} style={{ marginTop: 2 }} />
                ) : (
                  <span className="mt-0.5 size-6 shrink-0 rounded-full bg-fill" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold leading-snug">{t.title}</span>
                  {(t.context || t.text) && <span className="line-clamp-2 block text-[13px] text-subtle">{t.context || t.text}</span>}
                  <span className="mt-0.5 block text-[13px] text-hint">
                    {t.countryName ?? 'любая страна'} · {owner ? `у команды ${label(owner)}` : 'свободно'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open === 'new' ? 'Новое задание' : 'Задание'}>
        {open !== null && <TaskForm key={open === 'new' ? 'new' : open.id} task={open === 'new' ? null : open} onDone={() => setOpen(null)} />}
      </Sheet>
    </div>
  );
}

function TaskForm({ task, onDone }: { task: GameTaskView | null; onDone: () => void }) {
  const { busy, run } = useRun();
  const [title, setTitle] = useState(task?.title ?? '');
  const [context, setContext] = useState(task?.context ?? '');
  const [text, setText] = useState(task?.text ?? '');
  const [country, setCountry] = useState(task?.countryCode ?? '');
  const body = {
    title: title.trim(),
    context: context.trim(),
    text: text.trim(),
    countryCode: country || null,
  };

  const save = async () => {
    if (!body.title) {
      toast.error('Укажите название задания');
      return;
    }
    const ok = await run('save', () => (task ? staffApi.gameTaskUpdate(task.id, body) : staffApi.gameTaskCreate(body)), 'Сохранено');
    if (ok) onDone();
  };
  const remove = async () => {
    if (!task) return;
    if (
      !(await confirmAction({
        title: 'Удалить задание?',
        message: task.teamId ? 'Команда останется без задания.' : 'Задание удалится.',
        ok: 'Удалить',
        destructive: true,
      }))
    )
      return;
    const ok = await run('delete', () => staffApi.gameTaskDelete(task.id), 'Удалено');
    if (ok) onDone();
  };

  return (
    <div className="space-y-4">
      <Field label="Название">
        <TextInput value={title} maxLength={120} placeholder="Например: Церковь в горной деревне" onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Контекст" optional hint="Ситуация, в которой оказалась церковь. Команда видит вместе с заданием">
        <TextArea rows={5} value={context} maxLength={1500} onChange={(e) => setContext(e.target.value)} />
      </Field>
      <Field label="Задание" hint="Что команде сделать. Видно после «Показать задания» и на большом экране во время выступления. **жирный**, *курсив*">
        <TextArea rows={7} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Страна" optional hint="Со страной: команда, получившая эту страну, получит это задание">
        <Select value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">- любая -</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button block size="lg" loading={busy === 'save'} onClick={() => void save()}>
        Сохранить
      </Button>
      {task && (
        <Button variant="danger" block loading={busy === 'delete'} onClick={() => void remove()}>
          Удалить задание
        </Button>
      )}
    </div>
  );
}
