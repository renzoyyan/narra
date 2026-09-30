// Narra main window. The timesheet lives in the Rust side (store.json); this file renders
// it, runs onboarding, edits days, builds PDFs, and (in sheet mode) keeps the Google Sheet
// in step. Time math and pay rules are in shared.js, the PDF in pdf.js.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const SHEET_SYNC_EVERY_MS = 2 * 60 * 1000;

let view = null;             // see View in main.rs
let holidayLists = {};       // year -> [{ date, name, official, enabled }]
let selectedPeriod = null;   // Timesheets: period start date
let holidayYear = null;
let busy = false;
let syncing = false;
let holidayArmed = false;    // second click needed to clock in on a holiday
let lastTray = null;
let editing = null;          // date open in the day editor
let justSaved = null;        // date to highlight after an edit

const holidays = () => holidayMap(Object.values(holidayLists));
const today = (now = Date.now()) => todayState(view, holidays(), now);
const sheetMode = () => view && view.mode === 'sheet';
/**
 * Run fn while `button` shows `label` and is disabled; a second click while it runs is
 * ignored instead of queueing another run.
 */
async function working(button, label, fn) {
  if (!button || button.dataset.busy) return;
  const text = button.textContent;
  button.dataset.busy = '1';
  button.disabled = true;
  button.classList.add('busy');
  button.textContent = label;
  try {
    return await fn();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.classList.remove('busy');
    button.textContent = text;
  }
}

/**
 * Background work shown in the sidebar above the clocks (e.g. importing history), so the
 * app stays usable while it runs. Returns { update(text), done(text), fail(text) }.
 */
