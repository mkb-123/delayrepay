# MKC ↔ EUS Delay Repay

A private, local Python tool that tracks weekday trains between Milton Keynes Central and London Euston and produces a short Delay Repay briefing.

It separates three jobs so routine collection stays cheap:

1. `discover` finds the relevant timetable once and saves a service catalogue.
2. `collect` requests only those known services for a date.
3. `report` reads stored data and makes no RTT calls.

The supported application is the Python CLI. The earlier Next.js viewer and its inactive GitHub Pages workflows are archived under `legacy/nextjs/` for reference.

## Run it

The quickest option is the registered Windows task. Open PowerShell and run:

```powershell
Start-ScheduledTask -TaskName "MKC EUS Delay Repay"
```

Wait about a minute, then read the latest output:

```powershell
Get-Content C:\Users\mitzb\code\delayrepay\data-store\scheduled-task.log -Tail 50
Get-ChildItem C:\Users\mitzb\code\delayrepay\data-store\reports | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

The task also runs automatically at 19:00 every Monday–Friday. It uses WSL and plain Python; no AI model is involved.

To run a specific date manually in WSL:

```bash
cd /mnt/c/Users/mitzb/code/delayrepay
export PYTHONPATH=python
python3 -m delayrepay collect --date 2026-09-28
python3 -m delayrepay report --date 2026-09-28
python3 -m delayrepay report --date 2026-09-28 --lookback-days 14 --action-only
```

The report is saved as `data-store/reports/2026-09-28.md`. Collection requires that weekday to exist in `data-store/service-catalogue.json` and that `.env` contains a valid RTT token.

Every command prints timestamped progress to the terminal. Discovery shows lineup and candidate progress, collection shows each catalogue service, and reporting shows the number of assessments and output path. The Windows task captures the same output in `data-store/scheduled-task.log`. Authentication tokens are never included in logs.

## Requirements

- Python 3.11 or newer
- A current Realtime Trains API access or refresh token

From WSL, create and activate a virtual environment, then install the local package:

```bash
cd /mnt/c/Users/mitzb/code/delayrepay
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

Copy `.env.example` to `.env` and add either `RTT_ACCESS_TOKEN` or `RTT_REFRESH_TOKEN`. `.env` is ignored by Git. Credentials are never written to stored data or logs.

## 1. Discover relevant trains

Run this manually for a representative date for each weekday. Discovery searches both station lineups and checks service details. Running it again for the same weekday replaces that weekday’s catalogue entries.

```bash
python -m delayrepay discover --date 2026-09-28
python -m delayrepay discover --date 2026-09-28 --direction evening
python -m delayrepay discover --date 2026-10-02 --lookback-days 14
```

Repeat for Tuesday through Friday if their timetables differ. Direction-scoped discovery replaces only that weekday and direction, preserving the other half of the catalogue. Results are saved to `data-store/service-catalogue.json` and a readable `data-store/service-catalogue.md`. Only direct passenger services in the configured windows and scheduled to take no more than 60 minutes are retained.

To bootstrap a weekday from retained RTT observations without making any API calls:

```bash
python -m delayrepay discover --date 2026-09-25 --from-cache
```

## 2. Collect a day

Preview the exact RTT detail calls without using the API:

```bash
python -m delayrepay collect --date 2026-09-28 --dry-run
python -m delayrepay collect --date 2026-10-02 --lookback-days 14 --dry-run
```

Collect the running data:

```bash
python -m delayrepay collect --date 2026-09-28
python -m delayrepay collect --date 2026-10-02 --lookback-days 14
```

Collection uses the saved catalogue and makes one detail request per known train. It does not rediscover the timetable. Results are upserted to `data-store/daily/YYYY-MM-DD.json`, so rerunning a date replaces that date rather than creating duplicates.

## 3. Generate a briefing

```bash
python -m delayrepay report --date 2026-09-28
python -m delayrepay report --date 2026-09-28 --action-only
python -m delayrepay report --date 2026-09-28 --lookback-days 14
python -m delayrepay report-week --week-start 2026-09-28
```

Reports are written under `data-store/reports/` as matching `.json` and `.md` files. The structured JSON is written first and contains the services, calculations, alternatives, explanations, rule references, and summary counts. Markdown is then rendered from that saved JSON. This lets you build another visualisation directly from the report JSON without rerunning assessment. `--lookback-days 14` combines any stored dates in the 14 calendar days ending on `--date`; if `--date` is omitted, it ends today. It reads local files only and makes no RTT calls.

`--lookback-days` is supported by all three stages, with `--lookup-days` accepted as an alias. Discovery uses only the latest occurrence of each weekday in the range, so a 14-day lookup performs at most five timetable snapshots. Collection processes every weekday in the range. Reporting combines every stored day in the range.

## Claim acknowledgement

Copy a `serviceId` from the daily JSON and run:

```bash
python -m delayrepay claim --date 2026-09-28 --service "SERVICE_ID"
python -m delayrepay claim --date 2026-09-28 --service "SERVICE_ID" --undo
```

Acknowledgements persist in `data-store/claims.json` and disappear from the outstanding count on the next report. Marking a journey as claimed does not submit a claim to an operator.

## Stored data and rules

Current Python state is plain JSON or Markdown under `data-store/`: the service catalogue, normalized daily records, reports, and claim acknowledgements. The original TypeScript archive, raw observations, old brief, and ingestion logs are retained under `legacy/data-store/`. This keeps the active tool local and inspectable while separating its data from the previous implementation.

The current Avanti West Coast (`VT`) and London Northwestern Railway (`LM`) rules live in `python/delayrepay/rules.py`, including official sources and verification dates. Ambiguous cancellations, missing arrivals, unsupported operators, and journeys with a potentially earlier alternative are classified as `Needs review`.

## Scheduling

The repository includes `scripts/daily-brief.ps1` for Windows Task Scheduler. The local task runs through WSL at 19:00 every weekday, collects the current day once, then produces an action-only report covering the last 10 calendar days. It writes reports under `data-store/reports/` and appends command output to `data-store/scheduled-task.log`. Do not schedule `discover`; rerun it only when you want to refresh the catalogue.

Tests are intentionally deferred while the catalogue and report shapes are being finalised. The current no-network check is:

```bash
python -m compileall -q python
python -m delayrepay --help
```
