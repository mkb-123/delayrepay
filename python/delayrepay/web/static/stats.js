const pounds = pence => `£${(pence / 100).toFixed(2)}`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
const card = (value, label, note = "") => `<div class="stat-card"><strong>${esc(value)}</strong><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
const table = (head, rows) => rows.length
  ? `<table class="stat-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : '<p class="empty compact">Not enough data yet.</p>';

function bars(items) {
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="bars">${items.map(i => `<div class="bar-row"><span>${esc(i.label)}</span><div class="bar"><i style="width:${Math.round(100 * i.value / max)}%"></i></div><b>${esc(i.text)}</b></div>`).join("")}</div>`;
}

function render(s) {
  const m = s.money, c = s.claims;
  const awaitingPayment = m.approvedPence - m.paidPence;
  const months = Object.entries(m.byMonthPence || {});
  const operatorMoney = Object.entries(m.approvedByOperator || {}).map(([k, v]) => `${{VT: "Avanti", LM: "LNR"}[k] || k} ${pounds(v)}`).join(" · ");
  const statusText = Object.entries(c.byStatus).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(", ");
  $("stats").innerHTML = `
    <section class="stat-grid">
      ${card(pounds(m.approvedPence), "Approved", `${m.approvedClaims} claims · ${operatorMoney}`)}
      ${card(pounds(m.paidPence), "Paid", `${m.paidClaims} claims`)}
      ${card(pounds(Math.max(0, awaitingPayment)), "Approved, not yet marked paid", "may already be paid if the payment email predates tracking")}
      ${card(pounds(m.expectedPendingPence), "Expected if pending claims are approved", `${m.expectedPendingClaims} pending, at the amounts stated`)}
      ${card(c.successRatePercent == null ? "n/a" : `${c.successRatePercent}%`, "Claims approved", `${c.decided} decided of ${c.total}`)}
      ${card(c.averageDaysToDecision == null ? "n/a" : `${c.averageDaysToDecision} days`, "Average time to a decision")}
    </section>
    <section><h2>Claims by outcome</h2><p class="stat-note">${esc(statusText || "none yet")}</p>
      ${table(["Operator", "Approved", "Paid", "Rejected", "Submitted"], Object.entries(c.byOperator).map(([k, v]) => [k, v.APPROVED || 0, v.PAID || 0, v.REJECTED || 0, v.SUBMITTED || 0]))}</section>
    <section><h2>Approved by month</h2>${months.length ? bars(months.map(([k, v]) => ({label: k, value: v, text: pounds(v)}))) : '<p class="empty compact">Nothing yet.</p>'}</section>
    <section><h2>Trains you claim most</h2>
      ${table(["Train", "Claims", "Approved", "Rejected", "Paid out"], s.claimedTrains.map(r => [r.train, r.claims, r.approved, r.rejected, pounds(r.pencePaid)]))}</section>
    <section><h2>Trains that are late or cancelled most often</h2>
      <p class="stat-note">Late means ${15}+ minutes. Only trains seen at least 3 times.</p>
      ${table(["Train", "Seen", "Late", "Cancelled", "Late rate", "Avg when late"], s.lateTrains.map(r => [r.train, r.seen, r.late, r.cancelled, `${r.rate}%`, r.averageLate == null ? "-" : `${r.averageLate} min`]))}</section>
    <section><h2>Late or cancelled, by weekday</h2>
      ${bars(s.lateByWeekday.map(d => ({label: d.day, value: d.rate || 0, text: d.seen ? `${d.rate}% of ${d.seen}` : "no data"})))}</section>
    <p class="stat-note">Data covers ${esc(s.coverage.from || "—")} to ${esc(s.coverage.to || "—")}: ${s.coverage.days} days, ${s.coverage.trains} monitored trains. Amounts are only what the operators stated.</p>`;
}
const $ = id => document.getElementById(id);
fetch("/api/stats").then(r => r.json()).then(render).catch(e => { $("stats").innerHTML = `<p class="empty">Could not load stats: ${esc(e.message)}</p>`; });
