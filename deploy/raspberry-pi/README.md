# Raspberry Pi deployment

This setup targets Raspberry Pi OS or another Debian-based distribution with systemd. It runs without an AI model.

## What it installs

- `delayrepay.service`: dashboard on port 8765, restarted after failures and boots;
- `delayrepay-collect.timer`: ten-day refresh at 19:00 Monday–Friday;
- `delayrepay-email.timer`: outstanding-claims email at 09:00 Saturday;
- `delayrepay-reconcile.timer`: read-only Gmail claim reconciliation at 20:00 daily;
- `delayrepay-backup.timer`: consistent SQLite backup at 02:30 daily, retaining 30;
- Avahi/mDNS access at `http://delayrepay.local` through Nginx;
- runtime SQLite and catalogue files in `/var/lib/delayrepay`, separate from Git.

## Migration

Clone the repository on the Pi:

```bash
git clone https://github.com/mkb-123/delayrepay.git
cd delayrepay
cp deploy/raspberry-pi/delayrepay.env.example .env
nano .env
```

Add the RTT credentials to `.env`. Add the Gmail app password only if the
Saturday summary is required. The file is ignored by Git. Set the timezone,
but keep the Pi's existing hostname so other services continue using their
current `.local` address:

```bash
sudo timedatectl set-timezone Europe/London
```

The installer publishes `delayrepay.local` as an additional mDNS alias. It
does not rename the Pi or alter addresses used by Home Assistant or other apps.

After reconnecting, install everything:

```bash
cd delayrepay
chmod +x deploy/raspberry-pi/install.sh scripts/linux/*.sh
./deploy/raspberry-pi/install.sh
```

### Gmail reconciliation authorization

Google OAuth authorization needs a browser once. On the Windows checkout,
download a Google Desktop OAuth client JSON, set temporary paths in `.env`, and
run:

```powershell
.venv\Scripts\delayrepay.exe gmail-authorize
```

If this checkout uses a WSL virtual environment, run the equivalent command in
WSL. Copy the client and generated token files to the Pi without committing
them:

```bash
sudo install -d -m 700 -o "$USER" -g "$USER" /var/lib/delayrepay/secrets
scp gmail-oauth-client.json gmail-oauth-token.json delayrepay.local:/tmp/
sudo install -m 600 -o "$USER" -g "$USER" /tmp/gmail-oauth-*.json /var/lib/delayrepay/secrets/
rm /tmp/gmail-oauth-*.json
```

Set `GMAIL_OAUTH_CLIENT_FILE` and `GMAIL_OAUTH_TOKEN_FILE` in the Pi `.env` to
the `/var/lib/delayrepay/secrets/` paths shown in the example. The reconciliation
scope is read-only and does not change Gmail messages.

On the first installation, the script copies the repository's existing SQLite database and catalogue into `/var/lib/delayrepay`. Later Git pulls do not overwrite live claim history.

Open `http://delayrepay.local` from a device on the same network. Nginx listens
on normal HTTP port 80 and forwards privately to the Python dashboard on 8765.

## Updating

```bash
cd delayrepay
git pull --ff-only
./deploy/raspberry-pi/install.sh
```

## Operations

```bash
sudo systemctl status delayrepay.service
systemctl list-timers 'delayrepay-*'
sudo systemctl start delayrepay-collect.service
sudo systemctl start delayrepay-email.service
sudo systemctl start delayrepay-reconcile.service
sudo systemctl start delayrepay-backup.service
journalctl -u delayrepay.service -n 100
journalctl -u delayrepay-collect.service -n 100
journalctl -u delayrepay-reconcile.service -n 100
```

Backups are written safely with SQLite's backup API to
`/var/lib/delayrepay/backups`. To restore one, stop the dashboard, copy the
chosen backup over `/var/lib/delayrepay/delayrepay.sqlite`, set ownership to the
service user, and start the dashboard again.

## Cut over from Windows

1. Stop the Windows dashboard and scheduled collection after the Pi has passed
   its manual checks.
2. Copy the newest `data-store/delayrepay.sqlite` and service catalogue to the
   Pi before the first install, or restore them into `/var/lib/delayrepay`.
3. Start and verify collection, reconciliation, backup, and email services.
4. Reboot the Pi and confirm the dashboard and timers return.
5. Disable the Codex automation named `Reconcile Delay Repay emails` only after
   the Pi reconciliation service succeeds, preventing two writers.
