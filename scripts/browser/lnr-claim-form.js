// LNR Delay Repay claim form driver (proven 15 Oct 2026 against
// https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=myclaims.add).
// Run in the page of a logged-in session. LNR hosts both London Northwestern Railway
// and West Midlands Railway trains; the "visit the West Midlands Trains website"
// notice on a train card is generic and can be ignored.
//
//   await lnrClaim({ date: '2026-10-07', time: '07:46',
//     fromQuery: 'Milton Keynes', fromName: 'MILTON KEYNES CENTRAL',
//     toQuery: 'Euston', toName: 'LONDON EUSTON', delay: 19, submit: true })
//
// Without `submit` it stops on the ticket step. Submitting reloads the page, so the
// return value is lost; read the reference from the top row of the My Claims table.
window.lnrClaim = async (p) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = e => e && e.offsetParent !== null;
  const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(150); } throw new Error('timeout waiting for ' + fn); };
  const fire = e => ['input', 'change', 'blur'].forEach(t => e.dispatchEvent(new Event(t, { bubbles: true })));
  const setSel = (id, v) => { const e = document.getElementById(id); e.value = v; fire(e); window.jQuery && jQuery(e).trigger('change'); };
  const station = async (id, query, name) => {
    const i = await wait(() => { const e = document.getElementById(id); return vis(e) && e; });
    i.focus(); i.value = query; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: query.slice(-1) }));
    const opt = await wait(() => [...document.querySelectorAll('[role=option],.ui-autocomplete li,ul.dropdown-menu li,.autocomplete-suggestion')].find(e => vis(e) && e.innerText.toUpperCase().includes(name)));
    opt.click(); await sleep(300);
  };
  const press = async re => { const b = await wait(() => [...document.querySelectorAll('button,a,input[type=submit]')].find(e => vis(e) && re.test((e.innerText || e.value || '').trim()))); b.click(); return b; };
  const norm = s => s.replace(/\s+/g, ' ').trim().toUpperCase();
  // 1. date: quick radio for the last five days, otherwise the Bootstrap datepicker (same month only)
  const radio = [...document.querySelectorAll('input[name=delay-date]')].find(r => r.value === p.date.replace(/-/g, '/'));
  if (radio && radio.id !== 'date5') { radio.click(); } else {
    document.getElementById('date5').click(); const dp = document.getElementById('datePickerValue'); dp.click(); dp.focus();
    const day = String(+p.date.slice(8));
    const td = await wait(() => [...document.querySelectorAll('.datepicker-days td.day')].find(e => !/old|new|disabled/.test(e.className) && e.innerText.trim() === day));
    td.click(); await sleep(300);
  }
  // 2. scheduled departure time
  const [h, m] = p.time.split(':'); setSel('txtScheduleTimeHour', h); setSel('txtScheduleTimeMinute', m);
  // 3. stations (pick from autocomplete)
  await station('txtBoardingStation', p.fromQuery, p.fromName);
  await station('txtDestinationStation', p.toQuery, p.toName);
  await press(/^continue$/i);
  // 4. choose the train by departure time and origin
  await wait(() => [...document.querySelectorAll('button')].some(b => /View this Journey/i.test(b.innerText)));
  const card = [...document.querySelectorAll('button')].filter(b => /View this Journey/i.test(b.innerText)).map(b => ({ b, c: b.closest('div').parentElement })).find(x => norm(x.c.innerText).startsWith(norm(p.time + ' ' + p.fromName)));
  if (!card) return { ok: false, needs: 'train ' + p.time + ' not listed' };
  card.b.click(); await sleep(500);
  [...card.c.querySelectorAll('a,button')].find(e => /Select This journey/i.test(e.innerText)).click();
  // 5. delay length (15+ below 30 minutes, 30+ otherwise) and type Delayed
  await wait(() => document.getElementById('txtDelayLength-11'));
  document.getElementById(p.delay >= 30 ? 'txtDelayLength-12' : 'txtDelayLength-11').click();
  document.getElementById('txtDelaytype-11').click(); await sleep(300);
  await press(/^continue$/i);
  // 6. ticket step (saved season ticket is preselected)
  await wait(() => [...document.querySelectorAll('button,a,input[type=submit]')].some(e => vis(e) && /Submit claim/i.test(e.innerText || e.value)));
  const t = document.getElementById('TicketID');
  const summary = { journey: norm(card.c.innerText).slice(0, 60), ticket: t.options[t.selectedIndex].text.slice(0, 30) };
  if (p.submit) {
    [...document.querySelectorAll('button,a,input[type=submit]')].find(e => vis(e) && /Submit claim/i.test(e.innerText || e.value)).click();
    const ok = await wait(() => /submitted successfully/i.test(document.body.innerText) && document.body.innerText, 20000);
    return { ok: true, submitted: true, reference: (ok.match(/Reference number is\s*(\S+)/i) || [])[1], ...summary };
  }
  return { ok: true, readyToSubmit: true, ...summary };
};
