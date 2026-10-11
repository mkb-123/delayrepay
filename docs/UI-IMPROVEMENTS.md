# UI improvement ideas

The dashboard now shows email-derived claim lifecycle states (`Submitted`,
`Approved`, `Rejected`, `Paid`, or `Email review`) in the daily recommendation,
heat-map cell, and service detail.

## Implemented

1. **Reconciliation health at the top** — shows the last successful Gmail scan,
   whether authorization is working, and how many emails need manual matching.
2. **Claim-state filter** — filters the grid by submitted, approved, rejected,
   paid, or no matched email independently of rail eligibility.
3. **Unmatched email inbox** — provides a small review screen for ambiguous
   operator emails and lets the user attach one to a journey without editing the
   database.
4. **Action-first default view** — shows outstanding potential claims and
   submitted claims awaiting an outcome first; paid and rejected claims appear
   under a collapsed completed section.
5. **Mobile list alternative** — uses a compact day-by-day list instead of the
   heat map for narrow phones, while retaining the heat map for pattern finding.
6. **Operator reference search** — allows searching by claim reference and copying
   the reference from the service detail with one tap.
7. **Accessible status cues** — adds text alongside colour. Keyboard and
   contrast checks remain useful future work.
8. **Recovery visibility** — displays the last successful database backup and
   warns when the configured off-device backup destination is unavailable.

## Further improvements

- Add a button to run Gmail reconciliation manually after OAuth is configured.
- Show a direct Gmail link for each stored email event where Google permits it.
- Add browser-level accessibility testing for focus order and dialog behavior.
