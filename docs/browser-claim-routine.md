# Browser claim routine (low-token)

Preferred path for routine claims is the laptop worker (`run-claim-worker.ps1`),
which uses no AI. Use this routine when an agent has to submit claims in a logged-in
browser, for example before the worker sessions exist. It costs one tool call per
claim instead of a long click-and-screenshot walkthrough.

## Steps for an agent

1. Read the queue from the Pi database (no browser needed):
   `claim_submissions` joined to `services` (`payload_json` has origin, destination,
   scheduledDeparture, rawDelayMinutes). Skip rows already `SUBMITTED`.
2. The user logs in to the operator portal in the browser pane (never enter
   passwords or solve CAPTCHAs).
3. Per journey: navigate to the claim form, load `scripts/browser/lnr-claim-form.js`
   (LNR only), call `lnrClaim({... submit: true})`. Use `delay` from `rawDelayMinutes`.
4. Submitting reloads the page. Read the reference from the first row of the
   My Claims table (`table tr` cells 0 to 2).
5. Record each result on the Pi with `Database.record_submitted_claim(service_id,
   operator_code, now, reference)`. This marks the queue row and lifecycle as
   SUBMITTED so the worker never double-claims. Do this immediately.

Check the portal's My Claims list for existing claims on that date before submitting.
Avanti (VT) has no routine yet; build one from its form once and add it here.

## Notes

- LNR hosts both London Northwestern Railway and West Midlands Railway trains. The
  "visit the West Midlands Trains website" notice is generic; claims go through.
- Delay length is a button: 15+ for 15 to 29 minutes, 30+ from 30.
- The agent needs the browser click permission allowed
  (`mcp__Claude_Browser__computer` in `.claude/settings.local.json`, local only).
