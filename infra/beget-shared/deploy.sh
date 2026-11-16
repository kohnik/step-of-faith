#!/usr/bin/env bash
# Выкладка на общий VPS Beget (за Caddy проекта dolgov-net), запускать с Mac:
#   infra/beget-shared/deploy.sh          - сервер (образ) + фронтенды
#   infra/beget-shared/deploy.sh web      - только фронтенды (статика, без перезапусков)
#   infra/beget-shared/deploy.sh server   - только образ API/бота
# Образ собирается на Mac под linux/amd64: на сервере 2 ГБ памяти на несколько проектов, сборку там не делаем.
set -euo pipefail
HOST=${DEPLOY_HOST:-root@159.194.205.232}
KEY=${DEPLOY_KEY:-$HOME/.ssh/dolgov_vps}
DIR=/opt/stepoffaith
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST")
RSYNC_SSH="ssh -i $KEY -o IdentitiesOnly=yes"
cd "$(dirname "$0")/../.."

deploy_web() {
  export VITE_BOT_USERNAME=${VITE_BOT_USERNAME:-step_of_faith_2026_bot}
  corepack pnpm --filter @sof/miniapp build
  corepack pnpm --filter @sof/admin build
  # Сначала во временную папку, потом атомарная подмена - Caddy не увидит полупустую статику.
  for app in miniapp admin; do
    rsync -az --delete -e "$RSYNC_SSH" "apps/$app/dist/" "$HOST:$DIR/web/.$app-next/"
    "${SSH[@]}" "cd $DIR/web && rm -rf .$app-prev && mv $app .$app-prev && mv .$app-next $app && rm -rf .$app-prev"
  done
}

deploy_server() {
  docker buildx build --platform linux/amd64 -f infra/Dockerfile.server -t sof-server:latest --load .
  docker save --platform linux/amd64 sof-server:latest | gzip -1 | "${SSH[@]}" 'gunzip | docker load'
  scp -i "$KEY" -o IdentitiesOnly=yes -q infra/beget-shared/docker-compose.yml infra/beget-shared/Caddyfile "$HOST:$DIR/"
  "${SSH[@]}" "cd $DIR && docker compose up -d sof-api && docker compose up -d sof-bot sof-web sof-backup && docker compose ps"
}

case "${1:-all}" in
  web) deploy_web ;;
  server) deploy_server ;;
  all) deploy_server && deploy_web ;;
  *) echo "usage: $0 [all|server|web]"; exit 1 ;;
esac

# Соседи по серверу должны остаться живы.
curl -s -o /dev/null -w 'dolgov-net: %{http_code}\n' https://159.194.205.232.sslip.io/api/v1/health
curl -s -o /dev/null -w 'stepoffaith: %{http_code}\n' https://sof-app.159.194.205.232.sslip.io/api/health
