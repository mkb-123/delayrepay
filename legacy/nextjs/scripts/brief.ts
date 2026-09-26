import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderBrief } from "../src/server/brief";
import { loadArchive } from "../src/server/store";
import { ingest } from "../src/server/ingest";
import { isDate, londonDate, recentWeekdays, weekday } from "../src/domain/time";
import type { LocalRecords } from "../src/domain/claims";

const args = new Set(process.argv.slice(2));
const explicitDate = process.argv.slice(2).find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? process.env.BRIEF_DATE;
const fetchLatest = args.has("--fetch");
const dryRun = args.has("--dry-run") || args.has("--plan");
const outputPath = valueAfter("--output");
const maxDetails = numericValueAfter("--max-details");
const quiet = args.has("--quiet");
const dataDir = resolve(process.env.DATA_DIR || "data-store");
const ackPath = resolve(process.env.ACK_FILE || `${dataDir}/acknowledgements.json`);
const today = londonDate();

if (explicitDate && (!isDate(explicitDate) || !weekday(explicitDate) || explicitDate > today)) {
  console.error("Use a past or current weekday in YYYY-MM-DD format.");
  process.exit(1);
}

const dates = explicitDate ? [explicitDate] : recentWeekdays(today, 1);

if (fetchLatest || dryRun) {
  const runs = await ingest(dataDir, dates, undefined, { dryRun, maxDetailRequests: maxDetails, onProgress: quiet ? undefined : message => console.error(message) });
  for (const run of runs) console.error(`${run.serviceDate}: ${run.status} (${run.servicesUpdated} service updates) ${run.message}`);
  if (dryRun) process.exit(0);
}

const archive = await loadArchive(dataDir);
const local = await readLocalRecords(ackPath);
const text = renderBrief(archive, { date: dates[0], local });

if (outputPath) {
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), text, "utf8");
} else {
  console.log(text);
}

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numericValueAfter(name: string): number | undefined {
  const value = valueAfter(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`${name} must be a non-negative integer.`);
    process.exit(1);
  }
  return parsed;
}

async function readLocalRecords(path: string): Promise<LocalRecords> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as LocalRecords : {};
  } catch {
    return {};
  }
}
