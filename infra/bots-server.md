# Сервер для ботов (DigitalOcean)

Документ для агентов и разработчиков: как выложить бота на отдельный сервер `bots`.
Сервер создан 10 ноября 2026 и пока пустой: Docker, swap, файрвол и общий HTTPS-вход (Caddy) уже настроены.
Секретов (паролей, токенов) здесь нет, только где они лежат.

## 1. Правила (обязательно)

1. **Ничего не выкладываем и не перезапускаем без явного «да» владельца** (Кирилл, @kohnikk) на каждое действие.
2. **Каждый бот - свой compose-проект в своей папке** `/opt/<бот>`, со своими томами и **лимитом памяти** (`mem_limit`).
3. **Никогда:** `docker compose down -v`, `docker volume prune`, `docker system prune -a --volumes`, `docker rm -f` чужих контейнеров. Тома - это данные.
4. **Секреты** - только в `/opt/<бот>/.env` на сервере (`chmod 600`). В репозиторий, чат и логи не попадают; значения не печатаем.
5. **Перед выкладкой** - бэкап данных бота (если они есть) и пробный `rsync -n`.
6. **Порты бота наружу не публикуем.** Docker обходит файрвол `ufw`: всё, что в `ports:`, открыто в интернет. Веб-адрес - только через общий Caddy (раздел 4.2).
7. **Сервер «Шага веры» (`64.226.105.90`) - отдельный, его не трогаем.** Ботов туда не кладём.

## 2. Сервер

| Что | Значение |
|---|---|
| Провайдер | DigitalOcean, проект `first-project`, дроплет `bots` (id 617789693) |
| Регион | `lon1` (Лондон). Во Франкфурте дешёвые тарифы Basic были недоступны |
| IP | `134.209.191.125` |
| Вход | `ssh -i ~/.ssh/bots_do -o IdentitiesOnly=yes root@134.209.191.125` |
| Ключ | `~/.ssh/bots_do` на Mac владельца; в DigitalOcean называется `bots-server`. Вход по паролю выключен |
| Тариф | Basic Regular `s-1vcpu-1gb`: 1 vCPU, 1 ГБ RAM, 25 ГБ SSD, 1 ТБ трафика, **$6/мес** |
| ОС | Ubuntu 24.04 LTS, часовой пояс UTC |
| Swap | 2 ГБ (`/swapfile`), `vm.swappiness=10` |
| Docker | 29.1.3, Compose 2.40.3 - пакеты `docker.io` и `docker-compose-v2` из Ubuntu (команда `docker compose`, не `docker-compose`) |
| Логи контейнеров | ротация по умолчанию для всех: 10 МБ × 3 файла (`/etc/docker/daemon.json`) |
| Файрвол | `ufw`: открыты только 22/tcp, 80/tcp, 443/tcp, 443/udp |
| Порты 80/443 | общий Caddy, проект `/opt/proxy`, сеть Docker `edge` |
| Мониторинг | агент DigitalOcean (графики CPU и памяти в панели) |
| Бэкапы DigitalOcean | **выключены** (платные). Бэкапы - на каждом боте свои (раздел 4.4) |

## 3. Что уже есть на сервере

| Папка | Что это | Память |
|---|---|---|
| `/opt/proxy` | Caddy: HTTPS-сертификаты Let's Encrypt автоматически, проксирует на ботов по сети `edge` | ~10 МБ, лимит 64 МБ |

Файлы `/opt/proxy`: `docker-compose.yml`, `Caddyfile` (только `import /etc/caddy/sites/*.caddy`), папка `sites/` - по файлу на бота.

## 4. Как выложить бота

### 4.1. Бот на long polling (самый частый случай)

Домен, порты и Caddy не нужны: бот сам ходит в Telegram.

1. Папка: `ssh ... 'mkdir -p /opt/<бот>'` (имя латиницей, коротко).
2. Код с Mac - без мусора и секретов, сначала пробный прогон:

   ```bash
   rsync -azn --itemize-changes --exclude node_modules --exclude .git --exclude .env --exclude '.env.*' \
     --exclude dist --exclude __pycache__ --exclude .venv \
     -e "ssh -i ~/.ssh/bots_do -o IdentitiesOnly=yes" ./ root@134.209.191.125:/opt/<бот>/
   # проверили список - тот же запуск без -n
   ```

