# Gmail reconciliation policy (details)

Loaded on demand. `CLAUDE.md` holds only the short version. The Pi normally does all of this itself;
follow this document only when an agent has to reconcile by hand.

## Rules

Read and follow [`prompts/reconcile-gmail-claims.md`](prompts/reconcile-gmail-claims.md).
This is the authoritative reconciliation policy. The key paths are:

- repository: `C:\Users\mitzb\code\delayrepay`;
- database: `data-store/delayrepay.sqlite`;
- storage layer: `python/delayrepay/storage/sqlite.py`;
- report generation: `python/delayrepay/workflows.py`.

### Prerequisite

Claude must have read access to the user's primary Gmail account
`mitzbhakta@gmail.com`, through an approved Gmail connector or Gmail OAuth.
Do not request or use the Gmail password. Do not proceed by guessing when mail
access is unavailable; report that Gmail access is the blocker.

Mailbox access is read-only. Never send, delete, archive, label, mark read, or
otherwise alter a message.

### Trusted operator senders

Search incrementally from the timestamp stored in metadata under
`last_gmail_reconciliation`. On the first run, search 90 days. Include both:

- Avanti West Coast:
  `NOREPLYAvantiWestCoastDR@firstcustomercontact.com`
- London Northwestern Railway:
  `noreply_londonnorthwesternrailway@delayrepaycompensation.com`

Also search operator and Delay Repay terms in case a sender changes. A changed
sender is evidence to review, not automatically a trusted source.

Do not limit matching to rows in the `claims` table. Compare every relevant
message with every monitored service in the applicable period. Report messages
whose travel date or departure time falls outside the stored dataset or the
configured monitoring windows; do not force them onto a service.

### Outcome standard

Record an outcome only from explicit operator wording:

- `SUBMITTED`: received, submitted, in progress, or processing;
- `APPROVED`: accepted or approved;
- `REJECTED`: unsuccessful, rejected, or declined;
- `PAID`: payment or compensation explicitly sent or issued.

Conditional wording such as “if your claim is approved” is not approval.
“Approved and will be paid” is `APPROVED` until a payment-sent message arrives.
A duplicate-claim rejection does not invalidate an earlier approved original
claim. Preserve each reference and event, then derive the journey's current
state from the strongest explicit, chronologically valid evidence. Never
downgrade `PAID` after processing an older message.

### Journey matching

A certain match needs enough information to identify one service, normally:

- operator;
- travel date;
- scheduled departure time;
- route direction;
- claim reference, when supplied.

The monitored routes and windows are:

- daily (including Saturday and Sunday) MKC → EUS, scheduled departure 06:00–08:00;
- daily (including Saturday and Sunday) EUS → MKC, scheduled departure 16:30–18:30.

If several stored services could match, add a review event and do not update a
journey lifecycle. Never infer a journey date or train time from the email's
sent timestamp.

### Database writes

Open the database through `delayrepay.storage.sqlite.Database`. Use
`save_claim_email_event(...)`; do not duplicate its SQL in an ad-hoc script.
The Gmail message ID is the idempotency key. Store only the fields supported by
the storage method and a short factual explanation. Never store full message
bodies, HTML, attachments, authentication tokens, or credentials.

Keep `claims.claimed_at` unchanged. It is the user's manual acknowledgement and
is separate from the operator lifecycle in `claim_lifecycle`.

Call `set_last_gmail_reconciliation(...)` only after all event writes succeed.
If any mailbox page or database transaction fails, leave the previous timestamp
unchanged so the next run can retry safely.

### Verification

Before committing:

1. Confirm every certain match points to an existing `services.service_id`.
2. Confirm processed Gmail IDs are unique in `claim_email_events`.
3. Confirm rerunning the same inputs changes no event count or lifecycle.
4. Generate report data for affected dates and confirm `claimLifecycle` shows
   the expected current state.
5. Run `python -m compileall -q python` using the repository virtual
   environment.
6. Run `git diff --check` and confirm no credentials or email bodies appear in
   the diff.

If tracked files changed, commit them with a concise message and push `main`.
Do not create an empty commit. Restart the existing local dashboard task when
Python or web files changed; a database-only update does not require a restart.

### Run report

Return a short report containing:

- number of operator emails checked;
- number of events newly stored;
- journeys now Submitted, Approved, Rejected, or Paid;
- ambiguous matches requiring review;
- messages excluded because they fall outside the dataset or windows;
- commit hash, when changes were pushed.

Do not include email bodies, payment amounts, authentication data, or unrelated
mailbox content in the report.

## Schedule

The Raspberry Pi runs this reconciliation itself, daily at 20:00, with no AI model: the
`delayrepay-reconcile.timer` runs `python -m delayrepay gmail-reconcile` using the read-only
Gmail OAuth login stored on the Pi (`GMAIL_OAUTH_*` in its `.env`; set up with
`scripts/windows/gmail-authorize.ps1`). The Codex automation `Reconcile Delay Repay emails` was
disabled on 15 Oct 2026, so only the Pi writes to the live database.

An agent only reconciles by hand when the Pi cannot (for example the OAuth login is broken).
With an approved Gmail connector, fetch the messages, pass the key lines to
`python -m delayrepay gmail-ingest` (JSON on stdin), and follow the rules above. Emails are
matched by journey details or by the claim reference recorded at submission.
