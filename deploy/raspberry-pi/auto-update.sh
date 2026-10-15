#!/usr/bin/env bash
# Pull-based deploy: if origin/main has moved, fast-forward, reinstall if needed,
# smoke-test, restart the dashboard, and roll back on any failure.
# Runs as root (from delayrepay-auto-update.service); git/pip run as the repo owner.
set -euo pipefail

repo_dir="${DELAYREPAY_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
branch="${DELAYREPAY_DEPLOY_BRANCH:-main}"
state_dir="/var/lib/delayrepay"
failed_file="$state_dir/auto-update-failed-sha"
run_user="$(stat -c %U "$repo_dir")"
as_user() { runuser -u "$run_user" -- "$@"; }
log() { echo "auto-update: $*"; }

cd "$repo_dir"
exec 9>"$state_dir/auto-update.lock"
flock -n 9 || { log "another update is running"; exit 0; }

as_user git fetch --quiet origin "$branch"
old="$(as_user git rev-parse HEAD)"
new="$(as_user git rev-parse "origin/$branch")"
[[ "$old" == "$new" ]] && exit 0
if [[ -f "$failed_file" && "$(cat "$failed_file")" == "$new" ]]; then
  log "$new already failed to deploy; waiting for a newer commit"
  exit 0
fi
if ! as_user git merge-base --is-ancestor "$old" "$new"; then
  log "local HEAD $old is not an ancestor of origin/$branch; refusing to update"
  exit 1
fi
if [[ -n "$(as_user git status --porcelain --untracked-files=no)" ]]; then
  log "tracked files have local changes; refusing to update"
  exit 1
fi

log "updating ${old:0:8} -> ${new:0:8}"

check() {
  as_user "$repo_dir/.venv/bin/python" -m compileall -q python
  as_user "$repo_dir/.venv/bin/python" -c "import delayrepay"
  if [[ -d tests ]]; then as_user "$repo_dir/.venv/bin/python" -m pytest -q tests; fi
}

install_and_check() {
  if ! as_user git diff --quiet "$1" "$2" -- pyproject.toml; then
    log "pyproject.toml changed; reinstalling"
    as_user "$repo_dir/.venv/bin/pip" install -e "$repo_dir"
  fi
  check
}

wait_healthy() {
  for _ in $(seq 1 20); do
    curl -fsS -o /dev/null http://127.0.0.1:8765/ && return 0
    sleep 1
  done
  return 1
}

rollback() {
  log "FAILED; rolling back to ${old:0:8}"
  echo "$new" >"$failed_file"
  as_user git reset --hard "$old"
  as_user git diff --quiet "$new" "$old" -- pyproject.toml || as_user "$repo_dir/.venv/bin/pip" install -e "$repo_dir" || true
  systemctl restart delayrepay.service || true
  exit 1
}

as_user git merge --ff-only "$new" >/dev/null
install_and_check "$old" "$new" || rollback
systemctl restart delayrepay.service
wait_healthy || rollback
rm -f "$failed_file"
log "deployed ${new:0:8}"
