import { readFile, mkdir, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { emptyArchive, type Archive, type StoredService } from "@/domain/archive";
import type { RailService, Assessment } from "@/domain/types";
import { minutesBetween } from "@/domain/time";
export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export async function loadArchive(directory: string): Promise<Archive> {
  try {
    const value = JSON.parse(await readFile(join(directory, "archive.json"), "utf8"));
    if (value.schemaVersion !== 1 || !Array.isArray(value.services) || !Array.isArray(value.runs)) throw new Error("INVALID_ARCHIVE");
    return value as Archive;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyArchive();
    throw new Error("ARCHIVE_READ_FAILED"); // Never silently replace damaged historical data.
  }
}
export async function saveArchive(directory: string, archive: Archive): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temp = join(directory, "archive.json.tmp");
  await writeFile(temp, JSON.stringify(archive), "utf8");
  await rename(temp, join(directory, "archive.json"));
}
export function mergeService(previous: RailService | undefined, next: RailService): RailService {
  if (!previous) return next;
  if (Date.parse(next.lastCollectedAt) < Date.parse(previous.lastCollectedAt)) return previous;
  const merged = { ...next,
    id: previous.id,
    monitored: previous.monitored || next.monitored,
    scheduledDeparture: next.scheduledDeparture ?? previous.scheduledDeparture,
    scheduledArrival: next.scheduledArrival ?? previous.scheduledArrival,
    // Preserve final observations when a later API response omits them; retain original snapshots too.
    actualDeparture: next.actualDeparture ?? previous.actualDeparture,
    actualArrival: next.actualArrival ?? previous.actualArrival,
  };
  if (merged.cancelled && merged.actualArrival && !merged.dataIssues.includes("Cancellation conflicts with a recorded arrival."))
    merged.dataIssues = [...merged.dataIssues, "Cancellation conflicts with a recorded arrival."];
  merged.rawDelayMinutes = merged.cancelled ? null : minutesBetween(merged.actualArrival, merged.scheduledArrival);
  return merged;
}
export function upsert(archive: Archive, service: RailService, assessment: Assessment): StoredService {
  const index = archive.services.findIndex(r => r.service.id === service.id);
  const previous = index >= 0 ? archive.services[index] : undefined;
  const changed = !previous || hash(previous.assessment) !== hash(assessment);
  const value: StoredService = {
    service, assessment, firstCollectedAt: previous?.firstCollectedAt ?? service.lastCollectedAt,
    assessedAt: changed ? service.lastCollectedAt : previous.assessedAt,
    revisions: previous ? [...previous.revisions] : [],
  };
  if (previous && changed) value.revisions.push({ assessedAt: previous.assessedAt, assessment: previous.assessment });
  if (index < 0) archive.services.push(value); else archive.services[index] = value;
  return value;
}
export async function retainObservation(directory: string, service: RailService, payload: unknown): Promise<void> {
  // Content addressed, so duplicate ingestion creates no duplicate evidence.
  const path = join(directory, "observations", service.serviceDate, hash(payload) + ".json");
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, JSON.stringify({ collectedAt: service.lastCollectedAt, rttServiceId: service.rttServiceId, payload }), { flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
}
export async function retainRun(directory: string, record: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, "runs.jsonl"), JSON.stringify(record) + "\n", "utf8");
}
