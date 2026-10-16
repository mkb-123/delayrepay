// One-screen status of everything that may need attention. Reads the dashboard JSON on stdin:
//   wsl.exe -e ssh -o BatchMode=yes bhakta-pi@pi.local 'curl -s http://127.0.0.1:8765/api/dashboard' | node scripts/status.mjs
// No AI needed: run it, read it, act on the "NEEDS YOU" lines.
import fs from "node:fs";

const data = JSON.parse(fs.readFileSync(0, "utf8"));
const ops = data.operations || {};
const now = Date.now();
const ago = iso => {
  if (!iso) return "never";
  const mins = Math.round((now - Date.parse(iso)) / 60000);
  return mins < 90 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
};
const clock = iso => (iso || "").slice(11, 16);
const need = [];

console.log(`Range ${data.from} to ${data.to}`);
console.log(`Rail data collected ${ago(ops.lastCollection)} | Gmail checked ${ago(ops.lastGmailReconciliation)} | laptop worker seen ${ago(ops.laptopWorkerLastSeen)}`);
for (const s of ops.operatorSessions || []) console.log(`Session ${s.operator_code}: ${s.status} (${ago(s.checked_at)})`);
if (!ops.lastCollection || now - Date.parse(ops.lastCollection) > 26 * 3600000) need.push("Rail data is more than a day old: check the Pi collection timer.");
if (!ops.gmailConfigured) need.push("Gmail authorisation is missing on the Pi: run scripts/windows/gmail-authorize.ps1.");
else if (!ops.lastGmailReconciliation || now - Date.parse(ops.lastGmailReconciliation) > 26 * 3600000) need.push("Gmail was not checked in the last day: check delayrepay-reconcile.service.");
if (!ops.laptopWorkerLastSeen || now - Date.parse(ops.laptopWorkerLastSeen) > 26 * 3600000) need.push("The laptop worker has not run for over a day: is the laptop on, and is the 19:00 task enabled?");
for (const s of ops.operatorSessions || []) if (s.status !== "LOGIN_OK") need.push(`${s.operator_code} is signed out: run claim-login.ps1 -Operator ${s.operator_code} (CAPTCHA).`);

const tracking = ops.claimTracking || [];
const label = s => `${s.serviceDate} ${clock(s.scheduledDeparture)} ${s.operatorName}`;
const queued = tracking.filter(s => s.claimSubmission && s.claimSubmission.state !== "SUBMITTED");
console.log(`\nClaim queue: ${queued.length ? "" : "empty"}`);
for (const s of queued) {
  const state = s.claimSubmission.state, err = (s.claimSubmission.lastError || "").split(".")[0].slice(0, 90);
  console.log(`  ${state.padEnd(16)} ${label(s)} ${err}`);
  if (["QUEUED", "RETRY"].includes(state)) need.push(`Waiting for the 19:00 worker: ${label(s)}.`);
  else if (state === "PROCESSING") need.push(`Possibly stuck (leased by the worker): ${label(s)}.`);
  else need.push(`${state}: ${label(s)}. ${err}`);
}

const counts = {};
for (const s of tracking) { const k = s.claimLifecycle ? s.claimLifecycle.status : s.claimSubmission ? "QUEUED-ONLY" : "ACK-ONLY"; counts[k] = (counts[k] || 0) + 1; }
console.log(`\nOperator outcomes: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
for (const s of tracking.filter(s => ["APPROVED", "PAID"].includes(s.claimLifecycle?.status))) console.log(`  ${s.claimLifecycle.status} ${label(s)} ${s.claimLifecycle.claim_reference || ""}`);
const review = (ops.emailReview || []).length;
if (review) console.log(`Emails awaiting a match: ${review}`);

const choose = [];
for (const day of data.days || []) {
  if (day.acknowledgedAt) continue;
  for (const item of day.recommendations || []) {
    if (!["POTENTIAL", "NEEDS_REVIEW"].includes(item.status) || item.claimLifecycle || item.claimSubmission) continue;
    const text = `${day.date} ${item.direction.slice(0, 3)} ${clock(item.scheduledDeparture)} ${item.operatorName}`;
    if (item.likelyRejected) console.log(`  (likely rejected, skip) ${text}: ${(item.explanation || "").slice(0, 100)}`);
    else if (/not recorded/i.test(item.explanation || "")) console.log(`  (no RTT arrival yet) ${text}`);
    else choose.push(`${text} ${item.effectiveDelayMinutes != null ? item.effectiveDelayMinutes + " min" : /cancelled/i.test(item.explanation || "") ? "CANCELLED" : "?"}`);
  }
}
console.log(`\nTrains waiting for YOUR choice in the dashboard: ${choose.length ? "" : "none"}`);
for (const c of choose) console.log(`  ${c}`);
if (choose.length) need.push(`${choose.length} train(s) to choose in the dashboard (tick "Claim this train" before 19:00).`);

console.log(`\n${need.length ? "NEEDS YOU:" : "NOTHING NEEDS YOU."}`);
for (const n of need) console.log(`  - ${n}`);