function activity(text) {
  const box = $('activity');
  const item = document.createElement('div');
  item.className = 'activity-item running';
  item.innerHTML = '<span class="dot"></span><span class="text"></span>';
  const label = item.querySelector('.text');
  label.textContent = text;
  box.append(item);
  const finish = (cls, msg, ms) => {
    item.className = 'activity-item ' + cls;
    label.textContent = msg;
    setTimeout(() => { item.classList.add('leaving'); setTimeout(() => item.remove(), 400); }, ms);
  };
  return {
    update: msg => { label.textContent = msg; },
    done: msg => finish('done', msg, 5000),
    fail: msg => finish('failed', msg, 9000),
  };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Rendering: Today ----

function renderClocks(now) {
  $('clockEt').textContent = fmt(now, { hour: 'numeric', minute: '2-digit' });
  $('clockPh').textContent = fmt(now, { hour: 'numeric', minute: '2-digit' }, PH);
}

function renderSyncLine() {
  const line = $('syncLine');
  let text = 'Saved on this Mac';
  let warn = false;
  if (sheetMode()) {
    if (syncing) text = 'Syncing with your sheet…';
    else if (view.sync_error) { text = 'Sheet sync problem'; warn = true; }
    else if (view.unsynced) { text = `${view.unsynced} change${view.unsynced > 1 ? 's' : ''} waiting for the sheet`; warn = true; }
    else if (view.synced_at) text = 'Sheet synced ' + fmt(view.synced_at, { hour: 'numeric', minute: '2-digit' }, PH);
    else text = 'Not synced yet';
  }
  line.textContent = text;
  line.classList.toggle('warn', warn);

  const banner = $('syncBanner');
  banner.hidden = !(sheetMode() && view.sync_error);
  banner.textContent = sheetMode() && view.sync_error
    ? `Couldn't sync with your Google Sheet: ${view.sync_error} Your time is safe on this Mac and will sync when this is fixed.`
    : '';
}

function renderToday(now = Date.now()) {
  if (!view) return;
  const t = today(now);

  $('todayTitle').textContent = fmt(now, { weekday: 'long', month: 'long', day: 'numeric' });

  const state = $('heroState');
  if (t.open) {
    state.textContent = `Working · since ${clock(t.since)} New York (${clock(t.since, PH)} Manila)`;
    state.className = 'state on';
  } else if (t.leave) {
    state.textContent = 'On leave';
    state.className = 'state holiday';
  } else if (t.holiday) {
    state.textContent = 'Holiday' + (t.holidayName ? ' · ' + t.holidayName : '');
    state.className = 'state holiday';
  } else {
    state.textContent = t.sessions.length ? 'On a break' : 'Off the clock';
    state.className = 'state';
  }
  $('timer').textContent = duration(t.runningMs);

  const btn = $('punchBtn');
  btn.disabled = busy;
  btn.textContent = t.open ? 'Time Out' : holidayArmed ? 'Time In anyway' : 'Time In';
  btn.classList.toggle('out', t.open);
  $('forgotBtn').textContent = `Forgot to ${t.open ? 'time out' : 'time in'}? Set the time`;
  $('forgotBtn').disabled = busy;
  $('forgotLabel').textContent = `I actually ${t.open ? 'timed out' : 'timed in'} at`;
  $('forgotSave').textContent = t.open ? 'Time Out' : 'Time In';
  $('forgotSave').disabled = busy;

  let note = `Today ${hours(t.hours)} hrs`;
  if (overThreshold(view, t)) note = `You've passed ${hours(view.remind_hours).replace(/\.00$/, '')} hrs today. Time out when you're done.`;
  if ((t.holiday || t.leave) && !t.open) {
    note = holidayArmed ? 'Clocking in replaces the 8-hour credit with your actual hours.' : `${hours(t.hours)} hrs credited`;
  }
  $('heroNote').textContent = note;

  // Only touch the box when the note changed: fitNote forces a layout.
  const noteBox = $('todayNote');
  const saved = noteFor(view, t.key);
  if (!noteEditing && noteBox.value !== saved) {
    noteBox.value = saved;
    fitNote(noteBox);
  }

  const entries = $('entries');
  entries.innerHTML = '';
  for (const s of t.sessions) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${clock(s.start)}</span><span>→</span><span>${s.end ? clock(s.end) : 'now'}</span>`;
    entries.append(li);
  }

  renderStats(t, now);
  updateTray(t);
  reminderTick(invoke, view, t);
}

function renderStats(t, now) {
  const H = holidays();
  $('statToday').textContent = hours(t.hours);

  // Week (Mon–Sun, New York dates), today live.
  const monday = addDays(t.key, -((weekday(t.key) + 6) % 7));
  let week = 0;
  for (let i = 0; i < 7; i++) {
    const k = addDays(monday, i);
    week += k === t.key ? t.hours : dayInfo(view, k, H, now).hours;
  }
  $('statWeek').textContent = hours(week);
  $('statWeekHint').textContent = `hours · ${prettyDate(monday, { month: 'short', day: 'numeric' })}–${prettyDate(addDays(monday, 6), { month: 'short', day: 'numeric' })}`;

  const period = buildPeriod(view, t.key, H, now);
  const { logged, expectedToDate, expectedTotal } = periodProgress(period, t.key);
  const diff = logged - expectedToDate;
  $('statPeriod').textContent = hours(logged);
  $('statPeriodHint').innerHTML =
    `of ${expectedTotal} hrs · ${diff >= 0 ? '+' : ''}${hours(diff)} vs pace` +
    `<div class="meter"><span style="width:${Math.min(100, (logged / expectedTotal) * 100)}%"></span></div>`;
  const rate = view.monthly_rate;
  const p = payFor(period, logged, rate);
  $('statPay').textContent = rate ? money(p.pay) : '—';
  $('statPayHint').textContent = !rate
    ? 'Set your monthly rate in Settings'
    : p.overtime > 0 ? `incl. ${hours(p.overtime)} OT hrs × ${money(p.otRate)}` : `${hours(p.regular)} of ${p.required} regular hrs`;
  renderChart(period, t);
  renderFormula($('todayFormula'), period, true);
}

function renderChart(period, t) {
  const chart = $('chart');
  chart.innerHTML = '';
  $('chartTitle').textContent = `This period · ${period.title}`;
  const max = Math.max(10, ...period.days.map(d => d.hours));
  const plot = document.createElement('div');
  plot.className = 'plot';
  plot.innerHTML = `<div class="line" style="bottom:${(8 / max) * 100}%"></div>`;
  const labels = document.createElement('div');
  labels.className = 'labels';
  for (const d of period.days) {
    const credit = d.type === 'holiday' || d.type === 'leave';
    const cls = (credit ? ' holiday' : '') + (d.weekend ? ' weekend' : '') + (d.hours === 0 ? ' empty' : '') +
      (d.date > t.key ? ' future' : '') + (d.date === t.key ? ' today' : '');
    const bar = document.createElement('div');
    bar.className = 'bar' + cls;
    bar.title = `${d.label}: ${hours(d.hours)} hrs${credit ? ` (${d.type})` : ''}`;
    bar.innerHTML = `<div class="fill" style="height:${(d.hours / max) * 100}%"></div>`;
    plot.append(bar);
    const label = document.createElement('div');
    label.className = 'day' + cls;
    label.textContent = Number(d.date.slice(8));
    labels.append(label);
  }
  chart.append(plot, labels);
}

/** The pay formula written out with this period's real numbers. */
function renderFormula(details, period, live) {
  const body = details.querySelector('.formula-body');
  const rate = view.monthly_rate;
  const weekdays = period.days.filter(d => !d.weekend).length;
  const credits = period.days.filter(d => d.type === 'leave' || d.type === 'holiday');
  const p = payFor(period, period.total, rate);
  const over = period.total > p.required;
  const line = (label, math, result) =>
    `<div class="f-row"><div class="f-label">${label}</div><div class="f-math">${math}</div><div class="f-result">${result}</div></div>`;
  body.innerHTML =
    line('Hours each day', 'time out − time in, for each pair, to the minute' +
      (credits.length ? ` · leave &amp; holidays count ${HOURS_PER_DAY}` : ''), '') +
    line('Hours this period', `sum of ${period.days.length} days${live ? ' (today counts live)' : ''}` +
      (credits.length ? `, incl. ${credits.length} leave/holiday day${credits.length > 1 ? 's' : ''}` : ''), `${hours(period.total)} h`) +
    line('Required hours', `${HOURS_PER_DAY} h × ${weekdays} weekdays (Mon–Fri)`, `${p.required} h`) +
    line('Regular hours', `smaller of ${hours(period.total)} and ${p.required}`, `${hours(p.regular)} h`) +
    line('Overtime hours', over ? `${hours(period.total)} − ${p.required}` : `${hours(period.total)} is not above ${p.required}, so`, `${hours(p.overtime)} h`) +
    (rate
      ? line('Overtime rate', `${OVERTIME_MULTIPLIER} × (${money(rate)} ÷ ${HOURS_PER_MONTH})`, `${money(p.otRate)}/h`) +
        line('<b>Expected pay</b>', `${money(rate)} ÷ 2 + ${money(p.otRate)} × ${hours(p.overtime)}` +
          ` = ${money(rate / 2)} + ${money(p.otRate * p.overtime)}`, `<b>${money(p.pay)}</b>`)
      : line('<b>Expected pay</b>', 'add your monthly rate in Settings', '—')) +
    `<p class="muted small">Same rules as the Google Sheets timesheet template. Pay is half the monthly rate per period ` +
    `plus overtime; it isn't reduced when hours are under the required amount.</p>`;
}

function renderUpcoming() {
  const key = dateKey(Date.now());
  const list = Object.values(holidayLists).flat()
    .filter(h => h.enabled && h.date >= key)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
  const ul = $('upcoming');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="muted">Nothing upcoming.</li>';
    return;
  }
  for (const h of list) {
    const days = daysBetween(key, h.date);
    const li = document.createElement('li');
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    li.innerHTML = `<span class="date">${prettyDate(h.date, { month: 'short', day: 'numeric' })}</span><span class="name"></span>` +
      `<span class="badge ${days <= 7 ? 'soon' : ''}">${isWeekend(h.date) ? 'weekend' : when}</span>`;
    li.querySelector('.name').textContent = h.name;
    ul.append(li);
  }
}

