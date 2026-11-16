# Сервер DigitalOcean «Шага веры» (64.226.105.90)

> **Новых ботов сюда не кладём.** С 10 ноября 2026 для них есть отдельный сервер `bots` (134.209.191.125) - см. [bots-server.md](bots-server.md).
> Этот документ - справка по серверу «Шага веры».

Данные сняты с сервера 9 ноября 2026. Секретов (паролей, токенов) здесь нет - только где они лежат.

## 1. Правила (обязательно)

1. **Ничего не меняем на проде без явного «да» владельца** (Кирилл, @kohnikk) на каждое действие: выкладка, перезапуск, запись в базу.
2. **Не трогать проект `stepoffaith`** (папка `/opt/stepoffaith`, контейнеры `stepoffaith-*`, тома `stepoffaith_*`), кроме случаев, описанных ниже (Caddy и общая база) - и тоже только с «да».
3. **Никогда:** `docker compose down -v`, `docker volume prune`, `docker system prune -a --volumes`, `docker rm -f` чужих контейнеров. Тома - это данные.
4. **Файлы `/opt/stepoffaith` на сервере руками не правим:** источник правды - репозиторий на Mac (`/Users/elizavetaulosevic/Documents/stepoffaith`), следующая выкладка через rsync перезапишет правки на сервере.
5. **Секреты не печатаем** в чат и логи: значения из `.env` не выводим, только имена переменных.
6. **Перед любой выкладкой** - бэкап базы того проекта, который трогаем, и пробный `rsync -n`.
7. Каждый бот - **свой compose-проект в своей папке** `/opt/<имя-бота>`, со своими томами и лимитами памяти.

## 2. Сервер

