// Laptop claim worker: leases journeys you selected in the dashboard from the Pi
// (through the SSH tunnel opened by run-claim-worker.ps1) and submits each one in a
// real Chrome session using the proven page routines in scripts/browser/.
// No AI is involved. Set DELAYREPAY_DRY_RUN=1 to stop before the final Submit.
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const api = process.env.DELAYREPAY_WORKER_URL || "http://127.0.0.1:8877";
const chrome = process.env.DELAYREPAY_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dryRun = process.env.DELAYREPAY_DRY_RUN === "1";
const headless = process.env.DELAYREPAY_HEADLESS === "1"; // tests only: real runs stay headed for reCAPTCHA
const maxJobs = Number(process.env.DELAYREPAY_MAX_JOBS || 10);
const browserDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "browser");
const stations = {
  MKC: { query: "Milton Keynes", name: "MILTON KEYNES CENTRAL" },
  EUS: { query: "Euston", name: "LONDON EUSTON" },
};
const adapters = {
  LM: {
    script: "lnr-claim-form.js", fn: "lnrClaim", reference: /LNR\/DR\/\d+\/[A-Z0-9]+/,
    entry: "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=myclaims.add",
    // Logged out, the claim page still loads (as a guest form), so look for the account banner.
    loggedIn: async page => /logged in as/i.test(await page.locator("body").innerText()),
    confirmed: /submitted successfully/i,
  },
  VT: {
    script: "avanti-claim-form.js", fn: "awcClaim", reference: /AWC-[\d-]+/,
    entry: "https://delayrepay.avantiwestcoast.co.uk/en/",
    // Require positive evidence: the signed-in landing page is titled "Account Summary".
    loggedIn: async page => {
      for (let i = 0; i < 20; i++) {
        if (/\/login/i.test(page.url())) return false;
        if (/Account Summary/i.test(await page.title())) return true;
        await page.waitForTimeout(500);
      }
      return false;
    },
    confirmed: /claim has been submitted/i,
  },
};

