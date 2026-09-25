import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assess } from "@/domain/assess";
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
export async function ingestDate(archive: Archive, date: string, source: RailSource, directory?: string): Promise<RunRecord> {
  if (!isDate(date) || !weekday(date)) throw new Error("Weekday service date required.");
  const start = new Date().toISOString();
  const run: RunRecord = { id: randomUUID(), serviceDate: date, startedAt: start, finishedAt: start, status: "SUCCESS", servicesUpdated: 0, message: "" };
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
    // Hour-sized requests work with narrow-window entitlements and overlap safely.
    const minutes = (t: string) => Number(t.slice(0,2))*60 + Number(t.slice(3));
    const clock = (m: number) => String(Math.floor(m/60)).padStart(2,"0") + ":" + String(m%60).padStart(2,"0");
    for (let m = minutes(w.collectFrom); m < minutes(w.collectTo); m += 60) {
      try {
        const lineup = await source.lineup(w.origin, date, clock(m), clock(Math.min(m+60,minutes(w.collectTo))));
        successfulResponses++;
        if (degraded(lineup.systemStatus)) failed(new RttError("RTT_DEGRADED"));
        for (const item of lineup.services) if (item.scheduleMetadata.inPassengerService && item.scheduleMetadata.modeType === "TRAIN")
          identifiers.add(item.scheduleMetadata.uniqueIdentity);
      } catch(e) { failed(e); }
    }
    // Sequential requests avoid flooding RTT; the workflow has a bounded timeout.
    for (const id of identifiers) {
      try {
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
export async function ingest(directory: string, dates: string[], source: RailSource = new RttClient()): Promise<RunRecord[]> {
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, ".ingest.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); } catch { throw new Error("INGESTION_LOCKED"); }
  try {
    const archive = await loadArchive(directory);
    const runs: RunRecord[] = [];
    for (const date of dates) {
      runs.push(await ingestDate(archive, date, source, directory));
      await saveArchive(directory, archive); // checkpoint each day
    }
    return runs;
  } finally { await lock.close(); await unlink(lockPath); }
}
