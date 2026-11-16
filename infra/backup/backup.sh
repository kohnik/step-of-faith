#!/usr/bin/env bash
# Регулярный pg_dump + выгрузка в S3 (Beget S3). Настройки - переменными окружения (см. docker-compose.yml).
set -uo pipefail
INTERVAL=${BACKUP_INTERVAL_MINUTES:-60}
KEEP_LOCAL=${BACKUP_KEEP_LOCAL:-48}
KEEP_REMOTE_DAYS=${BACKUP_KEEP_REMOTE_DAYS:-30}
# Раз в день - зашифрованная копия (пароль BACKUP_MAIL_PASSWORD) в Telegram и/или на почту, в час BACKUP_MAIL_HOUR по TZ.
#   Telegram: BACKUP_TG_BOT_TOKEN + BACKUP_TG_CHAT_IDS (через запятую) - бот присылает файл в личный чат.
#   Почта: BACKUP_MAIL_TO + SMTP_USER + SMTP_PASSWORD (на DigitalOcean исходящий SMTP закрыт - там только Telegram).
MAIL_HOUR=${BACKUP_MAIL_HOUR:-22}
# На время конференции - копия в Telegram каждый час (без звука), если в базе что-то поменялось. До этой даты включительно.
HOURLY_UNTIL=${BACKUP_TG_HOURLY_UNTIL:-}
mkdir -p /backups

# Сколько строк в базе меняли (счётчик Postgres): тот же - значит, с прошлой копии ничего не изменилось.
# Служебные таблицы (счётчик запросов, ключи задач, очередь) не считаем - они меняются и без участников.
db_changes() {
  psql -At -c "select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) from pg_stat_user_tables where schemaname = 'public' and relname not in ('traffic_hourly', 'once_keys')" 2>/dev/null
}

send_hourly() {
  local file=$1 ts=$2
  [ -n "$HOURLY_UNTIL" ] && [ -n "${BACKUP_TG_BOT_TOKEN:-}" ] && [ -n "${BACKUP_TG_CHAT_IDS:-}" ] && [ -n "${BACKUP_MAIL_PASSWORD:-}" ] || return 0
  [[ "$(date +%F)" > "$HOURLY_UNTIL" ]] && return 0
  local now last
  now=$(db_changes)
  last=$(cat /backups/.hourly-changes 2>/dev/null || true)
  if [ -n "$now" ] && [ "$now" = "$last" ]; then echo "[$ts] hourly: no changes, skip"; return 0; fi
  local stamp name enc size caption chat ok=''
  stamp=$(date +%F-%H%M)
  name="stepoffaith-$stamp.dump.enc"
  enc="$(mktemp -d)/$name"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$file" -out "$enc" -pass env:BACKUP_MAIL_PASSWORD || { echo "[$ts] HOURLY ENCRYPT FAILED"; rm -rf "$(dirname "$enc")"; return 0; }
  size=$(du -h "$file" | cut -f1)
  caption="🗄 Копия базы «Шаг веры» · $(date '+%d.%m %H:%M') ($size). Каждый час на время конференции, без звука. Пароль - тот же, что у ежедневных копий. Открыть: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in $name -out stepoffaith.dump"
  IFS=',' read -ra chats <<< "$BACKUP_TG_CHAT_IDS"
  for chat in "${chats[@]}"; do
    if curl -sS --max-time 120 -o /dev/null -w '%{http_code}' -F "chat_id=$chat" -F "caption=$caption" -F "disable_notification=true" -F "document=@$enc" \
        "https://api.telegram.org/bot$BACKUP_TG_BOT_TOKEN/sendDocument" | grep -q '^200$'; then
      echo "[$ts] hourly sent to telegram $chat"; ok=1
    else
      echo "[$ts] HOURLY TELEGRAM FAILED for $chat"
    fi
  done
  rm -rf "$(dirname "$enc")"
  [ -n "$ok" ] && [ -n "$now" ] && echo "$now" > /backups/.hourly-changes
}

