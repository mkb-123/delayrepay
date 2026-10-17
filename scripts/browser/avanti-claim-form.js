// Avanti West Coast Delay Repay claim driver (proven 15 Oct 2026 against
// https://delayrepay.avantiwestcoast.co.uk, an Angular Material app).
// Run on /en/ in a logged-in session. Element ids such as mat-input-3 change between
// page loads, so fields are found by position and label, never by id.
//
//   await awcClaim({ date: '2026-10-12', time: '18:16',
//     fromQuery: 'Euston', fromName: 'LONDON EUSTON',
//     toQuery: 'Milton Keynes', toName: 'MILTON KEYNES CENTRAL', delay: 30, submit: true })
//
// Account details, the saved season ticket and BACS payment are pre-filled by the portal.
// Without `submit` it stops on the review page. Resolves with the AWC- reference.
window.awcClaim = async (p) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const wait = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(200); } throw new Error('timeout waiting for ' + fn); };
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const fire = (e, evs = ['input', 'change', 'blur']) => evs.forEach(t => e.dispatchEvent(new Event(t, { bubbles: true })));
  const [y, mo, d] = p.date.split('-'); const dd = d + '/' + mo + '/' + y;
  const dateRe = /^\d{1,2}\/\d{1,2}\/\d{4}$/; // the portal shows 8/10/2026 or 08/10/2026
  const mainInputs = () => [...document.querySelectorAll('main input[type=text],main input:not([type])')].filter(vis);
  // 1. date: quick tile on the summary page, else the "Enter other date" box
  if (!location.pathname.includes('make-claim')) {
    const tile = [...document.querySelectorAll('mat-card')].find(c => vis(c) && new RegExp('^' + (+d) + '\\s+\\w{3}\\b').test(c.innerText.trim()));
    if (tile) tile.click();
    else {
      const lab = [...document.querySelectorAll('mat-label,label')].find(l => /Enter other date/i.test(l.innerText));
      // typed dates are rejected (ng-invalid); use the calendar and click the day (current month only)
      lab.closest('mat-form-field').querySelector('button').click(); await sleep(800);
      // step the calendar back to the target month (header reads like "SEP 2026")
      const monthWanted = new Date(+y, +mo - 1, 1).toLocaleString('en-GB', { month: 'short' }).toUpperCase() + ' ' + y;
      for (let k = 0; k < 3 && (document.querySelector('.mat-calendar-period-button') || {}).innerText?.trim().toUpperCase() !== monthWanted; k++) {
        document.querySelector('.mat-calendar-previous-button').click(); await sleep(400);
      }
      (await wait(() => [...document.querySelectorAll('.mat-calendar-body-cell')].find(c => vis(c) && c.innerText.trim() === String(+d) && !c.classList.contains('mat-calendar-body-disabled')))).click();
    }
    await wait(() => location.pathname.includes('make-claim'), 8000);
  }
  // 2. journey search: date box is followed by From, To, Time inputs
  const dateBox = await wait(() => mainInputs().find(i => dateRe.test(i.value)));
  if (dateBox.value.split('/').map(Number).join('/') !== [+d, +mo, +y].join('/')) return { ok: false, needs: 'date shows ' + dateBox.value + ' not ' + dd };
  const ins = mainInputs(); const k = ins.indexOf(dateBox); const [from, to, time] = [ins[k + 1], ins[k + 2], ins[k + 3]];
  const pick = async (inp, text, name) => {
    inp.focus(); inp.value = text; fire(inp, ['input']);
    (await wait(() => [...document.querySelectorAll('mat-option')].find(e => vis(e) && e.innerText.toUpperCase().includes(name)))).click(); await sleep(400);
  };
  await pick(from, p.fromQuery, p.fromName); await pick(to, p.toQuery, p.toName);
  time.focus(); time.value = p.time; fire(time); await sleep(300);
  document.getElementById('find-journey').click();
  const want = new RegExp(p.fromName + '\\s*arrow_downward\\s*' + p.toName + '\\s*' + p.time + '\\s*-', 'i');
  (await wait(() => [...document.querySelectorAll('mat-card')].find(c => vis(c) && want.test(c.innerText.replace(/\s+/g, ' '))))).click(); await sleep(1500);
  // 3. delay band
  const band = p.delay >= 120 ? '120 minutes or more' : p.delay >= 60 ? 'Between 60 - 119 minutes' : p.delay >= 30 ? 'Between 30 - 59 minutes' : 'Between 15 - 29 minutes';
  (await wait(() => [...document.querySelectorAll('main mat-card-title')].find(e => vis(e) && e.innerText.trim() === band))).click(); await sleep(1500);
  // 4. ticket: "more than one ticket?" = No, then click the saved season ticket card,
  //    which fills ticket type and payment and jumps to the review page
  (await wait(() => [...document.querySelectorAll('mat-radio-button')].find(r => vis(r) && r.innerText.trim() === 'No'))).querySelector('input').click(); await sleep(1200);
  (await wait(() => [...document.querySelectorAll('main mat-card')].find(c => vis(c) && /London Terminals/.test(c.innerText)))).click(); await sleep(1500);
  await wait(() => /Please review the provided claim information/.test(document.body.innerText));
  const rv = norm(document.querySelector('main').innerText); const m = s => (rv.match(s) || [])[1];
  const summary = { date: m(/Travel date (\S+)/), delay: m(/Delay duration (Between [\d -]+ Minutes|120 Minutes or more)/), method: m(/Method (\w+)/), ticket: m(/Ticket price (\S+)/) };
  if (p.submit) {
    [...document.querySelectorAll('main button')].find(b => vis(b) && /Submit claim/.test(b.innerText)).click();
    const done = await wait(() => location.pathname.includes('claim-confirmation') && document.body.innerText, 40000);
    return { ok: true, submitted: true, reference: (done.match(/AWC-[\d-]+/) || [])[0], ...summary };
  }
  return { ok: true, readyToSubmit: true, ...summary };
};
