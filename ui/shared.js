// Shared by the main window (app.js) and the desktop widget (widget.js): time helpers,
// the timesheet model built from the Rust-side view ({ days, name, monthly_rate, ... }),
// and the pay rules. Everything on the timesheet is in Eastern Time, as the template asks.

const ET = 'America/New_York';
const PH = 'Asia/Manila';
const HOUR_MS = 3600 * 1000;

// Timesheet rules, copied from the Google Sheets template's formulas:
//   day hours = sum of (time out − time in), minute precision; leave/holiday = 8
//   (days that came from a Google Sheet keep the total the sheet recorded)
//   required  = 8 h × weekdays (Mon–Fri) in the period                (NETWORKDAYS)
//   overtime  = max(0, total − required); regular = min(total, required)
//   pay       = rate / 2 + OVERTIME_MULTIPLIER × (rate / HOURS_PER_MONTH) × overtime
const HOURS_PER_DAY = 8;
const HOURS_PER_MONTH = 160;
const OVERTIME_MULTIPLIER = 1.3;
const CREDIT_KINDS = ['leave', 'holiday'];

const $ = id => document.getElementById(id);

// ---- Time helpers ----

const fmt = (ms, opts, tz = ET) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(ms);
const dateKey = (ms, tz = ET) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ms); // yyyy-mm-dd
const keyToUtc = key => Date.parse(key + 'T00:00:00Z');
const weekday = key => new Date(keyToUtc(key)).getUTCDay();
const isWeekend = key => [0, 6].includes(weekday(key));
const addDays = (key, n) => new Date(keyToUtc(key) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((keyToUtc(to) - keyToUtc(from)) / 86400000);
const prettyDate = (key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(keyToUtc(key));
const hours = h => (Math.round(h * 100) / 100).toFixed(2);
/** "9:03 am", like the timesheet. */
const clock = (ms, tz = ET) => fmt(ms, { hour: 'numeric', minute: '2-digit' }, tz).replace('AM', 'am').replace('PM', 'pm');

function duration(ms, withSeconds = true) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return withSeconds ? `${h}:${m}:${sec}` : `${h}:${m}`;
}

function yearsToSync() {
  const y = Number(dateKey(Date.now()).slice(0, 4));
  return [y - 1, y, y + 1];
}

/** Minutes Eastern Time is ahead of UTC at instant `ms` (negative, e.g. -240). */
function etOffsetMin(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Epoch ms for an Eastern wall-clock time on Eastern date `key`. */
function etToMs(key, h, m) {
  const [y, mo, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  let ms = guess - etOffsetMin(guess) * 60000;
  ms = guess - etOffsetMin(ms) * 60000; // settle across DST changes
  return ms;
}

/** "HH:MM" (24h, Eastern) for <input type="time">. */
const etHHMM = ms => fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Parse "9:03 am" / "13:05" / "1:05 PM" into [h, m]. */
function parseClock(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return [h, Number(m[2])];
}

/** Epoch ms for an "HH:MM" picked in the Mac's own timezone: today, or yesterday if that's still ahead. */
function pickedTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() > Date.now() + 60 * 1000) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** "HH:MM" for now in the Mac's own timezone, for <input type="time">. */
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- Timesheet model ----

/** holidays: [{ date, name, enabled }] lists (any nesting) -> Map(date -> name) of enabled ones. */
function holidayMap(lists) {
  return new Map(lists.flat().filter(h => h.enabled).map(h => [h.date, h.name]));
}

/**
 * Everything the UI shows for one day.
 * type: 'work' | 'leave' | 'holiday' | 'off' (a weekend, or nothing logged).
 */
function dayInfo(view, key, holidays, now = Date.now()) {
  const rec = (view && view.days && view.days[key]) || { sessions: [] };
  const sessions = rec.sessions || [];
  const weekend = isWeekend(key);
  const holidayName = holidays.get(key) || '';
  let type = 'off';
  let hrs = 0;
  if (sessions.length) {
    type = 'work';
    const closed = sessions.every(s => s.end != null);
    if (closed && rec.hours != null) {
      hrs = rec.hours; // total recorded by the Google Sheet (imported / sheet mode)
    } else {
      const minutes = sessions.reduce((sum, s) => sum + Math.max(0, Math.floor(((s.end || now) - s.start) / 60000)), 0);
      hrs = minutes / 60;
    }
  } else if (CREDIT_KINDS.includes(rec.kind)) {
    type = rec.kind;
    hrs = rec.hours != null ? rec.hours : HOURS_PER_DAY;
  } else if (holidayName && !weekend && rec.kind !== 'off') {
    type = 'holiday'; // PH holiday on a weekday: credited automatically
    hrs = HOURS_PER_DAY;
  } else if (rec.hours != null) {
    type = 'work';
    hrs = rec.hours;
  }
  return {
    date: key,
    label: prettyDate(key),
    weekend,
    type,
    hours: hrs,
    holidayName,
    sessions,
    open: sessions.some(s => s.end == null),
  };
}

/** The open (running) session anywhere in the timesheet, newest day first. */
function openSession(view) {
  const keys = Object.keys((view && view.days) || {}).sort().reverse();
  for (const key of keys) {
    const s = (view.days[key].sessions || []).find(x => x.end == null);
    if (s) return { date: key, start: s.start };
  }
  return null;
}

/** Today's clock state (Eastern date). */
function todayState(view, holidays, now = Date.now()) {
  const key = dateKey(now);
  const info = dayInfo(view, key, holidays, now);
  const open = openSession(view);
  // A session started yesterday and still running counts toward its own day, but the
  // timer and Time Out button follow it.
  const extra = open && open.date !== key ? Math.floor((now - open.start) / 60000) / 60 : 0;
  return {
    key,
    open: !!open,
    since: open ? open.start : null,
    runningMs: open ? now - open.start : 0,
    holiday: info.type === 'holiday',
    leave: info.type === 'leave',
    holidayName: info.holidayName,
    hours: info.hours + extra,
    sessions: info.sessions,
  };
}

/** The half-month period containing Eastern date `key`: 1–15 or 16–end. */
function periodBounds(key) {
  const [y, m, d] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return d <= 15
    ? { start: `${y}-${mm}-01`, end: `${y}-${mm}-15`, first: 1, lastDay: 15 }
    : { start: `${y}-${mm}-16`, end: `${y}-${mm}-${last}`, first: 16, lastDay: last };
}

function buildPeriod(view, key, holidays, now = Date.now()) {
  const b = periodBounds(key);
  const days = [];
  for (let k = b.start; k <= b.end; k = addDays(k, 1)) days.push(dayInfo(view, k, holidays, now));
  const monthName = prettyDate(b.start, { month: 'long' });
  const short = k => `${Number(k.slice(5, 7))}/${Number(k.slice(8))}/${k.slice(2, 4)}`;
  return {
    id: b.start,
    start: b.start,
    end: b.end,
    days,
    total: days.reduce((s, d) => s + d.hours, 0),
    title: `${prettyDate(b.start, { month: 'short', day: 'numeric' })}–${b.lastDay}, ${b.start.slice(0, 4)}`,
    periodText: `${short(b.start)} - ${short(b.end)}`,
    fileName: `Biweekly Timesheet (${monthName}) - ${b.first}-${b.lastDay}.pdf`,
  };
}

/** Every period with anything logged, plus the current one, newest first. */
function allPeriods(view, holidays, now = Date.now()) {
  const starts = new Set([periodBounds(dateKey(now)).start]);
  for (const key of Object.keys((view && view.days) || {})) starts.add(periodBounds(key).start);
  return [...starts].sort().reverse().map(start => buildPeriod(view, start, holidays, now));
}

/** Expected pay for a period with `total` hours logged, using the template's formula. */
function payFor(period, total, rate) {
  const required = HOURS_PER_DAY * period.days.filter(d => !d.weekend).length;
  const overtime = Math.max(0, total - required);
  const otRate = rate ? OVERTIME_MULTIPLIER * (rate / HOURS_PER_MONTH) : null;
  return {
    required,
    regular: Math.min(total, required),
    overtime,
    otRate,
    pay: rate ? rate / 2 + otRate * overtime : null,
  };
}

/** Hours logged so far this period vs. 8 per weekday, to date and in total. */
function periodProgress(period, key) {
  const weekdays = period.days.filter(d => !d.weekend);
  return {
    logged: period.total,
    expectedToDate: weekdays.filter(d => d.date <= key).length * HOURS_PER_DAY,
    expectedTotal: weekdays.length * HOURS_PER_DAY,
  };
}

/** Past the clock-out reminder threshold while still clocked in. */
function overThreshold(view, t) {
  return !!(view && view.remind && t.open && t.hours >= view.remind_hours);
}

let lastReminderTick = 0;
/** Report today's numbers to the backend, which decides when to notify (and dedupes across windows). */
function reminderTick(invoke, view, t) {
  if (!view || Date.now() - lastReminderTick < 30 * 1000) return;
  lastReminderTick = Date.now();
  invoke('reminder_tick', { date: t.key, open: t.open, hours: t.hours }).catch(() => {});
}

/** Next enabled holiday on or after `key` that falls on a weekday (the ones that count). */
function nextWeekdayHoliday(lists, key) {
  return lists.flat()
    .filter(h => h.enabled && h.date >= key && !isWeekend(h.date))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
}

/** Sessions across all days; a Time Out that lowers it dropped a same-minute session. */
function sessionCount(view) {
  return Object.values(view.days).reduce((n, d) => n + d.sessions.length, 0);
}

/** A day's private note ('' when none). Notes never go into the PDF or the sheet. */
function noteFor(view, date) {
  return (view && view.notes && view.notes[date]) || '';
}

/** Save (or, with blank text, delete) a day's note; returns the new view. */
function saveNote(invoke, date, text) {
  return invoke('save_note', { date, text });
}

/** Sticky-note icon for note buttons (fill the first path to mark "has a note"). */
const NOTE_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 2.5h10a.5.5 0 0 1 .5.5v6.8L9.8 13.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"/>' +
  '<path d="M9.5 13.5V10h4"/><path d="M5 5.5h6M5 8h4"/></svg>';

/** Time In / Time Out through the backend; returns the new view. */
function punchNow(invoke, t, at = null) {
  const kind = t.open ? 'out' : 'in';
  // A new session belongs to the Eastern date it starts on.
  const date = dateKey(at != null ? at : Date.now());
  return invoke('punch', { kind, date, at });
}
