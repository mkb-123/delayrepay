import type { Archive, StoredService } from "@/domain/archive";
import type { LocalRecords } from "@/domain/claims";
import { londonDate, timeLabel } from "@/domain/time";
import { rules } from "@/domain/rules";

export interface BriefOptions {
  date?: string;
  now?: Date;
  local?: LocalRecords;
}

export function renderBrief(archive: Archive, options: BriefOptions = {}): string {
  const date = options.date ?? londonDate(options.now);
  const local = options.local ?? {};
  const records = archive.services
    .filter(record => record.service.serviceDate === date && record.service.monitored)
    .sort((a, b) =>
      a.service.direction.localeCompare(b.service.direction) ||
      (a.service.scheduledDeparture ?? "").localeCompare(b.service.scheduledDeparture ?? "")
    );
  const outstanding = records.filter(record => record.assessment.status === "POTENTIAL" && !local[record.service.id]?.claimedAt);
  const needsReview = records.filter(record => record.assessment.status === "NEEDS_REVIEW" && !local[record.service.id]?.claimedAt);
  const claimed = records.filter(record => !!local[record.service.id]?.claimedAt);
  const lines: string[] = [
    "# MKC EUS Delay Repay Brief",
    "",
    `Date: ${date}`,
    `Potential claims: ${outstanding.length}`,
    `Needs review: ${needsReview.length}`,
    `Claimed locally: ${claimed.length}`,
    "",
  ];

  if (archive.lastAttemptAt) lines.push(`Last collection attempt: ${archive.lastAttemptAt}`, "");
  if (!records.length) {
    lines.push("No monitored services are stored for this date.", "");
    lines.push("Run `pnpm brief --fetch` after the travel windows have completed to collect current RTT evidence.");
    return lines.join("\n");
  }

  appendDirection(lines, "Morning - MKC to EUS", records.filter(record => record.service.direction === "MORNING"), local);
  appendDirection(lines, "Evening - EUS to MKC", records.filter(record => record.service.direction === "EVENING"), local);

  const latest = archive.runs.at(-1);
  if (latest && latest.status !== "SUCCESS") {
    lines.push("", "## Collection warning", "", `${latest.status}: ${latest.message}`);
  }

  return lines.join("\n");
}

function appendDirection(lines: string[], title: string, records: StoredService[], local: LocalRecords) {
  lines.push(`## ${title}`, "");
  if (!records.length) {
    lines.push("No stored services for this direction.", "");
    return;
  }
  for (const record of records) {
    const service = record.service;
    const assessment = record.assessment;
    const claimedAt = local[service.id]?.claimedAt;
    const status = claimedAt ? "Claimed" : assessment.status === "POTENTIAL" ? "Potential claim" : assessment.status === "NEEDS_REVIEW" ? "Needs review" : "No claim";
    const delay = assessment.effectiveDelayMinutes ?? assessment.rawDelayMinutes;
    const delayText = delay == null ? "delay not established" : delay <= 0 ? "on time" : `+${delay} min`;
    lines.push(`### ${timeLabel(service.scheduledDeparture)} - ${service.operatorName}`);
    lines.push(`Status: ${status} (${delayText})`);
    lines.push(`Scheduled arrival: ${timeLabel(service.scheduledArrival)}; actual arrival: ${timeLabel(service.actualArrival)}`);
    lines.push(`Reason: ${assessment.explanation}`);
    if (assessment.alternatives.length) {
      lines.push("Alternatives considered:");
      for (const alternative of assessment.alternatives.slice(0, 5)) {
        const alternativeDelay = alternative.estimatedJourneyDelay == null ? "delay not established" : `${alternative.estimatedJourneyDelay} min`;
        lines.push(`- ${timeLabel(alternative.scheduledDeparture)} ${alternative.operatorName}: ${alternative.applicability}; ${alternativeDelay}; ${alternative.reason}`);
      }
    }
    const claimUrl = rules[service.operatorCode]?.claimUrl;
    if (claimUrl && assessment.status === "POTENTIAL" && !claimedAt) lines.push(`Claim link: ${claimUrl}`);
    lines.push(`Service id: ${service.id}`, "");
  }
}
