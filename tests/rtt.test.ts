import { describe, expect, it } from "vitest";
import { normalize } from "../src/server/rtt/normalize";
import { serviceSchema } from "../src/server/rtt/schema";
import { monitoredDeparture, londonDate, weekday, recentWeekdays } from "../src/domain/time";
import { response, at } from "./fixtures";
describe("RTT normalization", () => {
  it("uses advertised destination arrival", () => {
    const r = normalize(response(), "MORNING", at("09:00"))!;
    expect(r.rawDelayMinutes).toBe(18); expect(r.monitored).toBe(true);
  });
  it("never promotes forecasts or estimates to actuals", () => {
    const data = response(), arrival = data.service.locations[1].temporalData!.arrival!;
    arrival.realtimeActual = undefined; arrival.realtimeForecast = at("07:58"); arrival.realtimeEstimate = at("07:57");
    expect(normalize(data, "MORNING", at("09:00"))!.actualArrival).toBeNull();
  });
  it("does not replace public times with working timetable times", () => {
    const data = response(), arrival = data.service.locations[1].temporalData!.arrival!;
    arrival.scheduleAdvertised = undefined; arrival.scheduleInternal = at("07:39");
    const normalized = normalize(data, "MORNING", at("09:00"))!;
    expect(normalized.scheduledArrival).toBeNull(); expect(normalized.dataIssues.length).toBeGreaterThan(0);
  });
  it("preserves station-specific cancellation", () => {
    const data = response(); data.service.locations[1].temporalData!.arrival = { scheduleAdvertised: at("07:40"), isCancelled: true };
    expect(normalize(data, "MORNING", at("09:00"))!.cancelled).toBe(true);
  });
  it("excludes non-passenger and passing services", () => {
    const data = response(); data.service.scheduleMetadata.inPassengerService = false;
    expect(normalize(data, "MORNING", at("09:00"))).toBeNull();
    data.service.scheduleMetadata.inPassengerService = true;
    data.service.locations[0].temporalData!.scheduledCallType = "OPERATIONAL_ONLY";
    expect(normalize(data, "MORNING", at("09:00"))).toBeNull();
  });
  it("strips unknown fields rather than persisting secrets or arbitrary payloads", () => {
    const r = serviceSchema.parse({ ...response(), authorization: "not-a-real-secret" });
    expect(r).not.toHaveProperty("authorization");
  });
});
describe("London service windows", () => {
  it.each(["06:00","07:13","08:00"])("includes morning %s", t => expect(monitoredDeparture(at(t), "MORNING")).toBe(true));
  it.each(["05:59","08:01"])("excludes morning %s", t => expect(monitoredDeparture(at(t), "MORNING")).toBe(false));
  it.each(["16:30","18:00"])("includes evening %s", t => expect(monitoredDeparture(at(t), "EVENING")).toBe(true));
  it("rejects weekends", () => expect(monitoredDeparture("2026-09-26T07:00:00+01:00", "MORNING")).toBe(false));
  it("uses London time across DST", () => {
    expect(londonDate(new Date("2026-06-01T23:30:00Z"))).toBe("2026-06-02");
    expect(monitoredDeparture("2026-10-26T06:00:00Z","MORNING")).toBe(true);
  });
  it("backfills weekdays across weekends", () => expect(recentWeekdays("2026-09-28",3)).toEqual(["2026-09-28","2026-09-25","2026-09-24"]));
  it("rejects invalid dates", () => expect(weekday("2026-02-30")).toBe(false));
});
