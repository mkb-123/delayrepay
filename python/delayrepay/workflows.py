from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import logging
from pathlib import Path
from typing import Any

from .domain.assessment import assess
from .ingestion.rtt import RttClient, RttError
from .ingestion.services import WINDOWS, in_window, normalize
from .storage.sqlite import Database, catalogue_path, read_json, write_json

LOGGER = logging.getLogger("delayrepay.workflow")


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
    LOGGER.info("Saved catalogue with %d total services", len(services))


def discover(root: Path, service_date: str, client: RttClient, direction: str = "ALL") -> list[dict[str, Any]]:
    weekday = _weekday(service_date)
    found: list[dict[str, Any]] = []
    selected = set(WINDOWS) if direction == "ALL" else {direction}
    LOGGER.info("Discovering %s services for %s", ", ".join(sorted(selected)).lower(), service_date)
    for current_direction in selected:
        window = WINDOWS[current_direction]
        LOGGER.info("Loading %s origin and destination lineups", current_direction.lower())
        origin_line = client.lineup(window["origin"], service_date, window["from"], window["to"])
        destination_line = client.lineup(window["destination"], service_date, window["from"], _later(window["to"], 90))
        origin_ids = {item.get("scheduleMetadata", {}).get("uniqueIdentity") for item in origin_line.get("services", [])}
        destination_ids = {item.get("scheduleMetadata", {}).get("uniqueIdentity") for item in destination_line.get("services", [])}
        candidates = sorted((origin_ids & destination_ids) - {None})
        LOGGER.info("Checking %d shared %s service candidates", len(candidates), current_direction.lower())
        for index, unique in enumerate(candidates, 1):
            LOGGER.info("Checking candidate %d/%d: %s", index, len(candidates), unique)
            service = normalize(client.service(unique), current_direction, _now())
            if not service or not in_window(service):
                continue
            LOGGER.info("Retained %s %s %s", service["scheduledDeparture"][11:16], service["operatorName"], current_direction.lower())
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
    LOGGER.info("Reading cached observations from %s", observation_dir)
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
    LOGGER.info("Retained %d services from cached observations", len(found))
    return found


def collect(root: Path, service_date: str, client: RttClient | None, dry_run: bool = False) -> dict[str, Any]:
    weekday = _weekday(service_date)
    catalogue = read_json(catalogue_path(root))
    if not catalogue:
        raise ValueError("No service catalogue. Run discover first.")
    entries = [item for item in catalogue.get("services", []) if item.get("weekday") == weekday]
    planned = [f"gb-nr:{item['rttIdentity']}:{service_date}" for item in entries]
    LOGGER.info("Collection for %s: %d catalogue services%s", service_date, len(planned), " (dry run)" if dry_run else "")
    if dry_run:
        return {"date": service_date, "plannedRequests": planned, "requestCount": len(planned)}
    if not entries:
        return {
            "date": service_date, "skipped": True, "complete": False, "services": [],
            "errors": [{"error": "No catalogue entries for this weekday; run discover first."}],
        }
    services, errors = [], []
    assert client is not None
    for index, (entry, unique) in enumerate(zip(entries, planned), 1):
        LOGGER.info("Collecting service %d/%d: %s %s", index, len(planned), entry["scheduledDeparture"], entry["operatorName"])
        try:
            service = normalize(client.service(unique), entry["direction"], _now())
            if service and in_window(service):
                services.append(service)
        except RttError as error:
            LOGGER.warning("Could not collect %s: %s", unique, error)
            errors.append({"rttServiceId": unique, "error": str(error)})
    value = {"version": 1, "date": service_date, "collectedAt": _now(), "complete": not errors, "services": services, "errors": errors}
    with Database(root) as database:
        database.save_collection(value)
    LOGGER.info("Saved %d services for %s with %d errors", len(services), service_date, len(errors))
    return value


def generate_report(root: Path, service_date: str, action_only: bool = False) -> str:
    with Database(root) as database:
        report_data = build_report_data(database, service_date, action_only)
    return write_latest_report(root, report_data)


def build_report_data(database: Database, service_date: str, action_only: bool, persist: bool = True) -> dict[str, Any]:
    services = database.services_for_date(service_date)
    if not services:
        raise ValueError(f"No stored services for {service_date}. Run collect first.")
    LOGGER.info("Assessing %d stored services for %s", len(services), service_date)
    all_rows = []
    assessed_at = _now()
    for service in services:
        evaluation = assess(service, services, database.claimed_at(service["serviceId"]))
        if persist:
            database.save_assessment(service["serviceId"], assessed_at, evaluation)
        all_rows.append({**service, "assessment": evaluation})
    rows = all_rows
    if action_only:
        rows = [row for row in rows if row["assessment"]["status"] in {"POTENTIAL", "NEEDS_REVIEW"}]
    counts: dict[str, int] = {}
    for row in all_rows:
        status = row["assessment"]["status"]
        counts[status] = counts.get(status, 0) + 1
    report_data = {
        "version": 1,
        "generatedAt": _now(),
        "date": service_date,
        "actionOnly": action_only,
        "sourceComplete": database.collection_complete(service_date),
        "summary": {
            "storedServices": len(services),
            "includedServices": len(rows),
            "potentialClaims": counts.get("POTENTIAL", 0),
            "needsReview": counts.get("NEEDS_REVIEW", 0),
            "claimed": counts.get("CLAIMED", 0),
            "noClaim": counts.get("NO_CLAIM", 0),
            "storedByDirection": {
                direction: sum(service.get("direction") == direction for service in services)
                for direction in WINDOWS
            },
        },
        "services": all_rows,
    }
    return report_data


