from __future__ import annotations

from datetime import datetime, timezone
import logging
from pathlib import Path

from .browser import ClaimBrowserError, submit
from ..storage.sqlite import Database


LOGGER = logging.getLogger("delayrepay.claiming")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(root: Path, limit: int = 5) -> dict[str, int]:
    counts = {"checked": 0, "submitted": 0, "needsLogin": 0, "needsAttention": 0}
    with Database(root) as database:
        queued = database.pending_claim_submissions(limit)
    for item in queued:
        counts["checked"] += 1
        service_id = item["service_id"]
        with Database(root) as database:
            database.update_claim_submission(service_id, "PROCESSING", now(), started=True)
        try:
            result = submit(root, item["service"])
            with Database(root) as database:
                database.record_submitted_claim(service_id, item["operator_code"], now(), result.reference)
            counts["submitted"] += 1
            LOGGER.info("Submitted queued claim for %s", service_id)
        except ClaimBrowserError as error:
            state = error.state
            with Database(root) as database:
                database.update_claim_submission(service_id, state, now(), error=str(error), finished=True)
            key = "needsLogin" if state == "NEEDS_LOGIN" else "needsAttention"
            counts[key] += 1
            LOGGER.warning("Claim %s requires attention: %s", service_id, error)
    return counts
