# AGENTS.md

## What this is

SAT — a **zero-dependency, browser-only** shift-scheduling tool. Static
`index.html` + `sat.js` + `style.css`; no build system, no backend, no server,
no tests. It generates a duty schedule and exports a styled, Excel-compatible
`.xls` (HTML-table format) entirely in the browser. Deploys to Cloudflare Pages
as plain static files.

## Commands

- Serve locally: `python -m http.server 8501` (no dependencies), or any static
  server. Open `http://localhost:8501`.
- Validate the engine headlessly with Node (no browser needed): `node sat.js`
  exports `buildSchedule` only when run in a test harness; the pure functions
  are module-scoped and have no DOM dependency. See "Validation" below.
- Deploy: `wrangler pages deploy . --project-name sat-shift-schedule`, or Git
  integration (build output dir `/`).

## Architecture (files)

- `sat.js` keeps concerns in these exact functions:
  - **Parsing**: `parseNames`, `parseHolidays`, `needsWeekdayShift`,
    `needsWeekendShift`, `dateLabel`, `isWeekendISO`, `resolveDateExpr`,
    `groupContiguous`, `parseManualShifts`, `parseManualDeployments`.
  - **Derivation**: `deriveFromRecords(records, s, e)` maps the unified
    `records` array into `{ holidaysAdded, unavailable, manualShifts }`. This is
    the ONLY place records become engine inputs.
  - **Scheduler**: `buildSchedule(start, end, names, holidays, unavailable,
    manualShifts)` -> `{ rows, counts }`. The only place shift-allocation rules
    live (per-scope even distribution on m/d/t/wsat/wsun/h, rest rules,
    weekend successiveness across adjacent weekend-shift days, availability,
    manual-shift handling, Rule-10 total-shift balancing).
  - **Export**: `exportToXLS(rows, counts, names, unavailable)` -> HTML string;
    `downloadXLS(...)` wraps it in a Blob and triggers the download.
  - **UI/wiring**: `renderPreview`, `renderCounts`, `renderRecordsList`,
    `submitUnifiedRecord`, `init`. These are the only DOM-touching functions.
- `index.html`, `style.css` — shell and styling.
- `wrangler.toml` — optional Cloudflare Pages config.

Pure logic (`buildSchedule`, `deriveFromRecords`, parsers/date helpers via
`resolveDateExpr`/`expandRange`, `exportToXLS`) must stay DOM-free so it can run
in Node for headless validation.

## Key data shapes (do not change)

- The engine inputs are produced by `deriveFromRecords` from the unified
  `records` array. Each record is `{type, name, start, end, note}`:
  - `type: 'holiday'` with `name` empty → those dates become holidays; with a
    `name` → also `unavailable` for that person (note `"Holiday"`).
  - `type: 'deploy' | 'morning' | 'weekend'` → a manual-shift lock for `name`
    on those dates.
- `unavailable` is `{ name: { iso: [note, ...] } }`, where `iso` is `"YYYY-MM-DD"`.
  A colleague is treated as unavailable on `(name, date)` regardless of note text.
- `manualShifts` is `{ morning, deployment, weekend }`, each `{ iso: { name,
  manual: true } }` — first wins per date. Passed as the 6th arg to
  `buildSchedule`.
- `counts[n]` per colleague carries SIX independent fairness scopes plus two
  derived totals:
  `{ morning, deployment, thursday, wsat, wsun, hcount, weekend, total }`.
  `weekend = wsat + wsun + hcount` and `total = morning + deployment + weekend`
  are always kept consistent with the leaves (see `addCount`/`syncDerivedCounts`).
  - `morning` = morning health check.
  - `deployment` = any deployment day (incl. Thursdays).
  - `thursday` = deployments falling on Thursday only (its own fair scope `t`).
  - `wsat`/`wsun` = Weekend Support on Saturday/Sunday respectively.
  - `hcount` = Weekend Support on a holiday that falls on a weekday (Mon–Fri).
  Fairness balances EACH scope independently (its own 1_000_000-weighted evenness),
  so "4 Saturdays / N staff" is split evenly without being diluted by Sundays.
  `weekendScope(iso, holidays)` → `'wsat' | 'wsun' | 'hcount'` classifies a
  weekend-shift day; only call it on days where `needsWeekendShift` is true.
- Dates are **ISO strings** (`"YYYY-MM-DD"`) everywhere in the engine, NOT JS
  `Date`, to avoid timezone bugs. Helpers: `dayPlus`, `isoWeekday`,
  `isWeekendISO`, `dateLabel`. `dateLabel` yields `星期四 2026 07 23`; keep the
  leading Chinese weekday.
- Column/field keys in rows: `date`, `label`, `isWeekend`, `morning`,
  `morningManual`, `deployment`, `deploymentManual`, `weekend`,
  `weekendManual`, `notAvailable`. Keep them identical between preview and
  export strings.

## Conventions & gotchas

- All user input flows through one **Add Record** form (`#rec-kind` +
  `#rec-line`) into a module-level `records` array; each entry carries a `type`
  as described above. The single recompute entry `updateAll()` calls
  `deriveFromRecords(records, s, e)` to rebuild `unavailable`/`manualShifts`/
  holidays, then re-renders the preview, counts, matrix, and records list.
  Records are in-memory only (reset on reload — no storage).
- **Deployment locks are honored on any day type** (weekend/holiday included).
  A saved `deploy` record always puts that person in the Deployment column that
  day; auto-Deployment runs on weekdays only. The auto Weekend-morning pool
  excludes the day's deployment person so the same colleague is not
  double-booked into both shifts that day.
- Manual-shift records and holidays are deduped by
  `{type}|{name}|{start}|{end}` when submitted; first manual lock wins per date.
- Rest-rule bookkeeping must rebuild the block-set **each day** (a person from
  the prior day is blocked only for the next day's morning). It must NEVER
  accumulate across days — this was a real bug in the prototype.
- Weekend detection reuses `needsWeekendShift` (Sat/Sun **and** holidays get
  the peach tile/`#FBE5D6`). Not-available cells turn orange `#FCE4D6`.
- `updateAll()` is the single "recompute everything" entry — every input change
  calls it. New inputs must be added there.
- The `.xls` header/fill colors live in `exportToXLS` as literal hex values;
  keep them in sync with `style.css` if you change the palette.

## Legacy (do not extend)

`app.py` + `requirements.txt` are the original **Streamlit** prototype (same
rules, true `.xlsx` via openpyxl, functions `build_schedule`/`export_excel`).
Kept only as a reference/validation harness — it is NOT the shipped app and the
user may remove it. Do not route new work through it.