// ---- Rendering: Timesheets ----

function renderTimesheets() {
  if (!view) return;
  const now = Date.now();
  const key = dateKey(now);
  const periods = allPeriods(view, holidays(), now);
  if (!selectedPeriod || !periods.find(p => p.id === selectedPeriod)) selectedPeriod = periods[0].id;

  const chips = $('periodChips');
  chips.innerHTML = '';
  for (const p of periods) {
    const b = document.createElement('button');
    b.className = p.id === selectedPeriod ? 'active' : '';
    b.textContent = p.title;
    b.onclick = () => { selectedPeriod = p.id; renderTimesheets(); };
    chips.append(b);
  }

  const period = periods.find(p => p.id === selectedPeriod);
  const live = period.start <= key && key <= period.end;
  $('sheetTitle').textContent = period.title;
  $('sheetSub').textContent = `${period.periodText}${live ? ' · current period' : ''}`;
  $('openSheetBtn').hidden = !(sheetMode() && view.sheet_url);
  $('openSheetBtn').onclick = () => openUrl(view.sheet_url);
  $('pdfBtn').onclick = () => working($('pdfBtn'), 'Saving PDF…', () => downloadPdf(period));

  const rate = view.monthly_rate;
  const p = payFor(period, period.total, rate);
  const worked = period.days.filter(d => d.type === 'work' && d.hours > 0).length;
  const credits = period.days.filter(d => d.type === 'leave' || d.type === 'holiday').length;
  $('sheetSummary').innerHTML = [
    ['Total hours', hours(period.total)],
    ['Regular', `${hours(p.regular)} / ${p.required}`],
    ['Overtime', hours(p.overtime)],
    ['Days worked', `${worked}${credits ? ` + ${credits} leave/hol.` : ''}`],
    ['Expected pay', rate ? money(p.pay) : '—'],
  ].map(([label, value]) => `<div><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const rows = $('sheetRows');
  rows.innerHTML = '';
  for (const d of period.days) {
    const tr = document.createElement('tr');
    const credit = d.type === 'leave' || d.type === 'holiday';
    tr.className = 'editable ' + (d.weekend ? 'weekend ' : '') + (credit ? 'holiday ' : '') + (d.date === key ? 'today' : '');
    let cells;
    if (credit) {
      const name = d.type === 'holiday' ? 'Holiday' + (d.holidayName ? ' · ' + esc(d.holidayName) : '') : 'Leave';
      cells = `<td class="holiday-cell" colspan="4">${name}</td>`;
    } else {
      const slots = [0, 1].flatMap(i => {
        const s = d.sessions[i];
        return [s ? clock(s.start) : '', s ? (s.end ? clock(s.end) : 'now') : ''];
      });
      if (d.sessions.length > 2) slots[3] += ` (+${d.sessions.length - 2} more)`;
      cells = slots.map(v => `<td>${v || (d.weekend ? '' : '—')}</td>`).join('');
    }
    const note = noteFor(view, d.date);
    tr.innerHTML = `<td>${d.label}</td>${cells}<td class="num">${hours(d.hours)}</td>` +
      `<td class="note-cell"><button type="button" class="row-note${note ? ' has-note' : ''}" title="${esc(note || 'Add a note')}" aria-label="${note ? 'Edit note' : 'Add a note'} for ${d.label}">${NOTE_ICON}</button></td>` +
      `<td class="edit-cell"><button type="button" class="row-edit" aria-label="Edit ${d.label}">✎ Edit</button></td>`;
    tr.onclick = () => openEditor(d.date);
    tr.querySelector('.row-note').onclick = e => { e.stopPropagation(); openNoteDialog(d.date); };
    if (d.date === justSaved) {
      tr.classList.add('saved');
      tr.querySelector('.edit-cell').innerHTML = '<span class="saved-tag">✓ Saved</span>';
    }
    rows.append(tr);
  }
  renderFormula($('periodFormula'), period, live);
  renderPdfList();
}

async function renderPdfList() {
  const ul = $('pdfList');
  let files = [];
  try { files = await invoke('list_pdfs'); } catch (_) { /* folder missing is fine */ }
  ul.innerHTML = files.length ? '' : '<li class="muted">No PDFs yet. Download one above.</li>';
  for (const f of files.slice(0, 12)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name"></span><span class="muted small">${new Date(f.modified).toLocaleDateString()}</span>`;
    li.querySelector('.name').textContent = f.name;
    li.onclick = () => invoke('open_saved', { path: f.path }).catch(e => toast(String(e), true));
    ul.append(li);
  }
}

