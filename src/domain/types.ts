export type Direction = "MORNING" | "EVENING";
export type BaseStatus = "NO_CLAIM" | "POTENTIAL" | "NEEDS_REVIEW";
export type TicketScope = "ANY_PERMITTED" | "SAME_OPERATOR" | "UNKNOWN";
export interface JourneyEvidence {
  travelled: "UNKNOWN" | "ORIGINAL" | "ALTERNATIVE" | "NOT_TRAVELLED";
  alternativeId?: string;
  ticketValid: boolean;
  ticketScope: TicketScope;
}
export const defaultEvidence: JourneyEvidence = {
  travelled: "UNKNOWN", ticketValid: false, ticketScope: "ANY_PERMITTED",
};
export interface RailService {
  id: string;
  serviceDate: string;
  rttServiceId: string;
  rttIdentity: string;
  rttDepartureDate: string;
  operatorCode: string;
  operatorName: string;
  direction: Direction;
  origin: string;
  destination: string;
  monitored: boolean;
  scheduledDeparture: string | null;
  actualDeparture: string | null;
  scheduledArrival: string | null;
  actualArrival: string | null;
  cancelled: boolean;
  rawDelayMinutes: number | null;
  alterations: string[];
  dataIssues: string[];
  lastCollectedAt: string;
}
export interface Alternative {
  serviceId: string;
  rttServiceId: string;
  operatorName: string;
  operatorCode: string;
  scheduledDeparture: string | null;
  actualDeparture: string | null;
  actualArrival: string | null;
  estimatedJourneyDelay: number | null;
  applicability: "CANDIDATE" | "REQUIRES_CONFIRMATION" | "EXCLUDED";
  reason: string;
}
export interface Assessment {
  status: BaseStatus;
  effectiveDelayMinutes: number | null;
  rawDelayMinutes: number | null;
  explanation: string;
  ruleVersion: string;
  ruleSource: string | null;
  ruleVerifiedAt: string | null;
  minimumDelay: number | null;
  alternatives: Alternative[];
  evidence: JourneyEvidence;
  steps: string[];
  assumptions: string[];
  collectionComplete: boolean;
}
