#!/usr/bin/env bash
# One-time (idempotent) installer for the pull-based auto-deploy timer.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chmod +x "$repo_dir/deploy/raspberry-pi/auto-update.sh"

sudo tee /etc/systemd/system/delayrepay-auto-update.service >/dev/null <<UNIT
[Unit]
Description=Deploy new Delay Repay commits from origin/main
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$repo_dir
Environment=DELAYREPAY_REPO_DIR=$repo_dir
ExecStart=$repo_dir/deploy/raspberry-pi/auto-update.sh
UNIT

sudo tee /etc/systemd/system/delayrepay-auto-update.timer >/dev/null <<'UNIT'
[Unit]
Description=Check for new Delay Repay commits every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now delayrepay-auto-update.timer
echo "Auto-deploy enabled. Logs: journalctl -u delayrepay-auto-update.service"
