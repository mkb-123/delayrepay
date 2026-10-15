#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_user="${SUDO_USER:-$USER}"
run_group="$(id -gn "$run_user")"
data_dir="/var/lib/delayrepay"

chmod +x "$repo_dir"/deploy/raspberry-pi/*.sh "$repo_dir"/scripts/linux/*.sh

if [[ ! -f "$repo_dir/.env" ]]; then
  cp "$repo_dir/deploy/raspberry-pi/delayrepay.env.example" "$repo_dir/.env"
  chmod 600 "$repo_dir/.env"
  echo "Created $repo_dir/.env. Add RTT and Gmail credentials, then rerun this installer."
  exit 2
fi

sudo apt-get update
sudo apt-get install -y python3-venv avahi-daemon avahi-utils ca-certificates curl sqlite3 nginx
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
# always (not on-failure) so update.sh can restart the dashboard by stopping its own process, no sudo
Restart=always
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
OnCalendar=*-*-* 19:00
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

sudo tee /etc/nginx/sites-available/delayrepay >/dev/null <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name delayrepay.local;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo tee /usr/local/bin/delayrepay-avahi-alias >/dev/null <<'EOF'
#!/bin/sh
set -eu
address="$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')"
test -n "$address"
exec /usr/bin/avahi-publish-address -R delayrepay.local "$address"
EOF
sudo chmod 755 /usr/local/bin/delayrepay-avahi-alias

sudo tee /etc/systemd/system/delayrepay-avahi-alias.service >/dev/null <<'EOF'
[Unit]
Description=Publish delayrepay.local without changing the Pi hostname
After=network-online.target avahi-daemon.service
Requires=avahi-daemon.service

[Service]
Type=simple
ExecStart=/usr/local/bin/delayrepay-avahi-alias
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/delayrepay /etc/nginx/sites-enabled/delayrepay
sudo nginx -t

sudo systemctl daemon-reload
sudo systemctl disable --now delayrepay-claim-worker.timer delayrepay-claim-session.timer 2>/dev/null || true
sudo rm -f /etc/systemd/system/delayrepay-claim-worker.service /etc/systemd/system/delayrepay-claim-worker.timer /etc/systemd/system/delayrepay-claim-session.service /etc/systemd/system/delayrepay-claim-session.timer
sudo systemctl daemon-reload
sudo systemctl enable --now delayrepay.service delayrepay-collect.timer delayrepay-email.timer delayrepay-reconcile.timer delayrepay-backup.timer delayrepay-avahi-alias.service avahi-daemon.service nginx.service
sudo systemctl restart nginx.service

echo "Delay Repay installed."
echo "Dashboard: http://delayrepay.local"
echo "Status: sudo systemctl status delayrepay.service"
echo "Timers: systemctl list-timers 'delayrepay-*'"
