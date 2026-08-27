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
    `needsWeekendShift`, `dateLabel`, `isWeekendISO`.
  - **Scheduler**: `buildSchedule(start, end, names, holidays, unavailable)`
    -> `{ rows, counts }`. The only place shift-allocation rules live (even
    distribution, rest rules, weekend separation, availability).
  - **Export**: `exportToXLS(rows, counts, names, unavailable)` -> HTML string;
    `downloadXLS(...)` wraps it in a Blob and triggers the download.
  - **UI/wiring**: `renderPreview`, `renderCounts`, `renderRecordsList`,
    `init`. These are the only DOM-touching functions.
- `index.html`, `style.css` — shell and styling.
- `wrangler.toml` — optional Cloudflare Pages config.

Pure logic (`buildSchedule`, parsers, `exportToXLS`, date helpers) must stay
DOM-free so they can run in Node for headless validation.

## Key data shapes (do not change)

- `unavailable` is `{ name: { iso: [note, ...] } }`, where `iso` is `"YYYY-MM-DD"`.
  A colleague is treated as unavailable on `(name, date)` regardless of note text.
- Dates are **ISO strings** (`"YYYY-MM-DD"`) everywhere in the engine, NOT JS
  `Date`, to avoid timezone bugs. Helpers: `dayPlus`, `isoWeekday`,
  `isWeekendISO`, `dateLabel`. `dateLabel` yields `星期四 2026 07 23`; keep the
  leading Chinese weekday.
- Column/field keys in rows: `date`, `label`, `isWeekend`, `morning`,
  `deployment`, `weekend`, `notAvailable`. Keep them identical between preview
  and export strings.

## Conventions & gotchas

- Unavailability UI state is a module-level `records` array of
  `{name, date, note}`; `updateAll()` converts it to the engine `unavailable`
  shape on every render and rebuilds the preview + records list. Records are
  in-memory only (reset on reload — no storage).
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