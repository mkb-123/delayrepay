import { describe, expect, it } from "vitest";
import { emptyArchive } from "../src/domain/archive";
import { ingestDate, planLineupWindows, type RailSource } from "../src/server/ingest";

const service = (id: string, code = "LM") => ({
  scheduleMetadata: {
    uniqueIdentity: id,
    identity: id,
    namespace: "gb-nr",
    departureDate: "2026-09-25",
    operator: { code, name: code },
    modeType: "TRAIN",
    inPassengerService: true,
  },
});

describe("bounded RTT collection plan", () => {
  it("plans only monitored windows plus the default alternative buffer", () => {
    expect(planLineupWindows("MORNING")).toEqual([
      { direction: "MORNING", origin: "MKC", from: "06:00", to: "07:00" },
      { direction: "MORNING", origin: "MKC", from: "07:00", to: "08:00" },
      { direction: "MORNING", origin: "MKC", from: "08:00", to: "08:30" },
    ]);
    expect(planLineupWindows("EVENING")).toEqual([
      { direction: "EVENING", origin: "EUS", from: "16:30", to: "17:30" },
      { direction: "EVENING", origin: "EUS", from: "17:30", to: "18:30" },
    ]);
  });

  it("dry-runs without calling RTT or mutating the archive", async () => {
    const archive = emptyArchive();
    const source: RailSource = {
      lineup: async () => { throw new Error("lineup should not be called"); },
      service: async () => { throw new Error("service should not be called"); },
    };

    const run = await ingestDate(archive, "2026-09-25", source, undefined, { dryRun: true });

    expect(run.plannedOnly).toBe(true);
    expect(run.lineupRequests).toBe(5);
    expect(run.detailRequests).toBe(0);
    expect(archive.services).toHaveLength(0);
    expect(archive.runs).toHaveLength(0);
  });

  it("uses the bounded windows for live lineup calls", async () => {
    const calls: string[] = [];
    const source: RailSource = {
      lineup: async (origin, _date, from, to) => {
        calls.push(`${origin} ${from}-${to}`);
        return { systemStatus: { realtimeNetworkRail: "OK", rttCore: "OK" }, services: [] };
      },
      service: async () => { throw new Error("service should not be called for empty lineups"); },
    };

    const run = await ingestDate(emptyArchive(), "2026-09-25", source);

    expect(calls).toEqual([
      "MKC 06:00-07:00",
      "MKC 07:00-08:00",
      "MKC 08:00-08:30",
      "EUS 16:30-17:30",
      "EUS 17:30-18:30",
    ]);
    expect(run.detailRequests).toBe(0);
  });

  it("does not fetch service details for unsupported operators", async () => {
    const fetched: string[] = [];
    const source: RailSource = {
      lineup: async () => ({
        systemStatus: { realtimeNetworkRail: "OK", rttCore: "OK" },
        services: [service("known", "LM"), service("unknown", "ZZ")],
      }),
      service: async uniqueIdentity => {
        fetched.push(uniqueIdentity);
        throw new Error("detail response intentionally omitted");
      },
    };

    const run = await ingestDate(emptyArchive(), "2026-09-25", source);

    expect(fetched).toEqual(["known", "known"]);
    expect(fetched).not.toContain("unknown");
    expect(run.detailRequests).toBe(2);
  });
});
