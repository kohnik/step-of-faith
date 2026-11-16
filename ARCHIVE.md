# Консервация «Шага веры 2026»

Конференция прошла 6-7 ноября 2026. **16 ноября 2026 проект законсервирован:**

- код в этом репозитории совпадает с продом один в один (сверено `rsync -c` с сервером в тот же день);
- финальный бэкап базы и всех файлов снят, проверен восстановлением и хранится у владельца (Кирилл, @kohnikk);
- сервер на момент консервации **продолжает работать как есть**, ничего не выключено и не удалено.

Персональных данных и секретов в репозитории нет: база, чеки и `.env` лежат только в архиве у владельца.

## 1. Итоги в цифрах (на 16.11.2026)

| Что | Сколько |
|---|---|
| Регистрация | со 2 октября по 7 ноября 2026 |
| Зарегистрировано людей | 1 108: активных 1 066 (из них 11 детей), отменено 42 |
| Пришли на конференцию (отсканирован билет) | 771 |
| Аккаунтов Telegram в боте | 1 179 |
| Оплата взноса | оплатили 863, частично 1, не оплатили 171, освобождены 31 |
| Оплат взноса | 868 |
| Пожертвований | 22 |
| Мерч | заказов 71: оплачено и выдано 38, отменено 22, не выкуплено 11 |
| Чеков переводов | 333 (принято 323, отклонено 8, черновиков 2) |
| Записей на активности | 2 697 |
| Отзывов | 132 |
| Команда (сотрудники с ролями) | 35 человек |

Репозиторий публичный, поэтому денежных сумм здесь нет: они в копии этого файла внутри архива и в `таблицы/payments.csv`.

## 2. Где что лежит

| Что | Где |
|---|---|
| Код, миграции, Docker, Caddy, документация | этот репозиторий |
| Финальный архив данных | у владельца: Mac, `~/Documents/stepoffaith-backups/final-2026-11-16/` (копия отправлена владельцу в чат) |
| Боевой `.env` (токен бота, пароли, соль кодов билетов) | только `final-2026-11-16/secrets/prod.env` на Mac владельца и `/opt/stepoffaith/.env` на сервере. В git не класть |
| Прод-сервер | DigitalOcean, дроплет `stepoffaith-prod`, `64.226.105.90`, Франкфурт, ~$24/мес. Справка: [infra/digitalocean-server.md](infra/digitalocean-server.md) |
| Автобэкапы на сервере | том `stepoffaith_backups`: дамп базы каждый час, хранятся последние 672. Раз в сутки в 22:00 (Минск) зашифрованная копия базы и чеков уходит в Telegram и на почту, пароль - `BACKUP_MAIL_PASSWORD` в `prod.env`. Beget S3 не подключён |
| Домен `stepoffaith.online` | регистратор hoster.by. Мини-апп - `app.stepoffaith.online`, админка - `panel.stepoffaith.online` (старый адрес `admin.` перекидывает туда), корень - заглушка. Все A-записи на `64.226.105.90` |
| Бот | `@step_of_faith_2026_bot`, токен в @BotFather у владельца |
| Сервер для других ботов (не «Шаг веры») | [infra/bots-server.md](infra/bots-server.md) |

### Состав финального архива

| Файл / папка | Что внутри | Для чего |
|---|---|---|
| `db/sof-final-2026-11-16.dump` | вся база PostgreSQL 17 (`pg_dump -Fc`), включая очередь задач и журнал миграций | восстановление: `pg_restore` |
| `db/sof-final-2026-11-16.sql.gz` | та же база обычным SQL | на случай, если нужен текст или другая версия PostgreSQL |
| `files/private.tar.gz` | закрытые файлы: чеки переводов (`receipts/`), чеки за мерч (`merch-receipts/`), аватарки, картинки из чата поддержки | восстановление тома `stepoffaith_private` |
| `files/media.tar.gz` | фото и 360° мерча, картинки рассылок | восстановление тома `stepoffaith_media` |
| `чеки/` | те же чеки с понятными именами: `дата Фамилия Имя - сумма - чек N`, по папкам взносы / пожертвования / мерч, и `список чеков.csv` | посмотреть глазами, без сервера |
| `таблицы/` | каждая таблица базы в CSV (открывается в Excel), кроме служебных ключей и сессий | посмотреть глазами, без сервера |
| `secrets/prod.env` | боевые настройки и секреты | восстановление. **Хранить отдельно, никому не пересылать** |
| `SHA256SUMS.txt` | контрольные суммы | проверить, что архив не повреждён: `shasum -a 256 -c SHA256SUMS.txt` |

Проверка при консервации: дамп восстановлен в чистый PostgreSQL 17, число строк во всех 66 таблицах совпало с продом
(кроме служебной очереди задач `pgboss.job_common`, она меняется на ходу). Оба архива файлов полные: 520 и 48 файлов, как на сервере.
`чеки/` - 339 файлов, все привязаны к записям в базе.

> На Mac системный `tar` при просмотре прячет часть файлов (служебные `._*` от macOS). Архив цельный:
> распаковывайте на Linux-сервере командами ниже или смотрите готовую папку `чеки/`.

## 3. Как поднять всё заново

Понадобится: сервер Ubuntu 24.04 с Docker (2 ГБ RAM хватает), архив `final-2026-11-16` и доступ к DNS домена.

> **Один токен - один бот.** Если старый сервер ещё работает, сначала остановите на нём бота
> (`docker compose --env-file .env -f infra/docker-compose.yml stop bot`), иначе Telegram отдаст ошибку 409 обоим.

