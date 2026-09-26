import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadArchive } from "../src/server/store";
const archive = await loadArchive(resolve(process.env.DATA_DIR || "data-store"));
await mkdir("public/data", { recursive: true });
await writeFile("public/data/archive.json", JSON.stringify(archive), "utf8");
await writeFile("public/.nojekyll", "", "utf8");
console.log("Prepared " + archive.services.filter(r => r.service.monitored).length + " monitored services for the static dashboard.");
