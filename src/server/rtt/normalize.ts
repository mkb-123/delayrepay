import { minutesBetween, monitoredDeparture, londonDate, windows } from "@/domain/time";
import type { Direction, RailService } from "@/domain/types";
import { degraded, type ServiceResponse } from "./schema";
export function normalize(response: ServiceResponse, direction: Direction, collectedAt: string, fallback?: RailService): RailService | null {
  const { scheduleMetadata: m, locations } = response.service;
  if (m.namespace !== "gb-nr" || m.modeType !== "TRAIN" || m.inPassengerService !== true) return null;
  const w = windows[direction];
  const fromIndex = locations.findIndex(l => l.location.shortCodes?.includes(w.origin));
  const toIndex = locations.findIndex((l, i) => i > fromIndex && l.location.shortCodes?.includes(w.destination));
  const from = locations[fromIndex]?.temporalData, to = locations[toIndex]?.temporalData;
  if ((!from || !to) && !fallback) return null;
  // A passing/set-down-only origin or pick-up-only destination is not a passenger journey.
  const board = from?.scheduledCallType;
  const alight = to?.scheduledCallType;
  if (from && board && !["ADVERTISED_OPEN", "ADVERTISED_PICK_UP"].includes(board)) return null;
  if (to && alight && !["ADVERTISED_OPEN", "ADVERTISED_SET_DOWN"].includes(alight)) return null;
  const scheduledDeparture = from?.departure?.scheduleAdvertised ?? fallback?.scheduledDeparture ?? null;
  const scheduledArrival = to?.arrival?.scheduleAdvertised ?? fallback?.scheduledArrival ?? null;
  const actualDeparture = from?.departure?.realtimeNoReport ? null : from?.departure?.realtimeActual ?? null;
  const actualArrival = to?.arrival?.realtimeNoReport ? null : to?.arrival?.realtimeActual ?? null;
  const cancelled = !!(from?.departure?.isCancelled || to?.arrival?.isCancelled ||
    from?.displayAs === "CANCELLED" || to?.displayAs === "CANCELLED" ||
    from?.displayAs === "DIVERTED" || to?.displayAs === "DIVERTED");
  const issues: string[] = [];
  if (!from || !to) issues.push("Previously monitored calling point missing from latest response.");
  if (!board || !alight) issues.push("Passenger boarding/alighting permission missing.");
  if (!scheduledDeparture || !scheduledArrival) issues.push("Advertised timetable incomplete; working times are not substituted.");
  if (degraded(response.systemStatus)) issues.push("RTT reports degraded real-time data.");
  if (!m.operator?.code) issues.push("Operator code missing.");
  if (from?.isInterpolated || to?.isInterpolated) issues.push("RTT interpolated a monitored calling point.");
  if (actualDeparture && actualArrival && Date.parse(actualArrival) < Date.parse(actualDeparture)) issues.push("Actual arrival precedes departure.");
  if (scheduledDeparture && scheduledArrival && Date.parse(scheduledArrival) < Date.parse(scheduledDeparture)) issues.push("Scheduled arrival precedes departure.");
  if (cancelled && actualArrival) issues.push("Cancellation conflicts with a recorded arrival.");
  const alterations: string[] = [];
  for (const [name, point] of [[w.origin, from], [w.destination, to]] as const) {
    if (point?.displayAs && ["DIVERTED", "STARTS", "TERMINATES"].includes(point.displayAs)) alterations.push(name + ": " + point.displayAs);
    if (point?.realtimeCallType && point.scheduledCallType && point.realtimeCallType !== point.scheduledCallType && !cancelled)
      alterations.push(name + ": calling permission changed");
  }
  return {
    id: fallback?.id ?? m.uniqueIdentity + ":" + direction,
    serviceDate: scheduledDeparture ? londonDate(new Date(scheduledDeparture)) : fallback?.serviceDate ?? m.departureDate,
    rttServiceId: m.uniqueIdentity, rttIdentity: m.identity, rttDepartureDate: m.departureDate,
    operatorCode: m.operator?.code ?? "UNKNOWN", operatorName: m.operator?.name ?? "Unknown operator",
    direction, origin: w.origin, destination: w.destination,
    monitored: fallback?.monitored || monitoredDeparture(scheduledDeparture, direction),
    scheduledDeparture, scheduledArrival, actualDeparture, actualArrival, cancelled,
    rawDelayMinutes: cancelled ? null : minutesBetween(actualArrival, scheduledArrival),
    alterations, dataIssues: issues, lastCollectedAt: collectedAt,
  };
}
