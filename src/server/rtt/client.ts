import "server-only";
import { z } from "zod";
import { lineSchema, serviceSchema } from "./schema";
const BASE = "https://data.rtt.io";
export class RttError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RttError"; }
}
export class RttClient {
  private token: string | null = null;
  private expires = 0;
  private nextRequestAt = 0;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly request: typeof fetch = fetch) {}
  private async throttle(): Promise<void> {
    const interval = Number(this.env.RTT_MIN_INTERVAL_MS || 1500);
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + interval;
  }
  private async call(path: string, token: string): Promise<Response> {
    try {
      await this.throttle();
      return await this.request(BASE + path, {
        headers: { Authorization: "Bearer " + token, Version: this.env.RTT_API_VERSION || "2026-07-25", Accept: "application/json" },
        signal: AbortSignal.timeout(Number(this.env.RTT_REQUEST_TIMEOUT_MS || 15000)), cache: "no-store", redirect: "error",
      });
    } catch { throw new RttError("RTT_NETWORK_ERROR"); }
  }
  private async access(): Promise<string> {
    if (this.env.RTT_ACCESS_TOKEN) return this.env.RTT_ACCESS_TOKEN;
    if (!this.env.RTT_REFRESH_TOKEN) throw new RttError("RTT_NOT_CONFIGURED");
    if (this.token && this.expires > Date.now() + 60000) return this.token;
    const res = await this.call("/api/get_access_token", this.env.RTT_REFRESH_TOKEN);
    if (!res.ok) throw new RttError("RTT_AUTH_ERROR");
    let value;
    try { value = z.object({ token: z.string().min(1), validUntil: z.iso.datetime({ offset: true }) }).parse(await res.json()); }
    catch { throw new RttError("RTT_AUTH_RESPONSE_INVALID"); }
    this.token = value.token; this.expires = Date.parse(value.validUntil);
    return this.token;
  }
  private async get(path: string, retry = true, rateRetry = 2): Promise<unknown> {
    const res = await this.call(path, await this.access());
    if (res.status === 401 && retry && this.env.RTT_REFRESH_TOKEN && !this.env.RTT_ACCESS_TOKEN) {
      this.token = null; this.expires = 0; return this.get(path, false);
    }
    if (res.status === 429) {
      if (rateRetry > 0) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number(this.env.RTT_RATE_LIMIT_WAIT_MS || 10000);
        await new Promise(resolve => setTimeout(resolve, wait));
        return this.get(path, retry, rateRetry - 1);
      }
      throw new RttError("RTT_RATE_LIMITED");
    }
    if (!res.ok) throw new RttError(res.status === 404 ? "RTT_SERVICE_NOT_FOUND" : "RTT_REQUEST_FAILED");
    if (res.status === 204) return { services: [] };
    try { return await res.json(); } catch { throw new RttError("RTT_INVALID_JSON"); }
  }
  async lineup(origin: string, date: string, from: string, to: string) {
    const query = new URLSearchParams({ code: "gb-nr:" + origin, timeFrom: date + "T" + from + ":00", timeTo: date + "T" + to + ":00", timeTolerance: "false" });
    const value = lineSchema.safeParse(await this.get("/rtt/location?" + query));
    if (!value.success) throw new RttError("RTT_SCHEMA_CHANGED");
    return value.data;
  }
  async service(uniqueIdentity: string) {
    const value = serviceSchema.safeParse(await this.get("/rtt/service?" + new URLSearchParams({ uniqueIdentity })));
    if (!value.success) throw new RttError("RTT_SCHEMA_CHANGED");
    return value.data;
  }
}