async function downloadPdf(period) {
  if (!view.name) {
    toast('Add your name in Settings first; it goes at the top of the timesheet.', true);
    showView('settings');
    return;
  }
  try {
    const path = await invoke('save_pdf', { fileName: period.fileName, content: periodPdf(view, period), open: true });
    toast(`Saved ${path.replace(/^.*\/Documents\//, 'Documents/')}`);
    renderPdfList();
  } catch (e) {
    toast(String(e), true);
  }
}

// ---- Day editor ----

function openEditor(date) {
  editing = date;
  const rec = (view.days && view.days[date]) || { sessions: [] };
  const info = dayInfo(view, date, holidays());
  $('dayTitle').textContent = prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const type = rec.sessions && rec.sessions.length ? 'work'
    : rec.kind === 'off' ? 'off'
    : info.type === 'leave' || info.type === 'holiday' ? info.type
    : rec.hours != null ? 'work' : (info.weekend ? 'off' : 'work');
  document.querySelector(`input[name=dayType][value=${type}]`).checked = true;
  $('dayHours').value = rec.hours != null ? rec.hours : HOURS_PER_DAY;
  const box = $('daySessions');
  box.innerHTML = '';
  (rec.sessions || []).forEach(s => addSessionRow(etHHMM(s.start), s.end ? etHHMM(s.end) : ''));
  if (!box.children.length) { addSessionRow('', ''); addSessionRow('', ''); }
  syncEditorType();
  $('dayDialog').showModal();
}

function addSessionRow(start, end) {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.innerHTML = '<input type="time" class="s-in" aria-label="Time in"><span>→</span>' +
    '<input type="time" class="s-out" aria-label="Time out"><button type="button" class="ghost icon" aria-label="Remove">✕</button>';
  row.querySelector('.s-in').value = start;
  row.querySelector('.s-out').value = end;
  row.querySelector('button').onclick = () => row.remove();
  $('daySessions').append(row);
}

function syncEditorType() {
  const type = document.querySelector('input[name=dayType]:checked').value;
  $('daySessions').hidden = type !== 'work';
  $('addSession').hidden = type !== 'work';
  $('dayHoursRow').hidden = !(type === 'leave' || type === 'holiday');
  const info = dayInfo(view, editing, holidays());
  $('dayHint').textContent = type === 'off' && info.holidayName && !info.weekend
    ? `${info.holidayName} won't be credited this day.`
    : type === 'work' ? 'Leave "time out" empty only if you are still working.' : '';
}

function editorDay() {
  const type = document.querySelector('input[name=dayType]:checked').value;
  if (type === 'leave' || type === 'holiday') {
    return { sessions: [], kind: type, hours: Number($('dayHours').value) || HOURS_PER_DAY };
  }
  if (type === 'off') {
    const info = dayInfo(view, editing, holidays());
    return info.holidayName && !info.weekend ? { sessions: [], kind: 'off' } : { sessions: [] };
  }
  const sessions = [];
  for (const row of $('daySessions').querySelectorAll('.session-row')) {
    const a = parseClock(row.querySelector('.s-in').value);
    const b = parseClock(row.querySelector('.s-out').value);
    if (!a && !b) continue;
    if (!a) throw new Error('Each time out needs a time in.');
    const start = etToMs(editing, a[0], a[1]);
    let end = b ? etToMs(editing, b[0], b[1]) : null;
    if (end !== null && end <= start) end += 24 * HOUR_MS; // worked past midnight
    sessions.push({ start, end });
  }
  if (sessions.filter(s => s.end == null).length > 1) throw new Error('Only one session can be left open.');
  sessions.sort((x, y) => x.start - y.start);
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i - 1].end == null || sessions[i].start < sessions[i - 1].end) throw new Error('Times overlap. Check the in/out pairs.');
  }
  return { sessions };
}

// ---- Settings ----

function renderSettings() {
  if (!view) return;
  if (document.activeElement !== $('profileName')) $('profileName').value = view.name || '';
  if (document.activeElement !== $('profileRate')) $('profileRate').value = view.monthly_rate || '';
  document.querySelectorAll('input[name=mode]').forEach(r => { r.checked = r.value === (view.mode || 'local'); });
  renderSheetBox($('sheetBox'), false);
  $('autostart').checked = !!view.autostart;
  $('widgetToggle').checked = !!view.widget;
  $('remindToggle').checked = !!view.remind;
  if (document.activeElement !== $('remindHours')) $('remindHours').value = view.remind_hours;
  $('remindHours').disabled = !view.remind;
  $('backupNote').textContent = view.backup_path ? `Your timesheet is backed up to ${view.backup_path.replace(/^.*\/Documents\//, 'Documents/')} after every change.` : '';
}

/**
 * The Google Sheet panel: the setup guide + connection fields, used in onboarding and in
 * Settings. In local mode (Settings) it becomes a one-time "import history" tool.
 */
