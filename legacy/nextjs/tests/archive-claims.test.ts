import { describe, expect, it } from "vitest";
import { emptyArchive } from "../src/domain/archive";
import { acknowledge, undo } from "../src/domain/claims";
import { assess } from "../src/domain/assess";
import { mergeService, upsert } from "../src/server/store";
import { at, original, train } from "./fixtures";

describe("archive and local claim persistence", () => {
  it("upserts the same RTT service without duplicating journeys", () => {
    const archive = emptyArchive();
    const delayed = train({ actualArrival: at("08:00"), rawDelayMinutes: 20 });
    const assessment = assess(delayed, [], original);

    upsert(archive, delayed, assessment);
    upsert(archive, delayed, assessment);

    expect(archive.services).toHaveLength(1);
    expect(archive.services[0].revisions).toHaveLength(0);
  });

  it("keeps a revision when a later assessment changes", () => {
    const archive = emptyArchive();
    const first = train({ actualArrival: at("08:00"), rawDelayMinutes: 20 });
    const later = train({ actualArrival: at("07:50"), rawDelayMinutes: 10, lastCollectedAt: at("09:30") });

    upsert(archive, first, assess(first, [], original));
    upsert(archive, later, assess(later, [], original));

    expect(archive.services).toHaveLength(1);
    expect(archive.services[0].assessment.status).toBe("NO_CLAIM");
    expect(archive.services[0].revisions).toHaveLength(1);
  });

  it("preserves final arrivals when a later RTT response omits them", () => {
    const first = train({ actualArrival: at("08:00"), rawDelayMinutes: 20 });
    const later = train({ actualArrival: null, rawDelayMinutes: null, lastCollectedAt: at("09:30") });

    expect(mergeService(first, later).actualArrival).toBe(first.actualArrival);
  });

  it("does not duplicate already-claimed acknowledgements", () => {
    const service = train({ actualArrival: at("08:00"), rawDelayMinutes: 20 });
    const record = {
      service,
      assessment: assess(service, [], original),
      firstCollectedAt: service.lastCollectedAt,
      assessedAt: service.lastCollectedAt,
      revisions: [],
    };
    const claimed = acknowledge(record, undefined, "2026-09-25T10:00:00+01:00");
    const repeated = acknowledge(record, claimed, "2026-09-25T10:05:00+01:00");

    expect(repeated.claimedAt).toBe(claimed.claimedAt);
    expect(undo(repeated, "2026-09-25T10:06:00+01:00").claimedAt).toBeNull();
  });
});