send_backup() {
  local file=$1 ts=$2 force=${3:-}
  local want_tg='' want_mail=''
  [ -n "${BACKUP_TG_BOT_TOKEN:-}" ] && [ -n "${BACKUP_TG_CHAT_IDS:-}" ] && want_tg=1
  [ -n "${BACKUP_MAIL_TO:-}" ] && [ -n "${SMTP_USER:-}" ] && [ -n "${SMTP_PASSWORD:-}" ] && want_mail=1
  [ -n "$want_tg$want_mail" ] || return 0
  # Без пароля шифрования не отправляем: в копии личные данные участников.
  if [ -z "${BACKUP_MAIL_PASSWORD:-}" ]; then echo "[$ts] SEND SKIPPED: BACKUP_MAIL_PASSWORD is empty"; return 0; fi
  local day name enc size how
  day=$(date +%F)
  if [ -z "$force" ]; then
    [ -f "/backups/.sent-$day" ] && return 0
    [ "$(date +%H)" -ge "$MAIL_HOUR" ] || return 0
  fi
  name="stepoffaith-$day.dump.enc"
  enc="$(mktemp -d)/$name"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$file" -out "$enc" -pass env:BACKUP_MAIL_PASSWORD || { echo "[$ts] ENCRYPT FAILED"; rm -rf "$(dirname "$enc")"; return 0; }
  size=$(du -h "$file" | cut -f1)
  how="openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in $name -out stepoffaith.dump"
  local ok=''
  if [ -n "$want_tg" ]; then
    local chat caption
    caption="🗄 Резервная копия базы «Шаг веры» за $day ($size). Файл зашифрован паролем копий. Открыть: $how"
    IFS=',' read -ra chats <<< "$BACKUP_TG_CHAT_IDS"
    for chat in "${chats[@]}"; do
      if curl -sS --max-time 120 -o /dev/null -w '%{http_code}' -F "chat_id=$chat" -F "caption=$caption" -F "document=@$enc" \
          "https://api.telegram.org/bot$BACKUP_TG_BOT_TOKEN/sendDocument" | grep -q '^200$'; then
        echo "[$ts] sent to telegram $chat"; ok=1
      else
        echo "[$ts] TELEGRAM FAILED for $chat"
      fi
    done
  fi
  if [ -n "$want_mail" ]; then
    local eml boundary
    eml=$(mktemp)
    boundary="sof-$RANDOM$RANDOM"
    {
      printf 'From: %s\r\nTo: %s\r\nSubject: =?UTF-8?B?%s?=\r\nMIME-Version: 1.0\r\n' "${BACKUP_MAIL_FROM:-$SMTP_USER}" "$BACKUP_MAIL_TO" "$(printf 'Резервная копия базы Шаг веры %s' "$day" | base64 | tr -d '\n')"
      printf 'Content-Type: multipart/mixed; boundary="%s"\r\n\r\n--%s\r\n' "$boundary" "$boundary"
      printf 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'
      printf 'Копия базы за %s (%s). Файл зашифрован паролем копий.\n\nКак открыть:\n%s\nВосстановить: pg_restore --clean --if-exists -d <база> stepoffaith.dump\n' "$day" "$size" "$how" | base64
      printf '\r\n--%s\r\nContent-Type: application/octet-stream; name="%s"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="%s"\r\n\r\n' "$boundary" "$name" "$name"
      base64 "$enc"
      printf '\r\n--%s--\r\n' "$boundary"
    } > "$eml"
    if curl -sS --max-time 120 --ssl-reqd --url "${SMTP_URL:-smtps://smtp.gmail.com:465}" --user "$SMTP_USER:$SMTP_PASSWORD" \
        --mail-from "$SMTP_USER" --mail-rcpt "$BACKUP_MAIL_TO" --upload-file "$eml"; then
      echo "[$ts] mailed to $BACKUP_MAIL_TO"; ok=1
    else
      echo "[$ts] MAIL FAILED"
    fi
    rm -f "$eml"
  fi
  # Чеки переводов (взнос, мерч, пожертвования) - вторым файлом в Telegram: в S3 на этом сервере их нет.
  if [ -n "$want_tg" ]; then
    local dirs=() d
    for d in receipts merch-receipts; do [ -d "/private/$d" ] && dirs+=("$d"); done
    if [ ${#dirs[@]} -gt 0 ]; then
      local rname="stepoffaith-receipts-$day.tar.gz.enc" renc rbytes rcount
      renc="$(dirname "$enc")/$rname"
      rcount=$(find "${dirs[@]/#//private/}" -type f | wc -l)
      if tar -C /private -czf - "${dirs[@]}" | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out "$renc" -pass env:BACKUP_MAIL_PASSWORD; then
        rbytes=$(stat -c %s "$renc")
        # Бот в Telegram отправляет файлы до 50 МБ.
        if [ "$rbytes" -gt $((48 * 1024 * 1024)) ]; then
          echo "[$ts] RECEIPTS TOO BIG for telegram: $rbytes bytes"
        else
          local rcap="🧾 Чеки «Шаг веры» за $day: $rcount файлов ($(du -h "$renc" | cut -f1)). Зашифрованы паролем копий. Открыть: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in $rname -out receipts.tar.gz && tar -xzf receipts.tar.gz"
          IFS=',' read -ra chats <<< "$BACKUP_TG_CHAT_IDS"
          for chat in "${chats[@]}"; do
            if curl -sS --max-time 300 -o /dev/null -w '%{http_code}' -F "chat_id=$chat" -F "caption=$rcap" -F "document=@$renc" \
                "https://api.telegram.org/bot$BACKUP_TG_BOT_TOKEN/sendDocument" | grep -q '^200$'; then
              echo "[$ts] receipts sent to telegram $chat"
            else
              echo "[$ts] RECEIPTS TELEGRAM FAILED for $chat"
            fi
          done
        fi
      else
        echo "[$ts] RECEIPTS ARCHIVE FAILED"
      fi
    fi
  fi
  rm -rf "$(dirname "$enc")"
  if [ -n "$ok" ] && [ -z "$force" ]; then
    touch "/backups/.sent-$day"
    find /backups -name '.sent-*' -mtime +14 -delete 2>/dev/null
  fi
}

# Ручная отправка последней копии: docker compose exec backup backup.sh send-now
if [ "${1:-}" = send-now ]; then
  send_backup "$(ls -1t /backups/sof-*.dump | head -1)" manual force
  exit 0
fi

while true; do
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  FILE="/backups/sof-$TS.dump"
  if pg_dump -Fc -f "$FILE.tmp"; then
    mv "$FILE.tmp" "$FILE"
    echo "[$TS] dump ok: $(du -h "$FILE" | cut -f1)"
    if [ -n "${S3_BUCKET:-}" ]; then
      if rclone copy "$FILE" "s3:$S3_BUCKET/postgres/" --s3-no-check-bucket; then
        echo "[$TS] uploaded to s3:$S3_BUCKET/postgres/"
      else
        echo "[$TS] UPLOAD FAILED"
      fi
      rclone delete "s3:$S3_BUCKET/postgres/" --min-age "${KEEP_REMOTE_DAYS}d" >/dev/null 2>&1 || true
    fi
    # Ежедневная копия (в 22:00, со звуком и чеками) - в этот час вместо почасовой.
    daily_marker="/backups/.sent-$(date +%F)"
    had_daily=$([ -f "$daily_marker" ] && echo 1 || true)
    send_backup "$FILE" "$TS"
    if [ -z "$had_daily" ] && [ -f "$daily_marker" ]; then
      db_changes > /backups/.hourly-changes 2>/dev/null || true
    else
      send_hourly "$FILE" "$TS"
    fi
    ls -1t /backups/sof-*.dump 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f
    # Фото, 3D-модели и чеки мерча: файлы не меняются (имя - хеш), sync докачивает только новые.
    if [ -n "${S3_BUCKET:-}" ]; then
      for dir in media private; do
        if [ -d "/$dir" ]; then
          rclone copy "/$dir" "s3:$S3_BUCKET/$dir/" --s3-no-check-bucket >/dev/null 2>&1 || echo "[$TS] $dir UPLOAD FAILED"
        fi
      done
    fi
  else
    echo "[$TS] DUMP FAILED"
    rm -f "$FILE.tmp"
  fi
  sleep $((INTERVAL * 60))
done