function renderSheetBox(box, onboarding) {
  if (box.querySelector('[data-busy]')) return;
  const wantSheet = onboarding || document.querySelector('input[name=mode]:checked')?.value === 'sheet';
  if (box.dataset.state === `${wantSheet}|${view.has_sheet}|${view.mode}|${view.sync_error}|${view.synced_at}`) return;
  box.dataset.state = `${wantSheet}|${view.has_sheet}|${view.mode}|${view.sync_error}|${view.synced_at}`;

  const connected = sheetMode() && view.has_sheet;
  const status = connected
    ? `<p class="small ${view.sync_error ? 'error-text' : 'muted'}">${view.sync_error ? esc(view.sync_error)
      : `Connected${view.sheet_name ? ' to “' + esc(view.sheet_name) + '”' : ''}${view.synced_at ? ' · synced ' + fmt(view.synced_at, { hour: 'numeric', minute: '2-digit' }, PH) : ''}`}</p>`
    : '';
  const fields = `
    <label>Web app URL <input type="url" class="sb-url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(view.api_url || '')}"></label>
    <label>App key <input type="password" class="sb-key" placeholder="${view.has_sheet ? 'Saved — paste a new key to replace it' : 'From 🌼 Narra → Desktop app key… in your sheet'}"></label>`;
  const guide = `
    <ol class="guide">
      <li>Open <b>your own copy</b> of the timesheet in Google Sheets (File → Make a copy of the template if you don't have one).</li>
      <li>Go to <b>Extensions → Apps Script</b>. Delete what's in the editor, then paste Narra's script:
        <button type="button" class="ghost small-btn sb-copy">Copy script</button> and press <b>⌘S</b>.</li>
      <li>Click <b>Deploy → New deployment</b>, choose ⚙ <b>Web app</b>. Set <b>Execute as: Me</b> and
        <b>Who has access: Anyone</b>, then <b>Deploy</b> and allow access (Advanced → Go to … → Allow).</li>
      <li>Copy the <b>Web app URL</b> (ends in <code>/exec</code>) into the first box below.</li>
      <li>Reload your sheet, open <b>🌼 Narra → Desktop app key…</b>, and paste the key into the second box.</li>
    </ol>
    <p class="muted small">“Anyone” is needed because Narra can't sign in to Google (company-only access returns a 401). ` +
    `The key keeps the link private. Narra finds your sheet's “Time In / Time Out / Total” columns and date rows on its own.</p>`;

  if (wantSheet) {
    box.innerHTML = (connected ? status : guide) + fields + `
      <div class="row">
        <button type="button" class="sb-connect">${connected ? 'Save & sync now' : 'Connect & sync'}</button>
        ${connected ? '<button type="button" class="ghost sb-guide">Setup guide</button><button type="button" class="ghost sb-copy">Copy script</button>' : ''}
      </div>`;
    const wire = () => {
      const b = box.querySelector('.sb-connect');
      b.onclick = () => working(b, 'Connecting…', () => connectSheet(box, onboarding));
    };
    wire();
    const g = box.querySelector('.sb-guide');
    if (g) g.onclick = () => { box.innerHTML = guide + fields + '<div class="row"><button type="button" class="sb-connect">Save & sync now</button></div>'; wire(); wireCopy(box); };
  } else {
    box.innerHTML = `<details class="import"><summary class="muted small">Import history from a Google Sheet…</summary>
      ${view.legacy_import ? '<p class="small">Narra has a copy of your sheet from before. <button type="button" class="link inline sb-legacy">Import it</button></p>' : ''}
      <p class="muted small">Or connect a sheet that has the Narra script (see the Google Sheet option for the guide) and import its days. Days already in Narra are kept.</p>
      ${fields}<div class="row"><button type="button" class="ghost sb-import">Import</button></div></details>`;
    const imp = box.querySelector('.sb-import');
    imp.onclick = () => working(imp, 'Importing…', async () => {
      if (await saveLink(box)) await importHistory();
    });
    const legacy = box.querySelector('.sb-legacy');
    if (legacy) legacy.onclick = () => working(legacy, 'Importing…', () => importHistory(true));
    // (progress also shows in the sidebar)
  }
  wireCopy(box);
}

function wireCopy(box) {
  box.querySelectorAll('.sb-copy').forEach(b => {
    b.onclick = () => invoke('copy_sheet_script')
      .then(() => toast('Script copied. Paste it into Apps Script (⌘V).'))
      .catch(e => toast(String(e), true));
  });
}

/** Save the URL + key from a sheet panel. Returns false (after explaining) if the URL is wrong. */
async function saveLink(box) {
  const url = box.querySelector('.sb-url').value.trim();
  const key = box.querySelector('.sb-key').value.trim();
  if (url && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    toast('That doesn’t look like a web app URL. It should start with https://script.google.com and end in /exec.', true);
    return false;
  }
  view = await invoke('save_sheet_link', { apiUrl: url, apiKey: key || null });
  return true;
}

/** Connect (or re-sync) sheet mode: read the sheet once, then switch to following it. */
async function connectSheet(box, onboarding) {
  try {
    if (!(await saveLink(box))) return;
    if (!view.has_sheet) return toast('Add the web app URL and key first.', true);
    syncing = true;
    renderSyncLine();
    const data = await invoke('sheet_sync', { years: yearsToSync() });
    if (!view.name && data.ownerName) view = await invoke('set_profile', { name: data.ownerName, rate: view.monthly_rate || data.monthlyRate || null });
    if (!sheetMode()) view = await invoke('set_mode', { mode: 'sheet' });
    await syncSheet(true);
    toast(`Connected to “${data.sheetName || 'your sheet'}”. Narra now keeps it up to date.`);
    if (onboarding) finishOnboarding();
  } catch (e) {
    toast(String(e), true);
  } finally {
    syncing = false;
    renderAll();
  }
}

