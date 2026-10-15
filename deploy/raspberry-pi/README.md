# Raspberry Pi deployment

This setup targets Raspberry Pi OS or another Debian-based distribution with systemd. It runs without an AI model.

## What it installs

- `delayrepay.service`: dashboard on port 8765, restarted after failures and boots;
- `delayrepay-collect.timer`: ten-day refresh at 19:00 Monday–Friday;
- `delayrepay-email.timer`: outstanding-claims email at 09:00 Saturday;
- `delayrepay-reconcile.timer`: read-only Gmail claim reconciliation at 20:00 daily;
- `delayrepay-claim-worker.timer`: checks every five minutes for journeys explicitly selected in the dashboard;
- `delayrepay-claim-session.timer`: checks both saved operator sessions each morning;
- `delayrepay-backup.timer`: consistent SQLite backup at 02:30 daily, retaining 30;
- Avahi/mDNS access at `http://delayrepay.local` through Nginx;
- runtime SQLite and catalogue files in `/var/lib/delayrepay`, separate from Git.

## What is reproducible

Git is the source of truth for the Delay Repay code, Python dependencies,
Nginx proxy, mDNS alias, systemd services, and schedules. Running `install.sh`
on a clean Raspberry Pi OS installation recreates all of them.

The live database and credentials cannot safely be stored in Git. They are
preserved in a private recovery bundle containing:

- SQLite history and claim acknowledgements;
- the discovered service catalogue;
- `.env` and RTT/email settings;
- Gmail OAuth client and token files, when configured.
- authenticated operator browser profiles used to access saved season tickets.

Store that bundle on encrypted removable storage or a private NAS. This
repository only rebuilds Delay Repay. Home Assistant and any other software on
the Pi require their own configuration and backup procedure.

## Before replacing or reflashing the SD card

Connect or mount the private backup destination, then run:

```bash
cd ~/delayrepay
./deploy/raspberry-pi/export-state.sh /mnt/backup/delayrepay-recovery
```

The command prints the new timestamped bundle path. Copy that entire directory
off the SD card. It contains secrets in plain text, so the destination must be
private and encrypted.

For automatic off-device database copies, set this in `.env` after mounting a
USB disk or NAS permanently:

```dotenv
DELAYREPAY_BACKUP_MIRROR_DIR=/mnt/backup/delayrepay-database
```

The nightly backup then writes locally and to that directory. It fails loudly
if the configured mount disappears, avoiding a false sense of protection.

## Rebuild from a fresh Raspberry Pi OS image

