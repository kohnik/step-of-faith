/**
 * Игра «Церкви»: команды презентуют церковь, открытую в другой стране, а все, у кого есть телефон,
 * «отправляют» в неё людей - от 1 до N за выступление (или раздают общий запас в конце).
 */
import { z } from 'zod';

export const GAME_MODES = ['per_team', 'budget'] as const;
export type GameMode = (typeof GAME_MODES)[number];
export const GAME_AUDIENCES = ['arrived_today', 'registered'] as const;
/**
 * Запуск игры: `off` - никто не видит; `test` - тестовый запуск: только админы, ведущие и тест-лист,
 * записываются только тестировщики и без отметки на входе; `live` - настоящий запуск для всех.
 */
export const GAME_LAUNCHES = ['off', 'test', 'live'] as const;
export type GameLaunch = (typeof GAME_LAUNCHES)[number];

export const gameLaunchSchema = z.object({
  mode: z.enum(GAME_LAUNCHES),
  /** Стереть ответы, распределение, названия команд и голоса (тестовые данные не попадут в настоящую игру). */
  wipe: z.boolean().default(false),
  /** Сразу открыть запись и разослать приглашения «Будешь участвовать?». */
  invite: z.boolean().default(true),
  /** Со стиранием: оставить подготовку ведущего - названия команд, страны, задания (пульт: из теста в настоящую игру). */
  keepSetup: z.boolean().default(false),
});
export type GameAudience = (typeof GAME_AUDIENCES)[number];

const isoDateTime = z.iso.datetime({ offset: true });
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #RRGGBB');
const text = (max: number) => z.string().max(max);

export const gameConfigSchema = z.object({
  /** Игра видна в мини-апке (вкладка «Игра»). */
  enabled: z.boolean(),
  /** Тестовый режим: видят только админы, ведущие и тест-лист - прогнать игру заранее. */
  adminsOnly: z.boolean(),
  /** Тест-лист: аккаунты бота (users.id), которым игра видна в тестовом режиме и приходят приглашения. */
  testerIds: z.array(z.number().int().positive()).max(200),
  /** per_team - после каждой команды от 1 до pointsPerTeam; budget - общий запас на все команды в конце. */
  mode: z.enum(GAME_MODES),
  pointsPerTeam: z.number().int().min(1).max(20),
  budget: z.number().int().min(1).max(500),
  /** Длительность раунда голосования, секунд; null - пока ведущий не закроет. */
  roundSeconds: z.number().int().min(10).max(3600).nullable(),
  forbidOwnTeam: z.boolean(),
  /** Голосующие видят текущие очки (иначе - только на большом экране). */
  showResults: z.boolean(),
  /** Кому приглашение «Будешь участвовать?»: отмеченным сегодня на входе или всем зарегистрированным. */
  audience: z.enum(GAME_AUDIENCES),
  allowChangeAnswer: z.boolean(),
  balanceGender: z.boolean(),
  maxTeamSize: z.number().int().min(1).max(500).nullable(),
  /** Капитан, которого ведущий не выбрал заранее, - случайный игрок команды. */
  randomCaptain: z.boolean(),
  /** Название от капитана сначала одобряет ведущий. */
  reviewNames: z.boolean(),
  /** Сообщение в бот игрокам, когда открывается голосование. */
  notifyRounds: z.boolean(),
  signupOpensAt: isoDateTime.nullable(),
  signupClosesAt: isoDateTime.nullable(),
  /** Авто-распределение по командам (обычно за 15 минут до начала). */
  distributeAt: isoDateTime.nullable(),
  startsAt: isoDateTime.nullable(),
  /** До какого времени капитаны оформляют команду. */
  designUntil: isoDateTime.nullable(),
  inviteText: text(1000),
  assignedText: text(1000),
  captainText: text(1000),
  /** Сообщение в бот, когда открылось голосование за команду; {team} - команда. */
  roundText: text(500),
  /** Сообщение в бот, когда открылось общее голосование (общий запас). */
  budgetRoundText: text(500),
  /** Описание игры вверху вкладки «Игра»: для «после каждой команды» и для «общего запаса» ({budget} - запас). */
  introPerTeam: text(500),
  introBudget: text(500),
  /** Блок записи в мини-апке. */
  signupTitle: text(120),
  signupText: text(300),
  /** Пока голосования нет - подсказка под «Голосование откроется…». */
  waitHint: text(300),
  /** Подсказка на большом экране под названием команды. */
  screenHint: text(200),
  /** Кто даёт команде страну: ведущий (вместе с заданием) или капитан (из стран свободных заданий, если они есть). */
  countryBy: z.enum(['host', 'captain']),
  /** «Показать задания» - каждой команде её задание в бот. */
  notifyTasks: z.boolean(),
});
export type GameConfig = z.infer<typeof gameConfigSchema>;