// Optional automatic re-login. Credentials live only in a local file you create with
// set-operator-credentials.ps1 (never in Git, never sent to the Pi). Without them, or if the
// portal shows a CAPTCHA, the job is reported NEEDS_LOGIN as before.
const credentialKeys = { LM: ["LNR_DELAY_REPAY_EMAIL", "LNR_DELAY_REPAY_PASSWORD"], VT: ["AVANTI_DELAY_REPAY_EMAIL", "AVANTI_DELAY_REPAY_PASSWORD"] };
const loginUrls = { LM: "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=login.login", VT: "https://delayrepay.avantiwestcoast.co.uk/en/login" };
async function credentialsFor(code) {
  const file = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DelayRepay", "secrets", "operator-accounts.env");
  let text = "";
  try { text = await fs.readFile(file, "utf8"); } catch { return null; }
  const values = Object.fromEntries(text.split(/\r?\n/).map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, "")]));
  const [emailKey, passwordKey] = credentialKeys[code];
  return values[emailKey] && values[passwordKey] ? { email: values[emailKey], password: values[passwordKey] } : null;
}
async function ensureLoggedIn(page, code) {
  const adapter = adapters[code];
  await page.goto(adapter.entry, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  if (await adapter.loggedIn(page)) return true;
  const creds = await credentialsFor(code);
  if (!creds) return false;
  await page.goto(loginUrls[code], { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const email = page.locator('#emailadd, input[type="email"], input[name*="mail" i], input[formcontrolname*="mail" i]').first();
  const password = page.locator('input[type="password"]').first();
  if (!await email.count() || !await password.count()) return false;
  await email.fill(creds.email); await password.fill(creds.password);
  await page.getByRole("button", { name: /^\s*(log ?in|sign ?in|continue)\s*$/i }).first().click();
  await page.waitForTimeout(5000);
  if (await page.locator('iframe[src*="recaptcha/api2/bframe"]').first().isVisible().catch(() => false)) return false; // CAPTCHA challenge
  await page.goto(adapter.entry, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  return adapter.loggedIn(page);
}

async function post(route, body = {}) {
  const response = await fetch(api + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function screenshot(page) { return (await page.screenshot({ fullPage: true })).toString("base64"); }
const contexts = new Map();
async function contextFor(code) {
  if (contexts.has(code)) return contexts.get(code);
  const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DelayRepay", "browser-profiles", code.toLowerCase());
  await fs.mkdir(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless, args: headless ? [] : ["--start-minimized"], viewport: { width: 1100, height: 900 },
  });
  contexts.set(code, context);
  return context;
}

async function processJob(job) {
  const adapter = adapters[job.operatorCode];
  if (!adapter) { await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_ATTENTION", error: `Unsupported operator ${job.operatorCode}` }); return; }
  const context = await contextFor(job.operatorCode);
  const page = context.pages()[0] || await context.newPage();
  let submitStarted = false;
  try {
    if (!await ensureLoggedIn(page, job.operatorCode)) {
      await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_LOGIN", error: `Log in to ${job.operatorCode} with claim-login.ps1.` });
      return;
    }
    const s = job.service;
    if (s.rawDelayMinutes == null) throw new Error("No delay figure is recorded for this journey, so the claim band is unknown. Check the actual arrival time, then claim by hand and use record-claims.ps1.");
    const from = stations[s.origin], to = stations[s.destination];
    if (!from || !to) throw new Error(`Unknown station in ${s.origin} to ${s.destination}.`);
    await page.evaluate(await fs.readFile(path.join(browserDir, adapter.script), "utf8"));
    const params = {
      date: s.serviceDate, time: s.scheduledDeparture.slice(11, 16),
      fromQuery: from.query, fromName: from.name, toQuery: to.query, toName: to.name,
      delay: s.rawDelayMinutes, submit: false,
    };
    // Fill everything first. The final click is made separately so a reload cannot hide the outcome.
    const prepared = await page.evaluate(([fn, p]) => window[fn](p), [adapter.fn, params]);
    if (!prepared?.ok) throw new Error(prepared?.needs || "The claim form could not be filled in.");
    if (dryRun) {
      await post("/api/private-worker/result", { serviceId: job.serviceId, state: "CALIBRATION_READY", lastStep: "Dry run: stopped before Submit", screenshotBase64: await screenshot(page) });
      return;
    }
    submitStarted = true;
    await page.getByRole("button", { name: /Submit claim/i }).or(page.getByRole("link", { name: /Submit claim/i })).first().click();
    await page.waitForFunction(re => new RegExp(re, "i").test(document.body.innerText), adapter.confirmed.source, { timeout: 45000 });
    const body = await page.locator("body").innerText();
    const reference = body.match(adapter.reference)?.[0] || null;
    await post("/api/private-worker/result", { serviceId: job.serviceId, state: "SUBMITTED", reference });
    console.log(`  submitted ${reference || "(no reference shown)"}`);
  } catch (error) {
    const note = submitStarted ? " The Submit button was pressed, so check the operator's claims list before retrying." : "";
    await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_ATTENTION", error: error.message + note, screenshotBase64: await screenshot(page).catch(() => null) });
    console.log(`  needs attention: ${error.message}${note}`);
  }
}

// Visit each operator once a day with its saved profile. Activity extends the portal's
// idle timeout, and an expired session is reported to the dashboard straight away instead
// of surfacing only when a claim fails.
async function keepAlive() {
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DelayRepay");
  const stateFile = path.join(base, "keepalive.json");
  let last = {};
  try { last = JSON.parse(await fs.readFile(stateFile, "utf8")); } catch {}
  for (const [code, adapter] of Object.entries(adapters)) {
    if (Date.now() - (last[code] || 0) < 20 * 3600 * 1000) continue;
    try { await fs.access(path.join(base, "browser-profiles", code.toLowerCase())); } catch { continue; }
    try {
      const page = (await contextFor(code)).pages()[0] || await (await contextFor(code)).newPage();
      const ok = await ensureLoggedIn(page, code);
      await post("/api/private-worker/session", { operatorCode: code, status: ok ? "LOGIN_OK" : "LOGIN_NEEDED", explanation: ok ? "Daily keep-alive visit succeeded." : "Session expired. Run claim-login.ps1." });
      last[code] = Date.now();
      console.log(`Keep-alive ${code}: ${ok ? "signed in" : "SIGNED OUT, run claim-login.ps1 -Operator " + code}`);
    } catch (error) { console.log(`Keep-alive ${code} failed: ${error.message}`); }
  }
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(last));
}

let handled = 0;
try {
  for (let i = 0; i < maxJobs; i++) {
    const { job } = await post("/api/private-worker/next");
    if (!job) break;
    console.log(`Processing ${job.operatorCode} ${job.service.serviceDate} ${job.service.scheduledDeparture.slice(11, 16)}${dryRun ? " (dry run)" : ""}`);
    await processJob(job); handled++;
  }
  await keepAlive();
} finally {
  for (const context of contexts.values()) await context.close().catch(() => {});
}
console.log(handled ? `Processed ${handled} claim job(s).` : "No queued claim jobs.");
