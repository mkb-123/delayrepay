# Delay Repay agent instructions

These instructions apply to the whole repository. The active application is
the Python, Flask, and SQLite implementation under `python/delayrepay`.
`legacy/` is archived reference material and must not be used for new work.

## Guiding principle

Minimise AI usage and make everything systematic. Routine work (collecting data,
claiming, recording results, session upkeep, reconciliation) must run from
scripts, timers, and the worker with no model in the loop. An agent is for
exceptions: repairing a broken portal selector, handling a new situation, or
building the next script. When an agent does a manual step twice, codify it:
turn it into a tested script or command, record it in the docs, and make the
failure path say why it failed (reason and screenshot) so the next fix needs no
exploration. Prefer one call that does a whole job over many small steps, and
never rely on an agent to remember to update the database: scripts must do it.

## Working rules for agents

- Act on the queue without being asked. When claims are queued and ready, process them
  (run the worker, or submit through the proven browser routines) before reporting.
  Check the Pi queue first: `claim_submissions` where `state` is not `SUBMITTED`.
- Never try to evade bot detection. Operators use reCAPTCHA and may escalate to image
  challenges when they see automation. Do not hide automation, rotate identities, or
  retry rapidly. A person solves CAPTCHAs; the worker shows the window, notifies, and
  waits. Make at most one submit attempt per claim per run, and space claims apart.
- Every claim made outside the worker must be recorded with `record-claims.ps1`.

## Product rules

- Monitor direct daily (Saturday and Sunday included) MKC to EUS services scheduled from 06:00 to 08:00
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

## Deploying and restarting the Raspberry Pi UI

The Pi checkout is `~/delayrepay`, the live data directory is
`/var/lib/delayrepay`, the Flask service is `delayrepay.service`, and nginx
publishes it as `http://delayrepay.local`. A `git pull` alone does not update
the running UI because the Python process must be restarted.

Use this sequence after verified changes:

1. Commit the complete change locally and push `main` to GitHub.
2. From Windows, use the WSL SSH key. Do not use Windows `ssh.exe`:

   ```powershell
   wsl ssh bhakta-pi@pi.local
   ```

3. On the Pi, deploy with the checked-in updater:

   ```bash
   cd ~/delayrepay
   ./deploy/raspberry-pi/update.sh
   ```

   Use `./deploy/raspberry-pi/update.sh --full` when `deploy/`, Linux setup
   scripts, systemd units, nginx configuration, dependencies, or installation
   behavior changed. The updater makes a database backup before pulling code.
4. Confirm the exact deployed commit and restart state:

   ```bash
   git rev-parse --short HEAD
   sudo systemctl restart delayrepay.service
   sudo systemctl is-active delayrepay.service nginx.service
   curl --fail --silent http://127.0.0.1:8765/health
   curl --fail --silent http://127.0.0.1/health
   ```

5. If the UI still appears stale, inspect the service before changing code:

   ```bash
   sudo journalctl -u delayrepay.service -n 100 --no-pager
   sudo nginx -t
   ```

Do not overwrite `/var/lib/delayrepay`, copy the tracked development database
over the live database, or run `git reset --hard` on the Pi. If the updater
reports local Pi edits, inspect and preserve them before continuing. Report the
deployed commit, service state, and both health-check results when deployment
finishes.


## Checking for work

Run the status script instead of exploring by hand. It prints the queue, session and worker health,
operator outcomes, trains waiting for the user's choice, and a final "NEEDS YOU" list:

```bash
wsl.exe -e ssh -o BatchMode=yes bhakta-pi@pi.local 'curl -s http://127.0.0.1:8765/api/dashboard' | node scripts/status.mjs
```

If claims are queued, run `scripts/windows/run-claim-worker.ps1` rather than waiting for 19:00.

## Token discipline

Every token costs money and context. Follow these in every session:

- **Look with the script, not by exploring.** `scripts/status.mjs` first. Do not re-derive state by hand.
- **Small outputs.** Filter command output (`head`, `tail`, `cut`, `grep`). Return one-line JSON from page
  scripts. Use `max_chars` and `get_page_text`, not full-page screenshots or `read_page` dumps. Take a
  screenshot only when the text cannot answer the question.
- **Email.** Search with metadata-only views. LNR HTML bodies are huge (thousands of tokens each): search
  for decision phrases instead of opening them, and open only Avanti messages. Pass key lines, never full
  bodies, to `gmail-ingest`.
- **One call per job.** Batch independent calls in parallel. Put a repeated procedure in a script first.
- **Never poll.** Start long jobs in the background and check once, or let a timer do it.
- **Terse replies.** Lead with the result. No recap of the plan, no restating what the user said, no
  options list unless a decision is needed. Short tables only for data.
- **Fresh sessions.** One task per session; do not carry unrelated history. Spawn subagents only when asked.
- **Right-size the model.** Routine runs (worker, status, recording) do not need the largest model.
