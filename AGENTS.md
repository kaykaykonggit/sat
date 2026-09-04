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
    weekend successiveness across adjacent weekend-shift days (relaxed to allow
    a wsat+wsun pair; see `successivenessAllowed`), availability,
    manual-shift handling, the 3-consecutive-Deployment ceiling (a 2-day run is
    tolerated; a 3rd calendar-day run is a HARD red — see `computeFlags` /
    `validateAll`), the same-day Morning+Deployment relief that routes an
    unavoidable double onto a willing `mPlusDAccepted` volunteer (default
    Andy), the coverage-first "Sudoku" pre-scans, and Rule-10 total-shift
    balancing). The greedy's fair-pair search weights 3-day streaks above
    evenness (`DEPCONSEC3_W`), so deployment is spread out first.
  - **Post-passes** (pure row relocations, all gated by `validateAll` so hard
    rules never break): `reduceFatigue` (count-preserving local swaps that
    strip tiring orderings), `neighborRelax` (relieve the days adjacent to a
    forced same-day M+D row), `relieveTandems` (unwind ANY ">=3 duties in two
    consecutive days" tandem by relocating one adjacent cell; scans every row
    per pass so every occurrence is handled — not just the first few), and
    `rule10Pass` (cross-axis total-spread equalization within MAX_SPREAD).
  - **Flagging**: `validateAll` (full-range hard-rule check used to gate every
    swap) and `computeFlags` (writes the human-readable "must bear it" message
    into `row.forced` for the renderer).
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
  `weekend = wsat + wsun + hcount` and
  `total = morning + deployment + wsat + wsun + hcount` (a Thursday deployment
  counts ONLY in the independent `thursday` scope — via `addDeployCount` — and
  is NOT reflected in `deployment` nor `total`) are always kept consistent with
  the leaves (see `addCount`/`syncDerivedCounts`).
  - `morning` = morning health check.
  - `deployment` = non-Thursday deployment days.
  - `thursday` = deployments falling on Thursday only (its own fair scope `t`).
  - `wsat`/`wsun` = Weekend Support on Saturday/Sunday respectively.
  - `hcount` = Weekend Support on a holiday that falls on a weekday (Mon–Fri).
  Fairness balances EACH scope independently (檔1 = wsat/wsun/t/hcount at
  1_000_000, 檔2 = m/d at 30_000; 檔1 dominance means Thursday stays even before
  a Morning pairing is consulted), so "4 Saturdays / N staff" is split evenly
  without being diluted by Sundays. `weekendScope(iso, holidays)` →
  `'wsat' | 'wsun' | 'hcount'` classifies a weekend-shift day; only call it on
  days where `needsWeekendShift` is true.
- Dates are **ISO strings** (`"YYYY-MM-DD"`) everywhere in the engine, NOT JS
  `Date`, to avoid timezone bugs. Helpers: `dayPlus`, `isoWeekday`,
  `isWeekendISO`, `dateLabel`. `dateLabel` yields `星期四 2026 07 23`; keep the
  leading Chinese weekday.
- Column/field keys in rows: `date`, `label`, `isWeekend`, `morning`,
  `morningManual`, `morningForced`, `deployment`, `deploymentManual`,
  `weekend`, `weekendManual`, `weekendForced`, `notAvailable`. Keep them
  identical between preview and export strings.

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
- **3-consecutive-Deployment ceiling**: 2 consecutive calendar-day Deployments
  by the same person is the tolerated upper bound; a THIRD is a HARD red
  (`computeFlags` and `validateAll`, both exempting a `deploymentSudoku`-forced
  day because coverage wins). The greedy's `DEPCONSEC3_W` (just above the 檔2
  tier weight) makes it spread deployment first, so the red only surfaces as a
  genuine last-resort when spreading is physically impossible. `relieveTandems`
  further unwinds any residual ">=3 duties in two days" tandem (e.g. a same-day
  M+D followed by a Deployment) by relocating one adjacent cell, gated by
  `validateAll` + per-scope spread.
- **Same-day Morning+Deployment relief**: when coverage is tight enough that the
  greedy must book one person into BOTH shifts on a day, it prefers routing that
  double onto a colleague listed in the "Same-day Morning + Deployment" box
  (`mPlusDAccepted`, default `Andy`) — the volunteer's `SAME_W` penalty is
  dropped and a ladder override hands them the double. This is a red/fatigue
  relief valve, NOT a total-spread optimizer: it concentrates heavy m+d days on
  the willing volunteer to cut red flags, without regressing 檔2 (m/d) per-scope
  spreads or violating availability.
- Manual-shift records and holidays are deduped by
  `{type}|{name}|{start}|{end}` when submitted; first manual lock wins per date.
- Rest-rule bookkeeping must rebuild the block-set **each day** (a person from
  the prior day is blocked only for the next day's morning). It must NEVER
  accumulate across days — this was a real bug in the prototype.
- **Coverage-first invariant ("Sudoku")**: a required shift cell (weekend
  support on a weekend-shift day, or Morning/Deployment on a workday) is NEVER
  left blank while any colleague is available. On each day the Successiveness,
  Rule-1 (differ from yesterday's Deployment), rest-rule, and avoid-double-book
  checks are relaxed one level at a time so the sole available colleague covers
  the shift even if it breaks a preference. When a relaxation is needed the row
  is flagged `morningForced`/`weekendForced`, and `validateAll` CARVES OUT those
  forced rows (exempts them from the rule they broke) so the post-passes
  (`rebalance`, `reduceFatigue`, `rule10Pass`) are not disabled by a legitimate
  forced assignment and do not try to "fix" it back into a blank. Availability
  remains the only hard, never-relaxed constraint.
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