/** Sheet mode: push changes and follow the sheet. Quiet unless something needs saying. */
async function syncSheet(quiet = true) {
  if (!sheetMode() || !view.has_sheet || syncing) return;
  syncing = true;
  renderSyncLine();
  const task = quiet ? null : activity('Syncing with your Google Sheet…');
  try {
    const data = await invoke('sheet_sync', { years: yearsToSync() });
    if (data.notes && data.notes.length) toast(data.notes.join('\n'));
    if (task) task.done('✓ Synced with your sheet');
  } catch (e) {
    if (task) task.fail(`Sync failed: ${e}`);
  } finally {
    syncing = false;
    view = await invoke('load');
    renderAll();
  }
}

/** Old (first-version) sheet snapshots → Narra days. */
function legacyDays(snapshot) {
  const out = {};
  const todayKey = dateKey(Date.now());
  for (const tab of (snapshot && snapshot.timesheets) || []) {
    for (const d of tab.days) {
      const texts = d.slots.flat().map(s => String(s || '').trim());
      const label = texts[0].toUpperCase();
      if (label === 'HOLIDAY' || label === 'LEAVE') {
        out[d.date] = { sessions: [], kind: label.toLowerCase(), hours: d.hours || HOURS_PER_DAY };
        continue;
      }
      const sessions = [];
      for (const [a, b] of d.slots) {
        const s = parseClock(a);
        if (!s) continue;
        const e = parseClock(b);
        const start = etToMs(d.date, s[0], s[1]);
        let end = e ? etToMs(d.date, e[0], e[1]) : null;
        if (end !== null && end <= start) end += 24 * HOUR_MS;
        if (end === null && d.date !== todayKey) continue; // unfinished old entry
        sessions.push({ start, end });
      }
      // Keep the sheet's own total, so past periods match what was submitted.
      if (sessions.length) out[d.date] = sessions.every(s => s.end != null) ? { sessions, hours: d.hours } : { sessions };
      else if (d.hours > 0) out[d.date] = { sessions: [], hours: d.hours };
    }
  }
  return out;
}

async function importHistory(legacyOnly = false) {
  const task = activity('Importing your history…');
  try {
    let days = null;
    if (!legacyOnly && view.has_sheet) {
      try {
        const data = await invoke('sheet_sync', { years: yearsToSync() });
        days = data.days || null;
      } catch (e) {
        if (!view.legacy_import) throw e;
      }
    }
    if (!days) days = legacyDays(await invoke('legacy_snapshot'));
    // One period at a time, so the sidebar can say where it's up to.
    const groups = {};
    for (const [date, day] of Object.entries(days)) (groups[periodBounds(date).start] ||= {})[date] = day;
    let added = 0;
    for (const start of Object.keys(groups).sort()) {
      task.update(`Importing ${buildPeriod(view, start, holidays()).title}…`);
      const [n, next] = await invoke('import_days', { days: groups[start] });
      added += n;
      view = next;
      renderAll();
    }
    task.done(added ? `✓ Imported ${added} day${added > 1 ? 's' : ''}` : '✓ History already up to date');
  } catch (e) {
    task.fail(`Import failed: ${e}`);
  }
  renderAll();
}

// ---- Onboarding ----

async function startOnboarding() {
  $('onboard').hidden = false;
  $('obName').value = view.name || '';
  let rate = view.monthly_rate;
  if (!rate && view.legacy_import) {
    const snap = await invoke('legacy_snapshot');
    const tab = snap && (snap.timesheets || []).find(t => t.summary && t.summary.monthlyRate);
    if (tab) rate = Number(String(tab.summary.monthlyRate).replace(/[^0-9.]/g, '')) || null;
  }
  $('obRate').value = rate || '';
  showStep('stepProfile');
  $('obName').focus();
}

function showStep(id) {
  ['stepProfile', 'stepMode', 'stepSheet'].forEach(s => { $(s).hidden = s !== id; });
}

function finishOnboarding() {
  $('onboard').hidden = true;
  showView('today');
  syncSheet(true);
}

$('stepProfile').onsubmit = e => {
  e.preventDefault();
  working(e.submitter || $('stepProfile').querySelector('button[type=submit]'), 'Saving…', async () => {
  try {
    view = await invoke('set_profile', { name: $('obName').value, rate: Number($('obRate').value) || null });
    const canImport = view.legacy_import || view.has_sheet;
    $('obImportRow').hidden = !canImport;
    if (canImport && view.legacy_import) {
      const n = Object.keys(legacyDays(await invoke('legacy_snapshot'))).length;
      $('obImportText').textContent = `Bring in my ${n} days of history from Google Sheets`;
    }
    showStep('stepMode');
  } catch (err) {
    toast(String(err), true);
  }
  });
};
$('obBack').onclick = () => showStep('stepProfile');
$('stepMode').onsubmit = e => {
  e.preventDefault();
  const mode = document.querySelector('input[name=obMode]:checked').value;
  if (mode === 'sheet') {
    renderSheetBox($('obSheetBox'), true);
    showStep('stepSheet');
    return;
  }
  const doImport = !$('obImportRow').hidden && $('obImport').checked;
  working(e.submitter || $('stepMode').querySelector('button[type=submit]'), 'Setting up…', async () => {
    try {
      view = await invoke('set_mode', { mode: 'local' });
      finishOnboarding();
      // Runs in the background; progress shows in the sidebar. Uses the copy of the sheet
      // Narra already has when there is one (no calls to the sheet).
      if (doImport) importHistory(view.legacy_import);
    } catch (err) {
      toast(String(err), true);
    }
  });
};
$('obSheetBack').onclick = () => showStep('stepMode');
$('obSheetLocal').onclick = e => working(e.currentTarget, 'Setting up…', async () => {
  view = await invoke('set_mode', { mode: 'local' });
  finishOnboarding();
});

