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
  constructor(private readonly env: { RTT_ACCESS_TOKEN?: string; RTT_REFRESH_TOKEN?: string; RTT_API_VERSION?: string } = process.env,
    private readonly request: typeof fetch = fetch) {}
  private async call(path: string, token: string): Promise<Response> {
    try {
      return await this.request(BASE + path, {
        headers: { Authorization: "Bearer " + token, Version: this.env.RTT_API_VERSION || "2026-07-25", Accept: "application/json" },
        signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error",
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
  private async get(path: string, retry = true): Promise<unknown> {
    const res = await this.call(path, await this.access());
    if (res.status === 401 && retry && this.env.RTT_REFRESH_TOKEN && !this.env.RTT_ACCESS_TOKEN) {
      this.token = null; this.expires = 0; return this.get(path, false);
    }
    if (res.status === 429) throw new RttError("RTT_RATE_LIMITED"); // Next scheduled run retries; do not hammer the API.
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
