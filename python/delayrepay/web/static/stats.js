const pounds = pence => `£${(pence / 100).toFixed(2)}`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
const $ = id => document.getElementById(id);
const card = (value, label, note = "") => `<div class="stat-card"><strong>${esc(value)}</strong><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
const table = (head, rows, empty = "Not enough data yet.") => rows.length
  ? `<table class="stat-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr${r.cls ? ` class="${r.cls}"` : ""}>${r.cells.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<p class="empty compact">${esc(empty)}</p>`;
const rows = list => list.map(cells => ({cells}));
const bars = items => {
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="bars">${items.map(i => `<div class="bar-row"><span>${esc(i.label)}</span><div class="bar"><i style="width:${Math.round(100 * i.value / max)}%"></i></div><b>${esc(i.text)}</b></div>`).join("")}</div>`;
};
const section = (title, body, note = "") => `<section><h2>${esc(title)}</h2>${note ? `<p class="stat-note">${esc(note)}</p>` : ""}${body}</section>`;
const direction = d => d === "Morning" ? "Morning (MKC → EUS)" : "Evening (EUS → MKC)";

function render(s) {
  const m = s.money, c = s.claims;
  const operatorMoney = Object.entries(m.approvedByOperator || {}).map(([k, v]) => `${{VT: "Avanti", LM: "LNR"}[k] || k} ${pounds(v)}`).join(" · ");
  const months = Object.entries(m.byMonthPence || {});
  const missedTotal = s.missed.estimatePence;
  $("stats").innerHTML = `
    <section class="stat-grid">
      ${card(pounds(m.approvedPence), "Approved", `${m.approvedClaims} claims · ${operatorMoney}`)}
      ${card(pounds(m.paidPence), "Paid", `${m.paidClaims} claims`)}
      ${card(pounds(Math.max(0, m.approvedPence - m.paidPence)), "Approved, not yet marked paid", "may already be paid if the payment email predates tracking")}
      ${card(`${m.farePercent}%`, "Of your season ticket", `${pounds(m.approvedPence)} of ${pounds(m.farePence)}`)}
      ${card(c.successRatePercent == null ? "n/a" : `${c.successRatePercent}%`, "Claims approved", `${c.decided} decided of ${c.total}`)}
      ${card(c.averageDaysToDecision == null ? "n/a" : `${c.averageDaysToDecision} days`, "Time to a decision")}
      ${card(c.averageDaysToPayment == null ? "n/a" : `${c.averageDaysToPayment} days`, "Approval to payment")}
      ${card(pounds(missedTotal), "Possibly missed", `${s.missed.items.length} unclaimed late trains on your usual times (estimate)`)}
    </section>
    ${section("Deadline watch", table(["Date", "Direction", "Train", "Delay", "Days left", "Typical award"],
      s.deadlines.map(d => ({cls: d.daysLeft <= 5 ? "urgent-row" : "", cells: [d.date, d.direction, d.train, `${d.delay} min`, d.daysLeft, d.estimatePence ? pounds(d.estimatePence) : "-"]})),
      "Nothing unclaimed inside the 28-day window."), "Days with a train 15+ minutes late and no claim, soonest deadline first. Rows in red have 5 days or fewer.")}
    ${section("Possibly missed money", table(["Date", "Train", "Delay", "Days left", "Typical award"],
      s.missed.items.map(d => [d.date, d.train, `${d.delay} min`, d.daysLeft, d.estimatePence ? pounds(d.estimatePence) : "-"]).map(cells => ({cells})),
      "Nothing missed."), "Late trains at times you usually claim, on days with no claim. The amount is the typical award for that operator and band.")}
    ${section("Why claims were rejected", table(["Reason", "Claims"], rows(c.rejectionReasons.map(r => [r.reason, r.count])), "No rejections."))}
    ${section("Approval by delay band", table(["Delay", "Decided", "Approved", "Approval rate"], rows(c.byBand.map(b => [b.band, b.claims, b.approved, `${b.rate}%`]))))}
    ${section("Claims by operator", table(["Operator", "Approved", "Paid", "Rejected", "Submitted"], rows(Object.entries(c.byOperator).map(([k, v]) => [k, v.APPROVED || 0, v.PAID || 0, v.REJECTED || 0, v.SUBMITTED || 0]))))}
    ${section("Approved by month", months.length ? bars(months.map(([k, v]) => ({label: k, value: v, text: pounds(v)}))) : '<p class="empty compact">Nothing yet.</p>')}
    ${section("Trains you claim most", table(["Train", "Claims", "Approved", "Rejected", "Paid out"], rows(s.claimedTrains.map(r => [r.train, r.claims, r.approved, r.rejected, pounds(r.pencePaid)]))))}
    ${section("Trains late or cancelled most often", table(["Train", "Seen", "Late", "Cancelled", "Late rate", "Avg when late"],
      rows(s.lateTrains.map(r => [r.train, r.seen, r.late, r.cancelled, `${r.rate}%`, r.averageLate == null ? "-" : `${r.averageLate} min`]))), "Late means 15+ minutes. Only trains seen at least 3 times.")}
    ${Object.entries(s.heat).map(([d, list]) => section(`Reliability by departure time: ${direction(d)}`,
      list.length ? bars(list.map(x => ({label: x.slot, value: x.rate, text: `${x.rate}% of ${x.seen}`}))) : '<p class="empty compact">Not enough data yet.</p>',
      "Share of trains in each 15-minute slot that were 15+ minutes late or cancelled.")).join("")}
    ${section("Late or cancelled, by weekday", bars(s.lateByWeekday.map(d => ({label: d.day, value: d.rate || 0, text: d.seen ? `${d.rate}% of ${d.seen}` : "no data"}))))}
    ${section("Weekly trend", s.trend.length ? bars(s.trend.map(w => ({label: w.week.slice(5), value: w.rate, text: `${w.rate}% late${w.averageLate ? ` · avg ${w.averageLate} min` : ""}`}))) : '<p class="empty compact">Not enough weeks yet.</p>', "Week starting (Mon). Share of monitored trains late or cancelled.")}
    <p class="stat-note">Data covers ${esc(s.coverage.from || "—")} to ${esc(s.coverage.to || "—")}: ${s.coverage.days} days, ${s.coverage.trains} monitored trains. Amounts are only what the operators stated; estimates reuse past awards.</p>`;
}
fetch("/api/stats").then(r => r.json()).then(render).catch(e => { $("stats").innerHTML = `<p class="empty">Could not load stats: ${esc(e.message)}</p>`; });