Configure the network and SSH during Raspberry Pi OS imaging. After the first
boot, copy the newest recovery bundle onto the Pi or mount the device that
contains it, then run:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/mkb-123/delayrepay.git ~/delayrepay
cd ~/delayrepay
install -m 600 /mnt/backup/delayrepay-recovery/<bundle>/.env .env
chmod +x deploy/raspberry-pi/*.sh scripts/linux/*.sh
./deploy/raspberry-pi/install.sh
./deploy/raspberry-pi/restore-state.sh \
  /mnt/backup/delayrepay-recovery/<bundle>/delayrepay.sqlite \
  /mnt/backup/delayrepay-recovery/<bundle>
./deploy/raspberry-pi/verify.sh
```

Replace `<bundle>` with the timestamped directory created by `export-state.sh`.
The restore checks SQLite integrity before replacing live data. The final
verification checks the web service, proxy, mDNS publisher, timers, database,
and optional Gmail authorization.

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

### Operator account authorization

Store the account credentials outside Git:

```dotenv
# /var/lib/delayrepay/secrets/operator-accounts.env (mode 0600)
AVANTI_DELAY_REPAY_EMAIL=you@example.com
AVANTI_DELAY_REPAY_PASSWORD=your-password
LNR_DELAY_REPAY_EMAIL=you@example.com
LNR_DELAY_REPAY_PASSWORD=your-password
```

The worker uses them only when the saved session needs ordinary
reauthentication. CAPTCHA or additional verification still pauses the claim.

From the Raspberry Pi desktop, or a VNC session with a graphical display, run:

```bash
cd ~/delayrepay
.venv/bin/delayrepay claim-login --operator VT
.venv/bin/delayrepay claim-login --operator LM
```

Log into each Delay Repay account, complete any CAPTCHA, and confirm the saved
season ticket and compensation preference. Return to the terminal and press
Enter to save the browser profile. The worker uses those sessions and will stop
with `NEEDS_LOGIN` when one expires; it never stores account passwords in Git.

If the Pi has no attached desktop, reconnect with a local port forward:

```bash
ssh -L 6080:127.0.0.1:6080 bhakta-pi@pi.local
cd ~/delayrepay
./scripts/linux/claim-login-vnc.sh VT
```

Open `http://localhost:6080/vnc.html` on the computer running SSH. Finish the
login and press Enter in the terminal, then repeat with `LM`. noVNC binds only
to `127.0.0.1` on the Pi, so it is not exposed to the home network or internet.

For a faster login from Windows, use a normal laptop browser instead of VNC:

```powershell
.\scripts\windows\claim-login.ps1 -Operator VT
.\scripts\windows\claim-login.ps1 -Operator LM
```

Each command opens Chrome or Edge locally, waits for you to finish login and
CAPTCHA, then copies only the relevant session cookies over SSH to
`/var/lib/delayrepay/secrets`. Cookie exports are deleted from the laptop's
temporary directory after transfer and are never stored in Git.

On the first installation, the script copies the repository's existing SQLite database and catalogue into `/var/lib/delayrepay`. Later Git pulls do not overwrite live claim history.

Open `http://delayrepay.local` from a device on the same network. Nginx listens
on normal HTTP port 80 and forwards privately to the Python dashboard on 8765.

## Updating without losing data

The Pi owns live state that Git does not contain, all under
`/var/lib/delayrepay` (outside the checkout, so `git pull` cannot touch it):

- `delayrepay.sqlite`: claim history, acknowledgements, lifecycle, submissions;
- `secrets/`, `browser-profiles/`: Gmail OAuth, operator sessions;
- `backups/`, `claim-screenshots/`, `output/`, `logs/`;
- `~/delayrepay/.env`: credentials (ignored by Git).

Never copy a SQLite file from the laptop over the Pi's, and never delete
`/var/lib/delayrepay`. Code travels through Git only. To deploy:

1. On the laptop, commit and `git push` to `main`.
2. SSH to the Pi (from Windows: `wsl ssh bhakta-pi@pi.local`) and run:

   ```bash
   cd ~/delayrepay
   ./deploy/raspberry-pi/update.sh   # add --full to force install.sh
   ```

The script takes a verified database snapshot, refuses to run if the checkout
has real local edits, fast-forwards `main`, reruns `install.sh` (which only
seeds the database if none exists), restarts services, runs `verify.sh`, and
prints row counts before and after plus rollback and restore commands.

Schema changes are additive and applied automatically when the app starts
(`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`).

Manual equivalent: `export-state.sh` or `python -m delayrepay backup`, then
`git pull --ff-only`, `./deploy/raspberry-pi/install.sh`, `./deploy/raspberry-pi/verify.sh`.

If something breaks: `git checkout <old-commit> && ./deploy/raspberry-pi/install.sh`
to roll back code, or `restore-state.sh <snapshot>` to roll back data.
Disk is tight (about 92% used); prune `data-store/backups` and old files in
`/var/lib/delayrepay/backups` if the snapshot fails.

## Operations

```bash
sudo systemctl status delayrepay.service
systemctl list-timers 'delayrepay-*'
sudo systemctl start delayrepay-collect.service
sudo systemctl start delayrepay-email.service
sudo systemctl start delayrepay-reconcile.service
sudo systemctl start delayrepay-claim-worker.service
sudo systemctl start delayrepay-backup.service
journalctl -u delayrepay.service -n 100
journalctl -u delayrepay-collect.service -n 100
journalctl -u delayrepay-reconcile.service -n 100
journalctl -u delayrepay-claim-worker.service -n 100
```

The first queued claim for Avanti and the first for LNR stop at the final form
confirmation and save a screenshot. Review it in the dashboard and choose
`Approve form & submit`. This calibrates that operator adapter; subsequent
journeys selected in the dashboard may be submitted without that extra step.
Failures retain the last safe step and a screenshot, and can be retried from the
journey detail view.

Backups are written safely with SQLite's backup API to
`/var/lib/delayrepay/backups`. Use `export-state.sh` for a complete portable
recovery bundle and `restore-state.sh` to restore one. Run `verify.sh` after an
install, restore, update, or reboot.

## Cut over from Windows

1. Stop the Windows dashboard and scheduled collection after the Pi has passed
   its manual checks.
2. Copy the newest `data-store/delayrepay.sqlite` and service catalogue to the
   Pi before the first install, or restore them into `/var/lib/delayrepay`.
3. Start and verify collection, reconciliation, backup, and email services.
4. Reboot the Pi and confirm the dashboard and timers return.
5. Disable the Codex automation named `Reconcile Delay Repay emails` only after
   the Pi reconciliation service succeeds, preventing two writers.
