const pounds = pence => `£${(pence / 100).toFixed(2)}`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
const $ = id => document.getElementById(id);
const OPERATORS = {VT: "Avanti", LM: "LNR"};

// Every chart ships a text table view, so nothing depends on colour or on hovering.
const tableView = (head, rows) => rows.length
  ? `<details class="tbl"><summary>Table view</summary><table class="t"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></details>` : "";
const card = (title, sub, body) => `<section class="card"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}${body}</section>`;
const tile = (value, label, note = "") => `<div class="tile"><strong>${esc(value)}</strong><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
const none = text => `<p class="empty-note">${esc(text)}</p>`;
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;

function segments(parts) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return none("No claims yet.");
  return `<div class="seg" role="img" aria-label="${esc(parts.map(p => `${p.label} ${p.value}`).join(", "))}">${parts.filter(p => p.value).map(p => `<i style="flex:${p.value};background:${p.color}" title="${esc(p.label)}: ${p.value}"></i>`).join("")}</div>
    <div class="legend">${parts.map(p => `<span style="--c:${p.color}">${esc(p.label)} ${p.value}</span>`).join("")}</div>`;
}

function rank(rows) {
  if (!rows.length) return none("Not enough data yet.");
  const max = Math.max(1, ...rows.map(r => r.total));
  return `<div class="rank">${rows.map(r => `<div class="rank-row"><span class="name">${esc(r.name)}</span>
    <div class="track" style="width:${Math.max(6, Math.round(100 * r.total / max))}%" title="${esc(r.title || "")}">${r.parts.filter(p => p.value).map(p => `<i style="flex:${p.value};background:${p.color}"></i>`).join("")}</div>
    <span class="meta">${esc(r.meta)}</span></div>`).join("")}</div>`;
}

function columns(items, unit = "%") {
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="cols">${items.map(i => `<div class="col" title="${esc(i.title || `${i.label}: ${i.value}${unit}`)}"><b>${esc(i.text ?? `${i.value}${unit}`)}</b><i style="height:${Math.max(2, Math.round(100 * i.value / max))}%"></i><span>${esc(i.label)}</span></div>`).join("")}</div>`;
}

function strip(list, maxRate) {
  if (!list.length) return none("Not enough data yet.");
  return `<div class="strip">${list.map(x => `<div class="cell" tabindex="0" role="img" aria-label="${esc(`${x.slot}: ${x.rate}% late or cancelled of ${x.seen} trains`)}" title="${esc(`${x.slot} · ${x.rate}% late or cancelled (${x.seen} trains)`)}" style="--a:${(0.1 + 0.9 * x.rate / maxRate).toFixed(2)}"></div>`).join("")}</div>
    <div class="ticks">${list.map(x => `<span>${x.slot.endsWith(":00") ? x.slot.slice(0, 2) : ""}</span>`).join("")}</div>`;
}

const when = date => new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {weekday: "short", day: "numeric", month: "short"});

function overview(s) {
  const m = s.money, c = s.claims, waiting = Math.max(0, m.approvedPence - m.paidPence);
  const alerts = s.deadlines.length ? s.deadlines.slice(0, 6).map(d => {
    const level = d.daysLeft <= 5 ? "urgent" : d.daysLeft <= 10 ? "soon" : "";
    return `<div class="alert ${level}"><span aria-hidden="true">${level === "urgent" ? "⚠" : "•"}</span>
      <div><div class="what">${esc(when(d.date))} · ${esc(d.train)} · ${d.delay} min late</div><div class="when">${d.estimatePence ? `Typical award ${pounds(d.estimatePence)}` : "No claim yet"}</div></div>
      <span class="pill">${d.daysLeft} day${d.daysLeft === 1 ? "" : "s"} left</span></div>`;
  }).join("") : none("Nothing unclaimed inside the 28-day window.");
  const outcomes = segments([
    {label: "Paid", value: c.byStatus.PAID || 0, color: "var(--good)"},
    {label: "Approved", value: c.byStatus.APPROVED || 0, color: "rgb(var(--seq) / .55)"},
    {label: "Waiting", value: c.byStatus.SUBMITTED || 0, color: "var(--neutral)"},
    {label: "Rejected", value: c.byStatus.REJECTED || 0, color: "var(--bad)"},
  ]);
  return `
    <section class="card hero"><div class="big">${pounds(m.approvedPence)}</div><div class="label">Approved compensation</div>
      <div class="line">${pounds(m.paidPence)} paid · ${pounds(waiting)} waiting for payment · ${m.approvedClaims} claims</div>
      <div class="progress" role="img" aria-label="${pct(m.paidPence, m.approvedPence)}% of approved money has been paid"><i style="width:${pct(m.paidPence, m.approvedPence)}%"></i></div>
      <div class="line">${m.farePercent}% of your ${pounds(m.farePence)} season ticket</div></section>
    <section class="tiles">
      ${tile(c.successRatePercent == null ? "n/a" : `${c.successRatePercent}%`, "Claims approved", `${c.decided} decided of ${c.total}`)}
      ${tile(c.averageDaysToDecision == null ? "n/a" : `${c.averageDaysToDecision} days`, "To a decision")}
      ${tile(c.averageDaysToPayment == null ? "n/a" : `${c.averageDaysToPayment} days`, "Approval to payment")}
      ${tile(pounds(s.missed.estimatePence), "Possibly missed", `${s.missed.items.length} unclaimed late trains at your usual times`)}
    </section>
    ${card("Needs action", "Days with a train 15+ minutes late and no claim, soonest deadline first.", alerts)}
    ${card("Where your claims stand", "", outcomes)}`;
}

