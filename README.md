# «Шаг веры 2026» — бот, Mini App и админка конференции

> **Проект законсервирован 16 ноября 2026.** Конференция прошла 6-7 ноября. Итоги, где лежат данные,
> как поднять всё заново и как выключить сервер - в [ARCHIVE.md](ARCHIVE.md).

Регистрация (в том числе семьями и с друзьями), QR-коды для входа, оплата вне бота с проверкой чеков, отметка на входе
множеством сканеров (с офлайн-режимом), расписание и активности с записью и листом ожидания,
рассылки и веб-админка с ролями.

| Часть | Где | Что внутри |
|---|---|---|
| `apps/server` | API + бот | Fastify 5, grammY (long polling), Drizzle + PostgreSQL, pg-boss (очереди) |
| `apps/miniapp` | Telegram Mini App | React 19, tma.js 3, сканер, офлайн-очередь, веб-билет `/t/:token` |
| `apps/admin` | Веб-админка | React 19, Mantine 9, AG Grid |
| `packages/shared` | Контракт | zod-схемы, типы API, роли и права, формат кода билета |
| `infra` | Деплой | Docker, Caddy, бэкапы, runbook |

## Как это работает

- **Регистрация** — формой в Mini App, одним идемпотентным запросом: двойные нажатия и ретраи на плохой сети
  не создают дублей. Один аккаунт Telegram может записать до N человек (настройка); билет можно передать
  в другой Telegram ссылкой.
- **Билет** — код `SF-XXXXXXXXXXC` (Crockford base32 + контрольный символ), QR версии 1 с коррекцией Q.
  Картинка приходит в чат и закрепляется; есть веб-ссылка на билет, которая открывается без Telegram.
- **Вход** — сначала онлайн: отметка сразу уходит на сервер, а он решает, новая она, повтор или
  «уже отмечен другим сканером». Без сети — локальная очередь и локальная копия базы билетов.
  Конкурентность держат SQL-функции `check_in`, `register_activity`, `promote_waitlist` (`apps/server/src/db/migrations/0001_functions.sql`).
- **Роли**: суперадмин, админ, кассир, сканер, организатор. Права проверяет только сервер
  (`packages/shared/src/permissions.ts`); в боте у сотрудников свои команды и меню.

## Локальная разработка

Нужны Node 24 (`nvm use`), Docker.

```bash
corepack enable && pnpm install
cp .env.example .env            # заполнить; для локальной разработки токен можно не боевой
pnpm dev:db                     # PostgreSQL 17 в Docker на порту 55432
pnpm --filter @sof/server cli seed
pnpm dev:api                    # http://localhost:3000
pnpm dev:miniapp                # http://localhost:5173 (в браузере — мок Telegram через /api/dev/init-data)
pnpm dev:admin                  # http://localhost:5174
pnpm dev:bot                    # только с отдельным тестовым ботом, не с боевым токеном!
```

Проверки: `pnpm typecheck`, `pnpm test` (интеграционные тесты поднимают PostgreSQL в Docker:
50 сканеров на один билет → одна отметка, 200 записей на 30 мест → ровно 30), `pnpm build`.

Первый суперадмин: `pnpm --filter @sof/server cli invite superadmin` → ссылка вида
`t.me/<bot>?start=staff_…`, открыть её в Telegram.

## Деплой

- **Прод**: DigitalOcean `64.226.105.90` со своим Caddy и доменом `stepoffaith.online`
  (мини-апп `app.`, админка `panel.`): `infra/docker-compose.yml`, настройки - `.env.production.example`,
  справка по серверу - [`infra/digitalocean-server.md`](infra/digitalocean-server.md).
  Выкладка на настроенный сервер - `infra/deploy.sh`; восстановление из архива - [ARCHIVE.md](ARCHIVE.md), раздел 3.
- **Тестовый деплой (до переезда на прод)**: общий VPS Beget за Caddy проекта dolgov-net - `infra/beget-shared/`.

Порядок действий в день конференции и при сбоях: [`infra/runbook.md`](infra/runbook.md).
