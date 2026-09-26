# MKC EUS Delay Repay Tracker

Static, GitHub Pages friendly tracker for weekday rail services between Milton Keynes Central and London Euston.

The app collects RTT running data in GitHub Actions, retains the rail history on a `rail-data` branch, publishes a static Next.js dashboard to GitHub Pages, and stores personal claim acknowledgements in the browser. Clicking **Mark as claimed** is only a local acknowledgement; it does not submit anything to a train operator.

## Scope

- Morning: MKC to EUS, weekday scheduled departures from 06:00 to 08:00.
- Evening: EUS to MKC, weekday scheduled departures from 16:30 to 18:00.
- Operators currently encoded from official Delay Repay terms: Avanti West Coast and London Northwestern Railway.
- Ticket profile default: any permitted operator.
- No compensation amount calculation, account system, notifications, or automatic claim submission.

## Prerequisites

- Node.js 22 or newer.
- pnpm 11.
- RTT API credentials for the current Realtime Trains API.
- A GitHub repository with Pages enabled from GitHub Actions.

## Local Setup

Install dependencies:

```powershell
pnpm install
```

Create a local environment file from the example:

```powershell
Copy-Item .env.example .env
```

For local collection, put one RTT token in `.env`:

- `RTT_ACCESS_TOKEN`
- `RTT_REFRESH_TOKEN`

The `.env` file is ignored by Git. The static dashboard does not read RTT tokens; local tokens are used only by the collection script.

Run checks:

```powershell
pnpm test
pnpm typecheck
pnpm build
```

Run the local development server:

```powershell
pnpm dev
```

Generate a local Delay Repay brief from retained data:

```powershell
pnpm brief
```

Fetch current RTT evidence and then generate the brief:

```powershell
pnpm brief --fetch
```

## Data Collection

Collect rail data locally for the latest relevant weekday:

```powershell
pnpm ingest
```

Backfill a specific weekday:

```powershell
$env:INGEST_DATE = "2026-09-25"
pnpm ingest
```

Collection writes to `data-store/`, which is intentionally ignored by Git. The static dashboard is built from `public/data/archive.json`, produced by:

```powershell
pnpm publish:data
```

## GitHub Pages Deployment

For scheduled collection on GitHub, add one repository secret:

- `RTT_ACCESS_TOKEN` or `RTT_REFRESH_TOKEN`

Enable Pages using **GitHub Actions** as the source.

The workflow in `.github/workflows/pages.yml`:

- runs tests;
- opens or creates the durable `rail-data` branch;
- collects current RTT evidence;
- commits `archive.json`, retained observations, and run logs to `rail-data`;
- builds the static Next.js dashboard;
- deploys the `out/` directory to Pages.

Scheduled GitHub Actions can be delayed or skipped by GitHub. The dashboard shows collection status and keeps the last retained archive rather than inventing missing rail data.

## Claim Acknowledgements

Claim acknowledgements are stored in browser `localStorage`. They persist after refresh and normal browser restarts on that device. They are not synced to GitHub or any server.

Use **Backup** and **Import** in the dashboard to preserve acknowledgements before clearing browser storage or moving device.

## Compensation Rules

The rule engine is separate from ingestion and UI code:

- `src/domain/rules.ts` stores operator rule metadata, source URLs, and verification date.
- `src/domain/assess.ts` classifies services as `NO_CLAIM`, `POTENTIAL`, or `NEEDS_REVIEW`.
- `src/domain/claims.ts` handles local `CLAIMED` acknowledgement state.

Rules were verified on 2026-09-25 from official operator pages. Update rule versions when operator terms change.

## Official Claim Links

- Avanti West Coast: <https://delayrepay.avantiwestcoast.co.uk/>
- London Northwestern Railway: <https://londonnorthwesternrailway.delayrepaycompensation.com/>

## Tests

The automated tests cover:

- on-time, 5-minute, 14-minute, exactly 15-minute, 15+ minute, and 30+ minute delays;
- cancellations;
- earlier-arriving valid alternatives;
- cross-operator alternatives under ticket restrictions;
- missing and incomplete RTT data;
- duplicate-safe ingestion and status-preserving claim logic boundaries.

Run:

```powershell
pnpm test
```
