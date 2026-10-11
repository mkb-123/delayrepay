const $ = (id) => document.getElementById(id);
let data = null;
let pendingOperation = null;

function isoDate(value) { return value ? value.slice(0, 10) : ""; }
function clock(value) { return value ? value.slice(11, 16) : "—"; }
function dayLabel(value) { return new Intl.DateTimeFormat("en-GB", {weekday: "short", day: "numeric", month: "short"}).format(new Date(`${value}T12:00:00`)); }
function esc(value) { const span = document.createElement("span"); span.textContent = String(value ?? ""); return span.innerHTML; }
function dateRange(days) { const end = new Date(); const start = new Date(end); start.setDate(end.getDate() - days + 1); return [isoDate(start.toISOString()), isoDate(end.toISOString())]; }
function timestamp(value) { return value ? new Intl.DateTimeFormat("en-GB", {dateStyle: "medium", timeStyle: "short"}).format(new Date(value)) : "Never"; }
const lifecycleLabels = {SUBMITTED: "Submitted", APPROVED: "Approved", REJECTED: "Rejected", PAID: "Paid", NEEDS_REVIEW: "Email review"};
const lifecycleCompact = {SUBMITTED: "Sent", APPROVED: "OK", REJECTED: "No", PAID: "Paid", NEEDS_REVIEW: "?"};
function lifecycleBadge(lifecycle, compact = false) {
  if (!lifecycle) return "";
  const label = (compact ? lifecycleCompact : lifecycleLabels)[lifecycle.status] || lifecycle.status;
  const detail = lifecycle.claim_reference ? `${label} · ${lifecycle.claim_reference}` : label;
  return `<span class="claim-lifecycle lifecycle-${esc(lifecycle.status)}" title="${esc(detail)}">${esc(compact ? label : detail)}</span>`;
}

async function load() {
  const period = $("period").value;
  let from, to;
  if (period === "all") [from, to] = ["2000-01-01", isoDate(new Date().toISOString())];
  else if (period === "custom") [from, to] = [$("fromDate").value, $("toDate").value];
  else [from, to] = dateRange(Number(period));
  if (!from || !to) return;
  const response = await fetch(`/api/dashboard?from=${from}&to=${to}`);
  data = await response.json();
  if (!response.ok) return showNotice(data.error, true);
  const operators = new Set(data.days.flatMap(day => day.services.map(service => service.operatorName)));
  const selected = $("operator").value;
  $("operator").innerHTML = '<option value="">All</option>' + [...operators].sort().map(value => `<option ${value === selected ? "selected" : ""}>${esc(value)}</option>`).join("");
  renderHealth();
  renderClaimPipeline();
  renderRecommendations();
  render();
}

function renderHealth() {
  const value = data.operations || {};
  const collection = value.lastCollection ? `Rail data refreshed ${timestamp(value.lastCollection)}` : "Rail data not collected";
  const gmail = value.gmailConfigured ? `Gmail checked ${timestamp(value.lastGmailReconciliation)}` : "Gmail authorization needed";
  const backup = value.lastBackup ? `Backup ${timestamp(value.lastBackup)}` : "No backup found";
  const mirror = !value.backupMirrorConfigured ? "Off-device backup not configured" : value.backupMirrorAvailable ? "Off-device backup available" : "Off-device backup unavailable";
  const review = value.emailReview?.length || 0;
  $("systemHealth").innerHTML = `<span class="${value.lastCollection ? "health-ok" : "health-warn"}">${esc(collection)}</span><span class="${value.gmailConfigured ? "health-ok" : "health-warn"}">${esc(gmail)}</span><span class="${value.lastBackup ? "health-ok" : "health-warn"}">${esc(backup)}</span><span class="${value.backupMirrorAvailable ? "health-ok" : "health-warn"}">${esc(mirror)}</span>${review ? `<button class="health-review" onclick="openEmailReview()">${review} email${review === 1 ? "" : "s"} to match</button>` : ""}`;
}

