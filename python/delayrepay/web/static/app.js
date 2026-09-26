const $ = (id) => document.getElementById(id);
let data = null;

function isoDate(value) { return value ? value.slice(0, 10) : ""; }
function clock(value) { return value ? value.slice(11, 16) : "—"; }
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
  let html = "";
  for (const day of data.days) {
    const services = day.services.filter(s =>
      (!direction || s.direction === direction) &&
      (!operator || s.operatorName === operator) &&
      (!status || s.assessment.status === status) &&
      (delay === null || (s.rawDelayMinutes != null && s.rawDelayMinutes > delay))
    );
    if (!services.length) continue;
    html += `<article class="day"><div class="day-heading"><h2>${esc(day.date)}</h2><span>${day.sourceComplete ? "Complete" : "Incomplete collection"}</span></div>`;
    for (const routeDirection of ["MORNING", "EVENING"]) {
      const rows = services.filter(s => s.direction === routeDirection);
      if (!rows.length) continue;
      const route = rows[0];
      html += `<h3 class="route">${routeDirection === "MORNING" ? "Morning" : "Evening"} · ${route.origin} → ${route.destination}</h3><div class="cards">${rows.map(card).join("")}</div>`;
    }
    html += "</article>";
  }
  $("results").innerHTML = html || '<p class="empty">No stored services match these filters.</p>';
}

function card(service) {
  const a = service.assessment;
  const labels = {POTENTIAL: "Potential claim", NEEDS_REVIEW: "Needs review", CLAIMED: "✓ Claimed", NO_CLAIM: "No claim"};
  const delay = service.cancelled ? "Cancelled" : service.rawDelayMinutes == null ? "Unknown" : `${Math.max(0, service.rawDelayMinutes)} min`;
  const alternatives = a.alternativesConsidered?.length ? `<p><strong>Alternatives considered</strong></p><ul>${a.alternativesConsidered.map(x => `<li>${clock(x.actualDeparture)} ${esc(x.operator)} → ${clock(x.actualArrival)} (${x.estimatedDelayMinutes} min impact)</li>`).join("")}</ul>` : "<p>No applicable recorded alternative was found.</p>";
  let actions = "";
  if (a.status === "POTENTIAL") actions += `<button onclick="claim('${encodeURIComponent(service.serviceId)}', false)">Mark as claimed</button>`;
  if (a.status === "CLAIMED") actions += `<button class="secondary" onclick="claim('${encodeURIComponent(service.serviceId)}', true)">Undo</button>`;
  if (a.claimUrl && ["POTENTIAL", "CLAIMED"].includes(a.status)) actions += `<a href="${esc(a.claimUrl)}" target="_blank" rel="noopener">Claim with ${esc(a.ruleOperatorName)} →</a>`;
  return `<article class="card"><div class="card-top"><div><div class="train">${clock(service.scheduledDeparture)}</div><div class="operator">${esc(service.operatorName)}</div></div><div class="delay">${delay}</div></div><span class="status ${a.status}">${labels[a.status]}</span><details><summary>View details</summary><p>${esc(a.explanation)}</p><dl class="facts"><dt>Scheduled</dt><dd>${clock(service.scheduledDeparture)} → ${clock(service.scheduledArrival)}</dd><dt>Actual</dt><dd>${clock(service.actualDeparture)} → ${clock(service.actualArrival)}</dd><dt>Cancelled</dt><dd>${service.cancelled ? "Yes" : "No"}</dd><dt>Effective delay</dt><dd>${a.effectiveDelayMinutes == null ? "Not determined" : `${a.effectiveDelayMinutes} minutes`}</dd><dt>Rule</dt><dd>${esc(a.ruleVersion)}</dd></dl>${alternatives}${a.ruleSource ? `<p><a href="${esc(a.ruleSource)}" target="_blank" rel="noopener">Official rule source →</a> · verified ${esc(a.ruleVerifiedAt)}</p>` : ""}</details><div class="actions">${actions}</div></article>`;
}

async function claim(encodedId, undo) {
  const response = await fetch(`/api/services/${encodedId}/claim`, {method: undo ? "DELETE" : "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json();
  showNotice(response.ok ? result.message || "Updated." : result.error, !response.ok);
  if (response.ok) await load();
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
