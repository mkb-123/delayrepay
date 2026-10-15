# Delay Repay agent instructions

These instructions apply to the whole repository. The active application is
the Python, Flask, and SQLite implementation under `python/delayrepay`.
`legacy/` is archived reference material and must not be used for new work.

## Product rules

- Monitor direct weekday MKC to EUS services scheduled from 06:00 to 08:00
  and EUS to MKC services scheduled from 16:30 to 18:30.
- Ignore services whose scheduled journey is longer than 60 minutes.
- The user's ticket is valid on any permitted operator, but an alternative
  service only affects an assessment when the applicable operator rules allow
  it. Never invent eligibility from incomplete data.
- Use `NO_CLAIM`, `POTENTIAL`, `NEEDS_REVIEW`, and `CLAIMED` consistently.
  Operator claim lifecycle states such as queued, submitted, approved,
  rejected, and paid are separate from the user's manual acknowledgement.
- A claim is based on the train the user says they travelled on. Within each
  date and direction, submitting one claim must prevent competing claim
  suggestions from appearing as undecided.
- Do not calculate compensation amounts.

## Runtime architecture

- The Raspberry Pi is the always-on server and owns the live SQLite database,
  dashboard, RTT collection, reports, backups, and scheduled jobs.
- Browser claim automation runs on the Windows laptop. Do not launch Chromium
  on the Pi: it has too little memory and previous attempts were unreliable.
- The laptop claim worker must reach Pi-only worker endpoints through an SSH
  tunnel. Do not expose claim-control endpoints or browser sessions to the
  home network or Internet.
- Store operator browser profiles on the laptop outside Git. Store Pi runtime
  state under `/var/lib/delayrepay`. Never copy passwords, cookies, tokens, or
  email bodies into the repository, SQLite, logs, screenshots, API responses,
  commits, or chat output.
- The first automated claim for each operator is calibration only: fill the
  form, stop before final submission, and present a screenshot for approval.
  Never bypass CAPTCHA, uncertain form state, or operator confirmation.
- Claim submission must be idempotent. Lease one queued job atomically, retain
  operator references, and never submit the same service twice.

## Data and scheduled work

- Discovery updates the reusable service catalogue and runs only when the user
  explicitly requests it. Do not rediscover services during normal collection.
- Collection upserts live data and is safe to repeat. The normal scheduled
  lookback is 10 days. Do not run RTT collection while testing unrelated code.
- Reporting reads SQLite and writes JSON first; Markdown is derived from that
  JSON. The dashboard reads SQLite directly.
- Email reconciliation is read-only and follows
  `prompts/reconcile-gmail-claims.md`. Keep manual `claimed_at` separate from
  operator lifecycle evidence.
- Do not treat the tracked SQLite snapshot as a concurrent transport between
  the laptop and Pi. Back up the live Pi database before migrations or risky
  changes.

## Development workflow

1. Inspect `git status` and the relevant files before editing. Preserve any
   user changes.
2. Keep business rules in Python domain modules, persistence in the storage
   layer, and HTTP/UI concerns in the web package. Put only the browser-driving
   edge on the laptop.
3. Prefer small changes that can be exercised end to end. Do not claim a fix is
   working based only on syntax checks.
4. For Python changes, run the repository virtual environment's compile check
   and the narrowest meaningful smoke or integration test. For PowerShell and
   browser scripts, test the real path and quoting on Windows without making a
   live claim. Run `git diff --check` before committing.
5. Do not add broad or implementation-mirroring tests while the workflow is
   still being built. Add focused regression coverage once behavior is stable.
6. Update `README.md` and Pi deployment files whenever setup, schedules,
   environment variables, ports, or ownership of a process changes.
7. Commit meaningful verified changes and push `main`. Never commit `.env`,
   browser profiles, cookies, credentials, logs, generated reports, SQLite WAL
   files, or other runtime secrets.

## Useful commands

From WSL in the repository:

```bash
.venv/bin/python -m compileall -q python
.venv/bin/delayrepay serve
.venv/bin/delayrepay collect --lookback-days 10 --dry-run
.venv/bin/delayrepay report --lookback-days 10 --action-only
```

The Pi is normally reached with the user's WSL SSH key:

```bash
ssh bhakta-pi@pi.local
```

Use the scripts and full rebuild procedure in `deploy/raspberry-pi/`. Do not
manually alter Pi systemd configuration when the same change belongs in the
repository's install or update scripts.

