#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 BACKUP.sqlite [STATE_DIRECTORY]" >&2
  exit 2
fi

backup="$(readlink -f "$1")"
state_dir="${2:-}"
data_dir="/var/lib/delayrepay"
run_user="${SUDO_USER:-$USER}"
run_group="$(id -gn "$run_user")"

test -f "$backup"
if [[ "$(sqlite3 "$backup" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "Backup failed SQLite integrity check: $backup" >&2
  exit 1
fi

sudo systemctl stop delayrepay.service
sudo install -m 600 -o "$run_user" -g "$run_group" "$backup" "$data_dir/delayrepay.sqlite"

if [[ -n "$state_dir" ]]; then
  state_dir="$(readlink -f "$state_dir")"
  [[ -f "$state_dir/service-catalogue.json" ]] && sudo install -m 600 -o "$run_user" -g "$run_group" "$state_dir/service-catalogue.json" "$data_dir/service-catalogue.json"
  [[ -f "$state_dir/service-catalogue.md" ]] && sudo install -m 600 -o "$run_user" -g "$run_group" "$state_dir/service-catalogue.md" "$data_dir/service-catalogue.md"
  [[ -f "$state_dir/.env" ]] && install -m 600 "$state_dir/.env" "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env"
  if [[ -d "$state_dir/secrets" ]]; then
    sudo install -d -m 700 -o "$run_user" -g "$run_group" "$data_dir/secrets"
    for secret in "$state_dir"/secrets/*.json; do
      [[ -e "$secret" ]] || continue
      sudo install -m 600 -o "$run_user" -g "$run_group" "$secret" "$data_dir/secrets/"
    done
  fi
  if [[ -f "$state_dir/browser-profiles.tar.gz" ]]; then
    sudo tar -C "$data_dir" -xzf "$state_dir/browser-profiles.tar.gz"
    sudo chown -R "$run_user:$run_group" "$data_dir/browser-profiles"
    sudo chmod -R go-rwx "$data_dir/browser-profiles"
  fi
fi

sudo systemctl start delayrepay.service
echo "State restored. Run deploy/raspberry-pi/verify.sh."
