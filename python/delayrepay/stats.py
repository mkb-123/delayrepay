"""Statistics for the stats page: money, outcomes, rejection reasons, which trains are claimed or late most
often, reliability by time and week, missed money and the claim-window deadline watch.

Everything is derived from stored data. Nothing is calculated that the operators did not state: amounts
come from claim_amounts (operator emails or portals). "Estimated" figures reuse the amounts operators
actually awarded for the same operator and delay band.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from .storage.sqlite import Database

LATE_MINUTES = 15
CLAIM_WINDOW_DAYS = 28
FARE_PENCE = 683600  # the saved season ticket on both portals: £6,836.00
OPERATOR_NAMES = {"VT": "Avanti", "LM": "LNR"}
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
REASON_LABELS = {
    "WRONG_OPERATOR": "Claimed with the wrong operator", "DELAY_BELOW_THRESHOLD": "Their calculated delay was under 15 minutes",
    "TICKET_USED_ELSEWHERE": "Ticket used on another service", "DUPLICATE": "Duplicate claim", "OTHER": "Other",
    "UNKNOWN": "Reason not recorded",
}


def _band(delay: int | None) -> str | None:
    if delay is None or delay < LATE_MINUTES:
        return None
    return "15-29" if delay < 30 else "30-59" if delay < 60 else "60-119" if delay < 120 else "120+"


def _train_key(direction: str, time: str, operator: str) -> str:
    return f"{direction[:3].title()} {time} {OPERATOR_NAMES.get(operator, operator)}"


def _slot(time: str) -> str:
    return f"{time[:2]}:{(int(time[3:5]) // 15) * 15:02d}"


def build_stats(database: Database) -> dict[str, Any]:
    connection = database.connection
    today = date.today()
    services: dict[str, dict[str, Any]] = {}
    for row in connection.execute("SELECT service_id, service_date, direction, operator_code, payload_json FROM services"):
        payload = json.loads(row["payload_json"])
        if payload.get("context"):
            continue
        services[row["service_id"]] = {
            "id": row["service_id"], "date": row["service_date"], "direction": row["direction"], "operator": row["operator_code"],
            "time": (payload.get("scheduledDeparture") or "")[11:16], "delay": payload.get("rawDelayMinutes"),
            "cancelled": bool(payload.get("cancelled")), "weekday": date.fromisoformat(row["service_date"]).weekday(),
        }
    lifecycle = {row["service_id"]: dict(row) for row in connection.execute("SELECT service_id, status, claim_reference FROM claim_lifecycle")}
    queued = {row["service_id"] for row in connection.execute("SELECT service_id FROM claim_submissions")}
    acknowledged = {row["service_id"] for row in connection.execute("SELECT service_id FROM claims")}
    ignored = {row["service_id"] for row in connection.execute("SELECT service_id FROM not_claimable")}

    amounts: dict[str, int] = {}
    month_money: dict[str, int] = defaultdict(int)
    for row in connection.execute("SELECT claim_reference, kind, amount_pence FROM claim_amounts WHERE kind IN ('APPROVED', 'PAID')"):
        if row["claim_reference"] not in amounts or row["kind"] == "PAID":
            amounts[row["claim_reference"]] = row["amount_pence"]
    for row in connection.execute("SELECT MIN(received_at) AS first_at, MAX(amount_pence) AS pence FROM claim_amounts "
                                  "WHERE kind IN ('APPROVED', 'PAID') GROUP BY claim_reference"):
        month_money[row["first_at"][:7]] += row["pence"]

    # ---- Money, outcomes, reasons, speed -------------------------------------------------------------
    totals = database.compensation_totals()
    status_counts: dict[str, int] = defaultdict(int)
    by_operator: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for item in lifecycle.values():
        operator = services.get(item["service_id"], {}).get("operator", "?")
        status_counts[item["status"]] += 1
        by_operator[operator][item["status"]] += 1
    won = status_counts["APPROVED"] + status_counts["PAID"]
    decided = won + status_counts["REJECTED"]

    reasons = {row["claim_reference"]: row["reason"] for row in connection.execute("SELECT claim_reference, reason FROM claim_reasons")}
    reason_counts: Counter[str] = Counter()
    for item in lifecycle.values():
        if item["status"] == "REJECTED":
            reason_counts[reasons.get(item["claim_reference"] or "", "UNKNOWN")] += 1
    for ref, reason in reasons.items():  # rejections for journeys outside the stored data still teach something
        if ref not in {i["claim_reference"] for i in lifecycle.values()}:
            reason_counts[reason] += 1

    events: dict[str, dict[str, str]] = defaultdict(dict)
    for row in connection.execute("SELECT claim_reference, outcome, received_at FROM claim_email_events "
                                  "WHERE claim_reference IS NOT NULL ORDER BY received_at"):
        events[row["claim_reference"]].setdefault(row["outcome"], row["received_at"])
    days = lambda a, b: (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 86400
    decision_waits = [days(e["SUBMITTED"], min(e[k] for k in ("APPROVED", "REJECTED", "PAID") if k in e))
                      for e in events.values() if "SUBMITTED" in e and any(k in e for k in ("APPROVED", "REJECTED", "PAID"))]
    payment_waits = [days(e["APPROVED"], e["PAID"]) for e in events.values() if "APPROVED" in e and "PAID" in e]

    # ---- Approval by delay band and typical awards --------------------------------------------------
    band_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"claims": 0, "approved": 0})
    awards: dict[tuple[str, str], list[int]] = defaultdict(list)
    for service_id, item in lifecycle.items():
        service = services.get(service_id)
        if not service or item["status"] not in {"APPROVED", "PAID", "REJECTED"}:
            continue
        band = "cancelled" if service["cancelled"] else _band(service["delay"]) or "under 15"
        band_stats[band]["claims"] += 1
        if item["status"] != "REJECTED":
            band_stats[band]["approved"] += 1
            pence = amounts.get(item["claim_reference"] or "")
            if pence and band in {"15-29", "30-59", "60-119", "120+"}:
                awards[(service["operator"], band)].append(pence)

    def typical(operator: str, band: str | None) -> int | None:
        for pool in (awards.get((operator, band or "")), [p for (o, b), v in awards.items() if b == band for p in v]):
            if pool:
                return Counter(pool).most_common(1)[0][0]
        return None

    # ---- Trains claimed most --------------------------------------------------------------------------
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
    usual = set(claimed)

    # ---- Late trains, weekday, time slots, weekly trend -------------------------------------------------
    trains: dict[str, dict[str, Any]] = {}
    weekday: dict[int, list[int]] = {i: [0, 0] for i in range(7)}
    slots: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    weeks: dict[str, dict[str, int]] = defaultdict(lambda: {"seen": 0, "problems": 0, "lateMinutes": 0, "late": 0})
    for service in services.values():
        if service["delay"] is None and not service["cancelled"]:
            continue
        problem = service["cancelled"] or (service["delay"] or 0) >= LATE_MINUTES
        key = _train_key(service["direction"], service["time"], service["operator"])
        row = trains.setdefault(key, {"train": key, "seen": 0, "late": 0, "cancelled": 0, "lateMinutes": 0})
        row["seen"] += 1
        weekday[service["weekday"]][1] += 1
        weekday[service["weekday"]][0] += bool(problem)
        slot = slots[(service["direction"], _slot(service["time"]))]
        slot[1] += 1
        slot[0] += bool(problem)
        week = weeks[(date.fromisoformat(service["date"]) - timedelta(days=service["weekday"])).isoformat()]
        week["seen"] += 1
        week["problems"] += bool(problem)
        if service["cancelled"]:
            row["cancelled"] += 1
        elif (service["delay"] or 0) >= LATE_MINUTES:
            row["late"] += 1
            row["lateMinutes"] += service["delay"]
            week["late"] += 1
            week["lateMinutes"] += service["delay"]
    late_rows = [{**r, "rate": round(100 * (r["late"] + r["cancelled"]) / r["seen"]),
                  "averageLate": round(r["lateMinutes"] / r["late"]) if r["late"] else None}
                 for r in trains.values() if r["seen"] >= 3 and (r["late"] + r["cancelled"])]
    late_rows.sort(key=lambda r: (-(r["late"] + r["cancelled"]), -r["rate"]))
    heat = {direction.title(): [{"slot": slot, "seen": v[1], "rate": round(100 * v[0] / v[1])}
                                for (d, slot), v in sorted(slots.items()) if d == direction and v[1] >= 6]
            for direction in ("MORNING", "EVENING")}
    trend = [{"week": start, "seen": v["seen"], "rate": round(100 * v["problems"] / v["seen"]),
              "averageLate": round(v["lateMinutes"] / v["late"]) if v["late"] else None}
             for start, v in sorted(weeks.items()) if v["seen"] >= 20]

    # ---- Missed money and the deadline watch -------------------------------------------------------------
    handled_groups = {(s["date"], s["direction"]) for s in services.values() if s["id"] in lifecycle or s["id"] in queued or s["id"] in acknowledged}
    candidates: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for service in services.values():
        left = CLAIM_WINDOW_DAYS - (today - date.fromisoformat(service["date"])).days
        if left < 0 or (service["date"], service["direction"]) in handled_groups or service["id"] in ignored:
            continue
        if not service["cancelled"] and (service["delay"] or 0) >= LATE_MINUTES:
            candidates[(service["date"], service["direction"])].append({**service, "left": left})
    deadlines, missed = [], []
    for (day, direction), items in sorted(candidates.items()):
        best = max(items, key=lambda s: s["delay"])
        entry = {"date": day, "direction": direction.title(), "train": _train_key(direction, best["time"], best["operator"]),
                 "delay": best["delay"], "daysLeft": best["left"], "estimatePence": typical(best["operator"], _band(best["delay"]))}
        deadlines.append(entry)
        usual_items = [s for s in items if _train_key(s["direction"], s["time"], s["operator"]) in usual]
        if usual_items:
            top = max(usual_items, key=lambda s: s["delay"])
            missed.append({**entry, "train": _train_key(direction, top["time"], top["operator"]), "delay": top["delay"],
                           "estimatePence": typical(top["operator"], _band(top["delay"]))})
    deadlines.sort(key=lambda e: e["daysLeft"])

    return {
        "money": {**totals, "byMonthPence": dict(sorted(month_money.items())), "farePence": FARE_PENCE,
                  "farePercent": round(100 * totals["approvedPence"] / FARE_PENCE, 1)},
        "claims": {
            "total": len(lifecycle), "byStatus": dict(status_counts),
            "byOperator": {OPERATOR_NAMES.get(k, k): dict(v) for k, v in by_operator.items()},
            "successRatePercent": round(100 * won / decided) if decided else None, "decided": decided,
            "averageDaysToDecision": round(sum(decision_waits) / len(decision_waits), 1) if decision_waits else None,
            "averageDaysToPayment": round(sum(payment_waits) / len(payment_waits), 1) if payment_waits else None,
            "rejectionReasons": [{"reason": REASON_LABELS.get(k, k), "count": v} for k, v in reason_counts.most_common()],
            "byBand": [{"band": b, "claims": v["claims"], "approved": v["approved"],
                        "rate": round(100 * v["approved"] / v["claims"])} for b, v in sorted(band_stats.items())],
        },
        "claimedTrains": claimed_rows,
        "lateTrains": late_rows[:12],
        "lateByWeekday": [{"day": WEEKDAYS[i], "problems": weekday[i][0], "seen": weekday[i][1],
                           "rate": round(100 * weekday[i][0] / weekday[i][1]) if weekday[i][1] else None} for i in range(7)],
        "heat": heat,
        "trend": trend,
        "missed": {"items": missed, "estimatePence": sum(m["estimatePence"] or 0 for m in missed)},
        "deadlines": deadlines[:15],
        "coverage": {"days": len({s["date"] for s in services.values()}), "trains": len(services),
                     "from": min((s["date"] for s in services.values()), default=None),
                     "to": max((s["date"] for s in services.values()), default=None)},
    }
