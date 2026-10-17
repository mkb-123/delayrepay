// One-screen status of everything that may need attention. Reads the dashboard JSON on stdin:
//   scripts/pi.sh status            (or) curl .../api/dashboard | node scripts/status.mjs
//   scripts/pi.sh status --alerts   prints only real problems, one "ALERT: ..." line each (used by the Pi's alert email)
// No AI needed: run it, read it, act on the "NEEDS YOU" lines.
import fs from "node:fs";

const alertsOnly = process.argv.includes("--alerts");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const ops = data.operations || {};
const now = Date.now();
const log = (...a) => { if (!alertsOnly) console.log(...a); };
const ago = iso => {
  if (!iso) return "never";
  const mins = Math.round((now - Date.parse(iso)) / 60000);
  return mins < 90 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
};
const clock = iso => (iso || "").slice(11, 16);
const daysLeft = date => 28 - Math.floor((now - Date.parse(date + "T12:00:00Z")) / 86400000);
const need = []; // { text, alert } : alert=false means "normal waiting", not worth an email
const add = (text, alert = true) => need.push({ text, alert });
const DAY = 26 * 3600000;

log(`Range ${data.from} to ${data.to}`);
log(`Rail data collected ${ago(ops.lastCollection)} | Gmail checked ${ago(ops.lastGmailReconciliation)} | laptop worker seen ${ago(ops.laptopWorkerLastSeen)}`);
for (const s of ops.operatorSessions || []) log(`Session ${s.operator_code}: ${s.status} (${ago(s.checked_at)})`);
if (!ops.lastCollection || now - Date.parse(ops.lastCollection) > DAY) add("Rail data is more than a day old: check the Pi collection timer.");
if (!ops.gmailConfigured) add("Gmail authorisation is missing on the Pi: run scripts/windows/gmail-authorize.ps1.");
else if (!ops.lastGmailReconciliation || now - Date.parse(ops.lastGmailReconciliation) > DAY) add("Gmail was not checked in the last day: check delayrepay-reconcile.service.");
if (!ops.laptopWorkerLastSeen || now - Date.parse(ops.laptopWorkerLastSeen) > DAY) add("The laptop worker has not run for over a day: is the laptop on, and is the 19:00 task enabled?");
for (const s of ops.operatorSessions || []) if (s.status !== "LOGIN_OK") add(`${s.operator_code} is signed out: run claim-login.ps1 -Operator ${s.operator_code} (CAPTCHA).`);

const tracking = ops.claimTracking || [];
const label = s => `${s.serviceDate} ${clock(s.scheduledDeparture)} ${s.operatorName}`;
const queued = tracking.filter(s => s.claimSubmission && s.claimSubmission.state !== "SUBMITTED");
log(`\nClaim queue: ${queued.length ? "" : "empty"}`);
for (const s of queued) {
  const state = s.claimSubmission.state, err = (s.claimSubmission.lastError || "").split(".")[0].slice(0, 90);
  log(`  ${state.padEnd(16)} ${label(s)} ${err}`);
  const stale = now - Date.parse(s.claimSubmission.queuedAt || 0) > DAY;
  if (["QUEUED", "RETRY"].includes(state)) add(stale ? `Queued for over a day and not sent: ${label(s)}.` : `Waiting for the 19:00 worker: ${label(s)}.`, stale);
  else if (state === "PROCESSING") add(`Possibly stuck (leased by the worker): ${label(s)}.`, now - Date.parse(s.claimSubmission.startedAt || 0) > 30 * 60000);
  else add(`${state}: ${label(s)}. ${err}`);
}

const counts = {};
for (const s of tracking) { const k = s.claimLifecycle ? s.claimLifecycle.status : s.claimSubmission ? "QUEUED-ONLY" : "ACK-ONLY"; counts[k] = (counts[k] || 0) + 1; }
log(`\nOperator outcomes: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
for (const s of tracking.filter(s => ["APPROVED", "PAID"].includes(s.claimLifecycle?.status))) log(`  ${s.claimLifecycle.status} ${label(s)} ${s.claimLifecycle.claim_reference || ""}`);
const comp = ops.compensation;
if (comp) {
  const gbp = p => "£" + (p / 100).toFixed(2);
  log(`Compensation: approved ${gbp(comp.approvedPence)} (${comp.approvedClaims} claims; ${Object.entries(comp.approvedByOperator || {}).map(([k, v]) => k + " " + gbp(v)).join(", ")}), paid ${gbp(comp.paidPence)}, expected if pending approved ${gbp(comp.expectedPendingPence)} (${comp.expectedPendingClaims} claims)`);
}
const review = (ops.emailReview || []).length;
if (review) log(`Emails awaiting a match: ${review}`);

const choose = [];
for (const day of data.days || []) {
  if (day.acknowledgedAt) continue;
  for (const item of day.recommendations || []) {
    if (!["POTENTIAL", "NEEDS_REVIEW"].includes(item.status) || item.claimLifecycle || item.claimSubmission) continue;
    const text = `${day.date} ${item.direction.slice(0, 3)} ${clock(item.scheduledDeparture)} ${item.operatorName}`;
    if (item.likelyRejected) log(`  (likely rejected, skip) ${text}: ${(item.explanation || "").slice(0, 100)}`);
    else if (/not recorded/i.test(item.explanation || "")) log(`  (no RTT arrival yet) ${text}`);
    else choose.push({ date: day.date, text: `${text} ${item.effectiveDelayMinutes != null ? item.effectiveDelayMinutes + " min" : /cancelled/i.test(item.explanation || "") ? "CANCELLED" : "?"}` });
  }
}
log(`\nTrains waiting for YOUR choice in the dashboard: ${choose.length ? "" : "none"}`);
for (const c of choose) log(`  ${c.text}  (${daysLeft(c.date)} days left)`);
if (choose.length) {
  const soonest = Math.min(...choose.map(c => daysLeft(c.date)));
  add(`${choose.length} train(s) to choose in the dashboard; the earliest has ${soonest} day(s) left.`, soonest <= 5);
}

if (alertsOnly) { for (const n of need.filter(n => n.alert)) console.log(`ALERT: ${n.text}`); }
else { console.log(`\n${need.length ? "NEEDS YOU:" : "NOTHING NEEDS YOU."}`); for (const n of need) console.log(`  - ${n.text}`); }
