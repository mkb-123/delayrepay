from __future__ import annotations

from datetime import datetime, timezone
import logging
import os
from contextlib import contextmanager
from pathlib import Path

from .browser import ClaimBrowserError, check_session, screenshot_path, submit
from ..storage.sqlite import Database


LOGGER = logging.getLogger("delayrepay.claiming")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def worker_lock(root: Path):
    path = root / "claim-worker.lock"
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        try:
            process_id = int(path.read_text(encoding="ascii"))
            os.kill(process_id, 0)
        except (ValueError, ProcessLookupError, OSError):
            path.unlink(missing_ok=True)
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        else:
            raise RuntimeError("Claim worker is already running.") from error
    try:
        os.write(descriptor, str(os.getpid()).encode())
        os.close(descriptor)
        yield
    finally:
        path.unlink(missing_ok=True)


def _run(root: Path, limit: int) -> dict[str, int]:
    counts = {"checked": 0, "submitted": 0, "calibrated": 0, "needsLogin": 0, "needsAttention": 0}
    with Database(root) as database:
        queued = database.pending_claim_submissions(limit)
    for item in queued:
        counts["checked"] += 1
        service_id = item["service_id"]
        with Database(root) as database:
            database.update_claim_submission(service_id, "PROCESSING", now(), started=True)
        try:
            result = submit(root, item["service"], item.get("mode") or "CALIBRATE")
            with Database(root) as database:
                if result.submitted:
                    database.record_submitted_claim(service_id, item["operator_code"], now(), result.reference)
                    counts["submitted"] += 1
                else:
                    database.update_claim_submission(service_id, "CALIBRATION_READY", now(), finished=True,
                                                     last_step=result.last_step, screenshot_path=result.screenshot_path)
                    counts["calibrated"] += 1
        except ClaimBrowserError as error:
            state = error.state
            with Database(root) as database:
                shot = screenshot_path(root, item["service"])
                database.update_claim_submission(service_id, state, now(), error=str(error), finished=True,
                                                 screenshot_path=shot.name if shot.exists() else None)
            key = "needsLogin" if state == "NEEDS_LOGIN" else "needsAttention"
            counts[key] += 1
            LOGGER.warning("Claim %s requires attention: %s", service_id, error)
    return counts


def run(root: Path, limit: int = 5) -> dict[str, int]:
    with worker_lock(root):
        return _run(root, limit)


def check_sessions(root: Path) -> dict[str, str]:
    results = {}
    with worker_lock(root):
        for operator_code in ("VT", "LM"):
            status, explanation = check_session(root, operator_code)
            with Database(root) as database:
                database.set_operator_session(operator_code, status, now(), explanation)
            results[operator_code] = status
    return results
