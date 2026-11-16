/**
 * Игра «Церкви». Команды презентуют церковь, открытую в другой стране, а каждый, у кого есть телефон,
 * «отправляет» в неё людей. Здесь: запись в игру, своя команда (капитан её оформляет) и голосование.
 */
import { COUNTRY_CODES, GAME_TEAM_COLORS, countryName, type GameStateView, type GameTeamView } from '@sof/shared';
import { IconCheck, IconClock, IconCrown, IconMinus, IconPlus, IconSearch, IconUser, IconUserFilled, IconUsersGroup } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { haptic } from '../../lib/feedback.ts';
import { formatTime } from '../../lib/time.ts';
import { Markdown } from '../../lib/markdown.tsx';
import { Button, cx, EmptyState, ErrorState, Notice, Spinner, TextInput } from '../../ui/kit.tsx';
import { Page } from '../../ui/Page.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { toast } from '../../ui/toast.tsx';
import { participantApi, useMeData } from '../api.ts';
import { ChurchArt, Flag, shade } from './art.tsx';
import { useAutoSave, type SaveState } from './autosave.ts';

export const GAME_KEY = ['game'] as const;

/** Насколько часы телефона отстают от сервера: таймер считаем по серверу (у кого-то часы спешат на минуту). */
let clockOffset = 0;
const withClock = (s: GameStateView) => {
  clockOffset = Date.parse(s.serverTime) - Date.now();
  return s;
};

function useGame() {
  return useQuery({
    queryKey: GAME_KEY,
    queryFn: () => participantApi.game().then(withClock),
    // Живые обновления приходят потоком; опрос - страховка, чаще - пока идёт голосование.
    refetchInterval: (q) => (q.state.data?.round ? 4000 : 20_000),
  });
}

