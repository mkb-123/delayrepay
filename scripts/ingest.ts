import "dotenv/config";
import { resolve } from "node:path";
import { ingest } from "../src/server/ingest";
import { isDate, londonDate, recentWeekdays, weekday } from "../src/domain/time";
const explicit = process.argv[2] || process.env.INGEST_DATE;
const now = new Date(), today = londonDate(now);
if (explicit && (!isDate(explicit) || !weekday(explicit) || explicit > today)) {
  console.error("Use a past or current weekday in YYYY-MM-DD format."); process.exit(1);
}
// First run of each London day reconciles the previous two weekdays as well.
// Normal runs collect today; Saturday's early run finalises Friday.
const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(now);
const dates = explicit ? [explicit] : recentWeekdays(today, Number(hour) < 5 ? 3 : 1);
try {
  const runs = await ingest(resolve(process.env.DATA_DIR || "data-store"), dates);
  for (const run of runs) console.log(run.serviceDate + ": " + run.status + " (" + run.servicesUpdated + " service updates) " + run.message);
  // A missing token is a configuration failure; other failures remain visible in the published run history.
  if (runs.every(r => r.status === "FAILED")) process.exitCode = 2;
} catch {
  // Do not print exception objects: fetch/SDK errors can contain request credentials.
  console.error("Ingestion did not complete. Check configuration, data directory, and the ingestion lock.");
  process.exitCode = 1;
}
