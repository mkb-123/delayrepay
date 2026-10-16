# Delay Repay operating instructions for Claude

Private MKC ↔ EUS Delay Repay tracker (Python, Flask, SQLite). `legacy/` is archived: never use it.
**Read `AGENTS.md` first**: guiding principle (minimise AI use, make things systematic), architecture,
working rules, token discipline, and the status command. Commit and push verified changes to `main`.

## Gmail reconciliation

The Raspberry Pi does this itself daily at 20:00 with no AI (`delayrepay-reconcile.timer`). An agent
reconciles by hand only when the Pi cannot. Full rules: `docs/gmail-reconciliation-policy.md`
(plus `prompts/reconcile-gmail-claims.md`). Non-negotiable:

- Mailbox `mitzbhakta@gmail.com`, read-only, via an approved connector or OAuth. Never the password.
  If access is unavailable, report that as the blocker; do not guess. Never send, delete, label or
  mark anything.
- Write only through `delayrepay.storage.sqlite.Database` (`save_claim_email_event`), idempotent on
  the Gmail message ID. Never store bodies, tokens or credentials.
- Record an outcome only from explicit operator wording (SUBMITTED, APPROVED, REJECTED, PAID). Never
  downgrade PAID. Ambiguous matches become review events.
- By hand: fetch messages, pass only the key lines to `python -m delayrepay gmail-ingest` (JSON on stdin).
- Verify: a rerun changes nothing, `compileall` passes, `git diff --check` is clean.
- Report counts only: no email bodies, amounts or tokens.
