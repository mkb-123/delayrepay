from __future__ import annotations

from typing import Any

from .rules import RULES
from ..ingestion.services import minutes_between


def assess(service: dict[str, Any], all_services: list[dict[str, Any]], claimed_at: str | None = None) -> dict[str, Any]:
    rule = RULES.get(service.get("operatorCode"))
    raw = service.get("rawDelayMinutes")
    alternatives = []
    for candidate in all_services:
        if candidate.get("serviceId") == service.get("serviceId") or candidate.get("direction") != service.get("direction"):
            continue
        if not candidate.get("actualDeparture") or not candidate.get("actualArrival") or not service.get("scheduledDeparture"):
            continue
        if candidate["actualDeparture"] < service["scheduledDeparture"]:
            continue
        delay = minutes_between(candidate["actualArrival"], service.get("scheduledArrival"))
        alternatives.append({
            "serviceId": candidate["serviceId"], "operator": candidate["operatorName"],
            "actualDeparture": candidate["actualDeparture"], "actualArrival": candidate["actualArrival"],
            "estimatedDelayMinutes": delay, "ticketScope": "ANY_PERMITTED",
        })
    alternatives.sort(key=lambda item: item["actualArrival"])
    base = {
        "status": "NEEDS_REVIEW", "effectiveDelayMinutes": None, "rawDelayMinutes": raw,
        "explanation": "", "alternativesConsidered": alternatives,
        "ruleVersion": rule["ruleVersion"] if rule else "UNSUPPORTED",
        "ruleOperatorName": rule["operatorName"] if rule else None,
        "ruleSource": rule["sourceUrl"] if rule else None,
        "ruleVerifiedAt": rule["verifiedAt"] if rule else None,
        "claimUrl": rule["claimUrl"] if rule else None,
        "claimedAt": claimed_at,
    }
    if claimed_at:
        base.update(status="CLAIMED", explanation="Previously acknowledged as claimed.")
        return base
    if not rule:
        base["explanation"] = "This operator has no verified rule in the tracker."
    elif service.get("dataIssues"):
        base["explanation"] = "RTT data is incomplete: " + " ".join(service["dataIssues"])
    elif service.get("cancelled"):
        base["explanation"] = "Service cancelled; confirm which alternative you actually used and when it arrived."
    elif raw is None:
        base["explanation"] = "Actual destination arrival is not recorded."
    elif raw < rule["minimumDelay"]:
        base.update(status="NO_CLAIM", effectiveDelayMinutes=max(0, raw), explanation=f"Destination delay was {max(0, raw)} minutes, below the {rule['minimumDelay']}-minute threshold.")
    elif any((item.get("estimatedDelayMinutes") or 0) < raw for item in alternatives):
        base["explanation"] = f"Train arrived {raw} minutes late, but an earlier-arriving alternative exists; confirm the train actually taken."
    else:
        base.update(status="POTENTIAL", effectiveDelayMinutes=raw, explanation=f"Arrived {service['destination']} {raw} minutes late. Potential if you travelled on this service with a valid ticket.")
    return base
