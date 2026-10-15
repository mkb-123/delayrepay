from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any

from .ingestion.rtt import RttClient
from .refresh import CollectionLock
from .workflows import collect, report_lookback


def latest_weekday(value: date | None = None) -> date:
    # Name kept for callers; Saturday and Sunday are monitored too, so this is simply the latest day.
    return value or date.today()


def weekday_dates(end_date: date, lookback_days: int) -> list[date]:
    if lookback_days < 1:
        raise ValueError("Lookback days must be at least 1")
    start = end_date - timedelta(days=lookback_days - 1)
    return [start + timedelta(days=offset) for offset in range(lookback_days)]


def run_daily_brief(root: Path, end_date: date | None = None, lookback_days: int = 10) -> dict[str, Any]:
    end = latest_weekday(end_date)
    dates = weekday_dates(end, lookback_days)
    client = RttClient()
    results = []
    with CollectionLock(root):
        for service_date in dates:
            value = collect(root, service_date.isoformat(), client, False)
            results.append({
                "date": service_date.isoformat(),
                "services": len(value.get("services", [])),
                "errors": len(value.get("errors", [])),
            })
    report_lookback(root, end.isoformat(), lookback_days, True)
    return {"endDate": end.isoformat(), "lookbackDays": lookback_days, "dates": results}
