// Desktop widget: a compact live view of today plus Time In / Time Out.
// State comes from the Rust side; every window hears the "view" event when anything
// changes (punches here, edits and sheet syncs in the main window).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let view = null;
let holidays = [];           // [[...this year], [...next year]]
let busy = false;
let holidayArmed = false;
let flashTimer = null;
let pane = null;             // overlay replacing the main pane: 'forgot' | 'note' | null

function flash(text, isError = false) {
  const el = $('flash');
  el.textContent = text;
  el.className = 'flash' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
}

function render(now = Date.now()) {
  if (!view) return;
  const ready = !!view.mode;
  if (!ready) pane = null;
  $('setupPane').hidden = ready;
  $('mainPane').hidden = !ready || pane !== null;
  $('forgotPane').hidden = pane !== 'forgot';
  $('notePane').hidden = pane !== 'note';

  const t = todayState(view, holidayMap(holidays), now);
  const note = noteFor(view, t.key);
  $('noteBtn').hidden = !ready;
  $('noteBtn').classList.toggle('has-note', !!note);
  $('noteBtn').title = note || 'Add a note for today';
  const unsynced = view.mode === 'sheet' && (view.unsynced || view.sync_error);

  const pill = $('pill');
  if (!ready) { pill.textContent = 'Set up'; pill.className = 'pill warn'; }
  else if (t.open) { pill.textContent = 'Working'; pill.className = 'pill on'; }
  else if (t.leave) { pill.textContent = 'Leave'; pill.className = 'pill holiday'; }
  else if (t.holiday) { pill.textContent = 'Holiday'; pill.className = 'pill holiday'; }
  else if (unsynced) { pill.textContent = 'Not synced'; pill.className = 'pill warn'; }
  else { pill.textContent = t.sessions.length ? 'On a break' : 'Off'; pill.className = 'pill'; }

  $('timer').textContent = duration(t.runningMs);
  const over = overThreshold(view, t);
  $('sub').classList.toggle('alert', over);
  $('sub').textContent = over
    ? `${hours(view.remind_hours).replace(/\.00$/, '')} hrs done, time out?`
    : t.open
    ? 'since ' + clock(t.since, PH) + ' Manila'
    : t.holiday ? (t.holidayName || 'Holiday') + ' · 8 hrs' : t.leave ? `${hours(t.hours)} hrs leave` : 'not clocked in';

  const btn = $('punchBtn');
  btn.disabled = busy || !ready;
  btn.textContent = busy ? '…' : t.open ? 'Time Out' : holidayArmed ? 'Work anyway?' : 'Time In';
  btn.classList.toggle('out', t.open);
  $('forgotLabel').textContent = `I actually ${t.open ? 'timed out' : 'timed in'} at (Manila)`;
  $('forgotSave').textContent = t.open ? 'Time Out' : 'Time In';
  $('forgotSave').disabled = busy;

  $('statToday').textContent = hours(t.hours) + 'h';
  reminderTick(invoke, view, t);
  const period = buildPeriod(view, t.key, holidayMap(holidays), now);
  const p = periodProgress(period, t.key);
  $('statPeriod').textContent = `${Math.round(p.logged * 10) / 10}/${p.expectedTotal}h`;
  const next = nextWeekdayHoliday(holidays, t.key);
  if (next) {
    const days = daysBetween(t.key, next.date);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `${days}d`;
    $('statHoliday').textContent = `${prettyDate(next.date, { month: 'short', day: 'numeric' })} · ${when}`;
    $('statHoliday').title = next.name;
  } else {
    $('statHoliday').textContent = '—';
  }
}

async function punch(at = null) {
  if (busy || !view || !view.mode) return;
  const t = todayState(view, holidayMap(holidays));
  if (at === null && !t.open && (t.holiday || t.leave) && !holidayArmed) {
    holidayArmed = true;
    render();
    setTimeout(() => { holidayArmed = false; render(); }, 6000);
    return;
  }
  if (at !== null && t.open && t.since && at <= t.since) {
    flash('Time out must be after your time in.', true);
    return;
  }
  holidayArmed = false;
  const sessions = sessionCount(view);
  busy = true;
  render();
  try {
    view = await punchNow(invoke, t, at);
    const now = todayState(view, holidayMap(holidays));
    flash(now.open ? `Timed in at ${clock(now.since, PH)} Manila`
      : sessionCount(view) < sessions ? 'Stopped within a minute · nothing logged'
      : `Timed out · ${hours(now.hours)} hrs today`);
  } catch (e) {
    flash(String(e), true);
  } finally {
    busy = false;
    render();
  }
}

/** Open an overlay pane ('forgot' / 'note') in place of the main pane, or close it (null). */
function showPane(name) {
  pane = name;
  render();
  if (name === 'forgot') {
    $('forgotTime').value = nowHHMM();
    $('forgotTime').focus();
  } else if (name === 'note') {
    $('noteInput').value = noteFor(view, dateKey(Date.now()));
    $('noteInput').focus();
  }
}

async function loadHolidays() {
  const y = Number(dateKey(Date.now()).slice(0, 4));
  try {
    holidays = await Promise.all([y, y + 1].map(year => invoke('holidays', { year })));
  } catch (_) {
    holidays = [];
  }
}

async function refresh() {
  view = await invoke('load');
  render();
}

$('punchBtn').onclick = () => punch();
$('forgotBtn').onclick = () => showPane('forgot');
$('forgotCancel').onclick = () => showPane(null);
$('forgotPane').onsubmit = e => {
  e.preventDefault();
  const at = pickedTime($('forgotTime').value);
  showPane(null);
  punch(at);
};
$('noteBtn').innerHTML = NOTE_ICON;
$('noteBtn').onclick = () => showPane(pane === 'note' ? null : 'note');
$('noteCancel').onclick = () => showPane(null);
$('noteInput').addEventListener('keydown', e => { if (e.key === 'Escape') showPane(null); });
$('notePane').onsubmit = async e => {
  e.preventDefault();
  const key = dateKey(Date.now());
  const text = $('noteInput').value.trim();
  if (text === noteFor(view, key)) { showPane(null); return; }
  try {
    view = await saveNote(invoke, key, text);
    showPane(null);
    flash(text ? 'Note saved' : 'Note removed');
  } catch (err) {
    flash(String(err), true);
  }
};
$('openMain').onclick = () => invoke('show_main_view', { view: null });
$('setupBtn').onclick = () => invoke('show_main_view', { view: 'settings' });

listen('view', e => {
  view = e.payload;
  render();
});

setInterval(() => render(), 1000);
setInterval(() => { loadHolidays(); refresh(); }, 5 * 60 * 1000);

(async function start() {
  await loadHolidays();
  await refresh();
})();