export const DEFAULT_GAME_CONFIG: GameConfig = {
  // По умолчанию - тестовая игра: видят только админы, ведущие и тест-лист.
  enabled: true,
  adminsOnly: true,
  testerIds: [],
  // Голосуем один раз - в конце, общим запасом.
  mode: 'budget',
  pointsPerTeam: 5,
  budget: 10,
  roundSeconds: 120,
  forbidOwnTeam: true,
  showResults: false,
  audience: 'arrived_today',
  allowChangeAnswer: true,
  balanceGender: true,
  maxTeamSize: null,
  randomCaptain: true,
  reviewNames: false,
  notifyRounds: false,
  signupOpensAt: null,
  signupClosesAt: null,
  distributeAt: null,
  startsAt: null,
  designUntil: null,
  inviteText:
    '🌍 <b>Миссионерская игра «Церкви»</b>\n\nПосле обеда - большая игра: команды откроют свою церковь в другой стране, а все остальные будут «отправлять» в неё людей.\n\nБудешь играть в команде?',
  assignedText:
    '🎉 <b>Ты в игре!</b>\n\nТвоя команда - {team}. В зале найди свой флажок и садись к команде. Подробности - во вкладке «Игра».',
  captainText:
    '⭐️ <b>Ты капитан команды {team}</b>\n\nПридумай с командой название церкви и выбери страну - во вкладке «Игра» → «Моя команда».',
  roundText: '🗳 <b>Голосуем за команду {team}</b>\nСколько человек отправите в их церковь?',
  budgetRoundText: '🗳 <b>Голосование открыто</b>\nРаздайте людей между командами.',
  introPerTeam:
    'Команды открывают церковь в другой стране. После каждого выступления «отправь» в их церковь людей - столько, насколько понравилось.',
  introBudget: 'Команды открывают церковь в другой стране. Когда выступят все, раздай {budget} «человек» между церквями - как понравилось.',
  signupTitle: 'Будешь играть в команде?',
  signupText: 'Не играешь - можно прийти болеть и голосовать: это могут все.',
  waitHint: 'Держите телефон под рукой - экран переключится сам.',
  screenHint: 'Голосуйте в боте конференции: вкладка «Игра»',
  countryBy: 'host',
  notifyTasks: true,
};

/** Палитра команд-заглушек: «Команда 1…N» отличаются цветом с первого взгляда. */
export const GAME_TEAM_COLORS = [
  '#d0352c', '#2f6fde', '#2ea86b', '#e8a317', '#8e44ad', '#16a2b8', '#e4572e',
  '#5b6ee1', '#c2185b', '#6d8f1d', '#a0522d', '#00897b', '#7b5ea7', '#3c8dbc',
  '#d35400', '#558b2f', '#ad1457', '#0277bd', '#6a1b9a', '#827717',
] as const;

/** Страна - двухбуквенный код ISO; флаг - из кода. Названия на русском дают Intl.DisplayNames. */
export const COUNTRY_CODES = (
  'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI ' +
  'NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ ' +
  'TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW'
).split(' ');

