// Narra: a menu-bar time clock that keeps a biweekly timesheet on this Mac.
//
// The timesheet (days and their work sessions) lives in store.json and is backed up to
// ~/Documents/Narra after every change. Expected pay and the PDF use the same formulas
// as the original Google Sheets template. A Google Sheet can still be connected, but
// only to import history.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod remote;
mod store;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use store::{now_ms, to_minute, write_atomic, Day, Holiday, HolidayYear, Session, Store};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const HOLIDAY_REFRESH_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const TRAY_ID: &str = "clock";
const WIDGET: &str = "widget";
/// Same footprint as a medium macOS widget.
const WIDGET_SIZE: (f64, f64) = (344.0, 164.0);
/// After the first clock-out reminder, repeat every half hour while still clocked in.
const REMIND_EVERY_HOURS: f64 = 0.5;
/// Where PDFs are saved, under ~/Documents (matches how timesheets were kept before).
const PDF_DIR: &str = "timesheets";
/// Backup of the timesheet data, under ~/Documents.
const BACKUP_FILE: &str = "Narra/narra-backup.json";

struct AppState {
    path: PathBuf,
    store: Mutex<Store>,
    /// Serialises sheet imports.
    net: Mutex<()>,
    /// Last clock-out reminder sent: (Eastern date, half-hour step past the threshold).
    /// Both windows report ticks; this keeps each reminder to one notification.
    reminded: Mutex<Option<(String, i64)>>,
}

struct TrayItems {
    punch: MenuItem<Wry>,
    widget: CheckMenuItem<Wry>,
}

#[derive(Serialize, Clone)]
struct View {
    name: String,
    monthly_rate: Option<f64>,
    days: BTreeMap<String, Day>,
    notes: BTreeMap<String, String>,
    backup_path: String,
    mode: String,
    has_sheet: bool,
    api_url: String,
    sheet_url: String,
    sheet_name: String,
    synced_at: Option<i64>,
    sync_error: String,
    unsynced: usize,
    legacy_import: bool,
    autostart: bool,
    widget: bool,
    remind: bool,
    remind_hours: f64,
}

#[derive(Serialize)]
struct HolidayView {
    date: String,
    name: String,
    official: bool,
    enabled: bool,
}

#[derive(Serialize)]
struct SavedPdf {
    name: String,
    path: String,
    modified: i64,
}

fn documents(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().document_dir().map_err(|e| e.to_string())
}

