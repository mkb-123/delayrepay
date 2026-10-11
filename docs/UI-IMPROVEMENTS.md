# UI improvement ideas

The dashboard now shows email-derived claim lifecycle states (`Submitted`,
`Approved`, `Rejected`, `Paid`, or `Email review`) in the daily recommendation,
heat-map cell, and service detail.

## Recommended next changes

1. **Reconciliation health at the top** — show the last successful Gmail scan,
   whether authorization is working, and how many emails need manual matching.
2. **Claim-state filter** — filter the grid by submitted, approved, rejected,
   paid, or no matched email independently of rail eligibility.
3. **Unmatched email inbox** — provide a small review screen for ambiguous
   operator emails and let the user attach one to a journey without editing the
   database.
4. **Action-first default view** — show outstanding potential claims and
   submitted claims awaiting an outcome first; place paid and rejected claims
   under a collapsed completed section.
5. **Mobile list alternative** — offer a compact day-by-day list alongside the
   heat map for narrow phones, while retaining the heat map for pattern finding.
6. **Operator reference search** — allow searching by claim reference and copy
   the reference from the service detail with one tap.
7. **Accessible status cues** — add text or icons alongside every colour and
   check contrast and keyboard navigation across dialogs and grid cells.
8. **Recovery visibility** — display the last successful database backup and
   warn when the configured off-device backup destination is unavailable.
