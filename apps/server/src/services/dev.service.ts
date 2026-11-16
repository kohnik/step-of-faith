import { sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { conflict } from '../lib/errors.ts';
import { DELETABLE_HOURS, wipeChat } from '../lib/message-tracking.ts';

/**
 * Подстраховка: кнопка - для тестовых данных. Когда в базе уже настоящие регистрации,
 * одно нажатие не должно их стереть (перед конференцией DEV_WIPE_TG_IDS всё равно убираем).
 */
export const WIPE_MAX_PARTICIPANTS = 20;

export const RESET_MESSAGE =
  '👋 Мы обновили бота конференции «Шаг веры 2026» и очистили тестовые регистрации.\n\n' +
  'Зарегистрируйтесь, пожалуйста, заново: нажмите /start.\nСтарые QR-коды больше не действуют.';

const DATA_TABLES = [
  'broadcast_deliveries',
  'broadcasts',
  'activity_interest',
  'activity_registrations',
  'counseling_bookings',
  'scan_log',
  'check_ins',
  'ticket_messages',
  'payment_receipts',
  'consents',
  'registration_requests',
  'tickets',
  'participants',
  'one_time_tokens',
  'questions',
  'once_keys',
];

/**
 * Только на время разработки: стереть регистрации, отметки и все аккаунты, кроме того, кто чистит,
 * и главных администраторов (SUPERADMIN_TG_IDS) - их аккаунты и роли остаются. Расписание,
 * инфо-страницы и настройки не трогаем. Возвращает чаты, где нужно удалить переписку и прислать
 * сообщение о новой регистрации.
 */
export async function wipeDatabase(
  ctx: Pick<AppContext, 'db' | 'config'>,
  keepUserId: number,
): Promise<{ participants: number; accounts: number; chats: { tgId: number; messageIds: number[] }[] }> {
  return ctx.db.transaction(async (tx) => {
    const keepTg = ctx.config.SUPERADMIN_TG_IDS;
    const kept = await tx.execute<{ id: string }>(
      sql`select id from users where id = ${keepUserId} or tg_id in ${sql.raw(`(${[0, ...keepTg].map(Number).join(',')})`)}`,
    );
    const keep = kept.rows.map((r) => Number(r.id));
    const keepList = sql.raw(`(${keep.join(',')})`);
    const recipients = await tx.execute<{ tg_id: string }>(sql`select tg_id from users where tg_id is not null and not bot_blocked`);
    // Что Telegram ещё даст удалить: сообщения моложе 48 часов (с запасом на время очистки).
    const recent = await tx.execute<{ chat_id: string; ids: string[] }>(sql`
      select chat_id, array_agg(message_id order by message_id desc)::text[] as ids
        from chat_messages
       where at > now() - make_interval(hours => ${DELETABLE_HOURS})
       group by chat_id`);
    const idsByChat = new Map(recent.rows.map((r) => [Number(r.chat_id), r.ids.map(Number)]));
    const counts = await tx.execute<{ participants: number; accounts: number }>(sql`
      select (select count(*) from participants)::int as participants,
             (select count(*) from users where id not in ${keepList})::int as accounts`);
    const total = counts.rows[0]!.participants;
    if (total > WIPE_MAX_PARTICIPANTS) {
      throw conflict(
        'too_many_to_wipe',
        `В базе уже ${total} участников - похоже, это настоящие регистрации. Очистка отключена.`,
      );
    }
    for (const table of DATA_TABLES) await tx.execute(sql.raw(`delete from ${table}`));
    await tx.execute(sql`delete from staff_sessions where user_id not in ${keepList}`);
    await tx.execute(sql`delete from staff_roles where user_id not in ${keepList}`);
    await tx.execute(sql`delete from admin_credentials where user_id not in ${keepList}`);
    await tx.execute(sql`update activities set created_by = null where created_by not in ${keepList}`);
    await tx.execute(sql`update info_pages set updated_by = null where updated_by not in ${keepList}`);
    await tx.execute(sql`update announcements set created_by = null where created_by not in ${keepList}`);
    await tx.execute(sql`update settings set updated_by = null where updated_by not in ${keepList}`);
    // Журнал действий не стираем (кто что делал - важно и после очистки), только отвязываем удалённые аккаунты.
    await tx.execute(sql`update audit_log set actor_user_id = null where actor_user_id not in ${keepList}`);
    // Остальные необязательные ссылки на удаляемые аккаунты (кто выдал роль, кто создал служителя и т. п.)
    // обнуляем все сразу по каталогу - новая колонка со ссылкой на users не сломает очистку.
    const refs = await tx.execute<{ table_name: string; column_name: string }>(sql`
      select kcu.table_name, kcu.column_name
        from information_schema.referential_constraints rc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = rc.constraint_name and kcu.constraint_schema = rc.constraint_schema
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = rc.unique_constraint_name and ccu.constraint_schema = rc.unique_constraint_schema
        join information_schema.columns c
          on c.table_schema = kcu.table_schema and c.table_name = kcu.table_name and c.column_name = kcu.column_name
       where ccu.table_name = 'users' and kcu.table_schema = 'public' and c.is_nullable = 'YES'`);
    for (const r of refs.rows) {
      await tx.execute(
        sql.raw(`update "${r.table_name}" set "${r.column_name}" = null where "${r.column_name}" not in (${keep.join(',')})`),
      );
    }
    await tx.execute(sql`delete from users where id not in ${keepList}`);
    await tx.execute(sql`
      update users set awaiting_receipt_until = null, awaiting_question_until = null, last_tickets_sent_at = null
       where id in ${keepList}`);
    // Эти сообщения сейчас удалим - помнить их номера незачем.
    await tx.execute(sql`delete from chat_messages`);
    // Задачи в очереди ссылаются на удалённых людей - выбрасываем.
    await tx.execute(sql`delete from pgboss.job where state in ('created', 'retry')`);
    const c = counts.rows[0]!;
    return {
      participants: c.participants,
      accounts: c.accounts,
      chats: recipients.rows.map((r) => ({ tgId: Number(r.tg_id), messageIds: idsByChat.get(Number(r.tg_id)) ?? [] })),
    };
  });
}

/**
 * В фоне: в каждом чате удаляем переписку с ботом (сколько разрешит Telegram - за последние 48 часов)
 * и присылаем сообщение о новой регистрации.
 */
export function wipeChatsAndNotify(
  ctx: Pick<AppContext, 'tg' | 'log'>,
  chats: { tgId: number; messageIds: number[] }[],
  text: string,
): void {
  void (async () => {
    let sent = 0;
    let deleted = 0;
    for (const chat of chats) {
      try {
        if (chat.messageIds.length) deleted += await wipeChat(ctx.tg, chat.tgId, chat.messageIds);
        await ctx.tg.sendMessage(chat.tgId, text);
        sent++;
      } catch (err) {
        ctx.log.warn({ err, tgId: chat.tgId }, 'chat wipe / reset message failed');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    ctx.log.info({ sent, deleted, total: chats.length }, 'chats wiped, reset message sent');
  })();
}
