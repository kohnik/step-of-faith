import { GrammyError } from 'grammy';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { schema } from '../db/client.ts';
import { markBotBlocked, type UserRow } from '../services/users.service.ts';
import { BOT_KINDS } from '@sof/shared';
import { jobScope } from './scope.ts';

export type SendOutcome = 'sent' | 'blocked' | 'unreachable' | 'no_telegram';

/**
 * Отправка пользователю с разбором типовых ошибок Telegram: 403 - бот заблокирован,
 * 400 chat not found - человек ни разу не открывал бота. Остальное (сеть, 5xx) бросаем
 * дальше - pg-boss повторит задачу. 429 обрабатывает auto-retry.
 */
export async function sendToUser<T>(
  ctx: Pick<AppContext, 'db' | 'log'>,
  user: UserRow | undefined | null,
  fn: (chatId: number) => Promise<T>,
  {
    /** Пробовать даже при отметке «заблокировал бота»: она бывает устаревшей (QR-коды важнее лишнего запроса). */
    ignoreBlocked = false,
    /** Для журнала сообщений: вид (по умолчанию - имя задачи), запуск и к чему относится. */
    log,
  }: { ignoreBlocked?: boolean; log?: SendLog } = {},
): Promise<{ outcome: SendOutcome; result?: T }> {
  if (!user?.tgId) return noted(ctx, user, log, { outcome: 'no_telegram' });
  if (user.botBlocked && !ignoreBlocked) return noted(ctx, user, log, { outcome: 'blocked' });
  try {
    const result = await fn(user.tgId);
    if (user.botBlocked) await ctx.db.update(schema.users).set({ botBlocked: false }).where(eq(schema.users.id, user.id));
    return noted(ctx, user, log, { outcome: 'sent', result });
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.error_code === 403) {
        await markBotBlocked(ctx.db, user.id);
        return noted(ctx, user, log, { outcome: 'blocked' });
      }
      if (err.error_code === 400 && /chat not found|user not found|PEER_ID_INVALID/i.test(err.description)) {
        await ctx.db.update(schema.users).set({ allowsWrite: false }).where(eq(schema.users.id, user.id));
        return noted(ctx, user, log, { outcome: 'unreachable' });
      }
    }
    // Сбой сети или Telegram: задачу повторят - в журнале будет и сбой, и потом «дошло».
    await noted(ctx, user, log, { outcome: 'failed' as SendOutcome }, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export interface SendLog {
  kind?: string;
  /** Запуск массовой отправки; не задан - у массовых видов это сама задача, у остальных пусто. */
  campaign?: string | null;
  ref?: string | null;
}

/** Текст сообщения для журнала: Telegram возвращает его без разметки. */
function previewOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { text?: unknown; caption?: unknown };
  const text = typeof r.text === 'string' ? r.text : typeof r.caption === 'string' ? r.caption : null;
  return text ? text.slice(0, 300) : null;
}

/** Записать отправку в журнал сообщений бота. Журнал не должен мешать отправке: ошибка записи - только в лог. */
async function noted<R extends { outcome: SendOutcome; result?: unknown }>(
  ctx: Pick<AppContext, 'db' | 'log'>,
  user: UserRow | undefined | null,
  log: SendLog | undefined,
  res: R,
  error?: string,
): Promise<R> {
  const scope = jobScope.getStore();
  const kind = log?.kind ?? scope?.name ?? 'other';
  const campaign = log?.campaign !== undefined ? log.campaign : scope?.jobId && BOT_KINDS[kind]?.mass ? `job:${scope.jobId}` : null;
  try {
    await ctx.db.insert(schema.botMessages).values({
      userId: user?.id ?? null,
      kind,
      campaign,
      ref: log?.ref ?? null,
      outcome: res.outcome,
      error: error?.slice(0, 300) ?? null,
      preview: previewOf(res.result),
    });
  } catch (err) {
    ctx.log.warn({ err, kind }, 'bot message log failed');
  }
  return res;
}
