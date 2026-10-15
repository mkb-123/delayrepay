// Laptop claim worker: leases journeys you selected in the dashboard from the Pi
// (through the SSH tunnel opened by run-claim-worker.ps1) and submits each one in a
// real Chrome session using the proven page routines in scripts/browser/.
// No AI is involved. Set DELAYREPAY_DRY_RUN=1 to stop before the final Submit.
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
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
let loginNote = "";
async function ensureLoggedIn(page, code) {
  loginNote = "";
  const adapter = adapters[code];
  await page.goto(adapter.entry, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  if (await adapter.loggedIn(page)) return true;
  const creds = await credentialsFor(code);
  if (!creds) { loginNote = "no credentials file (run set-operator-credentials.ps1)"; return false; }
  await page.goto(loginUrls[code], { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  // A cookie banner can cover the form on a fresh profile; decline non-essential cookies.
  await page.locator('[aria-label="reject all cookie message"], button:has-text("Reject all")').first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  const email = page.locator('#emailadd, input[type="email"], input[name*="mail" i], input[formcontrolname*="mail" i]').first();
  const password = page.locator('input[type="password"]').first();
  if (!await email.count() || !await password.count()) { loginNote = `login form not found at ${page.url()}`; return false; }
  // LNR marks the fields readonly until focused (anti-autofill); focus, unlock, then type.
  for (const [field, value] of [[email, creds.email], [password, creds.password]]) {
    await field.click();
    await field.evaluate(el => el.removeAttribute("readonly"));
    await field.fill(value);
  }
  await page.getByRole("button", { name: /^\s*(log ?in|sign ?in|continue)\s*$/i }).first().click();
  await page.waitForTimeout(5000);
  const afterSubmit = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  const hint = afterSubmit.match(/(captcha|incorrect|invalid|locked|verify|try again|not recognised)[^.]{0,80}/i)?.[0] || "";
  if (await page.locator('iframe[src*="recaptcha/api2/bframe"]').first().isVisible().catch(() => false)) { loginNote = "CAPTCHA challenge shown after login attempt"; return false; }
  await page.goto(adapter.entry, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const ok = await adapter.loggedIn(page);
  if (!ok) loginNote = `still signed out after submitting credentials at ${page.url()}${hint ? ` (page said: ${hint})` : ""}`;
  return ok;
}

// One worker at a time: two runs would fight over the same Chrome profile and could double-claim.
const lockFile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DelayRepay", "worker.lock");
async function acquireLock() {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  try {
    const pid = Number(await fs.readFile(lockFile, "utf8"));
    if (pid) { try { process.kill(pid, 0); console.log(`Another worker (pid ${pid}) is running; exiting.`); return false; } catch {} }
  } catch {}
  await fs.writeFile(lockFile, String(process.pid));
  return true;
}
if (!await acquireLock()) process.exit(0);
process.on("exit", () => { try { fsSync.rmSync(lockFile, { force: true }); } catch {} });

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

// Restore and focus the (normally minimised) Chrome window, and raise a Windows balloon notification.
async function showWindow(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  } catch {}
  await page.bringToFront().catch(() => {});
}
function notify(message) {
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(15000, 'Delay Repay', '${message.replace(/'/g, "")}', [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep 16; $n.Dispose()`;
  spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], { stdio: "ignore", detached: true }).unref();
}

const spacingMs = { VT: 75000, LM: 20000 };
const lastSubmit = {};

// Session state kept between runs: when each operator was last checked and last seen signed in.
const stateFile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DelayRepay", "keepalive.json");
let state = { checked: {}, ok: {} };
try { const raw = JSON.parse(await fs.readFile(stateFile, "utf8")); state = { checked: raw.checked || {}, ok: raw.ok || {} }; } catch {}
async function saveState() { await fs.mkdir(path.dirname(stateFile), { recursive: true }); await fs.writeFile(stateFile, JSON.stringify(state)); }
// Records a sign-in; on failure returns how long the previous session lasted, to learn each portal's timeout.
function sessionNote(code, signedIn) {
  if (signedIn) { state.ok[code] = Date.now(); return ""; }
  return state.ok[code] ? ` Last seen signed in ${((Date.now() - state.ok[code]) / 3.6e6).toFixed(1)} h ago.` : "";
}