function claims(s) {
  const c = s.claims, m = s.money;
  const reasons = c.rejectionReasons;
  const byOperator = Object.entries(c.byOperator).map(([name, v]) => ({
    name, total: (v.APPROVED || 0) + (v.PAID || 0) + (v.REJECTED || 0) + (v.SUBMITTED || 0),
    meta: `${(v.APPROVED || 0) + (v.PAID || 0)} approved · ${v.REJECTED || 0} rejected · ${v.SUBMITTED || 0} waiting`,
    parts: [{value: (v.PAID || 0) + (v.APPROVED || 0), color: "var(--good)"}, {value: v.SUBMITTED || 0, color: "var(--neutral)"}, {value: v.REJECTED || 0, color: "var(--bad)"}]}));
  const months = Object.entries(m.byMonthPence || {});
  return `
    ${card("Why claims were rejected", "What to avoid next time.", rank(reasons.map(r => ({name: r.reason, total: r.count, meta: `${r.count}`, parts: [{value: r.count, color: "var(--bad)"}]}))) + tableView(["Reason", "Claims"], reasons.map(r => [r.reason, r.count])))}
    ${card("Approval by delay band", "Claims with a decision, by how late the train was.", rank(c.byBand.map(b => ({name: b.band === "under 15" ? "Under 15 min" : b.band === "cancelled" ? "Cancelled" : `${b.band} min`, total: b.claims,
      meta: `${b.approved} of ${b.claims} approved (${b.rate}%)`, parts: [{value: b.approved, color: "var(--good)"}, {value: b.claims - b.approved, color: "var(--bad)"}]}))) + tableView(["Delay", "Decided", "Approved", "Rate"], c.byBand.map(b => [b.band, b.claims, b.approved, `${b.rate}%`])))}
    ${card("By operator", "", rank(byOperator) + tableView(["Operator", "Approved", "Rejected", "Waiting"], Object.entries(c.byOperator).map(([k, v]) => [k, (v.APPROVED || 0) + (v.PAID || 0), v.REJECTED || 0, v.SUBMITTED || 0])))}
    ${card("Approved money by month", "When each approval arrived.", months.length ? columns(months.map(([k, v]) => ({label: k.slice(2), value: v, text: pounds(v)})), "") + tableView(["Month", "Approved"], months.map(([k, v]) => [k, pounds(v)])) : none("Nothing approved yet."))}`;
}

