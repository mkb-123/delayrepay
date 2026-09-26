import { describe, expect, it } from "vitest";
import { emptyArchive } from "../src/domain/archive";
import { assess } from "../src/domain/assess";
import { renderBrief } from "../src/server/brief";
import { at, original, train } from "./fixtures";

describe("local brief renderer", () => {
  it("summarizes potential claims without needing RTT", () => {
    const archive = emptyArchive();
    const service = train({ actualArrival: at("08:00"), rawDelayMinutes: 20 });
    archive.services.push({
      service,
      assessment: assess(service, [], original),
      firstCollectedAt: service.lastCollectedAt,
      assessedAt: service.lastCollectedAt,
      revisions: [],
    });

    const text = renderBrief(archive, { date: "2026-09-25" });

    expect(text).toContain("Potential claims: 1");
    expect(text).toContain("London Northwestern Railway");
    expect(text).toContain("| Train | Delay | Can I claim? |");
    expect(text).toContain("| 07:00 London Northwestern Railway | +20 min | [Yes](");
    expect(text).not.toContain("Alternatives considered:");
  });

  it("excludes locally claimed items from the outstanding count", () => {
    const archive = emptyArchive();
    const service = train({ actualArrival: at("08:00"), rawDelayMinutes: 20 });
    archive.services.push({
      service,
      assessment: assess(service, [], original),
      firstCollectedAt: service.lastCollectedAt,
      assessedAt: service.lastCollectedAt,
      revisions: [],
    });

    const text = renderBrief(archive, {
      date: "2026-09-25",
      local: { [service.id]: { serviceId: service.id, claimedAt: "2026-09-25T10:00:00+01:00", updatedAt: "2026-09-25T10:00:00+01:00" } },
    });

    expect(text).toContain("Potential claims: 0");
    expect(text).toContain("Claimed locally: 1");
    expect(text).toContain("| 07:00 London Northwestern Railway | +20 min | Claimed |");
  });

  it("omits services scheduled to take over an hour", () => {
    const archive = emptyArchive();
    const normal = train({ id: "normal", scheduledArrival: at("07:55"), actualArrival: at("08:10"), rawDelayMinutes: 15 });
    const slow = train({ id: "slow", scheduledArrival: at("08:05"), actualArrival: at("08:25"), rawDelayMinutes: 20 });
    for (const service of [normal, slow]) archive.services.push({
      service,
      assessment: assess(service, [], original),
      firstCollectedAt: service.lastCollectedAt,
      assessedAt: service.lastCollectedAt,
      revisions: [],
    });

    const text = renderBrief(archive, { date: "2026-09-25" });

    expect(text).toContain("07:00 London Northwestern Railway");
    expect(text).toContain("Potential claims: 1");
    expect(text).not.toContain("+20 min");
  });
});
