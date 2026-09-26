const $ = (id) => document.getElementById(id);
let data = null;
let pendingOperation = null;

function isoDate(value) { return value ? value.slice(0, 10) : ""; }
function clock(value) { return value ? value.slice(11, 16) : "—"; }
function dayLabel(value) { return new Intl.DateTimeFormat("en-GB", {weekday: "short", day: "numeric", month: "short"}).format(new Date(`${value}T12:00:00`)); }
function esc(value) { const span = document.createElement("span"); span.textContent = String(value ?? ""); return span.innerHTML; }
function dateRange(days) { const end = new Date(); const start = new Date(end); start.setDate(end.getDate() - days + 1); return [isoDate(start.toISOString()), isoDate(end.toISOString())]; }

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
  renderRecommendations();
  render();
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
      html += `<button class="recommend-row ${item.status}" onclick="showService('${encodeURIComponent(item.serviceId)}')"><strong>${route} · ${clock(item.scheduledDeparture)}</strong><span>${esc(item.operatorName)} · ${detail}</span></button>`;
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
  const delay = $("delay").value === "" ? null : Number($("delay").value);
  const parts = [delay === null ? "All trains" : `${delay}+ min or cancelled`];
  if (direction) parts.push(direction === "MORNING" ? "Morning" : "Evening");
  if (operator) parts.push(operator);
  if (status) parts.push({POTENTIAL: "Potential", NEEDS_REVIEW: "Decide", CLAIMED: "Claimed", NO_CLAIM: "No claim"}[status]);
  $("filterSummary").textContent = parts.join(" · ");
  const dates = [...data.days].reverse().map(day => day.date);
  const all = data.days.flatMap(day => day.services).filter(s =>
    (!direction || s.direction === direction) && (!operator || s.operatorName === operator) && (!status || s.assessment.status === status)
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
    html += "</tbody></table></div></section>";
  }
  $("results").innerHTML = html || '<p class="empty">No stored services match these filters.</p>';
}

function cell(service, threshold) {
  if (!service) return '<td class="heat-empty">—</td>';
  const a = service.assessment;
  const heat = service.cancelled ? "heat-cancelled" : service.rawDelayMinutes == null ? "heat-unknown" : service.rawDelayMinutes >= 60 ? "heat-60" : service.rawDelayMinutes >= 30 ? "heat-30" : service.rawDelayMinutes >= 15 ? "heat-15" : "heat-ok";
  const hidden = threshold !== null && !service.cancelled && (service.rawDelayMinutes == null || service.rawDelayMinutes < threshold);
  if (hidden) return '<td class="heat-muted">·</td>';
  const value = service.cancelled ? "×" : service.rawDelayMinutes == null ? "?" : service.rawDelayMinutes <= 0 ? "✓" : `+${service.rawDelayMinutes}`;
  const marker = a.status === "POTENTIAL" ? "!" : a.status === "CLAIMED" ? "✓" : a.status === "NEEDS_REVIEW" ? "?" : "";
  return `<td><button class="heat-cell ${heat}" onclick="showService('${encodeURIComponent(service.serviceId)}')"><strong>${value}</strong>${marker ? `<span>${marker}</span>` : ""}</button></td>`;
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
  $("serviceDetail").innerHTML = `<p class="eyebrow">${esc(dayLabel(service.serviceDate))} · ${service.origin} → ${service.destination}</p><h2>${clock(service.scheduledDeparture)} · ${esc(service.operatorName)}</h2><span class="status ${a.status}">${labels[a.status]}</span><p class="reason">${esc(a.explanation)}</p><dl class="facts"><dt>Scheduled</dt><dd>${clock(service.scheduledDeparture)} → ${clock(service.scheduledArrival)}</dd><dt>Actual</dt><dd>${clock(service.actualDeparture)} → ${clock(service.actualArrival)}</dd><dt>Raw delay</dt><dd>${service.cancelled ? "Cancelled" : service.rawDelayMinutes == null ? "Unknown" : `${service.rawDelayMinutes} minutes`}</dd><dt>Effective delay</dt><dd>${a.effectiveDelayMinutes == null ? "Not determined" : `${a.effectiveDelayMinutes} minutes`}</dd><dt>Rule</dt><dd>${esc(a.ruleVersion)}</dd></dl><div class="actions">${actions}</div>${a.ruleSource ? `<p><a href="${esc(a.ruleSource)}" target="_blank" rel="noopener">Official rule source →</a></p>` : ""}`;
  $("serviceDialog").showModal();
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
for (const id of ["direction", "operator", "status", "delay"]) $(id).addEventListener("change", render);
$("showAcknowledged").addEventListener("change", renderRecommendations);
$("refreshButton").addEventListener("click", openData);
$("planDiscovery").addEventListener("click", () => previewOperation("discover"));
$("planCollection").addEventListener("click", () => previewOperation("collect"));
$("runOperation").addEventListener("click", runOperation);
const initial = dateRange(10);
$("fromDate").value = initial[0]; $("toDate").value = initial[1];
$("discoverEnd").value = nextFriday(); $("collectEnd").value = latestWeekday();
load();
