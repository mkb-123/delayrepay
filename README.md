# MKC ↔ EUS Delay Repay

A private Python tracker for weekday journeys between Milton Keynes Central and London Euston. It collects live running data from Realtime Trains, keeps the history in SQLite, explains possible Delay Repay eligibility, and provides a mobile dashboard on your home network.

It monitors direct services taking no more than 60 minutes: MKC → EUS from 06:00–08:00 and EUS → MKC from 16:30–18:00.

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

`Refresh RTT` first shows the missing or incomplete dates and estimated request count. Confirmation collects only those weekdays. It never runs timetable discovery. Web refresh and scheduled collection share a lock and cannot run concurrently.

`Mark as claimed` is an acknowledgement only. It updates SQLite and does not submit anything to a train operator. Claim and undo changes persist after restart.

## Data workflow

### 1. Discover relevant trains occasionally

Discovery is the expensive step and is never scheduled automatically:

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

### 3. Generate optional files

The dashboard reads SQLite directly. JSON and Markdown remain useful portable outputs:

```bash
.venv/bin/delayrepay report --date 2026-10-02
.venv/bin/delayrepay report --date 2026-10-02 --lookback-days 10 --action-only
.venv/bin/delayrepay report-week --week-start 2026-09-28
```

Each run replaces `data-store/output/latest.json` and `latest.md`. Reporting makes no RTT calls.

## Existing weekday collector

The `MKC EUS Delay Repay` Windows task runs at 19:00 Monday–Friday. Run it manually with:

```powershell
Start-ScheduledTask -TaskName "MKC EUS Delay Repay"
```

It collects the latest weekday and generates a ten-day action report without an AI model. Output is logged to `data-store/scheduled-task.log`.

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
