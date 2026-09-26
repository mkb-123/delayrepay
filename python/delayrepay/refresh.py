from __future__ import annotations

from contextlib import AbstractContextManager
from datetime import date, timedelta
import json
import os
from pathlib import Path
import time
from typing import Any

from .storage.sqlite import Database, catalogue_path, read_json


class CollectionBusyError(RuntimeError):
    pass


class CollectionLock(AbstractContextManager["CollectionLock"]):
    """Small cross-process lock shared by CLI, scheduled, and web collection."""

    def __init__(self, root: Path):
        self.path = root / "collection.lock"
        self.acquired = False

    def __enter__(self) -> "CollectionLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as error:
            try:
                stale = time.time() - self.path.stat().st_mtime > 6 * 60 * 60
            except FileNotFoundError:
                stale = False
            if stale:
                self.path.unlink(missing_ok=True)
                return self.__enter__()
            raise CollectionBusyError("Another collection is already running.") from error
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump({"pid": os.getpid(), "startedAt": time.time()}, handle)
        self.acquired = True
        return self

    def __exit__(self, *_args: object) -> None:
        if self.acquired:
            self.path.unlink(missing_ok=True)
            self.acquired = False


def refresh_plan(root: Path, days: int = 10, end_date: date | None = None) -> dict[str, Any]:
    if days < 1 or days > 90:
        raise ValueError("Days must be between 1 and 90")
    end = end_date or date.today()
    start = end - timedelta(days=days - 1)
    catalogue = read_json(catalogue_path(root), {"services": []})
    entries = catalogue.get("services", [])
    fetch, current, uncatalogued = [], [], []
    with Database(root) as database:
        cursor = start
        while cursor <= end:
            if cursor.weekday() < 5:
                service_date = cursor.isoformat()
                matching = [item for item in entries if item.get("weekday") == cursor.weekday()]
                state = database.collection_state(service_date)
                if not matching:
                    uncatalogued.append({"date": service_date, "reason": "No catalogue entries for this weekday."})
                elif state and state["complete"]:
                    current.append({"date": service_date, "collectedAt": state["collectedAt"]})
                else:
                    fetch.append({
                        "date": service_date,
                        "requestCount": len(matching),
                        "reason": "Incomplete collection" if state else "Not collected",
                    })
            cursor += timedelta(days=1)
    return {
        "days": days,
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "fetch": fetch,
        "current": current,
        "uncatalogued": uncatalogued,
        "requestCount": sum(item["requestCount"] for item in fetch),
    }