// Look at the operator's own claims list before submitting. Avanti lists exact departure times, so an
// identical claim is recorded rather than repeated. LNR lists only travel dates, so more portal claims on
// that date than the Pi has recorded is treated as a possible duplicate and stops for a person.
async function portalGuard(page, job) {
  const s = job.service, [y, mo, d] = s.serviceDate.split("-"), dd = `${d}/${mo}/${y}`, time = s.scheduledDeparture.slice(11, 16);
  if (job.operatorCode === "VT") {
    await page.goto("https://delayrepay.avantiwestcoast.co.uk/en/claim-history", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => /Claim Reference/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    for (const hit of text.matchAll(/Claim Reference:\s*(AWC-[\d-]+)\s*Departure Time:\s*(\d\d\/\d\d\/\d{4})\s+(\d\d:\d\d)/g)) {
      if (hit[2] === dd && hit[3] === time) return { existing: hit[1] };
    }
    return {};
  }
  await page.goto("https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=myclaims.list", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const rows = await page.$$eval("table tr", trs => trs.map(tr => [...tr.children].map(c => c.innerText.trim())));
  const onDate = rows.filter(r => r[1] === dd).length;
  return onDate > (job.recordedOnDate || 0) ? { surplus: `${onDate} claim(s) on the portal for ${dd} but ${job.recordedOnDate || 0} recorded` } : {};
}

async function processJob(job) {
  const adapter = adapters[job.operatorCode];
  if (!adapter) { await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_ATTENTION", error: `Unsupported operator ${job.operatorCode}` }); return; }
  let context;
  try { context = await contextFor(job.operatorCode); } catch (error) {
    await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_ATTENTION", error: `Chrome could not open the ${job.operatorCode} profile: ${String(error.message).split("\n")[0]}` });
    return;
  }
  const page = context.pages()[0] || await context.newPage();
  let submitStarted = false;
  try {
    const signedIn = await ensureLoggedIn(page, job.operatorCode);
    const lifetime = sessionNote(job.operatorCode, signedIn);
    if (!signedIn) {
      const reason = `Log in to ${job.operatorCode} with claim-login.ps1. Automatic login: ${loginNote || "not attempted"}.${lifetime}`;
      await post("/api/private-worker/result", { serviceId: job.serviceId, state: "NEEDS_LOGIN", error: reason, screenshotBase64: await screenshot(page).catch(() => null) });
      console.log(`  needs login: ${reason}`);
      return;
    }
    // Duplicate guard: look at the portal's own claims before submitting anything.
    const guard = await portalGuard(page, job);
    if (guard.existing) {
      await post("/api/private-worker/result", { serviceId: job.serviceId, state: "SUBMITTED", reference: guard.existing });
      console.log(`  already on the portal as ${guard.existing}; recorded, nothing submitted`);
      return;
    }
    if (guard.surplus) throw new Error(`Possible duplicate: ${guard.surplus}. If this journey is already claimed, run record-claims.ps1; otherwise retry.`);
    await page.goto(adapter.entry, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
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
    // Space submissions: a burst of claims makes reCAPTCHA escalate to an image challenge.
    const pause = (lastSubmit[job.operatorCode] || 0) + spacingMs[job.operatorCode] + Math.random() * 10000 - Date.now();
    if (pause > 0) { console.log(`  waiting ${Math.ceil(pause / 1000)}s between claims`); await page.waitForTimeout(pause); }
    submitStarted = true;
    await page.getByRole("button", { name: /Submit claim/i }).or(page.getByRole("link", { name: /Submit claim/i })).first().click();
    const waitConfirmed = timeout => page.waitForFunction(re => new RegExp(re, "i").test(document.body.innerText), adapter.confirmed.source, { timeout });
    try { await waitConfirmed(45000); } catch (error) {
      // reCAPTCHA can escalate to an image challenge. A person has to solve it: surface the window and wait.
      const challenge = await page.locator('iframe[title*="recaptcha challenge" i], iframe[src*="recaptcha/api2/bframe"]').first().isVisible().catch(() => false);
      if (!challenge) throw error;
      console.log("  CAPTCHA challenge shown: solve it in the Chrome window (waiting up to 15 minutes)");
      await showWindow(page);
      notify("Solve the CAPTCHA in the Chrome window to finish this Delay Repay claim.");
      await waitConfirmed(15 * 60000);
    }
    lastSubmit[job.operatorCode] = Date.now();
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
  for (const code of Object.keys(adapters)) {
    if (Date.now() - (state.checked[code] || 0) < 20 * 3600 * 1000) continue;
    try { await fs.access(path.join(base, "browser-profiles", code.toLowerCase())); } catch { continue; }
    try {
      const page = (await contextFor(code)).pages()[0] || await (await contextFor(code)).newPage();
      const ok = await ensureLoggedIn(page, code);
      const note = sessionNote(code, ok);
      await post("/api/private-worker/session", { operatorCode: code, status: ok ? "LOGIN_OK" : "LOGIN_NEEDED", explanation: ok ? "Daily keep-alive visit succeeded." : `Session expired.${note} Run claim-login.ps1.` });
      state.checked[code] = Date.now();
      console.log(`Keep-alive ${code}: ${ok ? "signed in" : "SIGNED OUT," + note + " Run claim-login.ps1 -Operator " + code}`);
    } catch (error) { console.log(`Keep-alive ${code} failed: ${error.message}`); }
  }
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
  await saveState().catch(() => {});
  for (const context of contexts.values()) await context.close().catch(() => {});
}
console.log(handled ? `Processed ${handled} claim job(s).` : "No queued claim jobs.");
