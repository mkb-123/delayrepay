# MKC ↔ EUS Delay Repay

Local Python tool for monitoring weekday trains between Milton Keynes Central and London Euston and identifying possible Delay Repay claims.

It monitors:

- MKC → EUS departures from 06:00 to 08:00
- EUS → MKC departures from 16:30 to 18:00
- Direct journeys scheduled to take no more than 60 minutes

The active application is the Python CLI. The original Next.js implementation and its data are retained under `legacy/`.

## Quick start

Run the registered Windows task from PowerShell:

```powershell
Start-ScheduledTask -TaskName "MKC EUS Delay Repay"
```

The task runs automatically at 19:00 Monday–Friday. It collects the latest weekday and creates a 10-day action report using plain PowerShell, WSL, and Python. No AI model is involved.

Check progress and output:

```powershell
Get-Content C:\Users\mitzb\code\delayrepay\data-store\scheduled-task.log -Tail 50
Get-Content C:\Users\mitzb\code\delayrepay\data-store\output\latest.md
```

The structured version is `data-store/output/latest.json`.

## Setup in WSL

Requirements:

- Python 3.11 or newer
- A Realtime Trains API access or refresh token

```bash
cd /mnt/c/Users/mitzb/code/delayrepay
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cp .env.example .env
```

Set either `RTT_ACCESS_TOKEN` or `RTT_REFRESH_TOKEN` in `.env`. The file is ignored by Git, and credentials are never stored or logged.

If you do not install the package, run commands from the repository with:

```bash
export PYTHONPATH=python
python3 -m delayrepay --help
```

## Workflow

### 1. Discover the timetable

Discovery is an occasional catalogue refresh. It is the expensive step and should not be scheduled.

```bash
python -m delayrepay discover --date 2026-09-28
python -m delayrepay discover --date 2026-09-28 --direction evening
python -m delayrepay discover --date 2026-10-02 --lookback-days 14
```

Direction-scoped discovery preserves the other direction. A lookback discovers only the latest occurrence of each weekday, with at most five timetable snapshots. Relevant services are saved in `data-store/service-catalogue.json`; `service-catalogue.md` is its readable view.

Cached discovery makes no RTT calls:

```bash
python -m delayrepay discover --date 2026-09-25 --from-cache
```

### 2. Collect running data

Preview calls without contacting RTT:

```bash
python -m delayrepay collect --date 2026-10-02 --lookback-days 10 --dry-run
```

Collect one day or a range:

```bash
python -m delayrepay collect --date 2026-10-02
python -m delayrepay collect --date 2026-10-02 --lookback-days 10
```

Collection uses the catalogue and upserts services into `data-store/delayrepay.sqlite`. Missing catalogue weekdays are skipped rather than recorded as empty successful runs.

### 3. Generate output

```bash
python -m delayrepay report --date 2026-10-02
python -m delayrepay report --date 2026-10-02 --lookback-days 10 --action-only
python -m delayrepay report-week --week-start 2026-09-28
```

Reporting makes no RTT calls. It queries SQLite, writes `data-store/output/latest.json`, then renders `latest.md` from that JSON. Each run replaces the previous output instead of accumulating duplicate report files.

`--lookback-days` and its alias `--lookup-days` work with discovery, collection, and reporting.

## Claims

Copy a `serviceId` from `latest.json`:

```bash
python -m delayrepay claim --date 2026-10-02 --service "SERVICE_ID"
python -m delayrepay claim --date 2026-10-02 --service "SERVICE_ID" --undo
```

Claim acknowledgement is stored independently in SQLite and survives service refreshes. It records only that you acknowledged the item; it does not submit a claim.

## Storage

- `data-store/service-catalogue.json`: discovered timetable configuration
- `data-store/delayrepay.sqlite`: services, collection runs, assessments, and claims
- `data-store/output/latest.json`: complete structured report for visualisation
- `data-store/output/latest.md`: concise human-readable report
- `data-store/scheduled-task.log`: Windows task output

The SQLite database and catalogue are tracked in Git. SQLite WAL and shared-memory files, generated output, logs, and `.env` are ignored. Scheduled updates modify the local database; updating GitHub still requires a commit and push.

The current Avanti West Coast (`VT`) and London Northwestern Railway (`LM`) policies are defined in `python/delayrepay/rules.py` with official source URLs and verification dates. Ambiguous evidence is classified as `Needs review`.

## Validation

Tests remain deferred while the real workflow is being finalised. The current no-network checks are:

```bash
python -m compileall -q python
python -m delayrepay --help
python -m delayrepay collect --date 2026-10-02 --dry-run
```
