import type { Archive, StoredService } from "@/domain/archive";
import type { LocalRecords } from "@/domain/claims";
import { londonDate, minutesBetween, timeLabel } from "@/domain/time";
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
    .filter(record => scheduledJourneyMinutes(record) == null || scheduledJourneyMinutes(record)! <= 60)
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
  lines.push("| Train | Delay | Can I claim? |");
  lines.push("|---|---:|---|");
  for (const record of records) {
    const service = record.service;
    const assessment = record.assessment;
    const claimedAt = local[service.id]?.claimedAt;
    const delay = assessment.effectiveDelayMinutes ?? assessment.rawDelayMinutes;
    const delayText = delay == null ? "delay not established" : delay <= 0 ? "on time" : `+${delay} min`;
    const claim = claimText(record, claimedAt);
    lines.push(`| ${timeLabel(service.scheduledDeparture)} ${service.operatorName} | ${delayText} | ${claim} |`);
  }
  lines.push("");
}

function claimText(record: StoredService, claimedAt: string | null | undefined): string {
  if (claimedAt) return "Claimed";
  const service = record.service;
  const assessment = record.assessment;
  if (assessment.status === "NO_CLAIM") return "No";
  if (assessment.status === "NEEDS_REVIEW") return "Needs review";
  const claimUrl = rules[service.operatorCode]?.claimUrl;
  return claimUrl ? `[Yes](${claimUrl})` : "Yes";
}

function scheduledJourneyMinutes(record: StoredService): number | null {
  const service = record.service;
  return minutesBetween(service.scheduledArrival, service.scheduledDeparture);
}
