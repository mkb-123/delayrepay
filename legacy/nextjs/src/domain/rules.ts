export interface OperatorPolicy {
  operatorCode: string; operatorName: string; minimumDelay: number;
  ruleVersion: string; sourceUrl: string; verifiedAt: string; applicableFrom: string;
  claimUrl: string; claimWithinDays: number;
  alternativePolicy: "ACTUAL_JOURNEY"; cancellationAcceptanceSource: string;
  summary: string;
}
// Immutable versions: add a new version when official terms change.
// These are policy facts; operational uncertainty handling lives in assess.ts.
export const rules: Record<string, OperatorPolicy> = {
  VT: {
    operatorCode: "VT", operatorName: "Avanti West Coast", minimumDelay: 15,
    ruleVersion: "VT-2026-09-25-v1", verifiedAt: "2026-09-25", applicableFrom: "2026-09-25",
    sourceUrl: "https://www.avantiwestcoast.co.uk/help-and-support/delay-repay",
    claimUrl: "https://delayrepay.avantiwestcoast.co.uk/",
    claimWithinDays: 28, alternativePolicy: "ACTUAL_JOURNEY",
    cancellationAcceptanceSource: "https://www.avantiwestcoast.co.uk/travel%20information/disruptions/cancelled-train",
    summary: "Destination delay against the advertised arrival of the intended journey; valid ticket and completed journey required. Claim from the operator causing the first disruption.",
  },
  LM: {
    operatorCode: "LM", operatorName: "London Northwestern Railway", minimumDelay: 15,
    ruleVersion: "LM-2026-09-25-v1", verifiedAt: "2026-09-25", applicableFrom: "2026-09-25",
    sourceUrl: "https://www.londonnorthwesternrailway.co.uk/about-us/delay-repay",
    claimUrl: "https://londonnorthwesternrailway.delayrepaycompensation.com/",
    claimWithinDays: 28, alternativePolicy: "ACTUAL_JOURNEY",
    cancellationAcceptanceSource: "https://www.londonnorthwesternrailway.co.uk/about-us/delay-repay",
    summary: "Compare actual destination arrival with the intended advertised arrival. Use the journey actually made; no universal fastest-train substitution rule is established by the reviewed terms.",
  },
};