function trains(s) {
  const claimed = s.claimedTrains.map(r => ({name: r.train, total: r.claims, meta: r.pencePaid ? pounds(r.pencePaid) : `${r.claims}×`,
    title: `${r.claims} claims: ${r.approved} approved, ${r.rejected} rejected`,
    parts: [{value: r.approved, color: "var(--good)"}, {value: r.rejected, color: "var(--bad)"}, {value: r.claims - r.approved - r.rejected, color: "var(--neutral)"}]}));
  const late = s.lateTrains.map(r => ({name: r.train, total: r.late + r.cancelled, meta: `${r.late + r.cancelled} of ${r.seen} · ${r.rate}%`,
    title: `${r.late} late, ${r.cancelled} cancelled of ${r.seen}${r.averageLate ? `, ${r.averageLate} min on average when late` : ""}`,
    parts: [{value: r.late + r.cancelled, color: "rgb(var(--seq))"}]}));
  const missed = s.missed.items.length ? s.missed.items.map(d => `<div class="alert ${d.daysLeft <= 5 ? "urgent" : ""}"><span aria-hidden="true">${d.daysLeft <= 5 ? "⚠" : "•"}</span>
      <div><div class="what">${esc(when(d.date))} · ${esc(d.train)} · ${d.delay} min late</div><div class="when">Typical award ${d.estimatePence ? pounds(d.estimatePence) : "unknown"}</div></div><span class="pill">${d.daysLeft} days left</span></div>`).join("") : none("Nothing missed at your usual times.");
  return `
    ${card("Trains you claim most", "Green approved · red rejected · grey waiting.", rank(claimed) + tableView(["Train", "Claims", "Approved", "Rejected", "Paid out"], s.claimedTrains.map(r => [r.train, r.claims, r.approved, r.rejected, pounds(r.pencePaid)])))}
    ${card("Late or cancelled most often", "Trains seen at least 3 times. Late means 15+ minutes.", rank(late) + tableView(["Train", "Seen", "Late", "Cancelled", "Rate"], s.lateTrains.map(r => [r.train, r.seen, r.late, r.cancelled, `${r.rate}%`])))}
    ${card("Possibly missed money", "Late trains at times you usually claim, on days with no claim. Awards are typical amounts, not promises.", missed)}`;
}

function patterns(s) {
  const all = [...(s.heat.Morning || []), ...(s.heat.Evening || [])];
  const maxRate = Math.max(1, ...all.map(x => x.rate));
  const heat = d => card(`${d === "Morning" ? "Morning, MKC → EUS" : "Evening, EUS → MKC"}`, "Darker = more often 15+ minutes late or cancelled (15-minute slots).",
    strip(s.heat[d] || [], maxRate) + `<div class="help">Hover or tab to a cell for the exact rate. Scale: 0% (pale) to ${maxRate}% (darkest).</div>` + tableView(["Slot", "Late or cancelled", "Trains"], (s.heat[d] || []).map(x => [x.slot, `${x.rate}%`, x.seen])));
  return `
    ${heat("Morning")}${heat("Evening")}
    ${card("By weekday", "Share of trains late or cancelled.", columns(s.lateByWeekday.map(d => ({label: d.day, value: d.rate || 0, title: d.seen ? `${d.day}: ${d.rate}% of ${d.seen} trains` : `${d.day}: no data`}))) + tableView(["Day", "Late or cancelled", "Trains"], s.lateByWeekday.map(d => [d.day, d.rate == null ? "-" : `${d.rate}%`, d.seen])))}
    ${card("Week by week", "Week starting Monday.", s.trend.length ? columns(s.trend.map(w => ({label: w.week.slice(5), value: w.rate, title: `Week of ${w.week}: ${w.rate}% late or cancelled${w.averageLate ? `, ${w.averageLate} min on average when late` : ""}`}))) + tableView(["Week of", "Late or cancelled", "Avg when late"], s.trend.map(w => [w.week, `${w.rate}%`, w.averageLate ? `${w.averageLate} min` : "-"])) : none("Not enough weeks yet."))}`;
}

function render(s) {
  $("stats").innerHTML = ["overview", "claims", "trains", "patterns"].map((name, i) => `<div class="pane" data-pane="${name}"${i ? " hidden" : ""}>${({overview, claims, trains, patterns})[name](s)}</div>`).join("")
    + `<p class="note">Data covers ${esc(s.coverage.from || "—")} to ${esc(s.coverage.to || "—")}: ${s.coverage.days} days, ${s.coverage.trains} monitored trains. Amounts are only what the operators stated; estimates reuse past awards.</p>`;
  const tabs = [...document.querySelectorAll(".stats-tabs button")];
  const show = name => {
    tabs.forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    document.querySelectorAll(".pane").forEach(p => { p.hidden = p.dataset.pane !== name; });
    try { localStorage.setItem("statsTab", name); } catch {}
  };
  tabs.forEach(t => t.addEventListener("click", () => show(t.dataset.tab)));
  try { const saved = localStorage.getItem("statsTab"); if (saved && tabs.some(t => t.dataset.tab === saved)) show(saved); } catch {}
}
fetch("/api/stats").then(r => r.json()).then(render).catch(e => { $("stats").innerHTML = none(`Could not load stats: ${e.message}`); });