3. Секреты: создать `/opt/<бот>/.env` на сервере, `chmod 600 /opt/<бот>/.env`.
4. `docker-compose.yml` бота по шаблону:

   ```yaml
   name: <бот>
   services:
     bot:
       build: .
       restart: unless-stopped
       env_file: .env
       mem_limit: 200m     # подберите по docker stats, с запасом ~30%
       cpus: 0.5
       volumes:
         - data:/app/data  # если бот хранит файлы или SQLite
   volumes:
     data:
   ```

5. Запуск и проверка:

   ```bash
   cd /opt/<бот>
   docker compose up -d --build
   docker compose logs --tail=50 bot
   docker stats --no-stream
   ```

### 4.2. Бот с вебхуком или мини-аппом (нужен HTTPS-адрес)

1. Адрес:
   - без DNS: `https://<бот>.134.209.191.125.sslip.io` - sslip.io сам указывает на IP, сертификат Caddy получит сам;
   - свой домен: владелец ставит A-запись на `134.209.191.125` у регистратора.
2. В compose бота подключить сеть `edge`, порты **не публиковать**, сервису дать уникальное имя:

   ```yaml
   services:
     mybot-web:
       # ...
       networks: [default, edge]
   networks:
     edge:
       external: true
   ```

3. Файл `/opt/proxy/sites/<бот>.caddy`:

   ```
   mybot.134.209.191.125.sslip.io {
   	reverse_proxy mybot-web:8080
   }
   ```

4. Перечитать Caddy без простоя для остальных:

   ```bash
   cd /opt/proxy && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

### 4.3. База данных

- **SQLite в томе** - лучший вариант для обычного бота на 1 ГБ (лишней памяти не ест).
- **PostgreSQL** - одна общая на всех ботов, не по одной на бота (каждая ~80-130 МБ). Если понадобится: проект `/opt/db`,
  `postgres:17-alpine`, `mem_limit: 160m`, `command: postgres -c shared_buffers=32MB -c max_connections=30`, сеть `edge`;
  каждому боту - своя база и свой пользователь. Порт наружу не публиковать. Создаём только с «да» владельца.

### 4.4. Бэкапы

Автобэкапов нет. Боту с данными - свой бэкап по расписанию: копия SQLite или `pg_dump` (например, маленький сервис-цикл в его compose
или `cron` на сервере) и копия вне сервера (в Telegram-чат владельца или на Mac через `rsync`).

## 5. Память: как уложиться в 1 ГБ

| Что | Память |
|---|---|
| Всего | ~960 МБ + 2 ГБ swap |
| Ubuntu, Docker, агент DigitalOcean, Caddy (замер сразу после настройки) | ~400 МБ |
| Остаётся на ботов | ~550 МБ: три бота по ~150 МБ, пики - в swap |

- Обычный бот на Python (aiogram) или Node.js (grammY) в простое - 50-120 МБ. Ставьте `mem_limit` 150-200m; сумма лимитов всех ботов - не больше ~600m.
- **Сборка образов** (`npm install`, `tsc`, `vite`, `pip install` с компиляцией) на 1 ГБ идёт медленно, через swap. Тяжёлые образы лучше собрать на Mac и привезти:

  ```bash
  docker buildx build --platform linux/amd64 -t <бот>:latest --load .
  docker save <бот>:latest | gzip | ssh -i ~/.ssh/bots_do -o IdentitiesOnly=yes root@134.209.191.125 'gunzip | docker load'
  ```

  В compose тогда `image: <бот>:latest` вместо `build: .`.
- После сборок чистить кэш: `docker builder prune -f` (тома и образы не трогает).

## 6. Полезные команды

```bash
free -m && docker stats --no-stream        # память
df -h / && docker system df                # диск
docker ps --format '{{.Names}} {{.Status}}'
docker compose -p <бот> logs --tail=100    # логи бота по имени проекта
docker compose -p <бот> restart
```

## 7. Чек-лист агента

1. Получить «да» владельца на выкладку.
2. Проверить, что имя проекта и сервисов не занято (`docker ps`).
3. rsync с `-n`, потом без; `.env` - только на сервере, `chmod 600`.
4. В compose: `name`, `restart: unless-stopped`, `mem_limit`, тома для данных, без `ports:`.
5. `docker compose up -d --build` (или образ с Mac), проверить логи и `docker stats`.
6. Нужен HTTPS - раздел 4.2.
7. Настроить бэкап данных бота.
8. Дописать бота в таблицу ниже.

## 8. Боты на сервере

| Бот | Папка / проект | Режим | Адрес | Память |
|---|---|---|---|---|
| - | - | - | - | - |
