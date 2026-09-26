import type { StoredService } from "./archive";
import type { Assessment, JourneyEvidence } from "./types";
export interface LocalRecord {
  serviceId: string;
  evidence?: JourneyEvidence;
  claimedAt: string | null;
  // Full frozen record allows permanent local acknowledgement even if live data changes.
  claimedSnapshot?: StoredService;
  restoredAssessment?: Assessment;
  updatedAt: string;
}
export type LocalRecords = Record<string, LocalRecord>;
export function acknowledge(record: StoredService, previous?: LocalRecord, now = new Date().toISOString()): LocalRecord {
  if (previous?.claimedAt) return previous; // repeated clicks are idempotent
  if (record.assessment.status !== "POTENTIAL") throw new Error("Only potential claims can be acknowledged.");
  return { ...previous, serviceId: record.service.id, claimedAt: now, claimedSnapshot: structuredClone(record), restoredAssessment: undefined, updatedAt: now };
}
export function undo(previous: LocalRecord, now = new Date().toISOString()): LocalRecord {
  if (!previous.claimedAt) return previous;
  return { ...previous, claimedAt: null, restoredAssessment: previous.claimedSnapshot?.assessment, updatedAt: now };
}
export function outstanding(records: StoredService[], local: LocalRecords): number {
  return records.filter(r => !local[r.service.id]?.claimedAt && r.assessment.status === "POTENTIAL").length;
}
