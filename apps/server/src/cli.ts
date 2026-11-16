/**
 * Служебные команды на сервере:
 *   tsx src/cli.ts invite <role> [hours]   - ссылка-приглашение в команду (первый суперадмин)
 *   tsx src/cli.ts seed                    - стартовые точки входа, инфо-страницы и пример программы
 *   tsx src/cli.ts grant <@username|tgId> <role>  - выдать роль тому, кто уже писал боту
 *   tsx src/cli.ts restore-xlsx <участники.xlsx> [переводы.xlsx] [--dry]  - восстановить участников после сбоя (в пустую базу)
 *   tsx src/cli.ts reset-registrations --yes      - стереть регистрации, QR-коды, отметки, чеки, рассылки,
 *                                                   журнал и роли (кроме указанных через --keep-staff=@user)
 */
import { ROLES, type Role } from '@sof/shared';
import { eq, sql } from 'drizzle-orm';
import { loadConfig } from './config.ts';
import { createDb, schema } from './db/client.ts';
import { runMigrationsLocked } from './db/migrate.ts';
import { createBoss, enqueue, ensureQueues } from './jobs/queues.ts';
import { importRestore } from './services/restore-import.service.ts';
import { createInviteLink } from './services/staff.service.ts';

const config = loadConfig();
await runMigrationsLocked(config.DATABASE_URL);
const { db, pool } = createDb(config.DATABASE_URL, 2);
const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === 'invite') {
    const role = (args[0] ?? 'superadmin') as Role;
    if (!ROLES.includes(role)) throw new Error(`Unknown role ${role}. Use one of: ${ROLES.join(', ')}`);
    const hours = Number(args[1] ?? 24);
    const invite = await createInviteLink({ db, config }, role, hours, null);
    console.log(`Приглашение (${role}), действует до ${invite.expiresAt}:\n${invite.link}`);
  } else if (cmd === 'seed') {
    const [cp] = await db.execute<{ n: number }>(sql`select count(*)::int as n from checkpoints`).then((r) => r.rows);
    if (!cp?.n) {
      await db.insert(schema.checkpoints).values([
        { kind: 'entrance', name: 'Вход' },
        { kind: 'training', name: 'Тренировка волонтёров', countsInStats: false },
      ]);
      console.log('+ точки отметки: Вход, Тренировка');
    }
    await db
      .insert(schema.infoPages)
      .values([
        { slug: 'about', title: 'О конференции', sort: 1, bodyMd: '**Шаг веры 2026** - три дня вместе: общение, семинары, музыка и отдых.\n\nСкоро здесь появятся подробности 🙂' },
        { slug: 'what-to-bring', title: 'Что взять с собой', sort: 2, bodyMd: '- Хорошее настроение 🙂\n- Удобную одежду и обувь\n- Зарядку и пауэрбанк\n- Бутылку для воды' },
        { slug: 'contacts', title: 'Как добраться и контакты', sort: 3, bodyMd: 'Адрес и контакты организаторов скоро появятся здесь.' },
      ])
      .onConflictDoNothing();
    console.log('+ инфо-страницы (если их не было)');
    const [act] = await db.execute<{ n: number }>(sql`select count(*)::int as n from activities`).then((r) => r.rows);
    if (!act?.n) {
      const day = (d: number, h: number, m = 0) => {
        const x = new Date();
        x.setUTCDate(x.getUTCDate() + d);
        x.setUTCHours(h - 3, m, 0, 0); // время указано по Москве (UTC+3)
        return x;
      };
      await db.insert(schema.activities).values([
        { title: 'Открытие', kind: 'main', location: 'Главный зал', startsAt: day(1, 10), endsAt: day(1, 11, 30) },
        { title: 'Семинар: вера и семья', kind: 'seminar', location: 'Зал B', host: 'Спикер', startsAt: day(1, 12), endsAt: day(1, 13), registrationMode: 'required', capacity: 30 },
        { title: 'Мастер-класс для детей', kind: 'workshop', location: 'Детская комната', startsAt: day(1, 15), endsAt: day(1, 16), registrationMode: 'required', capacity: 15, maxAge: 12 },
        { title: 'Вечерняя игра', kind: 'game', location: 'Поляна', startsAt: day(1, 19), endsAt: day(1, 21) },
      ]);
      console.log('+ пример программы (4 активности)');
    }
  } else if (cmd === 'restore-xlsx') {
    const files = args.filter((a) => !a.startsWith('--'));
    if (!files[0]) throw new Error('Usage: restore-xlsx <participants.xlsx> [bank.xlsx] [--dry]');
    const report = await importRestore(db, files[0], files[1] ?? null, { dryRun: args.includes('--dry') });
    console.log(JSON.stringify({ ...report, notes: undefined }, null, 2));
    for (const n of report.notes) console.log(`- ${n}`);
    console.log(args.includes('--dry') ? 'Проверка без записи - в базу ничего не записано.' : 'Готово.');
  } else if (cmd === 'merch-import') {
    // Завести вещь из файлов (как редактор в админке): merch-import <manifest.json> --as=@username.
    // В манифесте: title, subtitle, descriptionMd, color {name, hex}, photos [пути], spin (путь к .spin). Вещь - скрытой.
    const file = args.find((a) => !a.startsWith('--'));
    const who = args.find((a) => a.startsWith('--as='))?.slice(5).replace(/^@/, '');
    if (!file || !who) throw new Error('Usage: merch-import <manifest.json> --as=@username');
    const { readFile } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    const { permissionsFor } = await import('@sof/shared');
    const { savePhoto, saveSpin, storedMedia } = await import('./services/media.service.ts');
    const { saveProduct } = await import('./services/merch.service.ts');
    const { getRoles } = await import('./services/users.service.ts');
    const m = JSON.parse(await readFile(file, 'utf8')) as {
      title: string;
      subtitle: string | null;
      descriptionMd: string;
      color: { name: string; hex: string };
      photos: string[];
      spin: string | null;
    };
    const at = (p: string) => resolve(dirname(file), p);
    const user = await db.query.users.findFirst({ where: sql`lower(${schema.users.username}) = ${who.toLowerCase()} and ${schema.users.tgId} is not null` });
    if (!user) throw new Error(`@${who} не найден среди зашедших в бота`);
    const roles = await getRoles(db, user.id);
    if (!permissionsFor(roles).includes('merch:stock')) throw new Error(`У @${who} нет права на мерч`);
    const media: { id: null; file: string; color: null }[] = [];
    for (const p of m.photos) media.push({ id: null, file: (await savePhoto(config.MEDIA_DIR, 'merch', await readFile(at(p)), 'image/png')).file, color: null });
    if (m.spin) media.push({ id: null, file: (await saveSpin(config.MEDIA_DIR, 'merch', await readFile(at(m.spin)))).file, color: null });
    const uploads = new Map(await Promise.all(media.map(async (x) => [x.file, await storedMedia(config.MEDIA_DIR, x.file)] as const)));
    const boss = createBoss(config.DATABASE_URL, { worker: false });
    await boss.start();
    const { product } = await saveProduct(
      { db, boss },
      {
        id: null,
        title: m.title,
        subtitle: m.subtitle,
        descriptionMd: m.descriptionMd,
        price: 0,
        badge: null,
        sort: 0,
        published: false,
        colors: [{ id: null, key: 'c1', name: m.color.name, hex: m.color.hex, sizes: [] }],
        media,
      },
      uploads,
      { user, name: who, roles, permissions: permissionsFor(roles), sessionId: 0 },
    );
    await boss.stop({ graceful: true, timeout: 5000 });
    console.log(`Вещь «${product.title}» (id ${product.id}) заведена скрытой: фото ${product.media.filter((x) => x.kind === 'photo').length}, 360°: ${product.media.some((x) => x.kind === 'spin') ? 'есть' : 'нет'}`);
  } else if (cmd === 'restore-selftest') {
    // Заход по нику и по номеру на восстановленной базе - внутри транзакции, которую потом откатываем.
    const boss = createBoss(config.DATABASE_URL, { worker: false });
    await boss.start();
    await ensureQueues(boss);
    const { adoptRestoredByPhone, adoptRestoredByUsername } = await import('./services/restore.service.ts');
    const { upsertTelegramUser } = await import('./services/users.service.ts');
    const { findClaimable } = await import('./services/claim.service.ts');
    const ROLLBACK = new Error('rollback');
    await db
      .transaction(async (tx) => {
        const ctx = { db: tx, boss };
        const [byNick] = (
          await tx.execute<{ id: number; username: string; n: number }>(sql`
            select u.id::int as id, u.username, count(p.id)::int as n from users u join participants p on p.owner_user_id = u.id and p.status = 'active'
             where u.restored_at is not null and u.username is not null group by u.id order by count(p.id) desc, u.id limit 1`)
        ).rows;
        const n1 = await adoptRestoredByUsername(ctx, { id: 990000001, username: byNick!.username.toUpperCase(), first_name: 'Тест' });
        const u1 = await upsertTelegramUser(tx, { id: 990000001, username: byNick!.username, first_name: 'Тест' });
        console.log(`по нику @${byNick!.username}: в выгрузке ${byNick!.n}, перешло ${n1}, тот же аккаунт: ${u1.id === byNick!.id}, код оплаты сохранён: ${!!u1.paymentRef}`);
        const [byPhone] = (
          await tx.execute<{ id: number; ref: string; phone: string; n: number }>(sql`
            select u.id::int as id, u.payment_ref as ref, min(p.phone) as phone, count(p.id)::int as n from users u join participants p on p.owner_user_id = u.id and p.status = 'active'
             where u.restored_at is not null and u.username is null and p.phone is not null group by u.id order by u.id limit 1`)
        ).rows;
        if (byPhone) {
          const fresh = await upsertTelegramUser(tx, { id: 990000002, first_name: 'Тест2' });
          const withPhone = { ...fresh, phone: byPhone.phone };
          await tx.update(schema.users).set({ phone: byPhone.phone }).where(eq(schema.users.id, fresh.id));
          const moved = await adoptRestoredByPhone(ctx, withPhone);
          const after = await tx.query.users.findFirst({ where: eq(schema.users.id, fresh.id) });
          const left = await findClaimable(tx, withPhone);
          console.log(`по номеру (аккаунт без ника): в выгрузке ${byPhone.n}, перешло ${moved.length}, код оплаты перешёл: ${after?.paymentRef === byPhone.ref}, осталось для «Это я»: ${left.candidates.length}`);
          const again = await adoptRestoredByPhone(ctx, withPhone);
          console.log(`повторно по номеру: ${again.length} (должно быть 0)`);
        }
        const [nickOwner] = (
          await tx.execute<{ phone: string; owner: number }>(sql`
            select p.phone, p.owner_user_id::int as owner from participants p join users u on u.id = p.owner_user_id
             where u.restored_at is not null and u.username is not null and p.status = 'active' and p.phone is not null order by p.id desc limit 1`)
        ).rows;
        const third = await upsertTelegramUser(tx, { id: 990000003, first_name: 'Тест3' });
        const thirdWithPhone = { ...third, phone: nickOwner!.phone };
        const moved3 = await adoptRestoredByPhone(ctx, thirdWithPhone);
        const cands = await findClaimable(tx, thirdWithPhone);
        console.log(`номер из аккаунта с ником: перешло ${moved3.length} (только если в семье один номер), можно забрать свою регистрацию: ${cands.candidates.length}`);
        // Аккаунт с этим Telegram id появился раньше, чем его узнали: семья из выгрузки и роль должны перейти на него.
        const [late] = (
          await tx.execute<{ id: number; username: string; n: number }>(sql`
            select u.id::int as id, u.username, count(p.id)::int as n from users u join participants p on p.owner_user_id = u.id and p.status = 'active'
             where u.restored_at is not null and u.tg_id is null and u.username is not null group by u.id order by count(p.id) desc, u.id offset 1 limit 1`)
        ).rows;
        await tx.insert(schema.staffRoles).values({ userId: late!.id, role: 'scanner' });
        const live = await upsertTelegramUser(tx, { id: 990000004, username: late!.username, first_name: 'Тест4' });
        const n4 = await adoptRestoredByUsername(ctx, { id: 990000004, username: late!.username, first_name: 'Тест4' });
        const roles4 = await tx.select().from(schema.staffRoles).where(eq(schema.staffRoles.userId, live.id));
        const ghost4 = await tx.query.users.findFirst({ where: eq(schema.users.id, late!.id) });
        console.log(`аккаунт появился раньше: в выгрузке ${late!.n}, перешло ${n4}, роль перешла: ${roles4.length === 1}, выгрузка больше не ждёт: ${ghost4?.restoredAt === null}`);
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
        console.log('Самопроверка закончена, изменения откатаны.');
      });
    await boss.stop({ graceful: true, timeout: 5000 });
  } else if (cmd === 'grant') {
    const who = (args[0] ?? '').replace(/^@/, '');
    const role = args[1] as Role;
    if (!who || !ROLES.includes(role)) throw new Error(`Usage: grant <@username|tgId> <${ROLES.join('|')}>`);
    const user = /^\d+$/.test(who)
      ? await db.query.users.findFirst({ where: eq(schema.users.tgId, Number(who)) })
      : // Ник может быть и у живого аккаунта, и у восстановленного из выгрузки: берём живой, потом заходивший последним.
        await db.query.users.findFirst({
          where: sql`lower(${schema.users.username}) = ${who.toLowerCase()}`,
          orderBy: sql`(${schema.users.tgId} is null), ${schema.users.lastSeenAt} desc nulls last, ${schema.users.id}`,
        });
    if (!user) throw new Error(`Пользователь ${who} не найден - пусть сначала откроет бота и нажмёт /start`);
    if (!user.tgId) console.log(`Внимание: @${who} ещё не заходил в бота на этом сервере - роль заработает, когда он нажмёт /start (бот узнает его по нику).`);
    await db.insert(schema.staffRoles).values({ userId: user.id, role }).onConflictDoNothing();
    const boss = createBoss(config.DATABASE_URL, { worker: false });
    await boss.start();
    await ensureQueues(boss);
    await enqueue(boss, 'user.commands', { userId: user.id });
    await boss.stop({ graceful: true, timeout: 5000 });
    console.log(`Роль ${role} выдана: @${user.username ?? user.tgId} (id ${user.id})`);
  } else if (cmd === 'reset-registrations') {
    if (!args.includes('--yes')) throw new Error('Это удалит все регистрации. Повторите с --yes');
    const keep = args
      .filter((a) => a.startsWith('--keep-staff='))
      .flatMap((a) => a.slice('--keep-staff='.length).split(','))
      .map((u) => u.replace(/^@/, '').toLowerCase())
      .filter(Boolean);
    await db.transaction(async (tx) => {
      for (const table of [
        'broadcast_deliveries', 'broadcasts', 'activity_interest', 'activity_registrations', 'scan_log', 'check_ins',
        'ticket_messages', 'payment_receipts', 'consents', 'registration_requests', 'tickets', 'participants', 'one_time_tokens',
        'staff_sessions', 'audit_log',
      ]) {
        await tx.execute(sql.raw(`delete from ${table}`));
      }
      await tx.execute(
        keep.length
          ? sql`delete from staff_roles where user_id not in (select id from users where lower(username) in ${sql.raw(`(${keep.map((k) => `'${k.replace(/'/g, "''")}'`).join(',')})`)})`
          : sql`delete from staff_roles`,
      );
      await tx.execute(sql`update users set awaiting_receipt_until = null, last_tickets_sent_at = null`);
    });
    console.log(`Регистрации и связанные данные удалены. Роли оставлены: ${keep.length ? keep.map((k) => '@' + k).join(', ') : 'никому'}`);
  } else {
    console.log('Команды: invite <role> [hours] | seed | grant <@user> <role> | reset-registrations --yes [--keep-staff=@user]');
  }
} finally {
  await pool.end();
}