function renderClaimPipeline() {
  const services = data.days.flatMap(day => day.services).filter(service => service.assessment.claimLifecycle);
  const active = services.filter(service => ["SUBMITTED", "APPROVED", "NEEDS_REVIEW"].includes(service.assessment.claimLifecycle.status));
  const complete = services.filter(service => ["PAID", "REJECTED"].includes(service.assessment.claimLifecycle.status));
  const cards = rows => rows.map(service => `<button class="pipeline-card" onclick="showService('${encodeURIComponent(service.serviceId)}')"><strong>${dayLabel(service.serviceDate)} · ${clock(service.scheduledDeparture)}</strong><span>${esc(service.operatorName)}</span>${lifecycleBadge(service.assessment.claimLifecycle)}</button>`).join("");
  $("claimPipeline").innerHTML = `<div class="section-heading"><h2>Claims in progress</h2></div>${active.length ? `<div class="pipeline-grid">${cards(active)}</div>` : '<p class="empty compact">No claims awaiting an outcome.</p>'}${complete.length ? `<details class="completed-claims"><summary>${complete.length} completed claim${complete.length === 1 ? "" : "s"}</summary><div class="pipeline-grid">${cards(complete)}</div></details>` : ""}`;
}

function openEmailReview() {
  const events = data.operations?.emailReview || [];
  const services = data.days.flatMap(day => day.services);
  $("emailReview").innerHTML = events.map((event, index) => {
    const candidates = services.filter(service => service.operatorCode === event.operator_code);
    return `<article class="email-event"><strong>${esc(lifecycleLabels[event.outcome] || event.outcome)} · ${esc(event.operator_code)}</strong><span>${timestamp(event.received_at)}${event.claim_reference ? ` · ${esc(event.claim_reference)}` : ""}</span><p>${esc(event.explanation)}</p><label>Journey<select id="emailMatch${index}"><option value="">Select journey</option>${candidates.map(service => `<option value="${esc(service.serviceId)}">${esc(dayLabel(service.serviceDate))} · ${clock(service.scheduledDeparture)} · ${esc(service.operatorName)}</option>`).join("")}</select></label><button onclick="matchEmail('${encodeURIComponent(event.gmail_message_id)}', 'emailMatch${index}')">Match email</button></article>`;
  }).join("") || '<p class="empty">No emails need matching.</p>';
  $("emailReviewDialog").showModal();
}

async function matchEmail(encodedId, selectId) {
  const serviceId = $(selectId).value;
  if (!serviceId) return showNotice("Choose a journey first.", true);
  const response = await fetch(`/api/email-events/${encodedId}/match`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({serviceId})});
  const result = await response.json();
  if (!response.ok) return showNotice(result.error, true);
  $("emailReviewDialog").close();
  showNotice("Email matched to journey.");
  await load();
}

function renderRecommendations() {
  let html = "";
  for (const day of data.days) {
    if (!day.recommendations?.length) continue;
    if (day.acknowledgedAt && !$('showAcknowledged').checked) continue;
    html += `<article class="recommend-day${day.acknowledgedAt ? " acknowledged" : ""}"><div class="recommend-date"><h3>${esc(dayLabel(day.date))}</h3><button class="ack-day secondary" onclick="acknowledgeDay('${day.date}', ${day.acknowledgedAt ? "true" : "false"})">${day.acknowledgedAt ? "Undo" : "Done"}</button></div><div>`;
    for (const item of day.recommendations) {
      const route = item.direction === "MORNING" ? "Morning" : "Evening";
      if (item.status === "NO_CLAIM") {
        html += `<div class="recommend-row no-action"><strong>${route}</strong><span>No claim</span></div>`;
        continue;
      }
      const label = item.status === "POTENTIAL" ? "Claim" : item.status === "CLAIMED" ? "✓ Claimed" : "Decide";
      const detail = item.effectiveDelayMinutes == null ? label : `${item.effectiveDelayMinutes} min · ${label}`;
      const preference = item.preferredClaimedTime ? " · claimed time" : "";
      html += `<button class="recommend-row ${item.status}" onclick="showService('${encodeURIComponent(item.serviceId)}')"><strong>${route} · ${clock(item.scheduledDeparture)}</strong><span>${esc(item.operatorName)} · ${detail}${preference}</span>${lifecycleBadge(item.claimLifecycle)}</button>`;
    }
    html += "</div></article>";
  }
  $("recommendations").innerHTML = html || '<p class="empty">No stored days to recommend.</p>';
}