export function flagEmoji(code: string | null | undefined): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    regionNames ??= new Intl.DisplayNames(['ru'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Как показываем команду: название церкви, иначе «Команда N». */
export const teamTitle = (t: { name: string | null; number: number }) => t.name?.trim() || `Команда ${t.number}`;

const teamName = z.string().trim().min(1, 'Укажите название').max(60);
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Выберите страну');

/** Ведущий правит команду. */
export const gameTeamUpdateSchema = z
  .object({
    name: teamName.nullable(),
    countryCode: countryCode.nullable(),
    flag: z.string().trim().max(16).nullable(),
    color: hexColor,
    captainId: z.number().int().positive().nullable(),
    /** Задание; у задания со страной страна ставится команде сама. */
    taskId: z.number().int().positive().nullable(),
  })
  .partial();
export type GameTeamUpdate = z.infer<typeof gameTeamUpdateSchema>;

/** Задание команде (ведущие пишут заранее). */
export const gameTaskInputSchema = z.object({
  title: z.string().trim().min(1, 'Укажите название задания').max(120),
  /** Контекст: ситуация, в которой оказалась церковь. */
  // Вместе с заданием - в одном сообщении бота (до 4096 знаков).
  context: z.string().trim().max(1500).default(''),
  text: z.string().trim().max(2000),
  /** Страна задания: выбрали эту страну - получили это задание. */
  countryCode: countryCode.nullable(),
});
export type GameTaskInput = z.infer<typeof gameTaskInputSchema>;

export const gameStageSchema = z.object({ teamId: z.number().int().positive().nullable() });
export const gameRevealSchema = z.object({ revealed: z.boolean(), notify: z.boolean().default(true) });

/** Капитан оформляет свою команду. Страну - только если её выбирает капитан (настройка «Страну даёт»). */
export const gameTeamDesignSchema = z.object({
  name: teamName,
  countryCode: countryCode.nullish(),
  color: hexColor.nullish(),
});
export type GameTeamDesign = z.infer<typeof gameTeamDesignSchema>;

export const gameAnswerSchema = z.object({ participantId: z.number().int().positive(), yes: z.boolean() });

export const gameVoteSchema = z.object({
  roundId: z.number().int().positive(),
  votes: z
    .array(z.object({ teamId: z.number().int().positive(), points: z.number().int().min(0).max(500) }))
    // Пустой список - убрать свой голос в этом раунде.
    .max(100),
});
export type GameVoteRequest = z.infer<typeof gameVoteSchema>;

export const gameRoundOpenSchema = z.object({
  /** null - общий раунд на все команды (режим «общий запас»). */
  teamId: z.number().int().positive().nullable(),
  seconds: z.number().int().min(10).max(3600).nullable().optional(),
});

export const gameMoveSchema = z.object({ participantId: z.number().int().positive(), teamId: z.number().int().positive().nullable() });

// ---------- ответы API ----------

export interface GameTeamView {
  id: number;
  number: number;
  title: string;
  /** Название ещё не придумали - показываем «Команда N». */
  placeholder: boolean;
  countryCode: string | null;
  countryName: string | null;
  flag: string | null;
  color: string;
  captainName: string | null;
  size: number;
  /** Очки - когда их показывают (настройка или итоги). */
  points: number | null;
}

export interface GameTaskView {
  id: number;
  title: string;
  context: string;
  text: string;
  countryCode: string | null;
  countryName: string | null;
  flag: string | null;
  /** У какой команды это задание. */
  teamId: number | null;
}

/** Задание своей команды - игроку после «Показать задания» и на большом экране во время выступления. */
export interface GameTaskText {
  title: string;
  /** Контекст: ситуация, в которой оказалась церковь. */
  context: string;
  /** Само задание. */
  text: string;
}

export interface GameRoundView {
  id: number;
  /** null - общий раунд (общий запас). */
  teamId: number | null;
  status: 'open' | 'closed';
  closesAt: string | null;
  voters: number;
}

export interface GamePersonView {
  participantId: number;
  fullName: string;
  answer: 'yes' | 'no' | null;
  teamId: number | null;
  captain: boolean;
  /** Приглашение ему положено (отмечен сегодня или зарегистрирован - по настройке). */
  eligible: boolean;
}

export interface GameStateView {
  visible: boolean;
  /** Тестовый запуск: записаться могут только люди из тест-листа. */
  testLaunch: boolean;
  mode: GameMode;
  pointsPerTeam: number;
  budget: number;
  forbidOwnTeam: boolean;
  signupOpen: boolean;
  allowChangeAnswer: boolean;
  distributed: boolean;
  designLocked: boolean;
  resultsShown: boolean;
  startsAt: string | null;
  teams: GameTeamView[];
  people: GamePersonView[];
  /** Команды, за которые этому аккаунту нельзя голосовать (свои). */
  ownTeamIds: number[];
  round: (GameRoundView & { myVotes: Record<number, number> }) | null;
  /** Своя команда капитана: предложенное название ждёт одобрения ведущего. */
  pendingDesign: GameTeamDesign | null;
  /** «Показать задания» нажали: команда видит своё задание, страну и флаг. */
  revealed: boolean;
  /** Задания своих команд по id команды (после «Показать задания»; у семьи команды бывают разные). */
  teamTasks: Record<number, GameTaskText>;
  /** Страну выбирает капитан; `countries` - из каких (страны свободных заданий), null - любая. */
  captainCountry: boolean;
  countries: string[] | null;
  /** Тексты вкладки «Игра» из настроек (описание - уже под режим, с подставленным запасом). */
  texts: { intro: string; signupTitle: string; signupText: string; waitHint: string };
  /** Часы сервера - таймер на телефоне считаем по ним, а не по часам телефона. */
  serverTime: string;
}

/** Аккаунт бота - для тест-листа. */
export interface GameBotUser {
  userId: number;
  name: string;
  username: string | null;
  /** Сколько у аккаунта участников (зарегистрированных). */
  participants: number;
  /** Сколько из них уже записаны в игру («участвую»). */
  inGame: number;
}

export interface GameCandidate {
  participantId: number;
  fullName: string;
  gender: 'm' | 'f';
  answer: 'yes' | 'no' | null;
  teamId: number | null;
}

export interface GameTeamAdmin extends GameTeamView {
  sort: number;
  taskId: number | null;
  captainId: number | null;
  males: number;
  females: number;
  proposal: GameTeamDesign | null;
  voters: number;
  points: number;
}

export interface GamePlayerRow {
  participantId: number;
  fullName: string;
  gender: 'm' | 'f';
  answer: 'yes' | 'no';
  teamId: number | null;
  captain: boolean;
  answeredAt: string;
}

export interface GameAdminView {
  launch: GameLaunch;
  config: GameConfig;
  signupOpen: boolean;
  distributedAt: string | null;
  designLocked: boolean;
  resultsShown: boolean;
  screenToken: string;
  /** Готовая ссылка на большой экран (для пульта в телефоне). */
  screenUrl: string | null;
  startedAt: string | null;
  tasksRevealedAt: string | null;
  /** Кто сейчас на сцене (его флаг и задание на большом экране). */
  stageTeamId: number | null;
  teams: GameTeamAdmin[];
  tasks: GameTaskView[];
  players: GamePlayerRow[];
  rounds: (GameRoundView & { openedAt: string; closedAt: string | null; points: number })[];
  /** Сколько человек получат приглашение (по настройке «кому»). */
  audience: number;
  /** Тест-лист с именами - для настроек. */
  testers: GameBotUser[];
}

export interface GameScreenView {
  /** lobby - игра не начата; started - «Начать игру» (флаги ещё скрыты); revealed - задания и флаги открыты. */
  phase: 'lobby' | 'started' | 'revealed';
  /** Выступает команда: её флаг, страна и задание на весь экран. */
  stage: { team: GameTeamView; task: GameTaskText | null } | null;
  mode: GameMode;
  eventName: string;
  teams: (GameTeamView & { points: number; voters: number })[];
  round: (GameRoundView & { team: GameTeamView | null }) | null;
  resultsShown: boolean;
  totalVoters: number;
  serverTime: string;
  /** Подсказка под названием команды в полосе голосования. */
  hint: string;
}
