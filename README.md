# MKC ↔ EUS Delay Repay

A private Python tracker for weekday journeys between Milton Keynes Central and London Euston. It collects live running data from Realtime Trains, keeps the history in SQLite, explains possible Delay Repay eligibility, and provides a mobile dashboard on your home network.

It monitors direct services taking no more than 60 minutes: MKC → EUS from 06:00–08:00 and EUS → MKC from 16:30–18:30.

## Repository layout

- `python/delayrepay/domain/`: compensation assessment and operator rules
- `python/delayrepay/ingestion/`: RTT client and service normalisation
- `python/delayrepay/storage/`: SQLite persistence
- `python/delayrepay/web/`: Flask API, dashboard HTML, CSS, and JavaScript
- `python/delayrepay/workflows.py`: discovery, collection, and reporting orchestration
- `data-store/service-catalogue.json`: tracked, stable timetable catalogue
- `data-store/delayrepay.sqlite`: tracked service, assessment, and claim history
- `data-store/output/`: generated JSON and Markdown reports, ignored by Git
- `scripts/`: Windows scheduled collector and local-server setup
- `legacy/`: archived implementations and old data

The complete Raspberry Pi install, backup, restore, and clean-image rebuild
procedure is documented in
[`deploy/raspberry-pi/README.md`](deploy/raspberry-pi/README.md). Machine config
is generated from the repository; live data and secrets use a private recovery
bundle outside Git.

Source code, the catalogue, and SQLite history are committed. Credentials, logs, SQLite WAL files, virtual environments, and generated reports are ignored.

## Install in WSL

Requirements are WSL with Ubuntu, Python 3.11 or newer, and a Realtime Trains API token.

From PowerShell, install Ubuntu's virtual-environment support once if needed:

```powershell
wsl -u root apt-get update
wsl -u root apt-get install -y python3-venv
```

Then run in WSL:

```bash
cd /mnt/c/Users/mitzb/code/delayrepay
python3 -m venv .venv
.venv/bin/python -m pip install -e .
cp .env.example .env
```

Put either `RTT_ACCESS_TOKEN` or `RTT_REFRESH_TOKEN` in `.env`. Never put a real token in `.env.example`; `.env` is ignored by Git.

RTT calls are paced and automatically retry rate limits with exponential backoff. The defaults retry five times, starting at roughly 15 seconds and capping at two minutes. They can be adjusted with `RTT_MIN_INTERVAL_MS`, `RTT_RATE_LIMIT_RETRIES`, `RTT_RATE_LIMIT_WAIT_MS`, and `RTT_RATE_LIMIT_MAX_WAIT_MS`.

## Run the dashboard

In WSL:

```bash
cd /mnt/c/Users/mitzb/code/delayrepay
.venv/bin/delayrepay serve
```

The WSL listener is `http://127.0.0.1:8765`.

To expose it to your phone on the same Wi-Fi and start it at Windows login, open **PowerShell as Administrator** and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
C:\Users\mitzb\code\delayrepay\scripts\setup-local-server.ps1
```

This creates a hidden `MKC EUS Delay Repay Server` login task with automatic restart, a Windows port-forward on port `8787`, and a firewall rule allowing that port only from the local subnet. It prints the phone URL. The laptop must be signed in, awake, and connected to the home network.

Server logs rotate under `logs/server.log` at 5 MB with three backups. Useful Windows commands are:

```powershell
Get-ScheduledTask -TaskName "MKC EUS Delay Repay Server"
Start-ScheduledTask -TaskName "MKC EUS Delay Repay Server"
Get-Content C:\Users\mitzb\code\delayrepay\logs\server.log -Tail 50
```

## Dashboard behavior

The dashboard defaults to the last ten days and supports 30-day, complete-history, and custom ranges. It filters by direction, operator, and assessment status.

The **What to claim** section selects the longest confidently claimable delay for each date and direction. This is conditional on that being the train actually travelled on; incomplete data is shown as `Needs review` rather than a definite recommendation.

Use **Update data** to preview and run either operation from the dashboard:

- **Discover timetable** refreshes the reusable service catalogue. The preview shows its bounded RTT request count.
- **Collect running data** fetches missing/incomplete dates by default, or can explicitly recollect the selected range.

Both run in the background with visible progress and share the same collection lock and RTT rate-limit backoff as the CLI.

`Claim this train` adds that exact journey to the Raspberry Pi submission queue and starts the worker immediately. The first claim for each operator runs in calibration mode: the form is completed but stops before its final submit button, and the dashboard shows a screenshot. After you approve that form once, later selected claims can submit automatically. The five-minute timer is a fallback for interrupted runs. `Mark as already claimed` remains a manual acknowledgement for claims submitted elsewhere.

The queue is deliberately journey-specific: select only the train actually travelled on. If an operator login expires, CAPTCHA appears, or the form changes, the item becomes **Login needed** or **Check needed** instead of being guessed or submitted twice.

## Data workflow

### 1. Discover relevant trains occasionally

Discovery is never scheduled automatically. It joins the origin and destination station lineups without fetching every service detail, so a full five-weekday refresh uses 20 RTT lineup requests:

```bash
.venv/bin/delayrepay discover --date 2026-09-28
.venv/bin/delayrepay discover --date 2026-09-28 --direction evening
.venv/bin/delayrepay discover --date 2026-10-02 --lookback-days 14
```

Cached discovery makes no RTT calls:

```bash
.venv/bin/delayrepay discover --date 2026-09-25 --from-cache
```

### 2. Collect running data

Preview exact calls without contacting RTT:

```bash
.venv/bin/delayrepay collect --date 2026-10-02 --lookback-days 10 --dry-run
```

Collect data:

```bash
.venv/bin/delayrepay collect --date 2026-10-02
.venv/bin/delayrepay collect --date 2026-10-02 --lookback-days 10
```

Collection joins two station lineups per direction and upserts the matching catalogue services into SQLite. A fully catalogued weekday uses four RTT requests regardless of how many trains run. Missing or ambiguous lineup evidence remains incomplete and is never invented.

### 3. Generate optional files

The dashboard reads SQLite directly. JSON and Markdown remain useful portable outputs:

```bash
.venv/bin/delayrepay report --date 2026-10-02
.venv/bin/delayrepay report --date 2026-10-02 --lookback-days 10 --action-only
.venv/bin/delayrepay report-week --week-start 2026-09-28
```

Each run replaces `data-store/output/latest.json` and `latest.md`. Reporting makes no RTT calls.

## Existing weekday collector

Install or repair the scheduled task with:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
& ".\scripts\setup-daily-task.ps1"
```

