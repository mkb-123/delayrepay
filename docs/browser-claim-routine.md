# Browser claim routine (low-token)

The preferred path for routine claims is the laptop worker (`run-claim-worker.ps1`),
which uses no AI. Use this routine when an agent has to submit claims in a logged-in
browser. It costs one tool call per claim instead of a click-and-screenshot walkthrough.

| Operator | Portal | Script | Entry point |
|---|---|---|---|
| LM (LNR, includes West Midlands Railway trains) | londonnorthwesternrailway.delayrepaycompensation.com | `scripts/browser/lnr-claim-form.js` | `lnrClaim`, from `index.cfm?action=myclaims.add` |
| VT (Avanti West Coast) | delayrepay.avantiwestcoast.co.uk | `scripts/browser/avanti-claim-form.js` | `awcClaim`, from `/en/` |

## Steps for an agent

1. Read the queue from the Pi database (no browser needed): `claim_submissions` joined
   to `services` (`payload_json` has origin, destination, scheduledDeparture,
   rawDelayMinutes). Skip rows already `SUBMITTED`.
2. The user logs in to each operator portal in the browser pane. Never enter
   passwords or solve CAPTCHAs.
3. Check the portal's claims list for existing claims on that date (avoid duplicates).
4. Load the script once into the page and keep it in `localStorage` so later calls are
   `eval('window.fn=' + localStorage.getItem('<key>'))` instead of re-sending the code
   (the page reloads after an LNR submit; Avanti is a single-page app).
5. Per journey call the routine with `submit: true`. Parameters: `date` (YYYY-MM-DD),
   `time` (HH:MM scheduled departure), `fromQuery/fromName`, `toQuery/toName`,
   `delay` (rawDelayMinutes). Avanti returns the reference; LNR reloads, so read the
   top row of the My Claims table.
6. Record each result on the Pi straight away with
   `Database.record_submitted_claim(service_id, operator_code, now, reference)`
   (run it in the Pi venv with `.env` loaded). That marks the queue row and lifecycle
   SUBMITTED so the worker can never double-claim.

## Hard-won details

- LNR hosts London Northwestern Railway and West Midlands Railway trains. The "visit
  the West Midlands Trains website" text on a train card is generic; claims go through.
- LNR delay buttons: 15+ for 15 to 29 minutes, 30+ from 30. Dates older than five days
  use the Bootstrap datepicker (same month only).
- Avanti ids such as `mat-input-3` change per page load. Fields are found by position
  and label. Typed dates are rejected; use the calendar for dates older than six days.
- Avanti: after "more than one ticket? No", clicking the saved ticket card
  ("London Terminals") fills ticket type and payment and jumps to the review page.
- Avanti bands: 15-29, 30-59, 60-119, 120+ minutes.
- The agent needs the browser click permission allowed
  (`mcp__Claude_Browser__computer` in `.claude/settings.local.json`, local only).
- Selectors can change when a portal is redeployed. If a routine times out, run it
  without `submit` and read the page state; then patch the script and this note.