def write_latest_report(root: Path, report_data: dict[str, Any]) -> str:
    output = root / "output"
    json_path = output / "latest.json"
    markdown_path = output / "latest.md"
    write_json(json_path, report_data)
    # Markdown is deliberately rendered from the persisted JSON artifact.
    persisted = read_json(json_path)
    if persisted.get("days") is not None:
        text = "\n\n---\n\n".join(render_report_markdown(item) for item in persisted["days"])
    else:
        text = render_report_markdown(persisted)
    markdown_path.write_text(text, encoding="utf-8")
    LOGGER.info("Wrote report data %s", json_path)
    LOGGER.info("Wrote Markdown report %s", markdown_path)
    return text


def render_report_markdown(report_data: dict[str, Any]) -> str:
    service_date = report_data["date"]
    rows = report_data.get("services", [])
    summary = report_data.get("summary", {})
    action_only = report_data.get("actionOnly", False)
    if action_only:
        rows = [row for row in rows if row["assessment"]["status"] in {"POTENTIAL", "NEEDS_REVIEW"}]
    lines = [f"# Delay Repay brief — {service_date}", "", f"Potential claims: **{summary.get('potentialClaims', 0)}**", ""]
    if not report_data.get("sourceComplete", True):
        lines.extend(["> Collection was incomplete. Missing services are not assessed.", ""])
    for direction in ("MORNING", "EVENING"):
        window = WINDOWS[direction]
        lines.extend([f"## {direction.title()} — {window['origin']} → {window['destination']}", "", "| Train | Delay | Can I claim? |", "|---:|---:|---|"])
        section = [row for row in rows if row["direction"] == direction]
        if not section:
            stored = summary.get("storedByDirection", {}).get(direction, 0) > 0
            lines.append(f"| — | — | {'No action required' if stored and action_only else 'No stored services'} |")
        for row in section:
            assessment = row["assessment"]
            delay = "Cancelled" if row["cancelled"] else ("Unknown" if row["rawDelayMinutes"] is None else f"{max(0, row['rawDelayMinutes'])} min")
            labels = {"NO_CLAIM": "No", "POTENTIAL": "Potential", "NEEDS_REVIEW": "Needs review", "CLAIMED": "Claimed"}
            lines.append(f"| {row['scheduledDeparture'][11:16]} · {row['operatorName']} | {delay} | {labels[assessment['status']]} |")
        lines.append("")
    return "\n".join(lines)


def report_week(root: Path, week_start: str, action_only: bool = False) -> str:
    start = date.fromisoformat(week_start)
    end = start + timedelta(days=4)
    reports = []
    with Database(root) as database:
        for current in database.stored_dates(start.isoformat(), end.isoformat()):
            report_data = build_report_data(database, current, action_only)
            reports.append(report_data)
    if not reports:
        raise ValueError("No stored services in that week")
    combined = {"version": 1, "generatedAt": _now(), "type": "week", "weekStart": week_start, "actionOnly": action_only, "days": reports}
    return write_latest_report(root, combined)


def report_lookback(root: Path, end_date: str, days: int, action_only: bool = False) -> str:
    if days < 1:
        raise ValueError("Lookback days must be at least 1")
    end = date.fromisoformat(end_date)
    start = end - timedelta(days=days - 1)
    LOGGER.info("Building %d-day report from %s to %s", days, start, end)
    reports = []
    with Database(root) as database:
        for service_date in database.stored_dates(start.isoformat(), end.isoformat()):
            report_data = build_report_data(database, service_date, action_only)
            reports.append(report_data)
    if not reports:
        raise ValueError(f"No stored services from {start.isoformat()} to {end.isoformat()}")
    combined = {
        "version": 1, "generatedAt": _now(), "type": "lookback", "daysRequested": days,
        "startDate": start.isoformat(), "endDate": end_date, "actionOnly": action_only, "days": reports,
    }
    LOGGER.info("Rendering combined report from %d stored days", len(reports))
    return write_latest_report(root, combined)


def set_claim(root: Path, service_date: str, service_id: str, undo: bool) -> None:
    with Database(root) as database:
        services = database.services_for_date(service_date)
        if service_id not in {item["serviceId"] for item in services}:
            raise ValueError("Service was not found in SQLite history")
        if undo:
            database.set_claim(service_id, None)
        else:
            service = next(item for item in services if item["serviceId"] == service_id)
            if assess(service, services)["status"] != "POTENTIAL":
                raise ValueError("Only a potential claim can be marked as claimed")
            database.set_claim(service_id, _now())
