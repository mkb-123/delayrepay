import { minutesBetween } from "./time";
import { rules } from "./rules";
import { defaultEvidence, type Alternative, type Assessment, type JourneyEvidence, type RailService } from "./types";

export function alternativesFor(s: RailService, all: RailService[], evidence: JourneyEvidence): Alternative[] {
  if (!s.scheduledDeparture) return [];
  return all.filter(a => a.id !== s.id && a.direction === s.direction && a.serviceDate === s.serviceDate &&
    a.origin === s.origin && a.destination === s.destination && a.scheduledDeparture &&
    // Include earlier-scheduled trains that actually leave after the intended departure.
    Date.parse(a.actualDeparture ?? a.scheduledDeparture) >= Date.parse(s.scheduledDeparture!))
    .map(a => {
      let applicability: Alternative["applicability"] = "CANDIDATE";
      let reason = "Candidate under your ticket profile; boarding and any time/route restrictions still need confirmation.";
      if (a.cancelled || a.dataIssues.length || a.alterations.length) {
        applicability = "EXCLUDED"; reason = "Cancelled, altered, or incomplete service: not a verified usable alternative.";
      } else if (!a.actualDeparture || !a.actualArrival) {
        applicability = "REQUIRES_CONFIRMATION"; reason = "Actual departure or arrival has not been recorded.";
      } else if (evidence.ticketScope === "UNKNOWN" || (evidence.ticketScope === "SAME_OPERATOR" && a.operatorCode !== s.operatorCode)) {
        applicability = "REQUIRES_CONFIRMATION";
        reason = a.operatorCode !== s.operatorCode
          ? "Different operator: ticket validity or disruption ticket acceptance is unconfirmed."
          : "Ticket restrictions are unknown.";
      }
      return {
        serviceId: a.id, rttServiceId: a.rttServiceId, operatorName: a.operatorName, operatorCode: a.operatorCode,
        scheduledDeparture: a.scheduledDeparture, actualDeparture: a.actualDeparture, actualArrival: a.actualArrival,
        estimatedJourneyDelay: minutesBetween(a.actualArrival, s.scheduledArrival), applicability, reason,
      };
    }).sort((a,b) => (a.actualArrival ?? "9999").localeCompare(b.actualArrival ?? "9999"));
}