fn view(app: &AppHandle) -> View {
    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    View {
        name: store.name.clone(),
        monthly_rate: store.monthly_rate,
        days: store.days.clone(),
        notes: store.notes.clone(),
        backup_path: documents(app).map(|d| d.join(BACKUP_FILE).display().to_string()).unwrap_or_default(),
        mode: store.mode.clone(),
        has_sheet: store.has_sheet(),
        api_url: store.api_url.clone(),
        sheet_url: store.sheet_url.clone(),
        sheet_name: store.sheet_name.clone(),
        synced_at: store.synced_at,
        sync_error: store.sync_error.clone(),
        unsynced: store.dirty.len(),
        legacy_import: store.snapshot.is_some(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        widget: !store.widget_hidden,
        remind: !store.remind_off,
        remind_hours: store.remind_hours(),
    }
}

/// Tell every window (main + desktop widget) that the state changed.
fn broadcast(app: &AppHandle, view: &View) {
    let _ = app.emit("view", view.clone());
}

fn update_store<T>(app: &AppHandle, f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
    let state = app.state::<AppState>();
    let mut store = state.store.lock().unwrap();
    let out = f(&mut store);
    store.save(&state.path)?;
    Ok(out)
}

/// Change the timesheet data: save, back up to ~/Documents, and refresh every window.
fn update_data<T>(app: &AppHandle, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<(T, View), String> {
    let (out, backup) = {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().unwrap();
        let out = f(&mut store)?;
        store.save(&state.path)?;
        (out, store.backup_json())
    };
    if let Ok(dir) = documents(app) {
        // The backup is a convenience; never fail a punch over it.
        let _ = write_atomic(&dir.join(BACKUP_FILE), &backup.to_string());
    }
    let view = view(app);
    broadcast(app, &view);
    Ok((out, view))
}

/// Official holidays for `year`, refreshed from Nager.Date at most weekly.
fn ensure_official(app: &AppHandle, year: i32) {
    let fresh = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store
            .official
            .get(&year)
            .map(|y| now_ms() - y.fetched_at < HOLIDAY_REFRESH_MS)
            .unwrap_or(false)
    };
    if fresh {
        return;
    }
    if let Ok(list) = remote::fetch_holidays(year) {
        let _ = update_store(app, |s| {
            s.official.insert(year, HolidayYear { fetched_at: now_ms(), list });
        });
    }
}

fn holiday_views(store: &Store, year: i32) -> Vec<HolidayView> {
    let prefix = format!("{year}-");
    let mut out: Vec<HolidayView> = store
        .official
        .get(&year)
        .map(|y| y.list.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|h| HolidayView {
            enabled: !store.removed.contains(&h.date),
            date: h.date,
            name: h.name,
            official: true,
        })
        .collect();
    for h in store.custom.iter().filter(|h| h.date.starts_with(&prefix)) {
        out.retain(|o| o.date != h.date);
        out.push(HolidayView { date: h.date.clone(), name: h.name.clone(), official: false, enabled: true });
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

fn active_holidays(store: &Store, years: &[i32]) -> Vec<Holiday> {
    years
        .iter()
        .flat_map(|y| holiday_views(store, *y))
        .filter(|h| h.enabled)
        .map(|h| Holiday { date: h.date, name: h.name })
        .collect()
}

/// Talk to the connected sheet: push days changed in Narra (sheet mode), then pull the
/// sheet's days. In sheet mode the sheet wins for every date it has a row for, so edits
/// made directly in the sheet show up in Narra. Returns the sheet's reply.
fn sheet_sync_blocking(app: &AppHandle, years: &[i32], follow: bool) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let _net = state.net.lock().unwrap();
    for year in years {
        ensure_official(app, *year);
    }
    let (url, key, holidays, pending) = {
        let store = state.store.lock().unwrap();
        if !store.has_sheet() {
            return Err("Add your sheet's web app URL and key first.".into());
        }
        let pending: BTreeMap<String, Day> = if follow {
            store.dirty.iter().map(|d| (d.clone(), store.days.get(d).cloned().unwrap_or_default())).collect()
        } else {
            BTreeMap::new()
        };
        (store.api_url.clone(), store.api_key.clone(), active_holidays(&store, years), pending)
    };

    let result = (|| {
        if !pending.is_empty() {
            remote::call(&url, &key, "setDays", json!({ "days": pending })).map_err(|e| e.message())?;
            update_store(app, |s| {
                // Only clear dates that weren't changed again while we were sending.
                for (date, sent) in &pending {
                    if s.days.get(date).cloned().unwrap_or_default() == *sent {
                        s.dirty.remove(date);
                    }
                }
            })?;
        }
        remote::call(&url, &key, "sync", json!({ "holidays": holidays })).map_err(|e| e.message())
    })();

    let data = match result {
        Ok(data) => data,
        Err(err) => {
            let _ = update_store(app, |s| s.sync_error = err.clone());
            return Err(err);
        }
    };
    if data.get("days").is_none() {
        let err = "Your sheet has the old Narra script. Paste the new one (Settings → Google Sheet → Copy script) and deploy a new version.".to_string();
        let _ = update_store(app, |s| s.sync_error = err.clone());
        return Err(err);
    }
    let sheet_days: BTreeMap<String, Day> = serde_json::from_value(data["days"].clone()).map_err(|e| e.to_string())?;
    let covered: Vec<String> = serde_json::from_value(data["covered"].clone()).unwrap_or_default();
    update_data(app, |s| {
        s.sheet_url = data["sheetUrl"].as_str().unwrap_or_default().to_string();
        s.sheet_name = data["sheetName"].as_str().unwrap_or_default().to_string();
        s.synced_at = Some(now_ms());
        s.sync_error.clear();
        if follow {
            for date in covered {
                if s.dirty.contains(&date) {
                    continue; // changed in Narra since; it goes out on the next sync
                }
                match sheet_days.get(&date) {
                    Some(day) => {
                        s.days.insert(date, day.clone());
                    }
                    None => {
                        s.days.remove(&date);
                    }
                }
            }
        }
        Ok(())
    })?;
    Ok(data)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && date.bytes().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn check_day(day: &Day) -> Result<(), String> {
    if let Some(kind) = &day.kind {
        if !["leave", "holiday", "off"].contains(&kind.as_str()) {
            return Err(format!("Unknown day type: {kind}"));
        }
    }
    if let Some(h) = day.hours {
        if !(0.0..=24.0).contains(&h) {
            return Err("Hours must be between 0 and 24.".into());
        }
    }
    for s in &day.sessions {
        if let Some(end) = s.end {
            if end <= s.start {
                return Err("Each time out must be after its time in.".into());
            }
        }
    }
    Ok(())
}

// ---- Commands ----

#[tauri::command]
fn load(app: AppHandle) -> View {
    view(&app)
}

/// Time In / Time Out. `date` is the Eastern date the session belongs to (computed by the
/// UI, which knows time zones); `at` is set when the user picked the time themselves.
#[tauri::command]
fn punch(app: AppHandle, kind: String, date: String, at: Option<i64>) -> Result<View, String> {
    let now = now_ms();
    let picked = at.is_some();
    let at = to_minute(at.unwrap_or(now));
    if at > now + 60_000 {
        return Err("That time is in the future.".into());
    }
    if now - at > 24 * 60 * 60 * 1000 {
        return Err("Pick a time within the last 24 hours, or edit the day in Timesheets.".into());
    }
    if !valid_date(&date) {
        return Err(format!("Bad date: {date}"));
    }
    update_data(&app, |s| {
        match kind.as_str() {
            "in" => {
                if s.open_session().is_some() {
                    return Err("You're already timed in. Time out first.".into());
                }
                if s.sheet_mode() {
                    s.dirty.insert(date.clone());
                }
                let day = s.days.entry(date).or_default();
                // Working on a leave/holiday day: log real hours instead of the credit.
                day.kind = None;
                day.hours = None;
                day.sessions.push(Session { start: at, end: None });
                day.sessions.sort_by_key(|x| x.start);
                Ok(())
            }
            "out" => {
                let d = s.time_out(at, picked)?;
                if s.sheet_mode() {
                    s.dirty.insert(d);
                }
                Ok(())
            }
            other => Err(format!("Unknown punch: {other}")),
        }
    })
    .map(|(_, view)| view)
}

/// Replace one day from the editor (an empty day is removed).
#[tauri::command]
fn save_day(app: AppHandle, date: String, day: Day) -> Result<View, String> {
    if !valid_date(&date) {
        return Err(format!("Bad date: {date}"));
    }
    check_day(&day)?;
    let mut day = day;
    for s in day.sessions.iter_mut() {
        s.start = to_minute(s.start);
        s.end = s.end.map(to_minute);
    }
    day.sessions.sort_by_key(|x| x.start);
    update_data(&app, |s| {
        let open_elsewhere = s.open_session().map(|(d, _)| d != date).unwrap_or(false);
        if open_elsewhere && day.sessions.iter().any(|x| x.end.is_none()) {
            return Err("Another day still has an open session. Time out there first.".into());
        }
        if s.sheet_mode() {
            s.dirty.insert(date.clone());
        }
        if day.is_empty() {
            s.days.remove(&date);
        } else {
            s.days.insert(date, day);
        }
        Ok(())
    })
    .map(|(_, view)| view)
}

/// Set or clear the private note on a day. Notes stay in Narra: not in the PDF, and the
/// date isn't marked for sheet sync.
#[tauri::command]
fn save_note(app: AppHandle, date: String, text: String) -> Result<View, String> {
    if !valid_date(&date) {
        return Err(format!("Bad date: {date}"));
    }
    update_data(&app, |s| s.set_note(&date, &text)).map(|(_, view)| view)
}

/// Add days imported from the Google Sheet. Days already in Narra are kept as they are.
#[tauri::command]
fn import_days(app: AppHandle, days: BTreeMap<String, Day>) -> Result<(usize, View), String> {
    for (date, day) in &days {
        if !valid_date(date) {
            return Err(format!("Bad date: {date}"));
        }
        check_day(day)?;
    }
    update_data(&app, |s| {
        let mut added = 0;
        for (date, day) in days {
            if !day.is_empty() && !s.days.contains_key(&date) {
                s.days.insert(date, day);
                added += 1;
            }
        }
        Ok(added)
    })
}

#[tauri::command]
fn set_profile(app: AppHandle, name: String, rate: Option<f64>) -> Result<View, String> {
    if let Some(r) = rate {
        if !(r > 0.0 && r < 10_000_000.0) {
            return Err("Enter your monthly rate as a positive number, e.g. 1600.".into());
        }
    }
    update_data(&app, |s| {
        s.name = name.trim().to_string();
        s.monthly_rate = rate;
        Ok(())
    })
    .map(|(_, view)| view)
}

#[tauri::command]
fn save_sheet_link(app: AppHandle, api_url: String, api_key: Option<String>) -> Result<View, String> {
    update_store(&app, |s| {
        s.api_url = api_url.trim().to_string();
        if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
            s.api_key = key.trim().to_string();
        }
    })?;
    let view = view(&app);
    broadcast(&app, &view);
    Ok(view)
}

/// Sheet mode: push local changes and follow the sheet. Local mode: just read it (for
/// importing). Returns the sheet's reply (days, owner name, monthly rate, notes).
#[tauri::command]
async fn sheet_sync(app: AppHandle, years: Vec<i32>) -> Result<Value, String> {
    blocking(move || {
        let follow = app.state::<AppState>().store.lock().unwrap().sheet_mode();
        sheet_sync_blocking(&app, &years, follow)
    })
    .await?
}

/// The first Narra script returned tab snapshots instead of days; kept for importing.
#[tauri::command]
fn legacy_snapshot(app: AppHandle) -> Option<Value> {
    app.state::<AppState>().store.lock().unwrap().snapshot.clone()
}

/// Finish onboarding (or change settings later): who, pay, and where the timesheet lives.
#[tauri::command]
fn set_mode(app: AppHandle, mode: String) -> Result<View, String> {
    if mode != "local" && mode != "sheet" {
        return Err(format!("Unknown mode: {mode}"));
    }
    update_data(&app, |s| {
        if mode == "sheet" && !s.sheet_mode() {
            // Everything already in Narra should reach the sheet too.
            s.dirty = s.days.keys().cloned().collect();
        }
        if mode == "local" {
            s.dirty.clear();
            s.sync_error.clear();
        }
        s.mode = mode;
        Ok(())
    })
    .map(|(_, view)| view)
}

/// The Apps Script users paste into their sheet (bundled so the guide can copy it).
const SHEET_SCRIPT: &str = include_str!("../../apps-script/Code.gs");

#[tauri::command]
fn copy_sheet_script() -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().unwrap().write_all(SHEET_SCRIPT.as_bytes()).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

/// Write a timesheet PDF (built by the UI) to ~/Documents/timesheets and open it.
#[tauri::command]
fn save_pdf(app: AppHandle, file_name: String, content: String, open: bool) -> Result<String, String> {
    let bad = file_name.contains('/') || file_name.contains("..") || !file_name.ends_with(".pdf");
    if bad {
        return Err("Bad file name".into());
    }
    let path = documents(&app)?.join(PDF_DIR).join(&file_name);
    // The PDF is 7-bit ASCII by construction; each char is one byte.
    if !content.is_ascii() {
        return Err("PDF content must be ASCII".into());
    }
    write_atomic(&path, &content)?;
    if open {
        app.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(path.display().to_string())
}

/// Timesheet PDFs already in ~/Documents/timesheets, newest first.
#[tauri::command]
fn list_pdfs(app: AppHandle) -> Result<Vec<SavedPdf>, String> {
    let dir = documents(&app)?.join(PDF_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut out: Vec<SavedPdf> = entries
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "pdf").unwrap_or(false))
        .map(|e| SavedPdf {
            name: e.file_name().to_string_lossy().to_string(),
            path: e.path().display().to_string(),
            modified: e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Open a saved PDF (only files inside ~/Documents/timesheets) or reveal the folder.
#[tauri::command]
fn open_saved(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let dir = documents(&app)?.join(PDF_DIR);
    match path {
        Some(p) => {
            let p = PathBuf::from(p);
            if p.parent() != Some(dir.as_path()) {
                return Err("Can only open files in the timesheets folder".into());
            }
            app.opener().open_path(p.display().to_string(), None::<&str>).map_err(|e| e.to_string())
        }
        None => {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
async fn holidays(app: AppHandle, year: i32) -> Result<Vec<HolidayView>, String> {
    blocking(move || {
        ensure_official(&app, year);
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        holiday_views(&store, year)
    })
    .await
}

#[tauri::command]
fn set_holiday(app: AppHandle, date: String, name: String, enabled: bool) -> Result<(), String> {
    update_store(&app, |s| {
        let official = s.official.values().any(|y| y.list.iter().any(|h| h.date == date));
        s.custom.retain(|h| h.date != date);
        s.removed.retain(|d| d != &date);
        if official && !enabled {
            s.removed.push(date);
        } else if !official && enabled {
            s.custom.push(Holiday { date, name });
        }
    })
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())?;
    launcher.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Menu-bar text (e.g. running session length) and the punch item's label.
#[tauri::command]
fn set_tray(app: AppHandle, title: String, clocked_in: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_title(if title.is_empty() { None } else { Some(title) }).map_err(|e| e.to_string())?;
    }
    let items = app.state::<TrayItems>();
    items
        .punch
        .set_text(if clocked_in { "Time Out" } else { "Time In" })
        .map_err(|e| e.to_string())
}

fn notify(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Called by the windows every ~30s with today's live numbers. Sends the clock-out
/// reminder once the day passes the threshold, then every half hour until Time Out.
#[tauri::command]
fn reminder_tick(app: AppHandle, date: String, open: bool, hours: f64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let threshold = {
        let store = state.store.lock().unwrap();
        if store.remind_off {
            return Ok(());
        }
        store.remind_hours()
    };
    if !open || hours < threshold {
        return Ok(());
    }
    let step = ((hours - threshold) / REMIND_EVERY_HOURS).floor() as i64;
    {
        let mut reminded = state.reminded.lock().unwrap();
        if matches!(&*reminded, Some((d, s)) if *d == date && *s >= step) {
            return Ok(());
        }
        *reminded = Some((date, step));
    }
    let worked = format!("{:.1}", hours);
    if step == 0 {
        notify(&app, "Time to time out?", &format!("You've worked {worked} hours today. Don't forget to time out in Narra."))
    } else {
        notify(&app, "Still clocked in", &format!("{worked} hours today and counting. Time out in Narra when you're done."))
    }
}

#[tauri::command]
fn set_reminder(app: AppHandle, enabled: bool, hours: f64) -> Result<View, String> {
    if !(0.5..=24.0).contains(&hours) {
        return Err("Pick between 0.5 and 24 hours.".into());
    }
    update_store(&app, |s| {
        s.remind_off = !enabled;
        s.remind_hours = Some(hours);
    })?;
    // A new threshold starts the reminders fresh.
    *app.state::<AppState>().reminded.lock().unwrap() = None;
    let view = view(&app);
    broadcast(&app, &view);
    Ok(view)
}

#[tauri::command]
fn test_reminder(app: AppHandle) -> Result<(), String> {
    notify(&app, "Time to time out?", "This is how Narra will remind you when your day is done.")
}

/// Bring up the main window, optionally on a given page ("settings", "timesheets", …).
#[tauri::command]
fn show_main_view(app: AppHandle, view: Option<String>) {
    show_main(&app);
    if let Some(page) = view {
        let _ = app.emit_to("main", "navigate", page);
    }
}

#[tauri::command]
fn set_widget(app: AppHandle, visible: bool) -> Result<bool, String> {
    update_store(&app, |s| s.widget_hidden = !visible)?;
    apply_widget(&app, visible).map_err(|e| e.to_string())?;
    let _ = app.state::<TrayItems>().widget.set_checked(visible);
    Ok(visible)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Show (creating on first use) or hide the desktop widget: a small frameless window on
/// HUD glass that sits below other windows on every Space. Its position is remembered.
fn apply_widget(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WIDGET) {
        return if visible { window.show() } else { window.hide() };
    }
    if !visible {
        return Ok(());
    }
    // Default: under the stock widgets at the top-left of the desktop.
    let (x, y) = app.state::<AppState>().store.lock().unwrap().widget_pos.unwrap_or((24.0, 380.0));
    let window = WebviewWindowBuilder::new(app, WIDGET, WebviewUrl::App("widget.html".into()))
        .title("Narra Widget")
        .inner_size(WIDGET_SIZE.0, WIDGET_SIZE.1)
        .position(x, y)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .skip_taskbar(true)
        .focused(false)
        .accept_first_mouse(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::HudWindow)
                .state(EffectState::Active)
                .radius(22.0)
                .build(),
        )
        .build()?;
    #[cfg(target_os = "macos")]
    pin_to_desktop(&window);
    Ok(())
}

/// Put the widget in the desktop layer, just above the desktop icons, and make it
/// "stationary": Show Desktop / clicking the wallpaper slides every other window away
/// but leaves this one in place, and it appears on every Space — like macOS widgets.
#[cfg(target_os = "macos")]
fn pin_to_desktop(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowLevelForKey(key: i32) -> i32;
    }
    const DESKTOP_ICON_LEVEL_KEY: i32 = 18; // kCGDesktopIconWindowLevelKey

    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || unsafe {
        let ns_window = &*(ptr as *const NSWindow);
        ns_window.setLevel((CGWindowLevelForKey(DESKTOP_ICON_LEVEL_KEY) + 1) as isize);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("store.json");
            app.manage(AppState {
                store: Mutex::new(Store::load(&path)),
                path,
                net: Mutex::new(()),
                reminded: Mutex::new(None),
            });

            let punch = MenuItem::with_id(app, "punch", "Time In", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open Narra", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Narra", true, None::<&str>)?;
            let widget_on = !app.state::<AppState>().store.lock().unwrap().widget_hidden;
            let widget = CheckMenuItem::with_id(app, "widget", "Desktop Widget", true, widget_on, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&punch, &show, &separator, &widget, &separator2, &quit])?;
            app.manage(TrayItems { punch, widget });

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Narra")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "punch" => {
                        let _ = app.emit("tray-punch", ());
                    }
                    "show" => show_main(app),
                    "widget" => {
                        // The check mark has already toggled; make the widget follow it.
                        let visible = app.state::<TrayItems>().widget.is_checked().unwrap_or(true);
                        if set_widget(app.clone(), visible).is_ok() {
                            broadcast(app, &view(app));
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            apply_widget(app.handle(), widget_on)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing a window keeps the clock running in the menu bar.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Remember where the widget was dragged.
            WindowEvent::Moved(pos) if window.label() == WIDGET => {
                let scale = window.scale_factor().unwrap_or(1.0);
                let logical = pos.to_logical::<f64>(scale);
                let _ = update_store(window.app_handle(), |s| s.widget_pos = Some((logical.x, logical.y)));
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load,
            punch,
            save_day,
            save_note,
            import_days,
            set_profile,
            save_sheet_link,
            sheet_sync,
            legacy_snapshot,
            set_mode,
            copy_sheet_script,
            save_pdf,
            list_pdfs,
            open_saved,
            holidays,
            set_holiday,
            set_autostart,
            open_url,
            set_tray,
            set_widget,
            show_main_view,
            reminder_tick,
            set_reminder,
            test_reminder
        ])
        .build(tauri::generate_context!())
        .expect("error while building Narra")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                show_main(app);
            }
        });
}
