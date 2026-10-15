#!/usr/bin/env bash
# Deploy the latest main to this Pi without touching live state in /var/lib/delayrepay.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
data_dir="/var/lib/delayrepay"
database="$data_dir/delayrepay.sqlite"
cd "$repo_dir"

if [[ ! -f "$database" ]]; then
  echo "Live database missing: $database. Restore it with restore-state.sh before updating." >&2
  exit 1
fi

row_counts() {
  sqlite3 "$database" "SELECT 'services=' || (SELECT count(*) FROM services) || ' claims=' || (SELECT count(*) FROM claims) || ' lifecycle=' || (SELECT count(*) FROM claim_lifecycle) || ' email_events=' || (SELECT count(*) FROM claim_email_events);"
}

# 1. Consistent snapshot of the live database before any code changes.
"$repo_dir/.venv/bin/python" -m delayrepay backup --keep 30 >/dev/null
snapshot="$(find "$data_dir/backups" -maxdepth 1 -name 'delayrepay-*.sqlite' -type f -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
if [[ "$(sqlite3 "$snapshot" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "Pre-update snapshot failed SQLite integrity check: $snapshot" >&2
  exit 1
fi
before="$(row_counts)"
echo "Snapshot: $snapshot"
echo "Before:   $before"

# 2. Fast-forward the code. Permission bits set by install.sh are not edits;
#    any real local edit stops the update so it is not silently discarded.
if ! git -c core.fileMode=false diff --quiet; then
  echo "The Pi checkout has local edits. Commit them elsewhere or discard them, then rerun." >&2
  git -c core.fileMode=false status --short >&2
  exit 1
fi
git checkout -- .
old_head="$(git rev-parse --short HEAD)"
git pull --ff-only
new_head="$(git rev-parse --short HEAD)"
echo "Code:     $old_head -> $new_head"

# 3. Code-only updates need no root: refresh the venv, then stop the dashboard's own process (it
#    runs as this user). systemd restarts it on any abnormal exit (Restart=on-failure or always),
#    so SIGKILL brings it straight back on the new code. The full installer (apt, systemd units,
#    nginx; needs sudo) runs only when install.sh changed or --full is given.
if [[ "${1:-}" == "--full" ]] || ! git diff --quiet "$old_head" "$new_head" -- deploy/raspberry-pi/install.sh scripts/linux; then
  echo "install.sh changed (or --full): running the full installer (asks for sudo)"
  "$repo_dir/deploy/raspberry-pi/install.sh"
else
  "$repo_dir/.venv/bin/pip" install -q -e "$repo_dir"
  case "$(systemctl show -p Restart --value delayrepay.service)" in
    always|on-failure|on-abnormal)
      kill -KILL "$(systemctl show -p MainPID --value delayrepay.service)"
      sleep 6 ;;
    *) sudo systemctl restart delayrepay.service ;;
  esac
fi
sleep 3
"$repo_dir/deploy/raspberry-pi/verify.sh"
echo "After:    $(row_counts)"
echo "Rollback: git checkout $old_head && ./deploy/raspberry-pi/install.sh"
echo "Restore:  ./deploy/raspberry-pi/restore-state.sh $snapshot"
