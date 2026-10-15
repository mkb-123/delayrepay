import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const api = process.env.DELAYREPAY_WORKER_URL || "http://127.0.0.1:8877";
const chrome = process.env.DELAYREPAY_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const adapters = {
  VT: { login: "https://delayrepay.avantiwestcoast.co.uk/", claim: "https://delayrepay.avantiwestcoast.co.uk/" },
  LM: { login: "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=login.login", claim: "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=myclaims.add" },
};
const labels = {
  date: [/date.*journey/i, /travel date/i, /departure date/i],
  origin: [/^from$/i, /origin/i, /departure station/i],
  destination: [/^to$/i, /destination/i, /arrival station/i],
  departure: [/scheduled departure/i, /departure time/i],
  arrival: [/actual arrival/i, /arrival time/i],
};

async function post(route, body = {}) {
  const response = await fetch(api + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function fill(page, patterns, value) {
  for (const pattern of patterns) {
    const field = page.getByLabel(pattern).first();
    if (await field.count() && await field.isVisible()) {
      try { await field.fill(value); return true; } catch {}
    }
  }
  return false;
}
async function screenshot(page) { return (await page.screenshot({ fullPage: true })).toString("base64"); }
async function processJob(job) {
  const adapter = adapters[job.operatorCode];
  if (!adapter) throw new Error(`Unsupported operator ${job.operatorCode}`);
  const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DelayRepay", "browser-profiles", job.operatorCode.toLowerCase());
  await fs.mkdir(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { executablePath: chrome, headless: true });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(adapter.login, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (await page.locator('input[type="password"]').count() || await page.getByText(/complete the recaptcha/i).count()) {
      await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_LOGIN", error: `Log in to ${job.operatorCode} with claim-login.ps1.` }); return;
    }
    if (adapter.claim !== adapter.login) await page.goto(adapter.claim, { waitUntil: "domcontentloaded", timeout: 60000 });
    const s = job.service;
    let filled = 0;
    filled += await fill(page, labels.date, s.serviceDate);
    filled += await fill(page, labels.origin, s.origin === "MKC" ? "Milton Keynes Central" : "London Euston");
    filled += await fill(page, labels.destination, s.destination === "EUS" ? "London Euston" : "Milton Keynes Central");
    filled += await fill(page, labels.departure, s.scheduledDeparture.slice(11, 16));
    const arrival = s.actualArrival || s.scheduledArrival;
    if (arrival) filled += await fill(page, labels.arrival, arrival.slice(11, 16));
    if (filled < 3) throw new Error("The operator claim form fields could not be identified.");
    for (let step = 0; step < 6; step++) {
      const submit = page.getByRole("button", { name: /submit( claim)?$/i }).first();
      if (await submit.count() && await submit.isVisible()) {
        if (job.mode === "CALIBRATE") {
          await post("/api/private-worker/result", { serviceId: job.serviceId, state: "CALIBRATION_READY", lastStep: "Final confirmation", screenshotBase64: await screenshot(page) }); return;
        }
        await submit.click(); await page.waitForLoadState("domcontentloaded"); break;
      }
      const next = page.getByRole("button", { name: /continue|next/i }).first();
      if (!await next.count() || !await next.isVisible()) throw new Error("The claim form needs information that could not be completed automatically.");
      await next.click(); await page.waitForLoadState("domcontentloaded");
    }
    const body = await page.locator("body").innerText();
    const reference = body.match(/(?:claim|reference)(?: number| ref(?:erence)?)?\s*[:#]?\s*([A-Z]{2,5}[-/][A-Z0-9/-]{5,})/i)?.[1] || null;
    if (!reference && !/claim (?:has been |was )?(?:submitted|received)|thank you.*claim/is.test(body)) throw new Error("The portal did not show submission confirmation.");
    await post("/api/private-worker/result", { serviceId: job.serviceId, state: "SUBMITTED", reference });
  } catch (error) {
    await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_ATTENTION", error: error.message, screenshotBase64: await screenshot(page).catch(() => null) });
  } finally { await context.close(); }
}

let handled = 0;
for (let i = 0; i < 5; i++) {
  const { job } = await post("/api/private-worker/next");
  if (!job) break;
  console.log(`Processing ${job.operatorCode} ${job.service.serviceDate} ${job.service.scheduledDeparture.slice(11, 16)} (${job.mode})`);
  await processJob(job); handled++;
}
console.log(handled ? `Processed ${handled} claim job(s).` : "No queued claim jobs.");
