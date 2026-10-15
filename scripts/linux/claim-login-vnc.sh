#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^(VT|LM)$ ]]; then
  echo "Usage: $0 VT|LM" >&2
  exit 2
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
operator="$1"
display_number="${DELAYREPAY_LOGIN_DISPLAY:-99}"
vnc_port="${DELAYREPAY_LOGIN_VNC_PORT:-5900}"
web_port="${DELAYREPAY_LOGIN_WEB_PORT:-6080}"
display=":$display_number"

for command in Xvfb x11vnc websockify; do
  command -v "$command" >/dev/null || {
    echo "$command is missing. Re-run deploy/raspberry-pi/install.sh first." >&2
    exit 2
  }
done

novnc_root="/usr/share/novnc"
[[ -d "$novnc_root" ]] || {
  echo "noVNC web files were not found at $novnc_root." >&2
  exit 2
}

cleanup() {
  [[ -n "${websockify_pid:-}" ]] && kill "$websockify_pid" 2>/dev/null || true
  [[ -n "${vnc_pid:-}" ]] && kill "$vnc_pid" 2>/dev/null || true
  [[ -n "${xvfb_pid:-}" ]] && kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "$display" -screen 0 1280x900x24 -nolisten tcp >/tmp/delayrepay-xvfb.log 2>&1 &
xvfb_pid=$!
sleep 1
x11vnc -display "$display" -localhost -nopw -forever -shared -rfbport "$vnc_port" >/tmp/delayrepay-x11vnc.log 2>&1 &
vnc_pid=$!
websockify --web="$novnc_root" "127.0.0.1:$web_port" "127.0.0.1:$vnc_port" >/tmp/delayrepay-novnc.log 2>&1 &
websockify_pid=$!

echo
echo "Open http://localhost:$web_port/vnc.html in the browser on your SSH computer."
echo "The SSH connection must include: -L $web_port:127.0.0.1:$web_port"
echo "Complete the $operator login in that page, then return here and press Enter."
echo

cd "$repo_dir"
DISPLAY="$display" "$repo_dir/.venv/bin/python" -m delayrepay claim-login --operator "$operator"