The `MKC EUS Delay Repay` Windows task runs at 19:00 Monday–Friday, catches up when the laptop next becomes available, and can run on battery. Run it manually with:

```powershell
Start-ScheduledTask -TaskName "MKC EUS Delay Repay"
```

It recollects the latest ten calendar days and generates a ten-day action report without an AI model. Output is logged to `data-store/scheduled-task.log`.

The scheduling workflow itself is implemented in Python and can be run on any platform:

```bash
.venv/bin/delayrepay daily-brief
```

## Saturday email

The reusable agent prompt at
[`prompts/reconcile-gmail-claims.md`](prompts/reconcile-gmail-claims.md) defines
the cautious workflow for matching Gmail claim responses to stored journeys.
It requires read-only mailbox handling and leaves ambiguous matches for review.

The `MKC EUS Delay Repay Email` task sends a short list of outstanding claim suggestions and decisions at 09:00 every Saturday. It omits acknowledged days and claimed journeys.

Add these values to the ignored `.env` file:

```dotenv
DELAYREPAY_EMAIL_TO=you@example.com
GMAIL_SMTP_USER=you@gmail.com
GMAIL_APP_PASSWORD=your_16_character_app_password
DELAYREPAY_DASHBOARD_URL=http://delayrepay.local:8765
```

Use a Google app password rather than your normal Gmail password. Then install or repair the task:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
& ".\scripts\setup-weekly-email-task.ps1"
```

Preview without sending or send immediately:

```bash
.venv/bin/delayrepay email-summary --dry-run
.venv/bin/delayrepay email-summary
```

Both commands choose the latest weekday and a ten-day lookback by default. PowerShell, Bash, Task Scheduler, and systemd only launch these Python commands.

## Raspberry Pi

For an always-on Raspberry Pi deployment with systemd services, weekday
collection, daily Gmail claim reconciliation, daily SQLite backups, Saturday
email, mDNS, and SQLite migration, follow
[deploy/raspberry-pi/README.md](deploy/raspberry-pi/README.md). The home-network
dashboard address is `http://delayrepay.local`.

### Enable automatic claims

The Pi installer installs Chromium, Playwright, a claim-worker timer, and a daily operator-session health check. Log in
to each operator once from a graphical Pi session or VNC terminal:

```bash
cd ~/delayrepay
.venv/bin/delayrepay claim-login --operator VT
.venv/bin/delayrepay claim-login --operator LM
```

On a Windows laptop, the faster setup avoids VNC entirely. From PowerShell in
the repository, run the following once for each operator. A normal local Chrome
window opens; after login and CAPTCHA, the script transfers only that site's
session cookies to the protected Pi secrets directory:

```powershell
.\scripts\windows\claim-login.ps1 -Operator VT
.\scripts\windows\claim-login.ps1 -Operator LM
```

Complete any CAPTCHA and confirm that the season ticket and preferred payment
method are saved in each account. Close neither browser manually: return to the
terminal and press Enter so Playwright saves the session cleanly. Sessions live
under `/var/lib/delayrepay/browser-profiles`, outside Git.

For a headless Pi that is only accessible through SSH, open a tunnel from the
computer running SSH:

```bash
ssh -L 6080:127.0.0.1:6080 bhakta-pi@pi.local
cd ~/delayrepay
./scripts/linux/claim-login-vnc.sh VT
```

Open `http://localhost:6080/vnc.html`, complete the login, then return to the
SSH terminal and press Enter. Repeat the command with `LM`. The temporary
browser is reachable only through the SSH tunnel and closes with the command.

Run the queue immediately or inspect its log with:

```bash
sudo systemctl start delayrepay-claim-worker.service
journalctl -u delayrepay-claim-worker.service -n 100
```

The worker never searches for claims itself. It processes only journeys marked
**Claim this train** in the dashboard. A CAPTCHA or expired session requires
running `claim-login` again.

## Claims and rules

CLI acknowledgement remains available:

```bash
.venv/bin/delayrepay claim --date 2026-10-02 --service "SERVICE_ID"
.venv/bin/delayrepay claim --date 2026-10-02 --service "SERVICE_ID" --undo
```

Avanti West Coast (`VT`) and London Northwestern Railway (`LM`) policies and official source links live in `python/delayrepay/domain/rules.py`. Missing or ambiguous evidence is classified as `Needs review`.

## Validation

No committed automated test suite has been added yet. Safe local checks are:

```bash
.venv/bin/python -m compileall -q python
.venv/bin/delayrepay --help
.venv/bin/delayrepay collect --date 2026-10-02 --dry-run
curl http://127.0.0.1:8765/health
```
