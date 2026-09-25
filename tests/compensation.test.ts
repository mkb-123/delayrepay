import { describe, expect, it } from "vitest";
import { assess } from "../src/domain/assess";
import { defaultEvidence } from "../src/domain/types";
import { train, original, at } from "./fixtures";
describe.each(["LM", "VT"])("%s destination-delay policy", code => {
  it.each([[0,"NO_CLAIM"],[5,"NO_CLAIM"],[14,"NO_CLAIM"],[15,"POTENTIAL"],[18,"POTENTIAL"],[30,"POTENTIAL"],[65,"POTENTIAL"]])("classifies a confirmed journey delayed %s minutes", (delay, status) => {
    const service = train({ operatorCode: code, actualArrival: new Date(Date.parse(at("07:40")) + Number(delay)*60000).toISOString() });
    const result = assess(service, [], original);
    expect(result.status).toBe(status);
    expect(result.effectiveDelayMinutes).toBe(delay);
    expect(result.ruleSource).toMatch(/^https:/);
  });
  it("does not round 14m59s up to fifteen", () => {
    expect(assess(train({ operatorCode: code, actualArrival: "2026-09-25T07:54:59+01:00" }), [], original).status).toBe("NO_CLAIM");
  });
});
describe("journey uncertainty and alternatives", () => {
  const disrupted = train({ actualArrival: at("08:00"), rawDelayMinutes: 20 });
  const faster = train({ id: "alternative", rttServiceId: "gb-nr:X00002:2026-09-25", scheduledDeparture: at("07:10"), actualDeparture: at("07:10"), actualArrival: at("07:50") });
  it("does not equate a 20-minute late train with a 20-minute passenger delay", () => {
    const r = assess(disrupted, [disrupted, faster]);
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.effectiveDelayMinutes).toBeNull();
    expect(r.alternatives[0].estimatedJourneyDelay).toBe(10);
  });
  it("uses the confirmed alternative arrival against the intended arrival", () => {
    const r = assess(disrupted, [faster], { ...original, travelled: "ALTERNATIVE", alternativeId: faster.id });
    expect(r.status).toBe("NO_CLAIM"); expect(r.effectiveDelayMinutes).toBe(10);
  });
  it("does not invent a fastest-service obligation for somebody who actually took the original", () => {
    expect(assess(disrupted, [faster], original).effectiveDelayMinutes).toBe(20);
  });
  it("requires confirmation for a different operator with restricted tickets", () => {
    const r = assess(disrupted, [train({ ...faster, operatorCode: "VT" })], { ...defaultEvidence, ticketScope: "SAME_OPERATOR" });
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.alternatives[0].applicability).toBe("REQUIRES_CONFIRMATION");
  });
  it("considers both operators for the user's any-permitted profile", () => {
    expect(assess(disrupted, [train({ ...faster, operatorCode: "VT" })]).alternatives[0].applicability).toBe("CANDIDATE");
  });
  it("does not count an alternative that already departed before the intended departure", () => {
    expect(assess(disrupted, [train({ ...faster, actualDeparture: at("06:59") })]).alternatives).toHaveLength(0);
  });
  it("does consider an earlier scheduled train that departed late", () => {
    expect(assess(disrupted, [train({ ...faster, scheduledDeparture: at("06:50"), actualDeparture: at("07:05") })]).alternatives).toHaveLength(1);
  });
  it("never automatically makes a cancellation claimable", () => {
    expect(assess(train({ cancelled: true, actualArrival: null }), [faster]).status).toBe("NEEDS_REVIEW");
  });
  it("calculates cancellation impact after passenger confirmation", () => {
    const alternative = train({ ...faster, actualArrival: at("08:03") });
    const r = assess(train({ cancelled: true, actualArrival: null }), [alternative], { ...original, travelled: "ALTERNATIVE", alternativeId: faster.id });
    expect(r.status).toBe("POTENTIAL"); expect(r.effectiveDelayMinutes).toBe(23);
  });
  it("requires ticket validity even for a confirmed alternative", () => {
    expect(assess(disrupted, [faster], { ...original, travelled: "ALTERNATIVE", alternativeId: faster.id, ticketValid: false }).status).toBe("NEEDS_REVIEW");
  });
  it("keeps missing actual arrival for review", () => expect(assess(train({ actualArrival: null }), [], original).status).toBe("NEEDS_REVIEW"));
  it("keeps incomplete RTT data for review", () => expect(assess(train({ dataIssues: ["Missing call"] }), [], original).status).toBe("NEEDS_REVIEW"));
  it("keeps failed alternative collection for review", () => expect(assess(disrupted, [], original, false).status).toBe("NEEDS_REVIEW"));
  it("keeps unknown operators for review", () => expect(assess(train({ operatorCode: "XX" }), [], original).status).toBe("NEEDS_REVIEW"));
  it("does not backdate researched terms", () => expect(assess(train({ serviceDate: "2026-09-24" }), [], original).status).toBe("NEEDS_REVIEW"));
  it("treats unused journeys as refund cases", () => expect(assess(disrupted, [], { ...original, travelled: "NOT_TRAVELLED" }).status).toBe("NO_CLAIM"));
  it("qualifies a conditional flag with explicit assumptions", () => {
    const r = assess(disrupted, []);
    expect(r.status).toBe("POTENTIAL"); expect(r.assumptions.length).toBeGreaterThan(0);
  });
  it("does not turn an unrelated delayed alternative into the original operator's claim", () => {
    expect(assess(train(), [faster], { ...original, travelled: "ALTERNATIVE", alternativeId: faster.id }).status).toBe("NEEDS_REVIEW");
  });
});