**Порядок важен:** сначала база и файлы, потом API и бот. API при старте применяет миграции: если его запустить на пустой базе,
он создаст пустые таблицы, и `pg_restore` в них не ляжет. Поэтому `infra/deploy.sh` для восстановления не подходит.

1. Код и настройки (на Mac, из корня репозитория):

   ```bash
   HOST=root@<IP нового сервера>
   ARCH=~/Documents/stepoffaith-backups/final-2026-11-16
   ssh $HOST 'mkdir -p /opt/stepoffaith/restore'
   rsync -az --exclude node_modules --exclude dist --exclude .git --exclude .env --exclude '.env.*' \
     --exclude coverage --exclude infra/data --exclude '*.tsbuildinfo' ./ $HOST:/opt/stepoffaith/
   scp $ARCH/secrets/prod.env $HOST:/opt/stepoffaith/.env
   scp $ARCH/db/sof-final-2026-11-16.dump $ARCH/files/*.tar.gz $HOST:/opt/stepoffaith/restore/
   ssh $HOST 'chmod 600 /opt/stepoffaith/.env'
   ```

   Если домены другие, поправьте в `.env` `APP_DOMAIN`, `ADMIN_DOMAIN`, `ADMIN_ALIAS`, `ROOT_DOMAIN`, `APP_URL`, `ADMIN_URL`
   (список всех переменных - [.env.production.example](.env.production.example)). `CODE_HASH_SALT` и `POSTGRES_PASSWORD` не меняйте.

2. На сервере - образы, база, файлы:

   ```bash
   cd /opt/stepoffaith
   dc() { docker compose --env-file .env -f infra/docker-compose.yml "$@"; }
   dc build
   dc up -d postgres
   until dc exec -T postgres psql -U sof -d sof -c 'select 1' >/dev/null 2>&1; do sleep 2; done
   dc exec -T postgres pg_restore -U sof -d sof --no-owner --exit-on-error < restore/sof-final-2026-11-16.dump
   dc create                       # создаёт остальные контейнеры и тома, не запуская их
   for v in private media; do
     docker run --rm -v stepoffaith_$v:/v -v $PWD/restore:/b:ro alpine \
       sh -c "tar -xzf /b/$v.tar.gz -C /v && chown -R 1000:1000 /v"
   done
   dc up -d
   dc ps
   ```

3. DNS: у регистратора hoster.by поставить A-записи `stepoffaith.online`, `app.`, `panel.`, `admin.` на новый IP.
   Caddy сам получит HTTPS-сертификаты, когда записи обновятся.

4. Проверка: `curl https://app.stepoffaith.online/api/health` отвечает 200, бот отвечает на `/start`, `https://panel.stepoffaith.online` открывается.
   После проверки удалить `/opt/stepoffaith/restore`.

### 3.1. Снять свежий бэкап с работающего сервера

Только чтение, на сервере ничего не меняется. С Mac:

```bash
OUT=~/Documents/stepoffaith-backups/final-$(date +%F) && mkdir -p $OUT/db $OUT/files $OUT/secrets
sx() { ssh -i ~/.ssh/stepoffaith_do -o IdentitiesOnly=yes root@64.226.105.90 "$@"; }
DC='cd /opt/stepoffaith && docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres'
sx "$DC pg_dump -U sof -d sof -Fc -Z 9" > $OUT/db/sof-final-$(date +%F).dump
sx "$DC pg_dump -U sof -d sof --no-owner --no-privileges" | gzip -9 > $OUT/db/sof-final-$(date +%F).sql.gz
for v in private media; do
  sx "tar -C \"\$(docker volume inspect -f '{{.Mountpoint}}' stepoffaith_$v)\" -czf - ." > $OUT/files/$v.tar.gz
done
scp -i ~/.ssh/stepoffaith_do -o IdentitiesOnly=yes root@64.226.105.90:/opt/stepoffaith/.env $OUT/secrets/prod.env
chmod 600 $OUT/secrets/prod.env
```

### 3.2. Посмотреть базу локально (для разработчика)

```bash
pnpm dev:db        # PostgreSQL 17 в Docker на localhost:55432, база и пользователь sof
pg_restore -h localhost -p 55432 -U sof -d sof --no-owner --clean --if-exists ~/Documents/stepoffaith-backups/final-2026-11-16/db/sof-final-2026-11-16.dump
```

Локально **не запускайте бота с боевым токеном** (`pnpm dev:bot`): он перехватит бота у сервера.

## 4. Как выключить совсем (когда решите)

Всё ниже необратимо или стоит денег, делать только по решению владельца и по порядку:

1. Убедиться, что архив `final-2026-11-16` на месте и есть вторая копия (облако или внешний диск), а `prod.env` сохранён в менеджере паролей.
2. Если после 16 ноября в боте что-то менялось - снять свежий бэкап (раздел 3.1) и положить рядом с архивом.
3. Удалить дроплет `stepoffaith-prod` в панели DigitalOcean: только удаление останавливает оплату (выключенный дроплет оплачивается).
4. Домен `stepoffaith.online` в hoster.by: продлить или дать истечь.
5. Бот в @BotFather можно оставить: без сервера он просто молчит. Если удалять - `/deletebot`.

## 5. Остальная документация

- [README.md](README.md) - устройство проекта и локальная разработка;
- [infra/digitalocean-server.md](infra/digitalocean-server.md) - прод-сервер: что где, команды;
- [infra/runbook.md](infra/runbook.md) - чек-лист дня конференции и что делать при сбоях (писался для тестового сервера);
- [docs/](docs) - правила игры «Церкви», планы доработок.
