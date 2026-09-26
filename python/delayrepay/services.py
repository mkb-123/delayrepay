from __future__ import annotations

from datetime import datetime
from typing import Any

WINDOWS = {
    "MORNING": {"origin": "MKC", "destination": "EUS", "from": "06:00", "to": "08:00"},
    "EVENING": {"origin": "EUS", "destination": "MKC", "from": "16:30", "to": "18:00"},
}


def _time(point: dict[str, Any] | None, movement: str, field: str) -> str | None:
    return ((point or {}).get(movement) or {}).get(field)


def _call(locations: list[dict[str, Any]], code: str, after: int = -1) -> tuple[int, dict[str, Any] | None]:
    for index, item in enumerate(locations):
        if index > after and code in item.get("location", {}).get("shortCodes", []):
            return index, item.get("temporalData")
    return -1, None


def minutes_between(later: str | None, earlier: str | None) -> int | None:
    if not later or not earlier:
        return None
    parse = lambda value: datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int((parse(later) - parse(earlier)).total_seconds() // 60)


def normalize(payload: dict[str, Any], direction: str, collected_at: str) -> dict[str, Any] | None:
    service = payload.get("service") or {}
    meta = service.get("scheduleMetadata") or {}
    if meta.get("namespace") != "gb-nr" or meta.get("modeType") != "TRAIN" or meta.get("inPassengerService") is not True:
        return None
    window = WINDOWS[direction]
    locations = service.get("locations") or []
    origin_index, origin = _call(locations, window["origin"])
    _, destination = _call(locations, window["destination"], origin_index)
    if not origin or not destination:
        return None
    if origin.get("scheduledCallType") not in {"ADVERTISED_OPEN", "ADVERTISED_PICK_UP"}:
        return None
    if destination.get("scheduledCallType") not in {"ADVERTISED_OPEN", "ADVERTISED_SET_DOWN"}:
        return None
    scheduled_departure = _time(origin, "departure", "scheduleAdvertised")
    scheduled_arrival = _time(destination, "arrival", "scheduleAdvertised")
    actual_departure = None if _time(origin, "departure", "realtimeNoReport") else _time(origin, "departure", "realtimeActual")
    actual_arrival = None if _time(destination, "arrival", "realtimeNoReport") else _time(destination, "arrival", "realtimeActual")
    cancelled = bool(
        _time(origin, "departure", "isCancelled") or _time(destination, "arrival", "isCancelled")
        or origin.get("displayAs") in {"CANCELLED", "DIVERTED"}
        or destination.get("displayAs") in {"CANCELLED", "DIVERTED"}
    )
    issues: list[str] = []
    if not scheduled_departure or not scheduled_arrival:
        issues.append("Advertised timetable is incomplete.")
    if actual_arrival and actual_departure and minutes_between(actual_arrival, actual_departure) is not None and minutes_between(actual_arrival, actual_departure) < 0:
        issues.append("Actual arrival precedes departure.")
    operator = meta.get("operator") or {}
    unique = meta.get("uniqueIdentity", "")
    return {
        "serviceId": f"{unique}:{direction}", "rttServiceId": unique, "rttIdentity": meta.get("identity"),
        "serviceDate": scheduled_departure[:10] if scheduled_departure else meta.get("departureDate"),
        "operatorCode": operator.get("code", "UNKNOWN"), "operatorName": operator.get("name", "Unknown operator"),
        "direction": direction, "origin": window["origin"], "destination": window["destination"],
        "scheduledDeparture": scheduled_departure, "actualDeparture": actual_departure,
        "scheduledArrival": scheduled_arrival, "actualArrival": actual_arrival, "cancelled": cancelled,
        "rawDelayMinutes": None if cancelled else minutes_between(actual_arrival, scheduled_arrival),
        "dataIssues": issues, "collectedAt": collected_at,
    }


def in_window(service: dict[str, Any]) -> bool:
    departure = service.get("scheduledDeparture")
    if not departure:
        return False
    clock = departure[11:16]
    window = WINDOWS[service["direction"]]
    duration = minutes_between(service.get("scheduledArrival"), departure)
    return window["from"] <= clock <= window["to"] and duration is not None and 0 <= duration <= 60
