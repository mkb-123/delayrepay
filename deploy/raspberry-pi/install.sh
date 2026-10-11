#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_user="${SUDO_USER:-$USER}"
run_group="$(id -gn "$run_user")"
data_dir="/var/lib/delayrepay"

if [[ ! -f "$repo_dir/.env" ]]; then
  cp "$repo_dir/deploy/raspberry-pi/delayrepay.env.example" "$repo_dir/.env"
  chmod 600 "$repo_dir/.env"
  echo "Created $repo_dir/.env. Add RTT and Gmail credentials, then rerun this installer."
  exit 2
fi

sudo apt-get update
sudo apt-get install -y python3-venv avahi-daemon sqlite3
python3 -m venv "$repo_dir/.venv"
"$repo_dir/.venv/bin/pip" install --upgrade pip
"$repo_dir/.venv/bin/pip" install -e "$repo_dir"

sudo install -d -o "$run_user" -g "$run_group" "$data_dir"
sudo install -d -m 700 -o "$run_user" -g "$run_group" "$data_dir/secrets" "$data_dir/backups" "$data_dir/logs"
if [[ ! -f "$data_dir/delayrepay.sqlite" && -f "$repo_dir/data-store/delayrepay.sqlite" ]]; then
  sudo cp "$repo_dir/data-store/delayrepay.sqlite" "$data_dir/delayrepay.sqlite"
  sudo chown "$run_user:$run_group" "$data_dir/delayrepay.sqlite"
fi
for catalogue in service-catalogue.json service-catalogue.md; do
  if [[ ! -f "$data_dir/$catalogue" && -f "$repo_dir/data-store/$catalogue" ]]; then
    sudo cp "$repo_dir/data-store/$catalogue" "$data_dir/$catalogue"
    sudo chown "$run_user:$run_group" "$data_dir/$catalogue"
  fi
done

sudo tee /etc/systemd/system/delayrepay.service >/dev/null <<EOF
[Unit]
Description=MKC EUS Delay Repay dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$run_group
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/.env
Environment=DELAYREPAY_REPO_DIR=$repo_dir
ExecStart=$repo_dir/.venv/bin/python -m delayrepay serve --host 0.0.0.0 --port 8765
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/delayrepay-collect.service >/dev/null <<EOF
[Unit]
Description=Collect the latest ten days of Delay Repay rail data
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$run_user
Group=$run_group
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/.env
Environment=DELAYREPAY_REPO_DIR=$repo_dir
ExecStart=$repo_dir/.venv/bin/python -m delayrepay daily-brief
EOF

sudo tee /etc/systemd/system/delayrepay-collect.timer >/dev/null <<'EOF'
[Unit]
Description=Weekday Delay Repay collection schedule

[Timer]
OnCalendar=Mon..Fri 19:00
Persistent=true
RandomizedDelaySec=2m

[Install]
WantedBy=timers.target
EOF

sudo tee /etc/systemd/system/delayrepay-email.service >/dev/null <<EOF
[Unit]
Description=Email the weekly Delay Repay summary
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$run_user
Group=$run_group
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/.env
Environment=DELAYREPAY_REPO_DIR=$repo_dir
ExecStart=$repo_dir/.venv/bin/python -m delayrepay email-summary
EOF

sudo tee /etc/systemd/system/delayrepay-email.timer >/dev/null <<'EOF'
[Unit]
Description=Saturday Delay Repay email schedule

[Timer]
OnCalendar=Sat 09:00
Persistent=true
RandomizedDelaySec=2m

[Install]
WantedBy=timers.target
EOF

sudo tee /etc/systemd/system/delayrepay-reconcile.service >/dev/null <<EOF
[Unit]
Description=Reconcile Delay Repay claim emails from Gmail
After=network-online.target delayrepay-collect.service
Wants=network-online.target

[Service]
Type=oneshot
User=$run_user
Group=$run_group
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/.env
Environment=DELAYREPAY_REPO_DIR=$repo_dir
ExecStart=$repo_dir/.venv/bin/python -m delayrepay gmail-reconcile
EOF

sudo tee /etc/systemd/system/delayrepay-reconcile.timer >/dev/null <<'EOF'
[Unit]
Description=Daily Delay Repay Gmail reconciliation

[Timer]
OnCalendar=*-*-* 20:00
Persistent=true
RandomizedDelaySec=2m

[Install]
WantedBy=timers.target
EOF

sudo tee /etc/systemd/system/delayrepay-backup.service >/dev/null <<EOF
[Unit]
Description=Back up the Delay Repay SQLite database

[Service]
Type=oneshot
User=$run_user
Group=$run_group
WorkingDirectory=$repo_dir
EnvironmentFile=$repo_dir/.env
Environment=DELAYREPAY_REPO_DIR=$repo_dir
ExecStart=$repo_dir/.venv/bin/python -m delayrepay backup --keep 30
EOF

sudo tee /etc/systemd/system/delayrepay-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily Delay Repay database backup

[Timer]
OnCalendar=*-*-* 02:30
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now delayrepay.service delayrepay-collect.timer delayrepay-email.timer delayrepay-reconcile.timer delayrepay-backup.timer avahi-daemon.service

hostname="$(hostname)"
echo "Delay Repay installed."
echo "Dashboard: http://${hostname}.local:8765"
echo "Status: sudo systemctl status delayrepay.service"
echo "Timers: systemctl list-timers 'delayrepay-*'"
