const $ = (id) => document.getElementById(id);
let data = null;

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
  render();
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
  if (status) parts.push({POTENTIAL: "Potential", NEEDS_REVIEW: "Review", CLAIMED: "Claimed", NO_CLAIM: "No claim"}[status]);
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
  const labels = {POTENTIAL: "Potential claim", NEEDS_REVIEW: "Needs review", CLAIMED: "✓ Claimed", NO_CLAIM: "No claim"};
  let actions = "";
  if (a.status === "POTENTIAL") actions += `<button onclick="claim('${encodedId}', false)">Mark as claimed</button>`;
  if (a.status === "CLAIMED") actions += `<button class="secondary" onclick="claim('${encodedId}', true)">Undo</button>`;
  if (a.claimUrl && ["POTENTIAL", "CLAIMED"].includes(a.status)) actions += `<a href="${esc(a.claimUrl)}" target="_blank" rel="noopener">Open claim page →</a>`;
  $("serviceDetail").innerHTML = `<p class="eyebrow">${esc(dayLabel(service.serviceDate))} · ${service.origin} → ${service.destination}</p><h2>${clock(service.scheduledDeparture)} · ${esc(service.operatorName)}</h2><span class="status ${a.status}">${labels[a.status]}</span><p class="reason">${esc(a.explanation)}</p><dl class="facts"><dt>Scheduled</dt><dd>${clock(service.scheduledDeparture)} → ${clock(service.scheduledArrival)}</dd><dt>Actual</dt><dd>${clock(service.actualDeparture)} → ${clock(service.actualArrival)}</dd><dt>Raw delay</dt><dd>${service.cancelled ? "Cancelled" : service.rawDelayMinutes == null ? "Unknown" : `${service.rawDelayMinutes} minutes`}</dd><dt>Effective delay</dt><dd>${a.effectiveDelayMinutes == null ? "Not determined" : `${a.effectiveDelayMinutes} minutes`}</dd><dt>Rule</dt><dd>${esc(a.ruleVersion)}</dd></dl><div class="actions">${actions}</div>${a.ruleSource ? `<p><a href="${esc(a.ruleSource)}" target="_blank" rel="noopener">Official rule source →</a></p>` : ""}`;
  $("serviceDialog").showModal();
}

async function claim(encodedId, undo) {
  const response = await fetch(`/api/services/${encodedId}/claim`, {method: undo ? "DELETE" : "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json();
  showNotice(response.ok ? result.message || "Updated." : result.error, !response.ok);
  if (response.ok) { $("serviceDialog").close(); await load(); }
}

function showNotice(message, error = false) { const notice = $("notice"); notice.hidden = false; notice.textContent = message; notice.style.background = error ? "#fee2e2" : "#e7f1ed"; }

async function openRefresh() {
  $("refreshPlan").textContent = "Checking what is missing…";
  $("confirmRefresh").disabled = true;
  $("refreshDialog").showModal();
  const response = await fetch("/api/refresh-plan?days=10"); const plan = await response.json();
  $("refreshPlan").innerHTML = `<strong>${plan.fetch.length} dates</strong> need collection (${plan.requestCount} RTT requests).<br>${plan.current.length} dates are already complete.${plan.uncatalogued.length ? `<br>${plan.uncatalogued.length} dates have no catalogue and will be skipped.` : ""}`;
  $("confirmRefresh").disabled = !plan.fetch.length;
}

async function startRefresh(event) {
  event.preventDefault(); $("confirmRefresh").disabled = true;
  const response = await fetch("/api/refresh", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({days: 10})});
  const job = await response.json(); $("refreshDialog").close();
  if (!response.ok) return showNotice(job.error, true);
  if (!job.id) return showNotice(job.message);
  showNotice(`${job.message} (0/${job.total})`); pollJob(job.id);
}

async function pollJob(id) {
  const response = await fetch(`/api/jobs/${id}`); const job = await response.json();
  showNotice(job.error || `${job.message} (${job.completed}/${job.total})`, job.status === "failed");
  if (["queued", "running"].includes(job.status)) setTimeout(() => pollJob(id), 1500); else if (job.status === "complete") load();
}

$("period").addEventListener("change", () => { const custom = $("period").value === "custom"; $("fromWrap").hidden = !custom; $("toWrap").hidden = !custom; if (!custom) load(); });
for (const id of ["fromDate", "toDate"]) $(id).addEventListener("change", load);
for (const id of ["direction", "operator", "status", "delay"]) $(id).addEventListener("change", render);
$("refreshButton").addEventListener("click", openRefresh);
$("confirmRefresh").addEventListener("click", startRefresh);
const initial = dateRange(10); $("fromDate").value = initial[0]; $("toDate").value = initial[1]; load();
