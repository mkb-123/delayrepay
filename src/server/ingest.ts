import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assess } from "@/domain/assess";
import { rules } from "@/domain/rules";
import { type Direction, type RailService } from "@/domain/types";
import { isDate, weekday, windows } from "@/domain/time";
import { type Archive, type RunRecord } from "@/domain/archive";
import { RttClient, RttError } from "./rtt/client";
import { degraded } from "./rtt/schema";
import { normalize } from "./rtt/normalize";
import { loadArchive, saveArchive, retainObservation, retainRun, mergeService, upsert } from "./store";

export interface RailSource {
  lineup: RttClient["lineup"];
  service: RttClient["service"];
}
export interface IngestOptions {
  dryRun?: boolean;
  alternativeBufferMinutes?: number;
}
export interface LineupWindow {
  direction: Direction;
  origin: string;
  from: string;
  to: string;
}
const minutes = (t: string) => Number(t.slice(0,2))*60 + Number(t.slice(3));
const clock = (m: number) => String(Math.floor(m/60)).padStart(2,"0") + ":" + String(m%60).padStart(2,"0");
export function planLineupWindows(direction: Direction, bufferMinutes = 30): LineupWindow[] {
  const w = windows[direction];
  const result: LineupWindow[] = [];
  const end = minutes(w.to) + bufferMinutes;
  for (let m = minutes(w.from); m < end; m += 60) {
    result.push({ direction, origin: w.origin, from: clock(m), to: clock(Math.min(m + 60, end)) });
  }
  return result;
}
export async function ingestDate(archive: Archive, date: string, source: RailSource, directory?: string, options: IngestOptions = {}): Promise<RunRecord> {
  if (!isDate(date) || !weekday(date)) throw new Error("Weekday service date required.");
  const start = new Date().toISOString();
  const planned = (["MORNING", "EVENING"] as Direction[]).flatMap(direction => planLineupWindows(direction, options.alternativeBufferMinutes));
  const run: RunRecord = { id: randomUUID(), serviceDate: date, startedAt: start, finishedAt: start, status: "SUCCESS", servicesUpdated: 0, message: "", lineupRequests: planned.length, detailRequests: 0 };
  if (options.dryRun) {
    run.finishedAt = new Date().toISOString();
    run.plannedOnly = true;
    run.message = `Planned ${planned.length} lineup requests across monitored windows; no RTT requests were made. Detail requests depend on matching services returned by live lineups.`;
    return run;
  }
  let failures = 0, successfulResponses = 0;
  const failureCodes = new Set<string>();
  const failed = (e: unknown) => {
    failures++;
    failureCodes.add(e instanceof RttError ? e.code : "COLLECTION_ERROR");
  };
  for (const direction of ["MORNING", "EVENING"] as Direction[]) {
    const w = windows[direction];
    const known = archive.services.filter(r => r.service.serviceDate === date && r.service.direction === direction);
    const services = new Map<string, RailService>(known.map(r => [r.service.rttServiceId, r.service]));
    const identifiers = new Set(services.keys());
    const errorsBefore = failures;
    for (const plannedWindow of planned.filter(item => item.direction === direction)) {
      try {
        const lineup = await source.lineup(w.origin, date, plannedWindow.from, plannedWindow.to);
        successfulResponses++;
        if (degraded(lineup.systemStatus)) failed(new RttError("RTT_DEGRADED"));
        for (const item of lineup.services) if (item.scheduleMetadata.inPassengerService && item.scheduleMetadata.modeType === "TRAIN" && rules[item.scheduleMetadata.operator?.code ?? ""])
          identifiers.add(item.scheduleMetadata.uniqueIdentity);
      } catch(e) { failed(e); }
    }
    // Sequential requests avoid flooding RTT; the workflow has a bounded timeout.
    for (const id of identifiers) {
      try {
        run.detailRequests = (run.detailRequests ?? 0) + 1;
        const payload = await source.service(id);
        if (payload.service.scheduleMetadata.uniqueIdentity !== id) throw new RttError("RTT_IDENTITY_MISMATCH");
        successfulResponses++;
        const fresh = normalize(payload, direction, new Date().toISOString(), services.get(id));
        if (!fresh || fresh.serviceDate !== date) continue;
        const service = mergeService(services.get(id), fresh);
        services.set(id, service);
        if (directory) await retainObservation(directory, service, payload);
        run.servicesUpdated++;
      } catch(e) { failed(e); }
    }
    const complete = failures === errorsBefore;
    const all = [...services.values()];
    for (const service of all) upsert(archive, service, assess(service, all, undefined, complete));
  }
  run.finishedAt = new Date().toISOString();
  run.status = failures ? (successfulResponses ? "PARTIAL" : "FAILED") : "SUCCESS";
  run.message = failures ? [...failureCodes].join(", ") : "Rail evidence collected. Passenger travel is not inferred.";
  archive.lastAttemptAt = run.finishedAt;
  if (run.status === "SUCCESS") archive.lastSuccessfulAt = run.finishedAt;
  archive.runs = [...archive.runs, run].slice(-100);
  if (directory) await retainRun(directory, run);
  return run;
}
export async function ingest(directory: string, dates: string[], source: RailSource = new RttClient(), options: IngestOptions = {}): Promise<RunRecord[]> {
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, ".ingest.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); } catch { throw new Error("INGESTION_LOCKED"); }
  try {
    const archive = await loadArchive(directory);
    const runs: RunRecord[] = [];
    for (const date of dates) {
      const run = await ingestDate(archive, date, source, directory, options);
      runs.push(run);
      if (!options.dryRun) await saveArchive(directory, archive); // checkpoint each day
    }
    return runs;
  } finally { await lock.close(); await unlink(lockPath); }
}