function useCountdown(closesAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!closesAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [closesAt]);
  return closesAt ? Math.max(0, Math.ceil((Date.parse(closesAt) - (now + clockOffset)) / 1000)) : null;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function Game() {
  const q = useGame();
  const qc = useQueryClient();
  const set = (s: GameStateView) => qc.setQueryData(GAME_KEY, withClock(s));

  if (q.isPending) {
    return (
      <Page title="Игра" back="/">
        <div className="flex justify-center py-10">
          <Spinner className="text-btn" />
        </div>
      </Page>
    );
  }
  if (q.isError) {
    return (
      <Page title="Игра" back="/">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  const s = q.data;
  if (!s.visible) {
    return (
      <Page title="Игра" back="/">
        <EmptyState icon={IconUsersGroup} title="Игра пока не началась">
          Здесь появится миссионерская игра «Церкви» - следите за объявлениями.
        </EmptyState>
      </Page>
    );
  }
  const myTeamIds = [...new Set(s.people.flatMap((p) => (p.teamId ? [p.teamId] : [])))];

  return (
    <Page back="/">
      <header className="mb-5 px-1">
        <p className="text-[13px] font-semibold uppercase tracking-[0.2em] text-brand">Миссионерская игра</p>
        <h1 className="font-display text-[34px] font-bold uppercase leading-none tracking-tight">Церкви</h1>
        {/* Описание - из настроек игры (ведущий может переписать); пустое - не показываем. */}
        {s.texts.intro && <p className="mt-2 whitespace-pre-line text-[15px] leading-snug text-subtle">{s.texts.intro}</p>}
      </header>

      {s.testLaunch && (
        <Notice tone="yellow" className="mb-4">
          Тестовый запуск - игру видят только тестировщики, участники конференции её пока не видят.
        </Notice>
      )}
      {!s.resultsShown && <Status s={s} />}
      {s.resultsShown && <Results teams={s.teams} />}
      {/* Идёт голосование - оно главное; иначе сначала запись и своя команда. */}
      {!s.resultsShown && s.round && <Voting s={s} onChange={set} />}
      {s.signupOpen && s.people.length > 0 && <Signup s={s} onChange={set} />}
      {!s.resultsShown && <Waiting s={s} />}
      {myTeamIds.map((id) => (
        <MyTeam key={id} s={s} team={s.teams.find((t) => t.id === id)!} onChange={set} />
      ))}
      {!s.resultsShown && !s.round && <Voting s={s} onChange={set} />}
      <TeamsList s={s} />
    </Page>
  );
}

// ---------- запись ----------

/**
 * Кому показывать «Участвую / Не участвую»: кто ещё не ответил - пока запись открыта; кто ответил - только пока
 * команды не собраны и голосование не идёт (передумать). Потом кнопки только мешают: команда уже есть.
 */
const canAnswer = (s: GameStateView, p: GameStateView['people'][number]) => p.answer === null || (s.allowChangeAnswer && !s.distributed && !s.round);

function Signup({ s, onChange }: { s: GameStateView; onChange: (s: GameStateView) => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const rows = s.people.filter((p) => (p.eligible ? canAnswer(s, p) : !s.distributed));
  if (rows.length === 0) return null;
  const answer = async (pid: number, yes: boolean) => {
    setBusy(pid);
    try {
      const next = await participantApi.gameAnswer(pid, yes);
      onChange(next);
      haptic('success');
      const team = next.people.find((p) => p.participantId === pid)?.teamId;
      toast.success(!yes ? 'Записали: в этот раз не играешь' : team ? 'Записали в игру - команда уже есть, смотри ниже' : 'Записали в игру! Перед началом пришлём команду');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mb-5 rounded-3xl bg-section p-4">
      <p className="text-[18px] font-bold">{s.texts.signupTitle || 'Будешь играть в команде?'}</p>
      {s.texts.signupText && <p className="mt-1 whitespace-pre-line text-[14px] text-subtle">{s.texts.signupText}</p>}
      <div className="mt-3 space-y-3">
        {rows.map((p) => (
          <div key={p.participantId}>
            {s.people.length > 1 && <p className="mb-1.5 px-1 text-[15px] font-semibold">{p.fullName}</p>}
            {!p.eligible ? (
              <p className="px-1 text-[14px] text-warn-fg">
                {s.testLaunch ? 'Идёт тестовый запуск - записаться могут только люди из тест-листа.' : 'Сначала отметьтесь на входе по QR-коду - потом можно записаться.'}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {([true, false] as const).map((yes) => {
                  const active = p.answer === (yes ? 'yes' : 'no');
                  return (
                    <button
                      key={String(yes)}
                      type="button"
                      disabled={busy !== null || active || (!s.allowChangeAnswer && p.answer !== null)}
                      onClick={() => void answer(p.participantId, yes)}
                      className={cx(
                        'flex min-h-12 items-center justify-center gap-2 rounded-2xl text-[16px] font-bold transition active:scale-[0.98] disabled:opacity-100',
                        active ? (yes ? 'bg-ok text-white' : 'bg-fg/80 text-section') : 'bg-fill text-fg disabled:opacity-60',
                      )}
                    >
                      {busy === p.participantId && !active ? <Spinner className="size-4" /> : active && <IconCheck size={18} />}
                      {yes ? 'Участвую' : 'Не участвую'}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Что сейчас с записью, если кнопок «Участвую» нет: ещё не открыли - или у аккаунта нет регистрации. */
function Status({ s }: { s: GameStateView }) {
  if (s.people.length === 0) {
    return (
      <Notice className="mb-5">
        Играть в команде можно только с регистрацией на конференцию. А голосовать - всем: когда ведущий откроет голосование, оно появится прямо здесь.
      </Notice>
    );
  }
  const unanswered = s.people.some((p) => p.answer === null && p.eligible);
  if (!s.signupOpen && !s.distributed && unanswered) {
    return <Notice className="mb-5">Запись в игру ещё не открыта - когда откроем, придёт сообщение в бот с кнопками «Участвую» и «Не участвую».</Notice>;
  }
  return null;
}

/** Записан, но команды ещё нет: ждём распределения - или команды заполнены, тогда к ведущему. */
function Waiting({ s }: { s: GameStateView }) {
  const tz = useMeData().event.timezone;
  const waiting = s.people.filter((p) => p.answer === 'yes' && !p.teamId);
  if (waiting.length === 0) return null;
  const who = s.people.length > 1 ? waiting.map((p) => p.fullName).join(', ') : null;
  return (
    <Notice tone={s.distributed ? 'yellow' : 'green'} className="mb-5">
      {s.distributed
        ? `${who ? `${who} - в игре` : 'Ты в игре'}, но свободных мест в командах нет - подойдите к ведущему, он добавит в команду.`
        : `${who ? `${who} - в игре` : 'Ты в игре'}! Команду пришлём в бот перед началом${s.startsAt ? ` (начало в ${formatTime(s.startsAt, tz)})` : ''}.`}
    </Notice>
  );
}

// ---------- своя команда ----------

/** Плитка команды: церковь в её цвете. */
function TeamFlag({ team, size = 44 }: { team: Pick<GameTeamView, 'color'>; size?: number }) {
  return (
    <span className="flex shrink-0 items-end justify-center overflow-hidden rounded-2xl pb-1" style={{ width: size, height: size, background: `${team.color}2e` }}>
      <ChurchArt color={team.color} size={size * 0.62} flat />
    </span>
  );
}

/** Страна с флагом-картинкой. */
function Country({ team, className }: { team: Pick<GameTeamView, 'countryCode' | 'countryName'>; className?: string }) {
  if (!team.countryCode) return null;
  return (
    <p className={cx('flex items-center gap-1.5', className)}>
      <Flag code={team.countryCode} height={14} />
      <span className="truncate">{team.countryName}</span>
    </p>
  );
}

function MyTeam({ s, team, onChange }: { s: GameStateView; team: GameTeamView; onChange: (s: GameStateView) => void }) {
  const [open, setOpen] = useState(false);
  const me = s.people.filter((p) => p.teamId === team.id);
  const captain = me.find((p) => p.captain);
  // Аккаунт семьи: пишем, кто именно в команде и кто капитан, а не «ты».
  const family = s.people.length > 1;
  const first = (name: string) => name.split(' ')[1] ?? name;
  const task = s.teamTasks[team.id];
  return (
    <section className="mb-5 overflow-hidden rounded-3xl" style={{ background: `linear-gradient(135deg, ${team.color}, ${team.color}bb)` }}>
      <div className="p-5 text-white">
        <p className="text-[13px] font-semibold uppercase tracking-wider opacity-85">
          {family ? `${me.map((p) => first(p.fullName)).join(', ')} - в команде` : 'Твоя команда'}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <ChurchArt color={shade(team.color, 0.4)} size={58} />
          <div className="min-w-0">
            <p className="font-display text-[26px] font-bold leading-tight">{team.title}</p>
            <Country team={team} className="text-[16px] opacity-90" />
          </div>
        </div>
        <p className="mt-3 text-[15px] opacity-90">
          {team.size} в команде{team.captainName ? ` · капитан ${team.captainName}` : ''}
        </p>
        {task ? (
          <div className="mt-4 rounded-2xl bg-white p-4 text-black">
            <p className="font-display text-[21px] font-bold leading-snug">{task.title}</p>
            {task.context && (
              <>
                <p className="mt-3 text-[12px] font-bold uppercase tracking-wider text-black/55">Контекст</p>
                <Markdown source={task.context} className="mt-1 text-[17px] leading-snug" />
              </>
            )}
            {task.text && (
              <>
                <p className="mt-3 text-[12px] font-bold uppercase tracking-wider text-black/55">Задание</p>
                <Markdown source={task.text} className="mt-1 text-[17px] font-medium leading-snug" />
              </>
            )}
          </div>
        ) : (
          !s.revealed && (
            <p className="mt-4 rounded-2xl bg-black/20 px-3 py-2.5 text-[14px] opacity-95">
              {s.captainCountry ? 'Задание команды покажут на игре.' : 'Задание и страну команды покажут на игре.'}
            </p>
          )
        )}
        {captain && (
          <div className="mt-4 rounded-2xl bg-black/20 p-3">
            <p className="flex items-center gap-1.5 text-[15px] font-bold">
              <IconCrown size={18} /> {family ? `${first(captain.fullName)} - капитан` : 'Ты капитан'}
            </p>
            {s.pendingDesign ? (
              <p className="mt-1 text-[14px] opacity-90">
                «{s.pendingDesign.name}»{s.captainCountry && s.pendingDesign.countryCode ? `, ${countryName(s.pendingDesign.countryCode)}` : ''} - ждёт одобрения ведущего.
              </p>
            ) : team.placeholder ? (
              <p className="mt-1 text-[14px] opacity-90">
                {s.captainCountry ? 'Придумайте с командой название церкви и страну, где вы её открываете.' : 'Придумайте с командой название церкви.'}
              </p>
            ) : (
              <p className="mt-1 text-[14px] opacity-90">Готово! Поменять можно, пока ведущий не закрыл оформление.</p>
            )}
            {!s.designLocked && (
              <button type="button" onClick={() => setOpen(true)} className="mt-3 min-h-11 w-full rounded-xl bg-white text-[16px] font-bold text-black active:scale-[0.99]">
                {team.placeholder ? 'Оформить команду' : s.captainCountry ? 'Изменить название и страну' : 'Изменить название'}
              </button>
            )}
          </div>
        )}
      </div>
      {captain && (
        <DesignSheet
          key={`${team.title}|${team.countryCode}|${team.color}|${open}`}
          open={open}
          onClose={() => setOpen(false)}
          team={team}
          taken={s.teams.filter((t) => t.id !== team.id).map((t) => t.color.toLowerCase())}
          pickCountry={s.captainCountry}
          allowed={s.countries}
          onSaved={onChange}
        />
      )}
    </section>
  );
}

function DesignSheet({
  open,
  onClose,
  team,
  taken,
  pickCountry,
  allowed,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  team: GameTeamView;
  /** Цвета других команд: на большом экране команды не должны сливаться. */
  taken: string[];
  /** Страну выбирает капитан (иначе её даёт ведущий вместе с заданием). */
  pickCountry: boolean;
  /** Из каких стран (страны свободных заданий); null - любая. */
  allowed: string[] | null;
  onSaved: (s: GameStateView) => void;
}) {
  const [name, setName] = useState(team.placeholder ? '' : team.title);
  const [country, setCountry] = useState<string | null>(team.countryCode);
  const [color, setColor] = useState(team.color);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const countries = useMemo(
    () => (allowed ?? COUNTRY_CODES).map((code) => ({ code, name: countryName(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [allowed],
  );
  const q = search.trim().toLowerCase();
  const shown = q ? countries.filter((c) => c.name.toLowerCase().includes(q)) : countries;

  const save = async () => {
    if (!name.trim() || (pickCountry && !country)) return;
    setBusy(true);
    try {
      const next = await participantApi.gameDesign(team.id, { name: name.trim(), countryCode: pickCountry ? country : null, color });
      onSaved(next);
      haptic('success');
      toast.success(next.pendingDesign ? 'Отправили ведущему - после одобрения название появится у всех' : 'Сохранили!');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Ваша церковь">
      <p className="mb-1.5 px-1 text-[14px] font-semibold text-subtle">Название церкви</p>
      <TextInput value={name} maxLength={60} placeholder="Например, «Надежда»" onChange={(e) => setName(e.target.value)} />

      {pickCountry && (
        <>
          <p className="mb-1.5 mt-4 px-1 text-[14px] font-semibold text-subtle">
            Страна{country ? `: ${countryName(country)}` : ''}
          </p>
          {allowed && <p className="mb-2 px-1 text-[13px] text-hint">Только страны, для которых есть задание.</p>}
          <div className="relative">
            <IconSearch size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-hint" />
            <TextInput className="pl-10" value={search} placeholder="Найти страну" onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="mt-2 max-h-56 overflow-y-auto rounded-2xl bg-fill">
            {shown.map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => setCountry(c.code)}
                className={cx('flex w-full items-center gap-3 px-4 py-2.5 text-left text-[16px]', country === c.code && 'bg-btn/15 font-semibold')}
              >
                <Flag code={c.code} height={18} />
                <span className="flex-1">{c.name}</span>
                {country === c.code && <IconCheck size={18} className="text-btn" />}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="mb-1.5 mt-4 px-1 text-[14px] font-semibold text-subtle">Цвет команды · бледные заняты другими командами</p>
      <div className="flex flex-wrap gap-2">
        {GAME_TEAM_COLORS.map((c) => {
          const busy = taken.includes(c.toLowerCase()) && color !== c;
          return (
            <button
              key={c}
              type="button"
              aria-label={busy ? `${c} - у другой команды` : c}
              disabled={busy}
              onClick={() => setColor(c)}
              className={cx('size-9 rounded-full transition disabled:opacity-20', color === c && 'ring-4 ring-fg/60 ring-offset-2 ring-offset-section')}
              style={{ background: c }}
            />
          );
        })}
      </div>

      <Button block size="lg" className="mt-5" loading={busy} disabled={!name.trim() || (pickCountry && !country)} onClick={() => void save()}>
        Сохранить
      </Button>
    </Sheet>
  );
}

// ---------- голосование ----------

function Voting({ s, onChange }: { s: GameStateView; onChange: (s: GameStateView) => void }) {
  const round = s.round;
  const left = useCountdown(round?.closesAt ?? null);
  if (!round) {
    return (
      <section className="mb-5 rounded-3xl bg-section p-5 text-center">
        <div className="flex items-end justify-center gap-0.5">
          <ChurchArt color="#4b5da5" size={34} />
          <ChurchArt color="#d0352c" size={46} />
          <ChurchArt color="#2ea86b" size={34} />
        </div>
        <p className="mt-3 text-[18px] font-bold">
          {s.mode === 'per_team' ? 'Голосование откроется после выступления команды' : 'Голосование откроется, когда выступят все команды'}
        </p>
        {s.texts.waitHint && <p className="mt-1 whitespace-pre-line text-[14px] text-subtle">{s.texts.waitHint}</p>}
      </section>
    );
  }
  // Новый раунд - новый компонент: выбор прошлого раунда не переезжает в следующий.
  return round.teamId !== null ? (
    <PerTeamVote key={round.id} s={s} team={s.teams.find((t) => t.id === round.teamId)!} left={left} onChange={onChange} />
  ) : (
    <BudgetVote key={round.id} s={s} left={left} onChange={onChange} />
  );
}

function Timer({ left }: { left: number | null }) {
  if (left === null) return null;
  return (
    <span className={cx('rounded-full px-3 py-1 text-[15px] font-bold tabular-nums', left <= 15 ? 'bg-bad text-white' : 'bg-black/25 text-white')}>
      <IconClock size={15} className="-mt-0.5 mr-1 inline" />
      {mmss(left)}
    </span>
  );
}

/** Что с голосом сейчас: подпись под кнопками. Голос сохраняется сам - кнопки «Отправить» нет. */
function SaveNote({ state, closed, done, light = false }: { state: SaveState; closed: boolean; done: string | null; light?: boolean }) {
  const tone = light ? 'opacity-90' : 'text-subtle';
  if (closed) return <p className={cx('text-center text-[14px] font-semibold', tone)}>{done ? `Голосование закрыто · засчитано: ${done}` : 'Голосование закрыто'}</p>;
  if (state === 'saving' || state === 'pending')
    return (
      <p className={cx('flex items-center justify-center gap-2 text-center text-[14px]', tone)}>
        <Spinner className="size-4" /> Сохраняем…
      </p>
    );
  if (state === 'error') return <p className={cx('text-center text-[14px] font-semibold', light ? 'text-white' : 'text-bad-fg')}>Не сохранилось - нажмите ещё раз</p>;
  return (
    <p className={cx('flex items-center justify-center gap-1.5 text-center text-[14px]', tone)}>
      {done ? (
        <>
          <IconCheck size={16} /> Засчитано: {done} · можно поменять, пока идёт таймер
        </>
      ) : (
        'Голос засчитывается сразу, как нажмёте'
      )}
    </p>
  );
}

const word = (n: number) => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'человека' : 'человек');

/** «После каждой команды»: крупная карточка команды и N человечков; нажал - голос ушёл. */
function PerTeamVote({ s, team, left, onChange }: { s: GameStateView; team: GameTeamView; left: number | null; onChange: (s: GameStateView) => void }) {
  const round = s.round!;
  const sent = round.myVotes[team.id] ?? 0;
  const [pick, setPick] = useState(sent);
  const own = s.ownTeamIds.includes(team.id);
  const closed = left === 0;
  const state = useAutoSave({
    value: pick,
    saved: sent,
    equal: (a, b) => a === b,
    delay: 350,
    maxWait: 1200,
    enabled: !own && !closed,
    send: async (n) => onChange(await participantApi.gameVote({ roundId: round.id, votes: n ? [{ teamId: team.id, points: n }] : [] })),
    onError: (err) => {
      haptic('error');
      toast.error(errorMessage(err));
    },
  });

  return (
    <section className="mb-5 overflow-hidden rounded-3xl text-white" style={{ background: `linear-gradient(160deg, ${team.color}, ${team.color}aa)` }}>
      <div className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold uppercase tracking-wider opacity-85">Сейчас голосуем</p>
          <Timer left={left} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <ChurchArt color={shade(team.color, 0.4)} size={62} />
          <div className="min-w-0">
            <p className="font-display text-[26px] font-bold leading-tight">{team.title}</p>
            <Country team={team} className="text-[16px] opacity-90" />
          </div>
        </div>

        {own ? (
          <p className="mt-5 rounded-2xl bg-black/20 p-4 text-[16px] font-semibold">Это твоя команда - за неё голосуют другие. Держим кулачки!</p>
        ) : (
          <>
            <p className="mt-5 text-[16px] font-semibold">Сколько человек отправишь в их церковь?</p>
            <div
              className="mt-3 grid gap-1"
              // До 7 - в один ряд; больше - по 5 в ряд, иначе фигурки не влезут в узкий экран.
              style={{ gridTemplateColumns: `repeat(${s.pointsPerTeam <= 7 ? s.pointsPerTeam : 5}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: s.pointsPerTeam }, (_, i) => i + 1).map((n) => {
                const on = n <= pick;
                return (
                  <button
                    key={n}
                    type="button"
                    disabled={closed}
                    aria-label={`${n}`}
                    onClick={() => {
                      haptic('selection');
                      setPick(n);
                    }}
                    className={cx('flex flex-col items-center rounded-2xl py-2 transition active:scale-90', on ? 'bg-white text-black' : 'bg-black/20 text-white/80')}
                  >
                    {on ? <IconUserFilled size={s.pointsPerTeam <= 5 ? 34 : 28} /> : <IconUser size={s.pointsPerTeam <= 5 ? 34 : 28} />}
                    <span className="text-[13px] font-bold">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 min-h-6">
              <SaveNote state={state} closed={closed} done={sent ? `${sent} ${word(sent)}` : null} light />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** Голоса без нулей, по порядку - чтобы {1: 0} и {} считались одинаковыми. */
const votesOf = (a: Record<number, number>) =>
  Object.entries(a)
    .filter(([, n]) => n > 0)
    .map(([teamId, points]) => ({ teamId: Number(teamId), points }))
    .sort((x, y) => x.teamId - y.teamId);
const sameAlloc = (a: Record<number, number>, b: Record<number, number>) => JSON.stringify(votesOf(a)) === JSON.stringify(votesOf(b));

/** «Общий запас»: «+» и «−» по командам (кроме своей), каждое нажатие сохраняется само - пузыри на экране растут сразу. */
function BudgetVote({ s, left, onChange }: { s: GameStateView; left: number | null; onChange: (s: GameStateView) => void }) {
  const round = s.round!;
  const [alloc, setAlloc] = useState<Record<number, number>>(() => ({ ...round.myVotes }));
  const used = Object.values(alloc).reduce((a, b) => a + b, 0);
  const rest = s.budget - used;
  const closed = left === 0;
  const state = useAutoSave({
    value: alloc,
    saved: round.myVotes,
    equal: sameAlloc,
    delay: 550,
    maxWait: 1400,
    enabled: !closed,
    send: async (a) => onChange(await participantApi.gameVote({ roundId: round.id, votes: votesOf(a) })),
    onError: (err) => {
      haptic('error');
      toast.error(errorMessage(err));
    },
  });
  const confirmed = Object.values(round.myVotes).reduce((a, b) => a + b, 0);

  const bump = (id: number, d: 1 | -1) => {
    const cur = alloc[id] ?? 0;
    if ((d > 0 && rest <= 0) || (d < 0 && cur <= 0)) return;
    haptic('selection');
    setAlloc({ ...alloc, [id]: cur + d });
  };

  return (
    <section className="mb-5 rounded-3xl bg-section p-4">
      <div className="flex items-center justify-between">
        <p className="text-[18px] font-bold">Раздайте людей</p>
        {left !== null && (
          <span className={cx('rounded-full px-3 py-1 text-[15px] font-bold tabular-nums', left <= 15 ? 'bg-bad text-white' : 'bg-fill')}>
            <IconClock size={15} className="-mt-0.5 mr-1 inline" />
            {mmss(left)}
          </span>
        )}
      </div>
      <p className="mt-1 text-[14px] text-subtle">Каждое нажатие засчитывается сразу - пузыри на большом экране растут на глазах.</p>
      <div className="mt-3 space-y-2">
        {s.teams.map((t) => {
          const own = s.ownTeamIds.includes(t.id);
          const n = alloc[t.id] ?? 0;
          return (
            <div key={t.id} className={cx('flex items-center gap-3 rounded-2xl bg-fill p-2.5', own && 'opacity-50')}>
              <TeamFlag team={t} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold leading-tight">{t.title}</p>
                {own ? <p className="truncate text-[13px] text-subtle">твоя команда</p> : <Country team={t} className="text-[13px] text-subtle" />}
              </div>
              {!own && (
                <div className="flex items-center gap-1.5">
                  <button type="button" aria-label="Меньше" disabled={closed || n === 0} onClick={() => bump(t.id, -1)} className="flex size-10 items-center justify-center rounded-full bg-section active:scale-90 disabled:opacity-40">
                    <IconMinus size={18} />
                  </button>
                  <span className="w-7 text-center text-[18px] font-bold tabular-nums">{n}</span>
                  <button type="button" aria-label="Больше" disabled={closed || rest === 0} onClick={() => bump(t.id, 1)} className="flex size-10 items-center justify-center rounded-full bg-btn text-btn-fg active:scale-90 disabled:opacity-40">
                    <IconPlus size={18} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Команд много - остаток и статус всегда под пальцем, а не в конце длинного списка. */}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+12px)] z-10 -mx-1 mt-3 rounded-2xl bg-section/95 p-3 shadow-lg backdrop-blur">
        <p className={cx('mb-1 text-center text-[16px] font-bold', rest === 0 ? 'text-ok-fg' : '')}>
          {rest === 0 ? `Розданы все ${s.budget}` : `Осталось раздать: ${rest} из ${s.budget}`}
        </p>
        <SaveNote state={state} closed={closed} done={confirmed ? `${confirmed} из ${s.budget}` : null} />
      </div>
    </section>
  );
}

// ---------- команды и итоги ----------

function TeamsList({ s }: { s: GameStateView }) {
  if (s.teams.length === 0) return null;
  const withPoints = s.teams.some((t) => t.points !== null);
  const list = withPoints ? [...s.teams].sort((a, b) => (b.points ?? 0) - (a.points ?? 0)) : s.teams;
  return (
    <section className="mb-4">
      <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider text-subtle">{withPoints ? 'Сейчас лидируют' : 'Команды'}</p>
      <div className="overflow-hidden rounded-2xl bg-section">
        {list.map((t) => (
          <div key={t.id} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
            <TeamFlag team={t} size={38} />
            <div className="min-w-0 flex-1">
              <p className={cx('truncate font-semibold leading-tight', t.placeholder && 'text-subtle')}>{t.title}</p>
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-subtle">
                <Country team={t} />
                {t.countryCode && t.size > 0 && <span>·</span>}
                {t.size > 0 && <span className="shrink-0">{t.size} в команде</span>}
              </div>
            </div>
            {t.points !== null && <span className="text-[18px] font-bold tabular-nums">{t.points}</span>}
          </div>
        ))}
      </div>
      {!withPoints && <Notice className="mt-3">Результаты покажут на большом экране в зале.</Notice>}
    </section>
  );
}

function Results({ teams }: { teams: GameTeamView[] }) {
  const top = [...teams].filter((t) => (t.points ?? 0) > 0).sort((a, b) => (b.points ?? 0) - (a.points ?? 0)).slice(0, 3);
  // Золото, серебро, бронза - цифрами, как на большом экране.
  const places = ['#e6b33d', '#b8b2a2', '#c98a5c'];
  return (
    <section className="mb-5 rounded-3xl bg-section p-5">
      <p className="text-center font-display text-[20px] font-bold uppercase">Итоги игры</p>
      <div className="mt-4 space-y-3">
        {top.map((t, i) => (
          <div key={t.id} className="flex items-center gap-3 rounded-2xl p-3" style={{ background: `${t.color}26` }}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full font-display text-[17px] font-bold text-[#241b26]" style={{ background: places[i] }}>
              {i + 1}
            </span>
            <ChurchArt color={t.color} size={38} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[18px] font-bold leading-tight">{t.title}</p>
              <Country team={t} className="text-[13px] text-subtle" />
            </div>
            <span className="text-[22px] font-bold tabular-nums">{t.points}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
