/**
 * Дорога до Telegram. С нашего сервера (Петербург) часть адресов api.telegram.org временами недоступна:
 * соединение даже не устанавливается, запрос висит и обрывается - бот «молчит». Поэтому адрес выбираем сами:
 * по умолчанию - тот, что отвечает стабильно; не соединились несколько раз подряд - берём следующий;
 * через 15 минут пробуем вернуться к основному. Имя сервера в TLS остаётся api.telegram.org - сертификат
 * проверяется как обычно.
 */
import dns from 'node:dns/promises';
import https from 'node:https';
import tls from 'node:tls';

const HOST = 'api.telegram.org';
/** Первый - основной (стабильно отвечает из России); остальные - запасные. Добавляем и то, что вернёт DNS. */
const DEFAULT_IPS = ['149.154.167.220', '149.154.166.110', '149.154.167.99', '149.154.167.51', '149.154.175.50', '91.108.56.130'];
/** Сколько неудачных соединений подряд - и переключаемся. */
const FAILS_TO_SWITCH = 3;
const CONNECT_TIMEOUT_MS = 5_000;
const BACK_TO_PRIMARY_MS = 15 * 60_000;

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

class Route {
  ips: string[] = [...DEFAULT_IPS];
  private i = 0;
  private fails = 0;
  private switchedAt = 0;
  log: Log | null = null;

  current(): string {
    if (this.i !== 0 && Date.now() - this.switchedAt > BACK_TO_PRIMARY_MS) {
      this.i = 0;
      this.fails = 0;
      this.log?.info({ ip: this.ips[0] }, 'telegram: пробуем снова основной адрес');
    }
    return this.ips[this.i]!;
  }

  ok(ip: string) {
    if (ip === this.ips[this.i]) this.fails = 0;
  }

  failed(ip: string, reason: string) {
    // Неудача старого адреса, когда мы уже переключились, - не повод переключаться ещё раз.
    if (ip !== this.ips[this.i]) return;
    this.fails += 1;
    if (this.fails < FAILS_TO_SWITCH) return;
    this.i = (this.i + 1) % this.ips.length;
    this.fails = 0;
    this.switchedAt = Date.now();
    this.log?.warn({ from: ip, to: this.ips[this.i], reason }, 'telegram: адрес не отвечает - переключаемся');
  }
}

const route = new Route();

class TelegramAgent extends https.Agent {
  override createConnection(options: tls.ConnectionOptions): tls.TLSSocket {
    const ip = route.current();
    const socket = tls.connect({ ...options, host: ip, servername: HOST });
    // Итог соединения учитываем один раз: таймаут и следующая за ним ошибка сокета - одна неудача.
    let settled = false;
    const settle = (ok: boolean, reason = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) route.ok(ip);
      else route.failed(ip, reason);
    };
    const timer = setTimeout(() => {
      settle(false, 'timeout');
      socket.destroy(new Error(`Telegram ${ip}: нет соединения за ${CONNECT_TIMEOUT_MS / 1000} с`));
    }, CONNECT_TIMEOUT_MS);
    socket.once('secureConnect', () => settle(true));
    socket.once('error', (err) => settle(false, err.message));
    socket.once('close', () => clearTimeout(timer));
    return socket;
  }
}

/** Общий для всех запросов к Telegram: соединения переиспользуются. */
export const telegramAgent = new TelegramAgent({ keepAlive: true });

/** Для grammY: `new Bot(token, { client: telegramClient() })`. */
export function telegramClient() {
  return { baseFetchConfig: { agent: telegramAgent, compress: true } };
}

/** Список адресов: первый - основной. Для проверки переключения и ручной замены. */
export function setTelegramIps(ips: string[]): void {
  if (ips.length) route.ips = [...ips];
}

/** Включить: логирование переключений и адреса из DNS в запас. Вызывается в точках входа. */
export function initTelegramNet(log: Log): void {
  route.log = log;
  dns.resolve4(HOST).then(
    (found) => {
      for (const ip of found) if (!route.ips.includes(ip)) route.ips.push(ip);
    },
    () => undefined,
  );
}

/** Скачать файл Telegram (`https://api.telegram.org/file/bot…`) той же дорогой. */
export function telegramDownload(url: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: telegramAgent, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`telegram file ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('telegram file timeout')));
    req.on('error', reject);
  });
}
