"""Statistics for the stats page: money, claim outcomes, and which trains are claimed or late most often.

Everything is derived from the stored data; nothing is calculated that the operators did not state
(amounts come from claim_amounts, which only holds figures taken from operator emails or portals).
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, datetime
from typing import Any

from .storage.sqlite import Database

LATE_MINUTES = 15
OPERATOR_NAMES = {"VT": "Avanti", "LM": "LNR"}
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _train_key(direction: str, time: str, operator: str) -> str:
    return f"{direction[:3].title()} {time} {OPERATOR_NAMES.get(operator, operator)}"


def build_stats(database: Database) -> dict[str, Any]:
    connection = database.connection
    services: dict[str, dict[str, Any]] = {}
    for row in connection.execute("SELECT service_id, service_date, direction, operator_code, payload_json FROM services"):
        payload = json.loads(row["payload_json"])
        if payload.get("context"):
            continue
        services[row["service_id"]] = {
            "date": row["service_date"], "direction": row["direction"], "operator": row["operator_code"],
            "time": (payload.get("scheduledDeparture") or "")[11:16], "delay": payload.get("rawDelayMinutes"),
            "cancelled": bool(payload.get("cancelled")), "weekday": date.fromisoformat(row["service_date"]).weekday(),
        }
    lifecycle = {row["service_id"]: dict(row) for row in connection.execute(
        "SELECT service_id, status, claim_reference FROM claim_lifecycle")}
    amounts: dict[str, int] = {}
    amount_month: dict[str, int] = defaultdict(int)
    for row in connection.execute("SELECT claim_reference, kind, amount_pence, received_at FROM claim_amounts WHERE kind IN ('APPROVED', 'PAID')"):
        if row["claim_reference"] not in amounts or row["kind"] == "PAID":
            amounts[row["claim_reference"]] = row["amount_pence"]
    for row in connection.execute("SELECT claim_reference, MIN(received_at) AS first_at, MAX(amount_pence) AS pence FROM claim_amounts "
                                  "WHERE kind IN ('APPROVED', 'PAID') GROUP BY claim_reference"):
        amount_month[row["first_at"][:7]] += row["pence"]

    # Money and outcomes.
    totals = database.compensation_totals()
    status_counts: dict[str, int] = defaultdict(int)
    by_operator: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for item in lifecycle.values():
        operator = services.get(item["service_id"], {}).get("operator", "?")
        status_counts[item["status"]] += 1
        by_operator[operator][item["status"]] += 1
    decided = status_counts["APPROVED"] + status_counts["PAID"] + status_counts["REJECTED"]
    won = status_counts["APPROVED"] + status_counts["PAID"]

    # Days from "received" to a decision, from the operators' own emails.
    first: dict[str, dict[str, str]] = defaultdict(dict)
    for row in connection.execute("SELECT claim_reference, outcome, received_at FROM claim_email_events WHERE claim_reference IS NOT NULL ORDER BY received_at"):
        kind = "submitted" if row["outcome"] == "SUBMITTED" else "decision" if row["outcome"] in {"APPROVED", "REJECTED", "PAID"} else None
        if kind and kind not in first[row["claim_reference"]]:
            first[row["claim_reference"]][kind] = row["received_at"]
    waits = [(datetime.fromisoformat(v["decision"]) - datetime.fromisoformat(v["submitted"])).total_seconds() / 86400
             for v in first.values() if "submitted" in v and "decision" in v]

    # Trains claimed most often, with how they fared.
    claimed: dict[str, dict[str, Any]] = {}
    for service_id, item in lifecycle.items():
        service = services.get(service_id)
        if not service:
            continue
        key = _train_key(service["direction"], service["time"], service["operator"])
        row = claimed.setdefault(key, {"train": key, "claims": 0, "approved": 0, "rejected": 0, "pencePaid": 0})
        row["claims"] += 1
        row["approved"] += item["status"] in {"APPROVED", "PAID"}
        row["rejected"] += item["status"] == "REJECTED"
        row["pencePaid"] += amounts.get(item["claim_reference"] or "", 0)
    claimed_rows = sorted(claimed.values(), key=lambda r: (-r["claims"], -r["pencePaid"]))[:12]

    # Trains that are late or cancelled most often (all monitored trains with data).
    trains: dict[str, dict[str, Any]] = {}
    weekday: dict[int, list[int]] = {i: [0, 0] for i in range(7)}
    for service in services.values():
        if service["delay"] is None and not service["cancelled"]:
            continue
        key = _train_key(service["direction"], service["time"], service["operator"])
        row = trains.setdefault(key, {"train": key, "seen": 0, "late": 0, "cancelled": 0, "lateMinutes": 0})
        row["seen"] += 1
        weekday[service["weekday"]][1] += 1
        if service["cancelled"]:
            row["cancelled"] += 1
            weekday[service["weekday"]][0] += 1
        elif (service["delay"] or 0) >= LATE_MINUTES:
            row["late"] += 1
            row["lateMinutes"] += service["delay"]
            weekday[service["weekday"]][0] += 1
    late_rows = []
    for row in trains.values():
        problems = row["late"] + row["cancelled"]
        if row["seen"] >= 3 and problems:
            late_rows.append({**row, "rate": round(100 * problems / row["seen"]),
                              "averageLate": round(row["lateMinutes"] / row["late"]) if row["late"] else None})
    late_rows.sort(key=lambda r: (-(r["late"] + r["cancelled"]), -r["rate"]))

    return {
        "money": {**totals, "byMonthPence": dict(sorted(amount_month.items()))},
        "claims": {
            "total": len(lifecycle), "byStatus": dict(status_counts),
            "byOperator": {OPERATOR_NAMES.get(k, k): dict(v) for k, v in by_operator.items()},
            "successRatePercent": round(100 * won / decided) if decided else None, "decided": decided,
            "averageDaysToDecision": round(sum(waits) / len(waits), 1) if waits else None,
        },
        "claimedTrains": claimed_rows,
        "lateTrains": late_rows[:12],
        "lateByWeekday": [{"day": WEEKDAYS[i], "problems": weekday[i][0], "seen": weekday[i][1],
                           "rate": round(100 * weekday[i][0] / weekday[i][1]) if weekday[i][1] else None} for i in range(7)],
        "coverage": {"days": len({s["date"] for s in services.values()}), "trains": len(services),
                     "from": min((s["date"] for s in services.values()), default=None),
                     "to": max((s["date"] for s in services.values()), default=None)},
    }
