#!/usr/bin/env bash
# Выкладка на VPS: ./infra/deploy.sh root@1.2.3.4 [/opt/stepoffaith]
# На сервере должны быть Docker и файл .env (см. .env.production.example).
set -euo pipefail
HOST=${1:?usage: infra/deploy.sh user@host [dir]}
DIR=${2:-/opt/stepoffaith}
cd "$(dirname "$0")/.."
ssh "$HOST" "mkdir -p $DIR"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude '.env' --exclude '.env.*' \
  --exclude coverage --exclude infra/data \
  ./ "$HOST:$DIR/"
ssh "$HOST" "cd $DIR && test -f .env && docker compose -f infra/docker-compose.yml --env-file .env up -d --build && docker compose -f infra/docker-compose.yml ps"