// ---- Day notes ----

function fitNote(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// While editing, Save / ✕ show and the 1 s re-render leaves the text alone.
let noteEditing = false;
function setNoteEditing(on) {
  noteEditing = on;
  $('todayNoteActions').hidden = !on;
  if (on) $('todayNoteSaved').hidden = true;
}

function cancelTodayNote() {
  setNoteEditing(false);
  $('todayNote').blur();
  renderToday();
}

let noteSavedTimer = null;
async function saveTodayNote() {
  const box = $('todayNote');
  const key = today().key;
  const text = box.value.trim();
  try {
    if (text !== noteFor(view, key)) view = await saveNote(invoke, key, text);
    setNoteEditing(false);
    box.blur();
    renderAll();
    const tag = $('todayNoteSaved');
    tag.hidden = false;
    clearTimeout(noteSavedTimer);
    noteSavedTimer = setTimeout(() => { tag.hidden = true; }, 2000);
  } catch (e) {
    toast(String(e), true); // still editing, so what they typed stays
  }
}

let noteDate = null;
function openNoteDialog(date) {
  noteDate = date;
  const note = noteFor(view, date);
  $('noteTitle').textContent = prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric' });
  $('noteText').value = note;
  $('noteDelete').hidden = !note;
  $('noteDialog').showModal();
  $('noteText').focus();
}

async function saveDialogNote(text) {
  try {
    view = await saveNote(invoke, noteDate, text);
    $('noteDialog').close();
    toast(text.trim() ? 'Note saved.' : 'Note deleted.');
    renderAll();
  } catch (e) {
    toast(String(e), true);
  }
}

// ---- Actions ----

function renderAll() {
  renderSyncLine();
  renderToday();
  renderUpcoming();
  if (!$('view-timesheets').hidden) renderTimesheets();
  renderSettings();
}

function updateTray(t) {
  const title = t.open ? duration(t.runningMs, false) : '';
  const key = title + '|' + t.open;
  if (key === lastTray) return;
  lastTray = key;
  invoke('set_tray', { title, clockedIn: t.open }).catch(() => {});
}

let toastTimer = null;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 9000 : 5000);
}

function toggleForgot(open) {
  $('forgotForm').hidden = !open;
  $('forgotBtn').hidden = open;
  if (open) {
    $('forgotTime').value = nowHHMM();
    $('forgotTime').focus();
  }
}

async function punch(at = null) {
  if (busy || !view) return;
  const t = today();
  if (at === null && !t.open && (t.holiday || t.leave) && !holidayArmed) {
    holidayArmed = true;
    renderToday();
    setTimeout(() => { holidayArmed = false; renderToday(); }, 8000);
    return;
  }
  if (at !== null && t.open && at <= t.since) {
    toast(`Time out must be after your time in (${clock(t.since, PH)} Manila).`, true);
    return;
  }
  holidayArmed = false;
  const sessions = sessionCount(view);
  busy = true;
  try {
    view = await punchNow(invoke, t, at);
    const now = today();
    toast(now.open ? `Timed in at ${clock(now.since, PH)} Manila (${clock(now.since)} New York)`
      : sessionCount(view) < sessions ? 'Stopped within a minute, so nothing was logged.'
      : `Timed out. ${hours(now.hours)} hrs today.`);
  } catch (e) {
    toast(String(e), true);
  } finally {
    busy = false;
    renderAll();
  }
  syncSheet(true);
}

async function loadHolidays(year, refresh = false) {
  if (!holidayLists[year] || refresh) {
    try {
      holidayLists[year] = await invoke('holidays', { year });
    } catch (_) {
      holidayLists[year] = holidayLists[year] || [];
    }
  }
  return holidayLists[year];
}

async function renderHolidays() {
  $('yearLabel').textContent = holidayYear;
  const list = await loadHolidays(holidayYear);
  const ul = $('holidayList');
  ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="muted">No holidays loaded for this year (offline?).</li>';
  for (const h of list) {
    const li = document.createElement('li');
    li.className = h.enabled ? '' : 'off';
    li.innerHTML = `<span class="date">${prettyDate(h.date)}</span><span class="name"></span>` +
      `${isWeekend(h.date) ? '<span class="badge">weekend</span>' : ''}` +
      `<span class="badge ${h.official ? '' : 'custom'}">${h.official ? 'official' : 'added'}</span>` +
      `<label class="toggle"><input type="checkbox" ${h.enabled ? 'checked' : ''}></label>`;
    li.querySelector('.name').textContent = h.name;
    li.querySelector('input').onchange = e => changeHoliday(h, e.target.checked);
    ul.append(li);
  }
}

async function changeHoliday(h, enabled) {
  await invoke('set_holiday', { date: h.date, name: h.name, enabled });
  await loadHolidays(Number(h.date.slice(0, 4)), true);
  renderHolidays();
  renderAll();
  syncSheet(true);
}

function openUrl(url) {
  invoke('open_url', { url }).catch(e => toast(String(e), true));
}

function showView(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  if (name === 'holidays') renderHolidays();
  if (name === 'timesheets') renderTimesheets();
  if (name === 'settings') renderSettings();
}

// ---- Wiring ----

