import type { RailService, JourneyEvidence } from "../src/domain/types";
import type { ServiceResponse } from "../src/server/rtt/schema";
export const at = (hhmm: string) => "2026-09-25T" + hhmm + ":00+01:00";
export function train(patch: Partial<RailService> = {}): RailService {
  return {
    id: "original", rttServiceId: "gb-nr:X00001:2026-09-25", rttIdentity: "X00001", rttDepartureDate: "2026-09-25",
    serviceDate: "2026-09-25", operatorCode: "LM", operatorName: "London Northwestern Railway",
    direction: "MORNING", origin: "MKC", destination: "EUS", monitored: true,
    scheduledDeparture: at("07:00"), actualDeparture: at("07:00"),
    scheduledArrival: at("07:40"), actualArrival: at("07:40"),
    cancelled: false, rawDelayMinutes: 0, alterations: [], dataIssues: [], lastCollectedAt: at("09:00"), ...patch,
  };
}
export const original: JourneyEvidence = { travelled: "ORIGINAL", ticketValid: true, ticketScope: "ANY_PERMITTED" };
export function response(): ServiceResponse {
  return {
    systemStatus: { realtimeNetworkRail: "OK", rttCore: "OK" },
    service: {
      scheduleMetadata: { uniqueIdentity: "gb-nr:X00001:2026-09-25", identity: "X00001", namespace: "gb-nr", departureDate: "2026-09-25",
        operator: { code: "LM", name: "London Northwestern Railway" }, modeType: "TRAIN", inPassengerService: true },
      locations: [
        { location: { shortCodes: ["MKC"] }, temporalData: { scheduledCallType: "ADVERTISED_OPEN", realtimeCallType: "ADVERTISED_OPEN", displayAs: "CALL", departure: { scheduleAdvertised: at("07:00"), realtimeActual: at("07:00") } } },
        { location: { shortCodes: ["EUS"] }, temporalData: { scheduledCallType: "ADVERTISED_OPEN", realtimeCallType: "ADVERTISED_OPEN", displayAs: "CALL", arrival: { scheduleAdvertised: at("07:40"), realtimeActual: at("07:58") } } },
      ],
    },
  };
}
