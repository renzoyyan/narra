# Day notes — design

Date: 2026-09-30 · Requested by Lei · Status: approved

## Goal

Let the user keep a private note on any day for their own reference, e.g. "Clocked in early
for the client call" or "Filed emergency leave". Notes are editable at any time and never
appear in the timesheet PDF or the Google Sheet.

## Decisions

- **One note per day**, keyed by the timesheet date (New York date, `yyyy-mm-dd`), the same
  key as `Store::days`.
- **Stored apart from the time data**: `Store::notes: BTreeMap<String, String>`, not a field
  on `Day`. Replacing a day (day editor, sheet sync, same-minute time-out drop, import) can
  therefore never wipe a note, and a note can exist on a day with no hours (e.g. future leave).
- **Private**: not sent to the Google Sheet, not in the PDF. Included in the local backup
  (`~/Documents/Narra/narra-backup.json`) so it survives a reinstall.
- **Rules**: text is trimmed; saving empty text deletes the note; max 500 characters
  (longer is refused with a message, not silently cut).

## Backend (Rust)

- `store.rs`
  - `Store.notes: BTreeMap<String, String>` (`#[serde(default)]` via the struct default, so
    existing `store.json` files load unchanged).
  - `Store::set_note(&mut self, date: &str, text: &str) -> Result<(), String>`: trim; empty →
    remove; over 500 chars → error "Keep notes under 500 characters.".
  - `backup_json()` gains `"notes"`.
- `main.rs`
  - `View.notes` (clone of `store.notes`), so both windows get notes with every `view` event.
  - Command `save_note(date, text) -> View`: validates the date (`valid_date`), calls
    `set_note` through `update_data` (saves, backs up, broadcasts). Does **not** mark the date
    dirty for sheet sync.

## Front end

- `shared.js`: `noteFor(view, date)` → string ('' when none); `saveNote(invoke, date, text)`.
- **Today screen** (`index.html`, `app.js`, `style.css`): a single-line, auto-growing textarea
  under the hero with placeholder "Add a note for today (only you see this)". Saves on blur
  and on Enter (Shift+Enter = new line); shows a quiet "Saved" for ~2 s. Not overwritten by an
  incoming `view` event while it has focus.
- **Timesheets table**: a new last column with a note button per row.
  - Has note → filled note icon, `title` shows the text.
  - No note → faint outline icon, visible on row hover (and keyboard focus).
  - Click (stops the row's open-editor click) → a small note dialog (same pattern as the
    day editor) with a textarea, **Save**, **Cancel** and **Delete** (Delete only when a note
    exists). Esc closes; ⌘Enter saves.
  - The PDF is built from `period.days`, which has no notes, so nothing changes there.
- **Desktop widget** (`widget.html/.css/.js`): a small note icon button in the header next
  to the status pill (filled when today has a note). Clicking swaps the main area to a note
  pane (same pattern as "Set time…"): one text field + Save + ✕. Enter saves; flash
  "Note saved" / "Note removed".

## Error handling

- Backend errors (bad date, too long) come back as strings and show in the existing toast
  (main window) or flash (widget). The field keeps the user's text so nothing is lost.

## Testing

- Rust unit tests in `store.rs`: add, edit, trim, delete-by-empty, too-long refused, note
  survives `time_out` dropping the day's session, `backup_json` includes notes, an old
  `store.json` without `notes` loads.
- UI: browser-pane preview of the widget note pane and a Timesheets row (static harness, as
  for the widget colours), then a release build for the user to try on the desktop.

## Out of scope

- Notes per time entry, note search/history, syncing notes to the Google Sheet.
