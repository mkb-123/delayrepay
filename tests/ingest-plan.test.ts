import { describe, expect, it } from "vitest";
import { emptyArchive } from "../src/domain/archive";
import { ingestDate, planDiscoveryWindows, planLineupWindows, type RailSource } from "../src/server/ingest";

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
      { direction: "MORNING", location: "MKC", role: "origin", from: "06:00", to: "07:00" },
      { direction: "MORNING", location: "MKC", role: "origin", from: "07:00", to: "08:00" },
      { direction: "MORNING", location: "MKC", role: "origin", from: "08:00", to: "08:30" },
    ]);
    expect(planLineupWindows("EVENING")).toEqual([
      { direction: "EVENING", location: "EUS", role: "origin", from: "16:30", to: "17:30" },
      { direction: "EVENING", location: "EUS", role: "origin", from: "17:30", to: "18:30" },
    ]);
    expect(planDiscoveryWindows("MORNING").filter(item => item.role === "destination")).toEqual([
      { direction: "MORNING", location: "EUS", role: "destination", from: "06:15", to: "07:15" },
      { direction: "MORNING", location: "EUS", role: "destination", from: "07:15", to: "08:15" },
      { direction: "MORNING", location: "EUS", role: "destination", from: "08:15", to: "09:15" },
      { direction: "MORNING", location: "EUS", role: "destination", from: "09:15", to: "10:15" },
      { direction: "MORNING", location: "EUS", role: "destination", from: "10:15", to: "10:30" },
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
    expect(run.lineupRequests).toBe(14);
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
      "EUS 06:15-07:15",
      "EUS 07:15-08:15",
      "EUS 08:15-09:15",
      "EUS 09:15-10:15",
      "EUS 10:15-10:30",
      "EUS 16:30-17:30",
      "EUS 17:30-18:30",
      "MKC 16:45-17:45",
      "MKC 17:45-18:45",
      "MKC 18:45-19:45",
      "MKC 19:45-20:30",
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

  it("fetches details only for services seen at both monitored endpoints", async () => {
    const fetched: string[] = [];
    const source: RailSource = {
      lineup: async location => ({
        systemStatus: { realtimeNetworkRail: "OK", rttCore: "OK" },
        services: location === "MKC"
          ? [service("through"), service("mkc-only")]
          : [service("through"), service("eus-only")],
      }),
      service: async uniqueIdentity => {
        fetched.push(uniqueIdentity);
        throw new Error("detail response intentionally omitted");
      },
    };

    await ingestDate(emptyArchive(), "2026-09-25", source);

    expect(fetched).toContain("through");
    expect(fetched).not.toContain("mkc-only");
    expect(fetched).not.toContain("eus-only");
  });
});
