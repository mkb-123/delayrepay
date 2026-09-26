from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .assess import assess
from .rtt import RttClient, RttError
from .services import WINDOWS, in_window, normalize
from .store import catalogue_path, daily_path, read_json, report_path, write_json


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _weekday(value: str) -> int:
    parsed = date.fromisoformat(value)
    if parsed.weekday() >= 5:
        raise ValueError("Monitoring is Monday-Friday only")
    return parsed.weekday()


def _later(clock: str, minutes: int) -> str:
    value = datetime.strptime(clock, "%H:%M") + timedelta(minutes=minutes)
    return value.strftime("%H:%M")


def _save_catalogue(root: Path, service_date: str, found: list[dict[str, Any]], directions: set[str]) -> None:
    weekday = _weekday(service_date)
    existing = read_json(catalogue_path(root), {"services": []})
    others = [
        item for item in existing.get("services", [])
        if item.get("weekday") != weekday or item.get("direction") not in directions
    ]
    services = sorted(others + found, key=lambda item: (item["weekday"], item["direction"], item["scheduledDeparture"], item["rttIdentity"]))
    value = {"version": 1, "updatedAt": _now(), "services": services}
    write_json(catalogue_path(root), value)
    lines = ["# Relevant service catalogue", "", f"Updated: {value['updatedAt']}", "", "| Day | Direction | Train | Operator | Journey |", "|---|---|---:|---|---|"]
    days = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    for item in services:
        lines.append(f"| {days[item['weekday']]} | {item['direction'].title()} | {item['scheduledDeparture']} | {item['operatorName']} | {item['origin']} → {item['destination']} ({item['scheduledArrival']}) |")
    (root / "service-catalogue.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def discover(root: Path, service_date: str, client: RttClient, direction: str = "ALL") -> list[dict[str, Any]]:
    weekday = _weekday(service_date)
    found: list[dict[str, Any]] = []
    selected = set(WINDOWS) if direction == "ALL" else {direction}
    for current_direction in selected:
        window = WINDOWS[current_direction]
        origin_line = client.lineup(window["origin"], service_date, window["from"], window["to"])
        destination_line = client.lineup(window["destination"], service_date, window["from"], _later(window["to"], 90))
        origin_ids = {item.get("scheduleMetadata", {}).get("uniqueIdentity") for item in origin_line.get("services", [])}
        destination_ids = {item.get("scheduleMetadata", {}).get("uniqueIdentity") for item in destination_line.get("services", [])}
        for unique in sorted((origin_ids & destination_ids) - {None}):
            service = normalize(client.service(unique), current_direction, _now())
            if not service or not in_window(service):
                continue
            found.append({
                "rttIdentity": service["rttIdentity"], "weekday": weekday, "direction": current_direction,
                "origin": service["origin"], "destination": service["destination"],
                "scheduledDeparture": service["scheduledDeparture"][11:16], "scheduledArrival": service["scheduledArrival"][11:16],
                "operatorCode": service["operatorCode"], "operatorName": service["operatorName"],
                "discoveredFrom": service_date,
            })
    _save_catalogue(root, service_date, found, selected)
    return found


def discover_cached(root: Path, service_date: str, direction: str = "ALL") -> list[dict[str, Any]]:
    weekday = _weekday(service_date)
    observation_dir = root / "observations" / service_date
    if not observation_dir.exists():
        observation_dir = root.parent / "legacy" / "data-store" / "observations" / service_date
    if not observation_dir.exists():
        raise ValueError(f"No cached RTT observations for {service_date}")
    found_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    selected = set(WINDOWS) if direction == "ALL" else {direction}
    for path in observation_dir.glob("*.json"):
        observation = read_json(path, {})
        payload = observation.get("payload", observation)
        collected_at = observation.get("collectedAt", _now())
        for current_direction in selected:
            service = normalize(payload, current_direction, collected_at)
            if not service or not in_window(service):
                continue
            item = {
                "rttIdentity": service["rttIdentity"], "weekday": weekday, "direction": current_direction,
                "origin": service["origin"], "destination": service["destination"],
                "scheduledDeparture": service["scheduledDeparture"][11:16], "scheduledArrival": service["scheduledArrival"][11:16],
                "operatorCode": service["operatorCode"], "operatorName": service["operatorName"],
                "discoveredFrom": service_date, "source": "cached-observation",
            }
            found_by_key[(item["rttIdentity"], current_direction)] = item
    found = list(found_by_key.values())
    _save_catalogue(root, service_date, found, selected)
    return found


def collect(root: Path, service_date: str, client: RttClient | None, dry_run: bool = False) -> dict[str, Any]:
    weekday = _weekday(service_date)
    catalogue = read_json(catalogue_path(root))
    if not catalogue:
        raise ValueError("No service catalogue. Run discover first.")
    entries = [item for item in catalogue.get("services", []) if item.get("weekday") == weekday]
    planned = [f"gb-nr:{item['rttIdentity']}:{service_date}" for item in entries]
    if dry_run:
        return {"date": service_date, "plannedRequests": planned, "requestCount": len(planned)}
    services, errors = [], []
    assert client is not None
    for entry, unique in zip(entries, planned):
        try:
            service = normalize(client.service(unique), entry["direction"], _now())
            if service and in_window(service):
                services.append(service)
        except RttError as error:
            errors.append({"rttServiceId": unique, "error": str(error)})
    value = {"version": 1, "date": service_date, "collectedAt": _now(), "complete": not errors, "services": services, "errors": errors}
    write_json(daily_path(root, service_date), value)
    return value


def load_claims(root: Path) -> dict[str, str]:
    return read_json(root / "claims.json", {})


def generate_report(root: Path, service_date: str, action_only: bool = False) -> tuple[str, list[dict[str, Any]]]:
    daily = read_json(daily_path(root, service_date))
    if not daily:
        raise ValueError(f"No daily data for {service_date}. Run collect first.")
    claims = load_claims(root)
    services = daily.get("services", [])
    rows = []
    for service in services:
        evaluation = assess(service, services, claims.get(service["serviceId"]))
        rows.append({**service, "assessment": evaluation})
    if action_only:
        rows = [row for row in rows if row["assessment"]["status"] in {"POTENTIAL", "NEEDS_REVIEW"}]
    outstanding = sum(row["assessment"]["status"] == "POTENTIAL" for row in rows)
    lines = [f"# Delay Repay brief — {service_date}", "", f"Potential claims: **{outstanding}**", ""]
    if not daily.get("complete", True):
        lines.extend(["> Collection was incomplete. Missing services are not assessed.", ""])
    for direction in ("MORNING", "EVENING"):
        window = WINDOWS[direction]
        lines.extend([f"## {direction.title()} — {window['origin']} → {window['destination']}", "", "| Train | Delay | Can I claim? |", "|---:|---:|---|"])
        section = [row for row in rows if row["direction"] == direction]
        if not section:
            stored = any(service.get("direction") == direction for service in services)
            lines.append(f"| — | — | {'No action required' if stored and action_only else 'No stored services'} |")
        for row in section:
            assessment = row["assessment"]
            delay = "Cancelled" if row["cancelled"] else ("Unknown" if row["rawDelayMinutes"] is None else f"{max(0, row['rawDelayMinutes'])} min")
            labels = {"NO_CLAIM": "No", "POTENTIAL": "Potential", "NEEDS_REVIEW": "Needs review", "CLAIMED": "Claimed"}
            lines.append(f"| {row['scheduledDeparture'][11:16]} · {row['operatorName']} | {delay} | {labels[assessment['status']]} |")
        lines.append("")
    text = "\n".join(lines)
    path = report_path(root, service_date)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return text, rows


def report_week(root: Path, week_start: str, action_only: bool = False) -> str:
    start = date.fromisoformat(week_start)
    chunks = []
    for offset in range(5):
        current = (start + timedelta(days=offset)).isoformat()
        if daily_path(root, current).exists():
            chunks.append(generate_report(root, current, action_only)[0])
    if not chunks:
        raise ValueError("No stored daily data in that week")
    text = "\n\n---\n\n".join(chunks)
    path = root / "reports" / f"week-{week_start}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return text


def set_claim(root: Path, service_date: str, service_id: str, undo: bool) -> None:
    daily = read_json(daily_path(root, service_date))
    if not daily or service_id not in {item["serviceId"] for item in daily.get("services", [])}:
        raise ValueError("Service was not found in stored daily data")
    claims = load_claims(root)
    if undo:
        claims.pop(service_id, None)
    else:
        services = daily.get("services", [])
        service = next(item for item in services if item["serviceId"] == service_id)
        if assess(service, services)["status"] != "POTENTIAL":
            raise ValueError("Only a potential claim can be marked as claimed")
        claims[service_id] = _now()
    write_json(root / "claims.json", claims)
