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
const lifecycleCompact = {SUBMITTED: "Sent", APPROVED: "✓", REJECTED: "✕", PAID: "Paid", NEEDS_REVIEW: "?"};
const submissionLabels = {QUEUED: "Queued", PROCESSING: "Submitting", CALIBRATION_READY: "Approve form", SUBMITTED: "Submitted", NEEDS_LOGIN: "Login needed", NEEDS_ATTENTION: "Check needed", RETRY: "Queued"};
function lifecycleBadge(lifecycle, compact = false) {
  if (!lifecycle) return "";
  const label = (compact ? lifecycleCompact : lifecycleLabels)[lifecycle.status] || lifecycle.status;
  const detail = lifecycle.claim_reference ? `${label} · ${lifecycle.claim_reference}` : label;
  const ref = lifecycle.claim_reference ? ` <small class="claim-ref">${esc(lifecycle.claim_reference)}</small>` : "";
  return `<span class="claim-lifecycle lifecycle-${esc(lifecycle.status)}" title="${esc(detail)}">${esc(label)}${ref}</span>`;
}
// The rows that appear in the recommendations list and still need a decision: one train per day and
// direction, on days not marked Done, not already claimed or queued, and not yet judged likely rejected.
function toChoose() {
  return (data.days || []).filter(day => !day.acknowledgedAt).flatMap(day => day.recommendations || [])
    .filter(item => ["POTENTIAL", "NEEDS_REVIEW"].includes(item.status) && !item.claimLifecycle && !item.claimSubmission
      && !item.likelyRejected && !/not recorded/i.test(item.explanation || ""));
}
// Plain-language reason and next step for a queued claim that has stopped.
function queueReason(submission) {
  if (!submission) return "";
  if (isStuck(submission)) return "The laptop worker did not finish this. Press Retry.";
  const error = submission.lastError || submission.last_error || "";
  if (submission.state === "NEEDS_LOGIN") return "Sign in to this operator on the laptop: run claim-login.ps1, solve the CAPTCHA, then it sends by itself.";
  if (submission.state === "NEEDS_ATTENTION") {
    if (/no delay figure/i.test(error)) return "No timing data for this train, so the claim band is unknown. Claim by hand if you know the delay, or remove it.";
    if (/duplicate/i.test(error)) return "Looks already claimed on the operator site. Check it, then record it or retry.";
    return error.split(".")[0].slice(0, 120);
  }
  return "";
}
function relativeTime(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
// A claim leased by the worker but never finished (worker crashed or the laptop slept).
function isStuck(submission) {
  if (submission?.state !== "PROCESSING") return false;
  const started = Date.parse(submission.startedAt || submission.started_at || submission.updated_at || "");
  return Number.isFinite(started) && Date.now() - started > 30 * 60000;
}
function workerChip() {
  const seen = data.operations?.laptopWorkerLastSeen;
  const fresh = seen && Date.now() - Date.parse(seen) < 24 * 3600000;
  const text = seen ? `Laptop worker seen ${relativeTime(seen)}` : "Laptop worker has not connected yet";
  return `<span class="${fresh ? "health-ok" : "health-warn"}" title="Queued claims are collected when the laptop is on and signed in, about every 15 minutes.">${esc(text)}</span>`;
}
function sessionChips() {
  const sessions = Object.fromEntries((data.operations?.operatorSessions || []).map(item => [item.operator_code, item]));
  const names = {VT: "Avanti", LM: "LNR"};
  return ["VT", "LM"].map(code => {
    const session = sessions[code], ok = session?.status === "LOGIN_OK";
    const text = `${names[code]} ${ok ? "signed in" : session ? "signed out" : "not checked"}${session?.checked_at ? ` · ${relativeTime(session.checked_at)}` : ""}`;
    return `<span class="${ok ? "health-ok" : "health-warn"}" title="${esc(session?.explanation || "")}">${esc(text)}</span>`;
  }).join("");
}
function submissionBadge(submission) {
  if (!submission) return "";
  if (isStuck(submission)) return '<span class="claim-submission submission-NEEDS_ATTENTION">Stuck · retry</span>';
  const label = submissionLabels[submission.state] || submission.state;
  return `<span class="claim-submission submission-${esc(submission.state)}">${esc(label)}</span>`;
}
function claimDisplay(assessment) {
  if (assessment.claimLifecycle) {
    const state = assessment.claimLifecycle.status;
    return {state, label: lifecycleLabels[state] || state, badge: lifecycleBadge(assessment.claimLifecycle)};
  }
  if (assessment.claimSubmission) {
    const state = assessment.claimSubmission.state;
    return {state, label: submissionLabels[state] || state, badge: submissionBadge(assessment.claimSubmission)};
  }
  if (assessment.status === "CLAIMED") return {state: "MARKED_CLAIMED", label: "Marked claimed", badge: '<span class="claim-lifecycle lifecycle-MARKED_CLAIMED">Marked claimed</span>'};
  return {state: assessment.status, label: null, badge: ""};
}

function daysLeft(serviceDate) {
  const deadline = new Date(`${serviceDate}T12:00:00`); deadline.setDate(deadline.getDate() + 28);
  return Math.ceil((deadline - new Date()) / 86400000);
}
function deadlineText(serviceDate) {
  const left = daysLeft(serviceDate);
  return left < 0 ? `${-left}d overdue` : left === 0 ? "last day" : `${left}d left`;
}
function renderTodo() {
  const tracking = data.operations?.claimTracking || [];
  const items = [];
  const ready = tracking.filter(s => s.claimSubmission?.state === "CALIBRATION_READY");
  const login = tracking.filter(s => s.claimSubmission?.state === "NEEDS_LOGIN");
  const check = tracking.filter(s => s.claimSubmission?.state === "NEEDS_ATTENTION" || isStuck(s.claimSubmission));
  const review = data.operations?.emailReview?.length || 0;
  const potential = toChoose().length;
  const add = (kind, count, text, action) => count && items.push(`<button class="todo-item todo-${kind}" onclick="${action}"><strong>${count}</strong><span>${text}</span></button>`);
  add("claim", potential, `claim${potential === 1 ? "" : "s"} to choose`, "document.getElementById('recommendations').scrollIntoView({behavior:'smooth'})");
  add("ready", ready.length, "claim ready to approve", `showTrackedClaim('${ready[0] ? encodeURIComponent(ready[0].serviceId) : ""}')`);
  add("warn", login.length, "need a login (run claim-login.ps1 on the laptop)", "document.getElementById('systemPanel').open = true");
  add("warn", check.length, "need a check", `showTrackedClaim('${check[0] ? encodeURIComponent(check[0].serviceId) : ""}')`);
  add("email", review, `email${review === 1 ? "" : "s"} to match`, "openEmailReview()");
  $("todo").innerHTML = items.length ? `<h2>To do now</h2><div class="todo-list">${items.join("")}</div>` : '<p class="todo-clear">✓ Nothing needs you right now.</p>';
  const problems = login.length + check.length + (data.operations?.lastCollection ? 0 : 1) + (data.operations?.gmailConfigured ? 0 : 1);
  $("systemSummary").textContent = problems ? `${problems} issue${problems === 1 ? "" : "s"}` : "All OK";
  $("systemPanel").classList.toggle("has-issues", problems > 0);
}

async function load() {
  const period = $("period").value;
  let from, to;
  if (period === "all") [from, to] = ["2000-01-01", isoDate(new Date().toISOString())];
  else if (period === "custom") [from, to] = [$("fromDate").value, $("toDate").value];
  else [from, to] = dateRange(Number(period));
  if (!from || !to) return;
  let response;
  try {
    response = await fetch(`/api/dashboard?from=${from}&to=${to}`);
    const body = await response.json();
    if (!response.ok) return showNotice(body.error || "Could not load data.", true, true);
    data = body;
  } catch (error) {
    return showNotice("Can't reach the dashboard server. Check the Pi is online.", true, true);
  }
  const operators = new Set(data.days.flatMap(day => day.services.map(service => service.operatorName)));
  const selected = $("operator").value;
  $("operator").innerHTML = '<option value="">All</option>' + [...operators].sort().map(value => `<option ${value === selected ? "selected" : ""}>${esc(value)}</option>`).join("");
  renderTodo();
  renderHealth();
  renderOperatorHealth();
  renderClaimPipeline();
  renderRecommendations();
  render();
}

function renderOperatorHealth() {
  const sessions = Object.fromEntries((data.operations?.operatorSessions || []).map(item => [item.operator_code, item]));
  const calibrated = data.operations?.operatorCalibrated || {};
  const names = {VT: "Avanti", LM: "LNR"};
  const cards = ["VT", "LM"].map(code => {
    const session = sessions[code];
    const healthy = session?.status === "LOGIN_OK";
    const state = healthy ? "Signed in" : session?.status === "LOGIN_NEEDED" ? "Signed out" : session ? "Check failed" : "Not checked";
    const hint = healthy ? "" : "<br>Run claim-login.ps1 on the laptop.";
    return `<article class="operator-card ${healthy ? "ready" : "warning"}"><strong>${names[code]}</strong><span>${state}</span><small>${session?.checked_at ? `Checked ${relativeTime(session.checked_at)}` : "Never checked"}${session?.explanation && !healthy ? ` · ${esc(session.explanation)}` : ""}${hint}</small></article>`;
  }).join("");
  $("operatorHealth").innerHTML = `${cards}<p class="empty compact">${workerChip()} The laptop checks each login daily.</p>`;
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
  const services = data.operations?.claimTracking || [];
  const active = services.filter(service => service.claimSubmission && !["SUBMITTED"].includes(service.claimSubmission.state));
  const awaiting = services.filter(service => ["SUBMITTED", "NEEDS_REVIEW"].includes(service.claimLifecycle?.status));
  const complete = services.filter(service => ["APPROVED", "PAID", "REJECTED"].includes(service.claimLifecycle?.status));
  const badge = service => lifecycleBadge(service.claimLifecycle) || submissionBadge(service.claimSubmission) || '<span class="claim-lifecycle lifecycle-SUBMITTED">Marked claimed</span>';
  const cards = rows => rows.map(service => `<button class="pipeline-card" onclick="showTrackedClaim('${encodeURIComponent(service.serviceId)}')"><strong>${dayLabel(service.serviceDate)} · ${clock(service.scheduledDeparture)}</strong><span>${esc(service.operatorName)}</span>${badge(service)}${queueReason(service.claimSubmission) ? `<small class="queue-reason">${esc(queueReason(service.claimSubmission))}</small>` : ""}</button>`).join("");
  $("claimPipeline").innerHTML = `<div class="section-heading"><h2>Claim queue</h2><div class="worker-status">${workerChip()}${sessionChips()}</div></div>${active.length ? `<div class="pipeline-grid">${cards(active)}</div>` : '<p class="empty compact">Nothing queued.</p>'}${awaiting.length ? `<details class="completed-claims" open><summary>${awaiting.length} awaiting operator</summary><div class="pipeline-grid">${cards(awaiting)}</div></details>` : ""}${complete.length ? `<details class="completed-claims"><summary>${complete.length} completed claim${complete.length === 1 ? "" : "s"}</summary><div class="pipeline-grid">${cards(complete)}</div></details>` : ""}`;
}

async function showTrackedClaim(encodedId) {
  const id = decodeURIComponent(encodedId);
  const loaded = data.days.flatMap(day => day.services).some(service => service.serviceId === id);
  if (!loaded) {
    $("period").value = "all";
    await load();
  }
  showService(encodedId);
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
      const claim = claimDisplay(item);
      const assessmentLabel = item.likelyRejected ? "Likely rejected" : item.status === "POTENTIAL" ? "Claim" : item.status === "CLAIMED" ? "Marked claimed" : "Decide";
      const label = claim.label || assessmentLabel;
      // A journey that has already run but has no timing data cannot be claimed reliably: flag it.
      const noData = item.effectiveDelayMinutes == null && !item.claimLifecycle && Date.parse(item.scheduledDeparture) < Date.now() - 2 * 3600000;
      const detail = item.effectiveDelayMinutes == null ? (noData ? `${label} · <span class="no-data">no timing data</span>` : label) : `${item.effectiveDelayMinutes} min · ${label}`;
      const preference = item.preferredClaimedTime ? " · claimed time" : "";
      const left = deadlineText(day.date);
      const urgent = daysLeft(day.date) <= 5 ? " urgent" : "";
      const canClaim = ["POTENTIAL", "NEEDS_REVIEW"].includes(item.status) && !item.claimLifecycle && !item.claimSubmission && !item.likelyRejected;
      const quick = canClaim ? `<button class="quick-claim" onclick="quickClaim(this, '${encodeURIComponent(item.serviceId)}')">Claim</button>` : "";
      html += `<div class="recommend-row ${item.status}${item.likelyRejected ? " likely-rejected" : ""} claim-state-${claim.state}"><button class="row-main" onclick="showService('${encodeURIComponent(item.serviceId)}')"><strong>${route} · ${clock(item.scheduledDeparture)}</strong><span>${esc(item.operatorName)} · ${detail}${preference}</span>${claim.badge}<small class="deadline${urgent}">${left}</small></button>${quick}</div>`;
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
  $("potentialCount").textContent = toChoose().length;
  const tracking = data.operations?.claimTracking || [];
  $("queuedCount").textContent = tracking.filter(s => ["QUEUED", "RETRY", "PROCESSING", "CALIBRATION_READY"].includes(s.claimSubmission?.state)).length;
  $("attentionCount").textContent = tracking.filter(s => ["NEEDS_LOGIN", "NEEDS_ATTENTION"].includes(s.claimSubmission?.state) || isStuck(s.claimSubmission)).length;
  $("awaitingCount").textContent = tracking.filter(s => ["SUBMITTED"].includes(s.claimLifecycle?.status)).length;
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
  const submission = a.claimSubmission;
  const canQueue = ["POTENTIAL", "NEEDS_REVIEW", "CLAIMED"].includes(a.status) && !a.claimLifecycle && !submission;
  if (canQueue) actions += `<button onclick="queueSubmission('${encodedId}', false)">Claim this train</button>`;
  if (a.status === "POTENTIAL") actions += `<button class="secondary" onclick="claim('${encodedId}', false)">Mark as already claimed</button>`;
  if (a.status === "NEEDS_REVIEW") actions += `<button class="secondary" onclick="claim('${encodedId}', false)">Mark as already claimed</button><button class="secondary" onclick="notClaimable('${encodedId}', false)">Not claimable</button>`;
  if (a.status === "CLAIMED") actions += `<button class="secondary" onclick="claim('${encodedId}', true)">Undo</button>`;
  if (submission?.state === "CALIBRATION_READY") actions += `<button onclick="confirmCalibration('${encodedId}')">Approve form & submit</button>`;
  if (["NEEDS_LOGIN", "NEEDS_ATTENTION"].includes(submission?.state) || isStuck(submission)) actions += `<button onclick="retrySubmission('${encodedId}')">Retry</button>`;
  if (submission && (!["SUBMITTED", "PROCESSING"].includes(submission.state) || isStuck(submission))) actions += `<button class="secondary" onclick="queueSubmission('${encodedId}', true)">Remove from queue</button>`;
  if (a.notClaimableAt) actions += `<button class="secondary" onclick="notClaimable('${encodedId}', true)">Undo not claimable</button>`;
  if (a.claimUrl && ["POTENTIAL", "NEEDS_REVIEW", "CLAIMED"].includes(a.status)) actions += `<a href="${esc(a.claimUrl)}" target="_blank" rel="noopener">Open claim page →</a>`;
  const lifecycle = a.claimLifecycle;
  const lifecycleFacts = lifecycle ? `<dt>Operator claim</dt><dd>${lifecycleBadge(lifecycle)}${lifecycle.claim_reference ? ` <button class="copy-reference secondary" onclick="copyReference(decodeURIComponent('${encodeURIComponent(lifecycle.claim_reference)}'))">Copy reference</button>` : ""}<br>${esc(lifecycle.explanation)}</dd>` : "";
  const screenshot = submission?.screenshot_path ? ` <a href="/api/claim-screenshots/${encodeURIComponent(submission.screenshot_path)}" target="_blank">View screenshot</a>` : "";
  const submissionFacts = submission ? `<dt>Automatic claim</dt><dd>${submissionBadge(submission)}${submission.claim_reference ? ` · ${esc(submission.claim_reference)}` : ""}${submission.last_step ? `<br>Stopped at: ${esc(submission.last_step)}` : ""}${submission.last_error ? `<br>${esc(submission.last_error)}` : ""}${screenshot}</dd>` : "";
  $("serviceDetail").innerHTML = `<p class="eyebrow">${esc(dayLabel(service.serviceDate))} · ${service.origin} → ${service.destination}</p><h2>${clock(service.scheduledDeparture)} · ${esc(service.operatorName)}</h2><span class="status ${a.status}">${labels[a.status]}</span><p class="reason">${esc(a.explanation)}</p><dl class="facts"><dt>Scheduled</dt><dd>${clock(service.scheduledDeparture)} → ${clock(service.scheduledArrival)}</dd><dt>Actual</dt><dd>${clock(service.actualDeparture)} → ${clock(service.actualArrival)}</dd><dt>Raw delay</dt><dd>${service.cancelled ? "Cancelled" : service.rawDelayMinutes == null ? "Unknown" : `${service.rawDelayMinutes} minutes`}</dd><dt>Effective delay</dt><dd>${a.effectiveDelayMinutes == null ? "Not determined" : `${a.effectiveDelayMinutes} minutes`}</dd><dt>Claim by</dt><dd>${claimDeadline(service.serviceDate)}</dd>${submissionFacts}${lifecycleFacts}<dt>Rule</dt><dd>${esc(a.ruleVersion)}</dd></dl><div class="actions">${actions}</div>${a.ruleSource ? `<p><a href="${esc(a.ruleSource)}" target="_blank" rel="noopener">Official rule source →</a></p>` : ""}`;
  $("serviceDialog").showModal();
}

function claimDeadline(serviceDate) {
  const deadline = new Date(`${serviceDate}T12:00:00`); deadline.setDate(deadline.getDate() + 28);
  const remaining = Math.ceil((deadline - new Date()) / 86400000);
  return `${dayLabel(isoDate(deadline.toISOString()))} · ${remaining >= 0 ? `${remaining} days left` : `${Math.abs(remaining)} days overdue`}`;
}

async function quickClaim(button, encodedId) {
  button.disabled = true; button.textContent = "Queuing…";
  try {
    const response = await fetch(`/api/services/${encodedId}/submission`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
    const result = await response.json();
    showNotice(response.ok ? result.message || "Claim queued." : result.error, !response.ok);
    if (response.ok) await load(); else { button.disabled = false; button.textContent = "Claim"; }
  } catch (error) {
    showNotice("Request failed. Check the connection and try again.", true);
    button.disabled = false; button.textContent = "Claim";
  }
}

async function postAction(url, success) {
  const response = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json(); showNotice(response.ok ? result.message || success : result.error, !response.ok);
  if (response.ok) { $("serviceDialog").close(); await load(); }
}
function confirmCalibration(encodedId) { return postAction(`/api/services/${encodedId}/submission/confirm-calibration`, "Submission approved and queued."); }
function retrySubmission(encodedId) { return postAction(`/api/services/${encodedId}/submission/retry`, "Claim queued again."); }

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

async function queueSubmission(encodedId, undo) {
  const response = await fetch(`/api/services/${encodedId}/submission`, {method: undo ? "DELETE" : "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json();
  showNotice(response.ok ? result.message : result.error, !response.ok);
  if (response.ok) { $("serviceDialog").close(); await load(); }
}

async function notClaimable(encodedId, undo) {
  const response = await fetch(`/api/services/${encodedId}/not-claimable`, {method: undo ? "DELETE" : "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  const result = await response.json();
  showNotice(response.ok ? (undo ? "Decision restored." : "Marked as not claimable.") : result.error, !response.ok);
  if (response.ok) { $("serviceDialog").close(); await load(); }
}

let noticeTimer = null;
function showNotice(message, error = false, retry = false) {
  const notice = $("notice"); notice.hidden = false; notice.textContent = message;
  notice.classList.toggle("error", error);
  clearTimeout(noticeTimer);
  if (retry) { const button = document.createElement("button"); button.textContent = "Retry"; button.onclick = () => { notice.hidden = true; load(); }; notice.append(" ", button); return; }
  if (!error) noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function latestWeekday() {
  return isoDate(new Date().toISOString());
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
  $("operationPlan").innerHTML = `<strong>${count} day${count === 1 ? "" : "s"}</strong> · ${plan.requestCount} RTT requests.${extras}`;
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
