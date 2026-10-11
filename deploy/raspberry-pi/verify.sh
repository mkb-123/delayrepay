#!/usr/bin/env bash
set -euo pipefail

failed=0
check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'OK   %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label"
    failed=1
  fi
}

check "dashboard service" systemctl is-active --quiet delayrepay.service
check "nginx service" systemctl is-active --quiet nginx.service
check "mDNS alias" systemctl is-active --quiet delayrepay-avahi-alias.service
scheduled() {
  local timer="$1"
  local service="$2"
  systemctl is-enabled --quiet "$timer" || grep -Fq "$service" /etc/cron.d/delayrepay
}
check "collection schedule" scheduled delayrepay-collect.timer delayrepay-collect.service
check "reconciliation schedule" scheduled delayrepay-reconcile.timer delayrepay-reconcile.service
check "backup schedule" scheduled delayrepay-backup.timer delayrepay-backup.service
check "Saturday email schedule" scheduled delayrepay-email.timer delayrepay-email.service
check "internal health" curl -fsS --max-time 5 http://127.0.0.1:8765/health
check "Nginx health" curl -fsS --max-time 5 http://127.0.0.1/health
check "runtime database" test -f /var/lib/delayrepay/delayrepay.sqlite
sqlite_ok() {
  [[ "$(sqlite3 /var/lib/delayrepay/delayrepay.sqlite 'PRAGMA integrity_check;')" == "ok" ]]
}
check "SQLite integrity" sqlite_ok

if [[ -f /var/lib/delayrepay/secrets/gmail-oauth-token.json ]]; then
  printf 'OK   Gmail OAuth token\n'
else
  printf 'WARN Gmail OAuth token missing; reconciliation cannot run\n'
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