async function acknowledgeDay(serviceDate, undo) {
  const response = await fetch(`/api/days/${serviceDate}/acknowledgement`, {method: undo ? "DELETE" : "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json();
  showNotice(response.ok ? (undo ? "Day restored." : "Day acknowledged.") : result.error, !response.ok);
  if (response.ok) await load();
}

function render() {
  $("potentialCount").textContent = data.summary.potentialClaims;
  $("reviewCount").textContent = data.summary.needsReview;
  $("claimedCount").textContent = data.summary.claimed;
  $("incompleteCount").textContent = data.summary.incompleteDays;
  $("rangeLabel").textContent = `${data.from} to ${data.to}`;
  const direction = $("direction").value, operator = $("operator").value, status = $("status").value;
  const lifecycle = $("lifecycle").value, reference = $("reference").value.trim().toLowerCase();
  const delay = $("delay").value === "" ? null : Number($("delay").value);
  const parts = [delay === null ? "All trains" : `${delay}+ min or cancelled`];
  if (direction) parts.push(direction === "MORNING" ? "Morning" : "Evening");
  if (operator) parts.push(operator);
  if (status) parts.push({POTENTIAL: "Potential", NEEDS_REVIEW: "Decide", CLAIMED: "Claimed", NO_CLAIM: "No claim"}[status]);
  if (lifecycle) parts.push(lifecycle === "NONE" ? "No email match" : lifecycleLabels[lifecycle]);
  if (reference) parts.push(`Reference: ${reference}`);
  $("filterSummary").textContent = parts.join(" · ");
  const dates = [...data.days].reverse().map(day => day.date);
  const all = data.days.flatMap(day => day.services).filter(s =>
    (!direction || s.direction === direction) && (!operator || s.operatorName === operator) && (!status || s.assessment.status === status) &&
    (!lifecycle || (lifecycle === "NONE" ? !s.assessment.claimLifecycle : s.assessment.claimLifecycle?.status === lifecycle)) &&
    (!reference || (s.assessment.claimLifecycle?.claim_reference || "").toLowerCase().includes(reference))
  );
  let html = "";
  for (const routeDirection of ["MORNING", "EVENING"]) {
    const routeServices = all.filter(s => s.direction === routeDirection);
    const groups = new Map();
    for (const service of routeServices) {
      const key = `${service.operatorCode}|${clock(service.scheduledDeparture)}`;
      if (!groups.has(key)) groups.set(key, {label: `${clock(service.scheduledDeparture)}–${clock(service.scheduledArrival)}`, operator: service.operatorName, cells: new Map(), broken: false});
      const group = groups.get(key);
      group.cells.set(service.serviceDate, service);
      if (service.cancelled || (service.rawDelayMinutes != null && service.rawDelayMinutes >= (delay ?? -Infinity))) group.broken = true;
    }
    const rows = [...groups.values()].filter(group => delay === null || group.broken).sort((a, b) => a.label.localeCompare(b.label));
    if (!rows.length) continue;
    const sample = routeServices[0];
    html += `<section class="grid-section"><h2>${routeDirection === "MORNING" ? "Morning" : "Evening"} <span>${sample.origin} → ${sample.destination}</span></h2><div class="grid-scroll"><table class="heat-grid"><thead><tr><th>Journey</th>${dates.map(value => `<th>${dayLabel(value).replace(" ", "<br>")}</th>`).join("")}</tr></thead><tbody>`;
    for (const row of rows) {
      html += `<tr><th><strong>${row.label}</strong><span>${esc(row.operator)}</span></th>${dates.map(value => cell(row.cells.get(value), delay)).join("")}</tr>`;
    }
    const mobileRows = routeServices.filter(service => delay === null || service.cancelled || (service.rawDelayMinutes != null && service.rawDelayMinutes >= delay)).map(service => mobileCard(service)).join("");
    html += `</tbody></table></div><div class="mobile-journeys">${mobileRows}</div></section>`;
  }
  $("results").innerHTML = html || '<p class="empty">No stored services match these filters.</p>';
}

function mobileCard(service) {
  const a = service.assessment;
  const delay = service.cancelled ? "Cancelled" : service.rawDelayMinutes == null ? "Unknown delay" : `${service.rawDelayMinutes > 0 ? "+" : ""}${service.rawDelayMinutes} min`;
  return `<button class="mobile-journey" onclick="showService('${encodeURIComponent(service.serviceId)}')"><strong>${dayLabel(service.serviceDate)} · ${clock(service.scheduledDeparture)}</strong><span>${esc(service.operatorName)} · ${delay}</span>${lifecycleBadge(a.claimLifecycle)}</button>`;
}

function cell(service, threshold) {
  if (!service) return '<td class="heat-empty">—</td>';
  const a = service.assessment;
  const heat = service.cancelled ? "heat-cancelled" : service.rawDelayMinutes == null ? "heat-unknown" : service.rawDelayMinutes >= 60 ? "heat-60" : service.rawDelayMinutes >= 30 ? "heat-30" : service.rawDelayMinutes >= 15 ? "heat-15" : "heat-ok";
  const hidden = threshold !== null && !service.cancelled && (service.rawDelayMinutes == null || service.rawDelayMinutes < threshold);
  if (hidden) return '<td class="heat-muted">·</td>';
  const value = service.cancelled ? "×" : service.rawDelayMinutes == null ? "?" : service.rawDelayMinutes <= 0 ? "✓" : `+${service.rawDelayMinutes}`;
  const marker = a.status === "POTENTIAL" ? "!" : a.status === "CLAIMED" ? "✓" : a.status === "NEEDS_REVIEW" ? "?" : "";
  const claimed = a.status === "CLAIMED" ? " heat-claimed" : "";
  const lifecycle = lifecycleBadge(a.claimLifecycle, true);
  return `<td><button class="heat-cell ${heat}${claimed}" onclick="showService('${encodeURIComponent(service.serviceId)}')"><strong>${value}</strong>${lifecycle || (marker ? `<span class="heat-marker">${marker}</span>` : "")}</button></td>`;
}

function showService(encodedId) {
  const id = decodeURIComponent(encodedId);
  const service = data.days.flatMap(day => day.services).find(item => item.serviceId === id);
  if (!service) return;
  const a = service.assessment;
  const labels = {POTENTIAL: "Potential claim", NEEDS_REVIEW: "Decision needed", CLAIMED: "✓ Claimed", NO_CLAIM: "No claim"};
  let actions = "";
  if (a.status === "POTENTIAL") actions += `<button onclick="claim('${encodedId}', false)">Mark as claimed</button>`;
  if (a.status === "NEEDS_REVIEW") actions += `<button onclick="claim('${encodedId}', false)">Mark as claimed</button><button class="secondary" onclick="notClaimable('${encodedId}', false)">Not claimable</button>`;
  if (a.status === "CLAIMED") actions += `<button class="secondary" onclick="claim('${encodedId}', true)">Undo</button>`;
  if (a.notClaimableAt) actions += `<button class="secondary" onclick="notClaimable('${encodedId}', true)">Undo not claimable</button>`;
  if (a.claimUrl && ["POTENTIAL", "NEEDS_REVIEW", "CLAIMED"].includes(a.status)) actions += `<a href="${esc(a.claimUrl)}" target="_blank" rel="noopener">Open claim page →</a>`;
  const lifecycle = a.claimLifecycle;
  const lifecycleFacts = lifecycle ? `<dt>Operator claim</dt><dd>${lifecycleBadge(lifecycle)}${lifecycle.claim_reference ? ` <button class="copy-reference secondary" onclick="copyReference(decodeURIComponent('${encodeURIComponent(lifecycle.claim_reference)}'))">Copy reference</button>` : ""}<br>${esc(lifecycle.explanation)}</dd>` : "";
  $("serviceDetail").innerHTML = `<p class="eyebrow">${esc(dayLabel(service.serviceDate))} · ${service.origin} → ${service.destination}</p><h2>${clock(service.scheduledDeparture)} · ${esc(service.operatorName)}</h2><span class="status ${a.status}">${labels[a.status]}</span><p class="reason">${esc(a.explanation)}</p><dl class="facts"><dt>Scheduled</dt><dd>${clock(service.scheduledDeparture)} → ${clock(service.scheduledArrival)}</dd><dt>Actual</dt><dd>${clock(service.actualDeparture)} → ${clock(service.actualArrival)}</dd><dt>Raw delay</dt><dd>${service.cancelled ? "Cancelled" : service.rawDelayMinutes == null ? "Unknown" : `${service.rawDelayMinutes} minutes`}</dd><dt>Effective delay</dt><dd>${a.effectiveDelayMinutes == null ? "Not determined" : `${a.effectiveDelayMinutes} minutes`}</dd>${lifecycleFacts}<dt>Rule</dt><dd>${esc(a.ruleVersion)}</dd></dl><div class="actions">${actions}</div>${a.ruleSource ? `<p><a href="${esc(a.ruleSource)}" target="_blank" rel="noopener">Official rule source →</a></p>` : ""}`;
  $("serviceDialog").showModal();
}

async function copyReference(value) {
  await navigator.clipboard.writeText(value);
  showNotice("Claim reference copied.");
}

async function claim(encodedId, undo) {
  const response = await fetch(`/api/services/${encodedId}/claim`, {method: undo ? "DELETE" : "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json();
  showNotice(response.ok ? result.message || "Updated." : result.error, !response.ok);
  if (response.ok) { $("serviceDialog").close(); await load(); }
}

async function notClaimable(encodedId, undo) {
  const response = await fetch(`/api/services/${encodedId}/not-claimable`, {method: undo ? "DELETE" : "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json();
  showNotice(response.ok ? (undo ? "Decision restored." : "Marked as not claimable.") : result.error, !response.ok);
  if (response.ok) { $("serviceDialog").close(); await load(); }
}

function showNotice(message, error = false) { const notice = $("notice"); notice.hidden = false; notice.textContent = message; notice.style.background = error ? "#fee2e2" : "#e7f1ed"; }

function latestWeekday() {
  const value = new Date();
  while ([0, 6].includes(value.getDay())) value.setDate(value.getDate() - 1);
  return isoDate(value.toISOString());
}

function nextFriday() {
  const value = new Date();
  value.setDate(value.getDate() + ((5 - value.getDay() + 7) % 7));
  return isoDate(value.toISOString());
}

function openData() {
  pendingOperation = null;
  $("operationPlan").hidden = true;
  $("runOperation").hidden = true;
  $("dataDialog").showModal();
}

async function previewOperation(operation) {
  const discovery = operation === "discover";
  const payload = discovery
    ? {endDate: $("discoverEnd").value, days: Number($("discoverDays").value), direction: $("discoverDirection").value}
    : {endDate: $("collectEnd").value, days: Number($("collectDays").value), mode: $("collectMode").value};
  const query = new URLSearchParams(payload).toString();
  const response = await fetch(`/api/${discovery ? "discovery" : "collection"}-plan?${query}`);
  const plan = await response.json();
  if (!response.ok) return showNotice(plan.error, true);
  pendingOperation = {operation, payload};
  const count = discovery ? plan.dates.length : plan.dates.length;
  const extras = discovery ? "" : `<br>${plan.completeDates.length} already complete; ${plan.uncataloguedDates.length} uncatalogued.`;
  $("operationPlan").innerHTML = `<strong>${count} weekday${count === 1 ? "" : "s"}</strong> · ${plan.requestCount} RTT requests.${extras}`;
  $("operationPlan").hidden = false;
  $("runOperation").textContent = `Run ${operation}`;
  $("runOperation").hidden = count === 0;
}

async function runOperation() {
  if (!pendingOperation) return;
  $("runOperation").disabled = true;
  const {operation, payload} = pendingOperation;
  const response = await fetch(`/api/${operation}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
  const job = await response.json();
  $("runOperation").disabled = false;
  if (!response.ok) return showNotice(job.error, true);
  $("dataDialog").close();
  if (!job.id) return showNotice(job.message);
  showNotice(`${job.message} (0/${job.total})`);
  pollJob(job.id);
}

async function pollJob(id) {
  const response = await fetch(`/api/jobs/${id}`); const job = await response.json();
  showNotice(job.error || `${job.message} (${job.completed}/${job.total})`, job.status === "failed");
  if (["queued", "running"].includes(job.status)) setTimeout(() => pollJob(id), 1500); else if (job.status === "complete") load();
}

$("period").addEventListener("change", () => { const custom = $("period").value === "custom"; $("fromWrap").hidden = !custom; $("toWrap").hidden = !custom; if (!custom) load(); });
for (const id of ["fromDate", "toDate"]) $(id).addEventListener("change", load);
for (const id of ["direction", "operator", "status", "lifecycle", "delay"]) $(id).addEventListener("change", render);
$("reference").addEventListener("input", render);
$("showAcknowledged").addEventListener("change", renderRecommendations);
$("refreshButton").addEventListener("click", openData);
$("planDiscovery").addEventListener("click", () => previewOperation("discover"));
$("planCollection").addEventListener("click", () => previewOperation("collect"));
$("runOperation").addEventListener("click", runOperation);
const initial = dateRange(10);
$("fromDate").value = initial[0]; $("toDate").value = initial[1];
$("discoverEnd").value = nextFriday(); $("collectEnd").value = latestWeekday();
load();
