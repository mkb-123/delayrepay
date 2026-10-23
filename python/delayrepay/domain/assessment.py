from __future__ import annotations

from typing import Any

from .rules import RULES
from ..ingestion.services import minutes_between


def assess(
    service: dict[str, Any], all_services: list[dict[str, Any]], claimed_at: str | None = None,
    not_claimable_at: str | None = None, superseded_by: str | None = None,
    claim_lifecycle: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rule = RULES.get(service.get("operatorCode"))
    raw = service.get("rawDelayMinutes")
    alternatives = []
    any_operator = bool(rule and rule.get("alternativeScope") == "ANY_OPERATOR")
    for candidate in all_services:
        if (
            candidate.get("serviceId") == service.get("serviceId")
            or candidate.get("direction") != service.get("direction")
            or (not any_operator and candidate.get("operatorCode") != service.get("operatorCode"))
        ):
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
    measured = [item for item in alternatives if item.get("estimatedDelayMinutes") is not None]
    best = min(measured, key=lambda item: item["estimatedDelayMinutes"]) if measured else None
    base = {
        "status": "NEEDS_REVIEW", "effectiveDelayMinutes": None, "rawDelayMinutes": raw,
        "explanation": "", "alternativesConsidered": alternatives, "likelyRejected": False,
        "ruleVersion": rule["ruleVersion"] if rule else "UNSUPPORTED",
        "ruleOperatorName": rule["operatorName"] if rule else None,
        "ruleSource": rule["sourceUrl"] if rule else None,
        "ruleVerifiedAt": rule["verifiedAt"] if rule else None,
        "claimUrl": rule["claimUrl"] if rule else None,
        "claimedAt": claimed_at,
        "notClaimableAt": not_claimable_at,
        "supersededBy": superseded_by,
        "claimLifecycle": claim_lifecycle,
    }
    if claimed_at:
        base.update(status="CLAIMED", explanation="Previously acknowledged as claimed.")
        return base
    if not_claimable_at:
        base.update(status="NO_CLAIM", explanation="Marked as not claimable by you.")
        return base
    if superseded_by:
        base.update(status="NO_CLAIM", explanation="Not required because another train for this date and direction was marked as claimed.")
        return base
    if not rule:
        base["explanation"] = "This operator has no verified rule in the tracker."
    elif service.get("dataIssues"):
        base["explanation"] = "RTT data is incomplete: " + " ".join(service["dataIssues"])
    elif service.get("cancelled"):
        # A cancelled train has no delay of its own. Infer it from the next train of the same operator:
        # when that train actually reached the destination, against when the cancelled one was due.
        following = sorted(
            (c for c in all_services
             if c.get("serviceId") != service.get("serviceId") and c.get("direction") == service.get("direction")
             and c.get("operatorCode") == service.get("operatorCode") and not c.get("cancelled") and c.get("actualArrival")
             and (c.get("scheduledDeparture") or "") >= (service.get("scheduledDeparture") or "")),
            key=lambda c: c["scheduledDeparture"])
        if not following or not service.get("scheduledArrival"):
            base["explanation"] = "Cancelled, and no later train from the same operator has arrival data yet."
        else:
            nxt = following[0]
            inferred = max(0, minutes_between(nxt["actualArrival"], service["scheduledArrival"]))
            when = nxt["scheduledDeparture"][11:16]
            if inferred < rule["minimumDelay"]:
                base.update(status="NO_CLAIM", effectiveDelayMinutes=inferred, cancelledInferred=True, explanation=(
                    f"Cancelled, but the next {nxt['operatorName']} ({when}) reached {service['destination']} only {inferred} minutes after this train was due."))
            else:
                base.update(status="POTENTIAL", effectiveDelayMinutes=inferred, cancelledInferred=True, explanation=(
                    f"Cancelled. The next {nxt['operatorName']} ({when}) reached {service['destination']} {inferred} minutes after this train was due."))
    elif raw is None:
        base["explanation"] = "Actual destination arrival is not recorded."
    elif raw < rule["minimumDelay"]:
        base.update(status="NO_CLAIM", effectiveDelayMinutes=max(0, raw), explanation=f"Destination delay was {max(0, raw)} minutes, below the {rule['minimumDelay']}-minute threshold.")
    elif best and best["estimatedDelayMinutes"] < rule["minimumDelay"] and best["estimatedDelayMinutes"] < raw:
        base.update(
            status="NEEDS_REVIEW", effectiveDelayMinutes=max(0, best["estimatedDelayMinutes"]), likelyRejected=True,
            explanation=(
                f"Likely rejected: this {service['operatorName']} train was {raw} minutes late, but the {best['actualDeparture'][11:16]} "
                f"{best['operator']} reached {service['destination']} at {best['actualArrival'][11:16]}, only "
                f"{max(0, best['estimatedDelayMinutes'])} minutes after your planned {(service.get('scheduledArrival') or '')[11:16]}. "
                f"{rule['operatorName']} measures the delay against its own best alternative train."
            ),
        )
    elif best and best["estimatedDelayMinutes"] < raw:
        base.update(
            status="NEEDS_REVIEW", effectiveDelayMinutes=best["estimatedDelayMinutes"],
            explanation=(
                f"Train arrived {raw} minutes late, but the {best['actualDeparture'][11:16]} {best['operator']} reached "
                f"{service['destination']} {best['estimatedDelayMinutes']} minutes late; the claim band may be lower. Confirm the train actually taken."
            ),
        )
    else:
        base.update(status="POTENTIAL", effectiveDelayMinutes=raw, explanation=f"Arrived {service['destination']} {raw} minutes late. Potential if you travelled on this service with a valid ticket.")
    return base
