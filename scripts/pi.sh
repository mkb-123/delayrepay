#!/usr/bin/env bash
# Talk to the Raspberry Pi from Windows (Git Bash) through WSL ssh, without the quoting pitfalls.
#
#   scripts/pi.sh run '<shell command>'        run a command on the Pi
#   scripts/pi.sh sql '<SELECT ...>'           query the live database (or pipe SQL on stdin / heredoc)
#   scripts/pi.sh py < script.py               run a Python script from stdin in the project venv
#   scripts/pi.sh cli <delayrepay args>        run `python -m delayrepay ...` on the Pi
#   scripts/pi.sh queue list|add|retry|remove|ignore --operator VT --date 2026-10-16 --time 18:16
#   scripts/pi.sh get <remote-file> [local]    copy a file from the Pi (scp is unreliable here)
#   scripts/pi.sh put <local> <remote-file>    copy a file to the Pi (owner-only permissions)
#   scripts/pi.sh status [--alerts]            one-screen status of everything that needs attention
#   scripts/pi.sh deploy                       pull and restart the dashboard (no sudo)
#
# Rules: no sudo (it needs a password); SQL and Python go through stdin so nothing needs escaping.
set -euo pipefail
PI="${PI_HOST:-bhakta-pi@pi.local}"
DB=/var/lib/delayrepay/delayrepay.sqlite
REPO='~/delayrepay'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh_pi() { timeout "${PI_TIMEOUT:-100}" wsl.exe -e ssh -o BatchMode=yes -o ConnectTimeout=15 "$PI" "$@"; }
find_node() {
  command -v node 2>/dev/null && return
  ls /c/Users/*/.cache/codex-runtimes/*/dependencies/node/bin/node.exe 2>/dev/null | head -1
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  run)    ssh_pi "$*" ;;
  sql)    if [ $# -gt 0 ]; then printf '%s\n' "$*"; else cat; fi | ssh_pi "sqlite3 -header -column $DB" ;;
  py)     ssh_pi "cd $REPO && .venv/bin/python -" ;;
  cli)    ssh_pi "cd $REPO && .venv/bin/python -m delayrepay $*" ;;
  queue)  ssh_pi "cd $REPO && .venv/bin/python -m delayrepay queue $*" ;;
  get)    ssh_pi "cat '$1'" > "${2:-$(basename "$1")}" ;;
  put)    ssh_pi "umask 077; cat > '$2'" < "$1" ;;
  status) ssh_pi "curl -s http://127.0.0.1:8765/api/dashboard" | "$(find_node)" "$HERE/status.mjs" "$@" ;;
  deploy) ssh_pi "cd $REPO && ./deploy/raspberry-pi/update.sh 2>&1 | grep -v 'invalid distribution'" ;;
  *)      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
