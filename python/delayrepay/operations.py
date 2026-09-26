from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any

from .ingestion.services import WINDOWS
from .storage.sqlite import Database, catalogue_path, read_json


def weekday_dates(end_date: str, days: int) -> list[str]:
    if days < 1 or days > 90:
        raise ValueError("Lookback days must be between 1 and 90")
    end = date.fromisoformat(end_date)
    start = end - timedelta(days=days - 1)
    return [(start + timedelta(days=offset)).isoformat() for offset in range(days) if (start + timedelta(days=offset)).weekday() < 5]


def discovery_plan(end_date: str, days: int, direction: str) -> dict[str, Any]:
    direction = direction.upper()
    if direction not in {*WINDOWS, "ALL"}:
        raise ValueError("Direction must be MORNING, EVENING, or ALL")
    dates = weekday_dates(end_date, days)
    calls_per_date = 4 if direction == "ALL" else 2
    return {
        "operation": "discover", "endDate": end_date, "lookbackDays": days,
        "direction": direction, "dates": dates, "requestCount": len(dates) * calls_per_date,
    }


def collection_plan(root: Path, end_date: str, days: int, mode: str = "missing") -> dict[str, Any]:
    if mode not in {"missing", "all"}:
        raise ValueError("Collection mode must be missing or all")
    catalogue = read_json(catalogue_path(root), {"services": []})
    entries = catalogue.get("services", [])
    collect_dates, complete_dates, uncatalogued = [], [], []
    with Database(root) as database:
        for service_date in weekday_dates(end_date, days):
            weekday = date.fromisoformat(service_date).weekday()
            matching = [item for item in entries if item.get("weekday") == weekday]
            if not matching:
                uncatalogued.append(service_date)
                continue
            directions = {item["direction"] for item in matching}
            state = database.collection_state(service_date)
            if mode == "missing" and state and state["complete"]:
                complete_dates.append(service_date)
                continue
            collect_dates.append({"date": service_date, "requestCount": len(directions) * 2})
    return {
        "operation": "collect", "endDate": end_date, "lookbackDays": days, "mode": mode,
        "dates": collect_dates, "completeDates": complete_dates, "uncataloguedDates": uncatalogued,
        "requestCount": sum(item["requestCount"] for item in collect_dates),
    }
