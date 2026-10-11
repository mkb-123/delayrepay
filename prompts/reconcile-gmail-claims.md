# Reconcile Delay Repay claims from Gmail

Use my connected Gmail account and the Delay Repay repository at
`C:\Users\mitzb\code\delayrepay` to reconcile claim emails with the local
SQLite database at `data-store/delayrepay.sqlite`.

Work autonomously, but use a cautious evidence standard. Do not ask me to
confirm clear matches. Never send, delete, label, archive, mark read, or
otherwise modify any email.

## Mail search

1. Read the most recent successful reconciliation time from the database. If
   none exists, search the last 90 days.
2. Search for Delay Repay correspondence from Avanti West Coast and London
   Northwestern Railway/West Midlands Trains. Use operator names, Delay Repay
   wording, claim references, and known senders. Do not assume that an unknown
   sender is genuine merely because it mentions a claim.
   Do not limit the search to journeys already marked as claimed: compare every
   relevant message with every stored monitored service in the search period.
3. Fetch only the headers, dates, snippets, and minimum body text required to
   establish the journey and outcome. Do not download attachments unless they
   are essential to resolve a clear match.

## Match each email

Match against stored services using as many of these fields as the message
provides:

- train operator;
- travel date;
- scheduled departure time;
- MKC to EUS or EUS to MKC direction;
- claim reference;
- delay or cancellation details.

Treat a match as certain only when the email identifies one stored journey.
Where several journeys remain possible, record a review item and do not change
the journey's claim status.

## Outcomes

Use only explicit wording in the email:

- `SUBMITTED`: the operator confirms receipt of a claim.
- `APPROVED`: the operator explicitly accepts or approves the claim.
- `REJECTED`: the operator explicitly rejects or declines the claim.
- `PAID`: the operator explicitly confirms that payment, a refund, or the
  selected compensation has been issued.

A receipt is not approval. Approval is not payment. A generic marketing,
service-disruption, or reminder email proves none of these outcomes.

If several messages refer to the same claim, retain its complete event history
and set the current status to the latest explicit lifecycle outcome. Never
downgrade `PAID` because an older receipt email was processed later.

## Database update

Use the application's Python storage layer and migrations rather than ad-hoc
SQL where those facilities exist. If claim lifecycle/event tables have not yet
been implemented, implement a versioned, backward-compatible migration first.
Preserve all existing services, assessments, acknowledgements, manual claim
marks, and not-claimable decisions.

For every processed claim email, store only:

- Gmail message ID, with a unique constraint for idempotency;
- matched service ID, if certain;
- operator and claim reference, if present;
- detected outcome;
- received timestamp;
- a short matching explanation and confidence;
- parser version.

Do not store complete message bodies, attachments, access tokens, or OAuth
credentials. Do not print them in terminal output or logs.

For a certain `SUBMITTED`, `APPROVED`, `REJECTED`, or `PAID` match, update the
journey lifecycle status and its timestamp. Keep the user's original
`claimed_at` acknowledgement as separate history. For an ambiguous result,
create a review item with a safe summary and leave the lifecycle unchanged.

Record the successful reconciliation time only after the transaction commits.
Re-running this prompt must not create duplicate events or change an already
correct result.

## Finish

Refresh any derived report data needed by the dashboard. Commit and push code,
migrations, and the updated tracked database to `main`, without committing
credentials or email content.

Report only:

- number of relevant emails checked;
- journeys moved to Submitted, Approved, Rejected, or Paid;
- ambiguous items requiring review;
- claim emails intentionally excluded because their journeys fall outside the
  stored dates or monitoring windows;
- whether the database was committed and pushed.
