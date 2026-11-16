import pg from 'pg';
import type { Logger } from 'pino';

/** Виды подсказок «что устарело» (их шлют триггеры из миграции 0010_realtime). */
export type RealtimeKind = 'me' | 'questions' | 'schedule' | 'seminars' | 'counseling' | 'settings' | 'info' | 'merch' | 'game' | 'resync';

export interface RealtimeConnection {
  userId: number;
  send(kind: RealtimeKind): void;
  close(): void;
}

const CHANNEL = 'sof_events';
/** Сколько потоков держим на одного человека (несколько устройств или вкладок). */
const MAX_PER_USER = 5;

/**
 * Живые обновления: одно отдельное соединение с базой слушает канал sof_events (туда пишут триггеры -
 * и из API, и из бота) и пересылает подсказки открытым приложениям. Личные (оплата, ответ на вопрос) -
 * только адресатам, общие (расписание, семинары) - всем, но не чаще раза в `throttleMs` на вид:
 * иначе каждая запись на семинар вызывала бы перезапрос у сотен открытых приложений.
 * Если база недоступна, API продолжает работать: приложения обновляются опросом, слушатель переподключается.
 */
export class RealtimeHub {
  private readonly byUser = new Map<number, Set<RealtimeConnection>>();
  private client: pg.Client | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 1000;
  private readonly lastSent = new Map<RealtimeKind, number>();
  private readonly trailing = new Map<RealtimeKind, NodeJS.Timeout>();

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly throttleMs = 2000,
    /** Вызывается на каждую подсказку до рассылки (например, сбросить кэш настроек этого процесса). */
    private readonly onKind: (kind: RealtimeKind) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      this.log.warn({ err }, 'realtime: listener failed to start, retrying');
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const t of this.trailing.values()) clearTimeout(t);
    this.trailing.clear();
    for (const set of this.byUser.values()) for (const c of set) c.close();
    this.byUser.clear();
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }

  /** Подключить поток; возвращает функцию отключения. */
  add(conn: RealtimeConnection): () => void {
    let set = this.byUser.get(conn.userId);
    if (!set) {
      set = new Set();
      this.byUser.set(conn.userId, set);
    }
    // Старые потоки того же человека (забытые вкладки) закрываем первыми.
    while (set.size >= MAX_PER_USER) {
      const oldest = set.values().next().value!;
      set.delete(oldest);
      oldest.close();
    }
    set.add(conn);
    return () => {
      const s = this.byUser.get(conn.userId);
      if (!s) return;
      s.delete(conn);
      if (s.size === 0) this.byUser.delete(conn.userId);
    };
  }

  /** Есть ли место для ещё одного потока (общий потолок защищает память API и прокси). */
  hasRoom(max: number): boolean {
    return this.connections < max;
  }

  get connections(): number {
    let n = 0;
    for (const s of this.byUser.values()) n += s.size;
    return n;
  }

  get listening(): boolean {
    return this.client !== null;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.url, application_name: 'sof-realtime' });
    client.on('notification', (m) => {
      if (m.channel === CHANNEL && m.payload) this.onPayload(m.payload);
    });
    const lost = (err?: unknown) => {
      if (this.client !== client) return;
      this.client = null;
      if (err) this.log.warn({ err }, 'realtime: listener connection lost');
      client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    const wasDown = this.retryDelay > 1000;
    this.client = client;
    this.retryDelay = 1000;
    // Пока слушателя не было, подсказки терялись - пусть все приложения перезапросят данные.
    if (wasDown) this.toAll('resync');
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch((err: unknown) => {
        this.log.warn({ err }, 'realtime: reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Подсказка из базы: {"k": вид, "u": [кому]}. */
  onPayload(payload: string): void {
    let msg: { k?: string; u?: number[] };
    try {
      msg = JSON.parse(payload) as typeof msg;
    } catch {
      return;
    }
    const kind = msg.k as RealtimeKind | undefined;
    if (!kind) return;
    this.onKind(kind);
    if (Array.isArray(msg.u)) {
      for (const id of msg.u) for (const c of this.byUser.get(Number(id)) ?? []) c.send(kind);
      return;
    }
    this.throttled(kind);
  }

  private throttled(kind: RealtimeKind): void {
    if (this.trailing.has(kind)) return;
    const wait = (this.lastSent.get(kind) ?? 0) + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.lastSent.set(kind, Date.now());
      this.toAll(kind);
      return;
    }
    // Недавно уже слали - одна отложенная подсказка вместо пачки.
    this.trailing.set(
      kind,
      setTimeout(() => {
        this.trailing.delete(kind);
        this.lastSent.set(kind, Date.now());
        this.toAll(kind);
      }, wait),
    );
  }

  private toAll(kind: RealtimeKind): void {
    for (const set of this.byUser.values()) for (const c of set) c.send(kind);
  }
}
