import { z } from "zod";
// Strip unknown fields at the boundary: only rail evidence is persisted, never headers or credentials.
const timestamp = z.string().min(1).nullish();
const time = z.object({
  scheduleAdvertised: timestamp, scheduleInternal: timestamp,
  realtimeActual: timestamp, realtimeForecast: timestamp, realtimeEstimate: timestamp,
  realtimeNoReport: z.boolean().nullish(), isCancelled: z.boolean().nullish(),
  cancellationReasonCode: z.string().nullish(),
});
const temporal = z.object({
  arrival: time.nullish(), departure: time.nullish(),
  scheduledCallType: z.string().nullish(), realtimeCallType: z.string().nullish(),
  displayAs: z.string().nullish(), isInterpolated: z.boolean().nullish(),
});
const metadata = z.object({
  uniqueIdentity: z.string().min(1), identity: z.string().min(1),
  namespace: z.string(), departureDate: z.iso.date(),
  operator: z.object({ code: z.string(), name: z.string() }).nullish(),
  modeType: z.string().nullish(), inPassengerService: z.boolean().nullish(),
  trainReportingIdentity: z.string().nullish(), stpIndicator: z.string().nullish(),
});
const location = z.object({
  namespace: z.string().nullish(), description: z.string().nullish(),
  shortCodes: z.array(z.string()).nullish(), longCodes: z.array(z.string()).nullish(),
});
const reason = z.object({ type: z.string().nullish(), code: z.string().nullish(), shortText: z.string().nullish(), longText: z.string().nullish() });
export const systemStatus = z.object({ realtimeNetworkRail: z.string().nullish(), rttCore: z.string().nullish() }).nullish();
export const lineSchema = z.object({
  systemStatus,
  services: z.array(z.object({ scheduleMetadata: metadata, temporalData: temporal.nullish() })),
});
export const serviceSchema = z.object({
  systemStatus,
  service: z.object({
    scheduleMetadata: metadata,
    locations: z.array(z.object({ location, temporalData: temporal.nullish() })),
    reasons: z.array(reason).nullish(),
  }),
});
export type ServiceResponse = z.infer<typeof serviceSchema>;
export function degraded(status: z.infer<typeof systemStatus>): boolean {
  return !!status && Object.values(status).some(v => v != null && v !== "OK");
}