| Что | Значение |
|---|---|
| Провайдер | DigitalOcean, регион `fra1` (Франкфурт), имя дроплета `stepoffaith-prod` |
| IP | `64.226.105.90` |
| Вход | `ssh -i ~/.ssh/stepoffaith_do -o IdentitiesOnly=yes root@64.226.105.90` (ключ лежит на Mac владельца) |
| ОС | Ubuntu 24.04.5 LTS, ядро 6.8 |
| Ресурсы | 2 vCPU (Premium Intel), 2 ГБ RAM, диск 87 ГБ (занято ~20 ГБ), swap 4 ГБ (`/swapfile`) |
| Docker | 29.9.2, Compose v5.7.0 (`docker compose`, не `docker-compose`) |
| Файрвол | `ufw`: открыты только 22/tcp, 80/tcp, 443/tcp, 443/udp |
| Порты 80/443 | заняты Caddy внутри контейнера `stepoffaith-web-1` (HTTPS-сертификаты Let's Encrypt - автоматически) |
| DNS домена `stepoffaith.online` | у регистратора hoster.by (NS `u1/u2.hoster.by`); записи меняет только владелец в панели hoster.by |

## 3. Что уже работает: «Шаг веры»

Папка `/opt/stepoffaith`, compose-проект `stepoffaith`, файл `infra/docker-compose.yml`, секреты - `/opt/stepoffaith/.env`.

| Контейнер | Что это | Память в простое |
|---|---|---|
| `stepoffaith-web-1` | Caddy: HTTPS, раздача мини-аппа и админки, прокси на API | ~25 МБ |
| `stepoffaith-api-1` | API (Node.js) | ~120 МБ |
| `stepoffaith-bot-1` | Telegram-бот и очередь задач (Node.js) | ~130 МБ |
| `stepoffaith-postgres-1` | PostgreSQL 17 (alpine) | ~130 МБ |
| `stepoffaith-backup-1` | pg_dump каждый час, копия в Telegram раз в сутки | ~10 МБ |

Итого ~415 МБ. Сеть Docker - `stepoffaith_default`. Тома: `stepoffaith_pgdata`, `stepoffaith_media`, `stepoffaith_private`,
`stepoffaith_backups`, `stepoffaith_caddy_data`, `stepoffaith_caddy_config`.

Команды «Шага веры» (всегда с `--env-file .env`):

```bash
cd /opt/stepoffaith
docker compose --env-file .env -f infra/docker-compose.yml ps
docker compose --env-file .env -f infra/docker-compose.yml logs --tail=100 bot
```

## 4. Как выложить нового бота

### 4.1. Бот на long polling (самый простой случай)

Не нужен ни домен, ни порты, ни Caddy. Бот сам ходит в Telegram.

1. Папка: `mkdir -p /opt/<bot>` (имя - латиницей, коротко: `podhod`, `zadach`, …).
2. Код - с Mac через rsync, без мусора и секретов:

   ```bash
   rsync -azn --itemize-changes --exclude node_modules --exclude .git --exclude .env --exclude '.env.*' --exclude dist --exclude __pycache__ \
     -e "ssh -i ~/.ssh/stepoffaith_do -o IdentitiesOnly=yes" ./ root@64.226.105.90:/opt/<bot>/
   # убедились, что едут только нужные файлы, - тот же запуск без -n
   ```

3. Секреты - в `/opt/<bot>/.env` на сервере (`chmod 600`), токен бота и прочее. В репозиторий и в чат не попадают.
4. `docker-compose.yml` бота - по шаблону ниже: имя проекта, `restart`, **лимит памяти**, ротация логов.

   ```yaml
   name: <bot>
   services:
     bot:
       build: .
       restart: unless-stopped
       env_file: .env
       mem_limit: 200m        # подберите по факту (docker stats), с запасом ~30%
       cpus: 0.5
       logging:
         driver: json-file
         options: { max-size: '10m', max-file: '3' }
       volumes:
         - data:/app/data     # если бот хранит файлы или SQLite
   volumes:
     data:
   ```

5. Запуск и проверка:

   ```bash
   cd /opt/<bot>
   docker compose up -d --build
   docker compose logs --tail=50 bot
   docker stats --no-stream
   ```

### 4.2. Бот с вебхуком или мини-аппом (нужен HTTPS-адрес)

Порты 80/443 держит Caddy «Шага веры» - второй веб-сервер на них не поднять. Варианты:

- **Адрес без DNS (для проверки и даже для работы):** `https://<имя>.64.226.105.90.sslip.io` - домен sslip.io сам указывает на IP, сертификат Caddy получит автоматически.
- **Свой домен:** владелец добавляет A-запись на `64.226.105.90` у своего регистратора.

Как подключить (только с «да» владельца - это выкладка «Шага веры»):

1. Контейнер бота подключить к сети Caddy - в compose бота:

   ```yaml
   services:
     bot:
       networks: [default, edge]
   networks:
     edge:
       name: stepoffaith_default
       external: true
   ```

   Наружу порты **не публиковать** (`ports:` не нужен): Caddy достучится по имени сервиса.
   Чтобы имя не совпало с сервисами «Шага веры» (`api`, `bot`, `web`, `postgres`), дайте сервису уникальное имя, например `podhod-bot`.
2. В репозитории «Шага веры» на Mac, в `infra/Caddyfile`, добавить блок:

   ```
   podhod.64.226.105.90.sslip.io {
   	reverse_proxy podhod-bot:8080
   }
   ```

3. Выложить только веб «Шага веры» (бэкап, пробный rsync, затем):

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml build web
   docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps web
   ```

> Если ботов с веб-адресами станет несколько, лучше вынести Caddy в отдельный общий проект `/opt/proxy` (свой compose, сеть `edge`), а «Шаг веры» подключить к нему как соседа. Это отдельная работа - согласовать с владельцем.

### 4.3. База данных

- **SQLite в томе** - самый лёгкий вариант для обычного бота (0 МБ лишней памяти).
- **Свой PostgreSQL на каждого бота** - ещё ~80-130 МБ на сервер. На маленьком сервере лучше не множить.
- **Общий PostgreSQL «Шага веры»** (экономит память): отдельная база и пользователь на бота, подключение через сеть `stepoffaith_default`, хост `postgres`.
  Создаёт владелец или агент с «да»; бэкап «Шага веры» эти базы **не** копирует - нужен свой. Если «Шаг веры» когда-нибудь выключат, контейнер `postgres` придётся оставить.

### 4.4. Бэкапы

Бэкап-контейнер «Шага веры» копирует только базу `sof`. Каждому боту с данными - свой бэкап: `pg_dump`/копия SQLite по расписанию
(например, маленький сервис-цикл в его compose, как `infra/backup` у «Шага веры») и копия куда-то вне сервера.

## 5. Память и «хватит ли 1 ГБ»

**Этот дроплет до 1 ГБ уменьшить нельзя.** DigitalOcean не уменьшает диск, а у тарифов с 1 ГБ RAM диск 25-35 ГБ (здесь 87 ГБ).
Путь к 1 ГБ - **новый дроплет** (Basic, 1 vCPU / 1 ГБ / 25 ГБ) и переезд: перенести тома и `.env`, восстановить базы из дампов, переключить DNS.

Примерная раскладка на 1 ГБ:

| Что | Память |
|---|---|
| Ubuntu + Docker | ~200-250 МБ |
| «Шаг веры» целиком (если оставить работать) | ~415 МБ, после настройки Postgres - ~350 МБ |
| Остаётся на три бота | ~300-400 МБ, то есть ~100 МБ на бота |

- Обычный бот на Python (aiogram) или Node.js (grammY) в простое - 50-120 МБ. Три таких бота **без** «Шага веры» - спокойно помещаются в 1 ГБ.
- Три бота **и** работающий «Шаг веры» - впритык: на пиках будет свопиться, сборка образов на сервере (npm install, tsc, vite) не уложится в 1 ГБ без swap.
- Если боты со своим PostgreSQL каждый - 1 ГБ не хватит.

Рекомендации для 1 ГБ: swap 2-4 ГБ, `mem_limit` у каждого контейнера, одна база на всех (или SQLite), логи с ротацией,
у «Шага веры» снизить `shared_buffers` у Postgres (сейчас 512MB) и при ненадобности выключить API и мини-апп.

## 6. Полезные команды

```bash
free -m && docker stats --no-stream          # память
df -h / && docker system df                  # диск
docker builder prune -f                      # чистка кэша сборки (безопасно: тома и образы не трогает; сейчас ~11 ГБ)
docker compose -p <bot> logs --tail=100      # логи бота по имени проекта
```

## 7. Чек-лист агента

1. Получить «да» владельца на выкладку.
2. Проверить, что имя проекта и сервисов не совпадает с существующими (`docker ps`).
3. rsync с `-n`, потом без; `.env` - только на сервере.
4. В compose: `name`, `restart: unless-stopped`, `mem_limit`, ротация логов, тома для данных.
5. `docker compose up -d --build`, проверить логи и `docker stats`.
6. Если нужен HTTPS - раздел 4.2 (это касается «Шага веры», отдельное «да»).
7. Настроить бэкап данных бота.
8. Записать бота в этот документ (папка, имя проекта, память, адрес).
