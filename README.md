# Narra

A menu-bar time clock for the biweekly timesheet: Time In / Time Out, a desktop widget,
PH holidays credited as 8 hours, expected pay, and a PDF in the usual timesheet layout.
Works on its own ("On this Mac"), or kept in sync with a Google Sheet.

## Install (no building needed)

1. Download **`Narra_x.y.z_universal.dmg`** from the
   [latest release](https://github.com/renzoyyan/narra/releases/latest)
   (or the copy shared with you). It runs on Apple Silicon and Intel Macs.
2. Open the `.dmg` and drag **Narra** into **Applications**.
3. Open Narra from Applications. macOS will say it can't verify the app, because it
   isn't signed with a paid Apple Developer account. One time only:
   - Click **Done** (not "Move to Trash").
   - Open **System Settings → Privacy & Security**, scroll down to
     *"Narra" was blocked…*, click **Open Anyway**, then **Open Anyway** again and enter
     your Mac password.
4. Narra opens and asks for your name and monthly rate, then where your timesheet
   lives. Pick **On this Mac** unless you want a Google Sheet kept up to date too
   (the app walks you through that).

After that it lives in the menu bar (the tree icon). Closing the window keeps it running.

> Terminal alternative for step 3: `xattr -dr com.apple.quarantine /Applications/Narra.app`

## Project layout

- `ui/`: plain HTML/CSS/JS front end (no bundler).
- `src-tauri/`: Rust backend (store, holidays, tray, widget, notifications).
- `apps-script/Code.gs`: the optional Google Sheets bridge users paste into their sheet.
- `scripts/`: icon generation and `reset-narra.sh` for testing onboarding.

## How it works

- First launch: onboarding asks for name + monthly rate, then where the timesheet lives:
  - **On this Mac** (recommended): days are stored in the app's `store.json` and backed up to
    `~/Documents/Narra/narra-backup.json` after every change. *Download PDF* writes the
    timesheet (same layout as the Google Sheets template's PDF) to `~/Documents/timesheets/`.
  - **Google Sheet sync**: every change is also written to the user's sheet, and edits made in
    the sheet come back on the next sync (the sheet wins for dates it has rows for). Setup guide
    and *Copy script* are built into the app.
- `apps-script/Code.gs` finds the sheet's layout itself (header labels "Time In", "Time Out",
  "Total", "Day/Date"; date rows; rows per day), so it works on any copy of the template.
  Deploy as a web app: Execute as **Me**, access **Anyone** (the app key protects it).
- Pay (same formula as the template): `rate / 2 + 1.3 × (rate / 160) × overtime`, overtime =
  hours beyond 8 × weekdays in the period. The app shows the formula with the real numbers.

## Build from source (developers)

Needs Rust (`rustup`), Node 20+ and the Xcode Command Line Tools.

```bash
pnpm install
rustup target add x86_64-apple-darwin      # once, for the universal build
npx tauri build --target universal-apple-darwin --bundles app,dmg
# → src-tauri/target/universal-apple-darwin/release/bundle/dmg/Narra_<version>_universal.dmg
```

After changing `Code.gs`: paste it into the Apps Script editor, save, then
**Deploy → Manage deployments → Edit → Version: New version** (same URL).

## Behaviour

- Expected pay is computed in the app with the template's formula: `rate / 2 + 1.3 × (rate / 160) × overtime`,
  overtime = hours beyond 8 × weekdays in the period. Each person sets their monthly rate in
  Settings (falls back to the rate typed in their sheet).
- The sheet script works on the spreadsheet it's bound to, so colleagues can use
  *File → Make a copy* of the template, deploy their copy, and paste its URL + key into Narra.

- Times are Eastern (the template asks for it). Each day has 2 slots (before/after lunch).
- Punches are stored locally first (`~/Library/Application Support/com.renz.narra/store.json`)
  and sent in order; offline punches keep their original time.
- A tab still holding an older period is copied to a hidden tab (e.g. `16-30 (Jun 2026)`),
  then reset with new dates, "--" weekends, and restored TOTAL HOURS formulas.
- Weekday PH holidays (Nager.Date + your additions − ones you switch off) get
  "Holiday" in the time cells and 8 in TOTAL HOURS. Clocking in on a holiday replaces that.
- Clock-out reminder: macOS notification once today passes the threshold (default 8 h, Settings),
  then every 30 min while still clocked in. Both windows report ticks; the backend dedupes.
- Desktop widget (`ui/widget.*`): frameless HUD-glass window, always below other windows,
  on every Space. Drag it anywhere; its position is saved in store.json (`widget_pos`).
  Toggle it from the menu-bar icon → Desktop Widget, or Settings.
- `ui/shared.js` holds time helpers and derived state used by both windows. Each window
  listens for the `view` event the backend emits after every punch/sync.