export function assess(s: RailService, all: RailService[], evidence = defaultEvidence, collectionComplete = true): Assessment {
  const rule = rules[s.operatorCode];
  const raw = minutesBetween(s.actualArrival, s.scheduledArrival);
  const alternatives = alternativesFor(s, all, evidence);
  const result: Assessment = {
    status: "NEEDS_REVIEW", effectiveDelayMinutes: null, rawDelayMinutes: raw,
    explanation: "", ruleVersion: rule?.ruleVersion ?? "UNSUPPORTED",
    ruleSource: rule?.sourceUrl ?? null, ruleVerifiedAt: rule?.verifiedAt ?? null, minimumDelay: rule?.minimumDelay ?? null,
    alternatives, evidence, collectionComplete,
    steps: ["Baseline: advertised arrival at the monitored destination, not departure lateness."],
    assumptions: [],
  };
  const finish = (status: Assessment["status"], text: string, delay: number | null = null): Assessment => ({
    ...result, status, explanation: s.operatorName + " — " + text, effectiveDelayMinutes: delay,
  });
  if (evidence.travelled === "NOT_TRAVELLED")
    return finish("NO_CLAIM", "you did not travel. Delay Repay does not apply; an unused-ticket refund may be appropriate.");
  if (!rule) return finish("NEEDS_REVIEW", "this operator has no verified compensation policy in the tracker.");
  if (s.serviceDate < rule.applicableFrom) return finish("NEEDS_REVIEW", "this journey predates the verified rule period. Check the terms applicable on the travel date.");
  if (!s.scheduledArrival || !s.scheduledDeparture || s.dataIssues.length)
    return finish("NEEDS_REVIEW", "incomplete or inconsistent rail data. " + s.dataIssues.join(" "));
  if (s.alterations.length)
    return finish("NEEDS_REVIEW", "service alterations require checking the advertised timetable and usable calling points.");
  if (!collectionComplete)
    return finish("NEEDS_REVIEW", "collection is incomplete; alternative services or updated running data may be missing.");
  result.steps.push("Rule " + rule.ruleVersion + ": destination delay of at least " + rule.minimumDelay + " minutes.");
  if (evidence.travelled === "ALTERNATIVE") {
    const selected = alternatives.find(a => a.serviceId === evidence.alternativeId);
    if (!selected || selected.applicability === "EXCLUDED" || !selected.actualDeparture || !selected.actualArrival)
      return finish("NEEDS_REVIEW", "the selected alternative has no verified usable departure and arrival.");
    if (!evidence.ticketValid) return finish("NEEDS_REVIEW", "confirm your ticket was valid on the alternative, including any cross-operator acceptance.");
    // A different journey must be a consequence of a disruption to the intended train.
    if (!s.cancelled && (raw === null || raw <= 0))
      return finish("NEEDS_REVIEW", "the data does not establish that this operator disrupted your intended journey.");
    const delay = Math.max(0, selected.estimatedJourneyDelay!);
    result.steps.push("Confirmed alternative " + selected.rttServiceId + ": actual arrival minus the intended service's advertised arrival = " + delay + " minutes.");
    return finish(delay >= rule.minimumDelay ? "POTENTIAL" : "NO_CLAIM",
      (s.cancelled ? "service cancelled; " : "disrupted intended service; ") +
      "your confirmed alternative arrived " + delay + " minutes after the intended arrival.", delay);
  }
  if (s.cancelled) {
    const candidate = alternatives.find(a => a.applicability === "CANDIDATE" && a.actualArrival);
    if (candidate) result.steps.push("Earliest recorded candidate gives a scenario delay of " + Math.max(0, candidate.estimatedJourneyDelay!) + " minutes. This is not a confirmed passenger delay.");
    return finish("NEEDS_REVIEW", "service cancelled. Confirm whether you travelled, the alternative used, and ticket validity.");
  }
  if (raw === null) return finish("NEEDS_REVIEW", "actual destination arrival is not recorded. Forecasts and estimates cannot establish a claim.");
  if (evidence.travelled === "ORIGINAL") {
    if (!evidence.ticketValid) return finish("NEEDS_REVIEW", "confirm you held a valid ticket for the journey taken.");
    result.steps.push("You confirmed travelling on the original service with a valid ticket. Actual arrival minus advertised arrival = " + raw + " minutes.");
    return finish(raw >= rule.minimumDelay ? "POTENTIAL" : "NO_CLAIM", "your confirmed journey arrived " + Math.max(0, raw) + " minutes after the scheduled arrival.", Math.max(0, raw));
  }
  if (raw < rule.minimumDelay)
    return finish("NO_CLAIM", "recorded destination delay is " + Math.max(0, raw) + " minutes, below the " + rule.minimumDelay + "-minute threshold for this service.", Math.max(0, raw));
  const earlier = alternatives.filter(a => a.applicability !== "EXCLUDED" && a.actualArrival && Date.parse(a.actualArrival) < Date.parse(s.actualArrival!));
  const unresolved = alternatives.some(a => a.applicability !== "EXCLUDED" && (!a.actualArrival || !a.actualDeparture));
  if (earlier.length || unresolved) {
    result.steps.push("The original train's " + raw + "-minute delay is not enough to establish the passenger's delay; check the alternatives and journey taken.");
    return finish("NEEDS_REVIEW", "a potentially earlier or unresolved alternative exists. Confirm the journey actually made before using the original train's delay.");
  }
  result.assumptions.push("Potential only if this was your intended and actual journey and you held a valid ticket. The tracker does not know that you travelled.",
    "Alternatives are limited to the collected direct-service window. Ability to board and connecting journeys are not inferred.");
  result.steps.push("No earlier-arriving usable candidate was found in the collected window. Conditional original-journey delay = " + raw + " minutes.");
  return finish("POTENTIAL", "arrived " + s.destination + " " + raw + " minutes after the scheduled arrival. Potential only if you travelled on this service with a valid ticket.", raw);
}