document.querySelectorAll('nav button').forEach(b => { b.onclick = () => showView(b.dataset.view); });
$('punchBtn').onclick = () => punch();
$('forgotBtn').onclick = () => toggleForgot(true);
$('forgotCancel').onclick = () => toggleForgot(false);
$('forgotForm').onsubmit = e => {
  e.preventDefault();
  const at = pickedTime($('forgotTime').value);
  toggleForgot(false);
  punch(at);
};
$('yearPrev').onclick = () => { holidayYear--; renderHolidays(); };
$('yearNext').onclick = () => { holidayYear++; renderHolidays(); };
$('openFolderBtn').onclick = () => invoke('open_saved', { path: null }).catch(e => toast(String(e), true));

document.querySelectorAll('input[name=dayType]').forEach(r => { r.onchange = syncEditorType; });
$('addSession').onclick = () => addSessionRow('', '');
$('dayCancel').onclick = () => $('dayDialog').close();
$('dayForm').onsubmit = e => {
  e.preventDefault();
  working($('daySave'), 'Saving…', async () => {
    try {
      view = await invoke('save_day', { date: editing, day: editorDay() });
      $('dayDialog').close();
      toast(`Saved ${prettyDate(editing)}`);
      justSaved = editing;
      renderAll();
      renderTimesheets();
      setTimeout(() => { justSaved = null; renderTimesheets(); }, 4000);
      syncSheet(true);
    } catch (err) {
      toast(err.message || String(err), true);
    }
  });
};

$('profileForm').onsubmit = e => {
  e.preventDefault();
  working(e.submitter || $('profileForm').querySelector('button[type=submit]'), 'Saving…', async () => {
    try {
      view = await invoke('set_profile', { name: $('profileName').value, rate: Number($('profileRate').value) || null });
      toast('Saved');
    } catch (err) {
      toast(String(err), true);
    }
    renderAll();
  });
};

document.querySelectorAll('input[name=mode]').forEach(r => {
  r.onchange = async () => {
    if (r.value === 'local' && sheetMode()) {
      view = await invoke('set_mode', { mode: 'local' });
      toast('Your timesheet now lives on this Mac. The Google Sheet is no longer updated.');
      renderAll();
    } else if (r.value === 'sheet' && view.has_sheet && !sheetMode()) {
      view = await invoke('set_mode', { mode: 'sheet' });
      renderAll();
      syncSheet(false);
    } else {
      $('sheetBox').dataset.state = '';
      renderSheetBox($('sheetBox'), false);
    }
  };
});

$('autostart').onchange = async e => {
  try {
    view.autostart = await invoke('set_autostart', { enabled: e.target.checked });
  } catch (err) {
    toast(String(err), true);
  }
  renderSettings();
};

$('addHoliday').onsubmit = async e => {
  e.preventDefault();
  const date = $('newHolidayDate').value;
  const name = $('newHolidayName').value.trim();
  if (!date || !name) return;
  await invoke('set_holiday', { date, name, enabled: true });
  $('newHolidayName').value = '';
  holidayYear = Number(date.slice(0, 4));
  await loadHolidays(holidayYear, true);
  renderHolidays();
  renderAll();
  syncSheet(true);
};

$('widgetToggle').onchange = async e => {
  try {
    view.widget = await invoke('set_widget', { visible: e.target.checked });
  } catch (err) {
    toast(String(err), true);
  }
  renderSettings();
};

async function saveReminder() {
  try {
    view = await invoke('set_reminder', { enabled: $('remindToggle').checked, hours: Number($('remindHours').value) });
  } catch (err) {
    toast(String(err), true);
  }
  renderSettings();
}
$('remindToggle').onchange = saveReminder;
$('remindHours').onchange = saveReminder;
$('testReminder').onclick = () =>
  invoke('test_reminder').then(() => toast('Sent. If nothing appeared, allow Narra in System Settings → Notifications.'))
    .catch(err => toast(String(err), true));

$('todayNote').addEventListener('input', e => fitNote(e.target));
$('todayNote').addEventListener('focus', () => setNoteEditing(true));
// Clicking away keeps unsaved changes (and the buttons) in place; an untouched note just closes.
$('todayNote').addEventListener('blur', e => {
  if ($('todayNoteBox').contains(e.relatedTarget)) return;
  if (e.target.value.trim() === noteFor(view, today().key)) setNoteEditing(false);
});
$('todayNote').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTodayNote(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelTodayNote(); }
});
$('todayNoteSave').onclick = saveTodayNote;
$('todayNoteCancel').onclick = cancelTodayNote;
$('noteForm').onsubmit = e => { e.preventDefault(); saveDialogNote($('noteText').value); };
$('noteDelete').onclick = () => saveDialogNote('');
$('noteCancel').onclick = () => $('noteDialog').close();
$('noteText').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('noteForm').requestSubmit(); }
});

listen('tray-punch', () => punch());
listen('navigate', e => showView(e.payload));
// Another window (the desktop widget) punched, or a sync changed things.
listen('view', e => {
  view = e.payload;
  renderAll();
  // e.g. a punch from the widget: send it on to the sheet.
  if (sheetMode() && view.unsynced && !syncing) syncSheet(true);
});
window.addEventListener('focus', () => syncSheet(true));

setInterval(() => {
  const now = Date.now();
  renderClocks(now);
  renderToday(now);
}, 1000);
setInterval(() => syncSheet(true), SHEET_SYNC_EVERY_MS);

(async function start() {
  holidayYear = Number(dateKey(Date.now()).slice(0, 4));
  view = await invoke('load');
  await Promise.all(yearsToSync().map(y => loadHolidays(y)));
  renderClocks(Date.now());
  renderAll();
  if (!view.mode) startOnboarding();
  else syncSheet(true);
})();
