/* ============================================================================
   SAT — Shift Arrangement Tool (browser, zero-dependency)
   ----------------------------------------------------------------------------
   Ported from the Python prototype. Keep the scheduling rules identical.

   Dates are represented as ISO strings "YYYY-MM-DD" to avoid JS Date
   timezone pitfalls. Helper functions wrap parsing/day-math/formatting.
   ========================================================================== */

/* ------------------------- Date helpers (ISO-string based) --------------- */

const DAY_MS = 86400000;

function toISO(d) {
  if (typeof d === "string") return d;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12); // noon to dodge DST edge cases
}

function isoDay(offsetFromToday = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetFromToday);
  return toISO(d);
}

function dayPlus(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function expandRange(startISO, endISO) {
  const out = [];
  for (let d = startISO; d <= endISO; d = dayPlus(d, 1)) out.push(d);
  return out;
}

function neededYears(startISO, endISO) {
  const set = new Set();
  for (let d = startISO; d <= endISO; d = dayPlus(d, 1)) {
    set.add(d.slice(0, 4));
  }
  return [...set].sort();
}

function isoWeekday(iso) {
  // 0=Sun...6=Sat (JS getDay). Convert to Mon=0..Sun=6 to mirror Python.
  const wd = parseISO(iso).getDay();
  return (wd + 6) % 7; // Mon=0 ... Sun=6
}

function isWeekendISO(iso) {
  return isoWeekday(iso) >= 5; // Fri=4, Sat=5, Sun=6
}

const CHINESE_WEEKDAYS = [
  "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日",
];

function dateLabel(iso) {
  const wd = isoWeekday(iso); // Mon=0..Sun=6
  const [y, m, d] = iso.split("-");
  return `${CHINESE_WEEKDAYS[wd]} ${y} ${m} ${d}`;
}

/* ------------------------- HK public holidays -----------------------------
   The official endpoint (https://www.1823.gov.hk/common/ical/en.json) does NOT
   send Access-Control-Allow-Origin, so a browser fetch is usually CORS-blocked.
   We try the live fetch first and fall back to a bundled static set. One fetch
   returns ALL years (2024-2027); the parsed per-year Sets are cached in hkCache
   so no refetch is needed when the range changes.
  --------------------------------------------------------------------------- */

const HK_ENDPOINT = "https://www.1823.gov.hk/common/ical/en.json";

// Bundled fallback: real HK public holidays, grouped by year (ISO strings).
const STATIC_HK_HOLIDAYS = {
  "2025": [
    "2025-01-01", "2025-01-29", "2025-01-30", "2025-01-31",
    "2025-04-04", "2025-04-18", "2025-04-21",
    "2025-05-01", "2025-05-05", "2025-05-31",
    "2025-07-01",
    "2025-10-01", "2025-10-06", "2025-10-07", "2025-10-29",
    "2025-12-25", "2025-12-26",
  ],
  "2026": [
    "2026-01-01",
    "2026-02-17", "2026-02-18", "2026-02-19",
    "2026-04-03", "2026-04-04", "2026-04-06", "2026-04-07",
    "2026-05-01", "2026-05-25",
    "2026-06-19",
    "2026-07-01",
    "2026-09-26",
    "2026-10-01", "2026-10-19",
    "2026-12-25", "2026-12-26",
  ],
};

let hkCache = {};   // { year: Set<iso> } from a successful live fetch
let hkLoaded = false; // true when the fetched/cached set covers the spanned years
let hkLoading = false; // guards against overlapping fetches

function staticHolidaysForYears(years) {
  // Union of the bundled fallback dates for the given years.
  const out = new Set();
  for (const y of years) {
    const arr = STATIC_HK_HOLIDAYS[y];
    if (arr) for (const iso of arr) out.add(iso);
  }
  return out;
}

/* ------------------------- Parsing helpers ------------------------------- */

/* ------------------------- Parsing helpers ------------------------------- */

function parseNames(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHolidays(raw, startISO, endISO) {
  return new Set(resolveDateExpr(raw, startISO, endISO));
}

/* Resolve an ambiguous "M-D" short date to a concrete ISO date given the main
   date range. If the whole range is inside one year, that year is used. If the
   range spans two years, we pick the year whose date still falls inside the
   range; if neither (or both) fit, we default to the range's START year and let
   the caller reject it if it lands outside the range. Returns the ISO date
   string, or null when the short date is malformed / cannot resolve. */
function yearFor(m, d, startISO, endISO) {
  const M = parseInt(m, 10);
  const D = parseInt(d, 10);
  if (!(M >= 1 && M <= 12) || !(D >= 1 && D <= 31)) return null;
  const years = [...neededYears(startISO, endISO)];
  if (!years.length) return null;
  const inRange = (iso) => iso >= startISO && iso <= endISO;
  if (years.length === 1) {
    const iso = `${years[0]}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
    return iso; // single-year range: the caller decides if it lands inside
  }
  // Spanning ranges: try start year first, then fall back to other years.
  for (const y of years) {
    const iso = `${y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
    if (inRange(iso)) return iso;
  }
  return null;
}

/* Parse a free-text list of short dates like "9-2,9-5,9-18,9-19" into an array
   of contiguous unavailable ranges [{startISO, endISO}], ascending. Consecutive
   calendar days collapse into one range (including across month boundaries: a
   token resolves exactly one ISO day, so adjacent resolved dates collapse even
   when the earlier one ends a month and the next starts the following month).
   Invalid/out-of-range/ambiguous tokens are silently dropped. DOM-free. */
function parseShortDates(raw, startISO, endISO) {
  if (raw == null) return [];
  const solved = [];
  for (const tok of String(raw).split(/[\s,]+/)) {
    if (!tok) continue;
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(tok.trim());
    if (!m) continue;
    const iso = yearFor(m[1], m[2], startISO, endISO);
    if (iso) solved.push(iso);
  }
  // Collapse exact-duplicate dates, then sort ascending.
  const uniq = [...new Set(solved)].sort();
  const ranges = [];
  for (const iso of uniq) {
    const last = ranges[ranges.length - 1];
    if (last && dayPlus(last.endISO, 1) === iso) {
      last.endISO = iso; // extend the open range
    } else {
      ranges.push({ startISO: iso, endISO: iso });
    }
  }
  return ranges;
}

/* Parse a free-text list of manual deployments "M-D:Name" (comma/space/newline
   separated) into an object keyed by ISO date -> { name, manual: true }.
   Year inference follows the same yearFor rules as parseShortDates. Unknown
   names and malformed tokens are silently ignored. When the same date appears
   more than once, the FIRST occurrence wins. DOM-free. */
function parseManualDeployments(raw, startISO, endISO, names) {
  const out = {};
  if (raw == null) return out;
  const nameSet = new Set(names);
  for (const tok of String(raw).split(/[\s,]+/)) {
    if (!tok) continue;
    const m = /^(\d{1,2})-(\d{1,2}):(.+)$/.exec(tok.trim());
    if (!m) continue;
    const iso = yearFor(m[1], m[2], startISO, endISO);
    if (!iso) continue;
    const name = m[3].trim();
    if (!nameSet.has(name)) continue;
    if (out[iso] !== undefined) continue; // first wins
    out[iso] = { name, manual: true };
  }
  return out;
}

/* Month name -> number (1-12), for "sep7-20" style inputs. Case-insensitive. */
const MONTH_ABBRS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/* Resolve a single date-expression string ("sep1,5,20-23" or "2026-10-01,")
   into a sorted array of ISO dates within [startISO, endISO]. Tokens are comma/
   space/newline separated. Month-abbr tokens (sep7, sep7-20) set the current
   month; subsequent bare days (5, 11, or 20-23) inherit it; ISO tokens stand
   alone. Out-of-range and malformed tokens are dropped. Shared by holidays,
   manual shifts, and the unavailability-from-holiday path. DOM-free. */
function resolveDateExpr(raw, startISO, endISO) {
  const out = [];
  if (raw == null) return out;
  let currentMonth = 0; // inheritable month context
  for (const tok of String(raw).split(/[\s,]+/).filter(Boolean)) {
    // Month-abbrev form: sep7 / sep7-20 (resets month context).
    const mTok = /^([A-Za-z]{3})(\d{1,2})(?:-(\d{1,2}))?$/.exec(tok);
    if (mTok) {
      const month = MONTH_ABBRS[mTok[1].toLowerCase()];
      if (!month) { currentMonth = 0; continue; }
      currentMonth = month;
      const from = parseInt(mTok[2], 10);
      const to = parseInt(mTok[3] ?? mTok[2], 10);
      addRange(Math.min(from, to), Math.max(from, to));
      continue;
    }
    // Full ISO date: 2026-10-01 (resets month context).
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) {
      currentMonth = 0;
      if (tok >= startISO && tok <= endISO) out.push(tok);
      continue;
    }
    // Bare day under an established month context: 5, 11, or 20-23.
    const dTok = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(tok);
    if (dTok && currentMonth) {
      const from = parseInt(dTok[1], 10);
      const to = parseInt(dTok[2] ?? dTok[1], 10);
      addRange(Math.min(from, to), Math.max(from, to));
      continue;
    }
    // Unrecognized token: reset month context (stray text starts a new unit).
    currentMonth = 0;
  }

  function addRange(dFrom, dTo) {
    if (dFrom < 1 || dTo > 31 || dFrom > dTo) return;
    for (let d = dFrom; d <= dTo; d++) {
      const iso = yearFor(String(currentMonth), String(d), startISO, endISO);
      if (!iso) continue;
      if (iso >= startISO && iso <= endISO) out.push(iso);
    }
  }

  return [...new Set(out)].sort();
}

/* Group a sorted array of ISO dates into contiguous ranges [{start,end}]. */
function groupContiguous(isoArr) {
  const ranges = [];
  for (const iso of [...isoArr].sort()) {
    const last = ranges[ranges.length - 1];
    if (last && dayPlus(last.end, 1) === iso) {
      last.end = iso;
    } else {
      ranges.push({ start: iso, end: iso });
    }
  }
  return ranges;
}

/* Parse a manual-shift block in the "Name: sep7-20 / Name: sep2,5,11" format
   into { isoDate: { name, manual:true } } keyed by resolved ISO date.

   Each line is "<name>: <date-expr>" where <date-expr> uses the resolveDateExpr
   grammar. Unknown names and out-of-range resolved dates are silently ignored;
   first occurrence of a date wins. DOM-free. */
function parseManualShifts(raw, startISO, endISO, names) {
  const out = {};
  if (raw == null) return out;
  const nameSet = new Set(names);
  for (const line of String(raw).split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (!nameSet.has(name)) continue;
    for (const iso of resolveDateExpr(line.slice(idx + 1), startISO, endISO)) {
      if (out[iso] === undefined) out[iso] = { name, manual: true };
    }
  }
  return out;
}

function needsWeekdayShift(iso) {
  return !isWeekendISO(iso);
}

function needsWeekendShift(iso, holidays) {
  return isWeekendISO(iso) || holidays.has(iso);
}

/* Classify a weekend-shift day into its fairness scope. Sat -> 'wsat',
   Sun -> 'wsun', any other weekend-shift day (a public holiday on Mon–Fri)
   -> 'hcount'. Only call this on days where needsWeekendShift is true. */
function weekendScope(iso, holidays) {
  if (isWeekendISO(iso)) {
    return isoWeekday(iso) === 5 ? "wsat" : isoWeekday(iso) === 6 ? "wsun" : "hcount";
  }
  return "hcount"; // holiday falling on a weekday
}

// Successiveness relaxation (user rule): a colleague MAY be the weekend-support
// on two ADJACENT weekend-shift days when those days sit in DIFFERENT scopes and
// NEITHER is the public-holiday scope (hcount) — i.e. the calendar Sat+Sun
// weekend (wsat + wsun). Same-scope recurrence (two Saturdays, two Sundays, two
// weekday-holidays) and any pair touching a weekday public holiday stay blocked.
// This subsumes the old "Sat != Sun" rule, which previously forbade a normal
// Sat+Sun stint. Only meaningful on days where needsWeekendShift is true.
function successivenessAllowed(isoA, isoB, holidays) {
  const a = weekendScope(isoA, holidays);
  const b = weekendScope(isoB, holidays);
  return a !== b && a !== "hcount" && b !== "hcount";
}

/* Parse the 1823.gov.hk iCal payload into per-year Sets of ISO holiday dates.
   Payload shape (one request, ALL years):
     { vcalendar: [ { vevent: [ { dtstart: ["20260101",{value:"DATE"}], ... } ] } ] }
   dtstart is an array whose index 0 is "YYYYMMDD"; dtend is the exclusive next
   day and is ignored. */
function parseHKPayload(payload) {
  const byYear = {};
  const vcalendar = payload && payload.vcalendar;
  if (!Array.isArray(vcalendar)) return byYear;
  for (const cal of vcalendar) {
    const vevents = cal && cal.vevent;
    if (!Array.isArray(vevents)) continue;
    for (const ev of vevents) {
      const dt = ev && ev.dtstart;
      if (!Array.isArray(dt) || typeof dt[0] !== "string") continue;
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(dt[0]);
      if (!m) continue;
      const iso = `${m[1]}-${m[2]}-${m[3]}`;
      const year = m[1];
      (byYear[year] = byYear[year] || new Set()).add(iso);
    }
  }
  return byYear;
}

/* Pure: map the unified `records` array to the three engine inputs.
     records entries: {type, name, start, end, note}
       type 'holiday' (no name)        -> holiday date(s)
       type 'holiday' (named)          -> holiday date(s) AND that person unavailable
       type 'deploy'|'morning'|'weekend' -> manual-shift lock
   Returns { holidaysAdded:Set<string>, unavailable, manualShifts }.
   DOM-free so it can be validated headlessly. */
function deriveFromRecords(records, s, e) {
  const holidaysAdded = new Set();
  const unavailable = {};
  const manualShifts = { morning: {}, deployment: {}, weekend: {} };

  // Process records in a CANONICAL order so the derived inputs (unavailability,
  // holidays, manual "first-wins" locks) are identical no matter the order the
  // user typed the records. This is what makes the schedule order-independent.
  const ordered = (records || [])
    .slice()
    .sort((a, b) =>
      (a.type || "").localeCompare(b.type || "") ||
      (a.name || "").localeCompare(b.name || "") ||
      (a.start || "").localeCompare(b.start || "") ||
      (a.end || "").localeCompare(b.end || "")
    );

  const addUnavailable = (who, rec) => {
    let rs = rec.start, re = rec.end;
    if (rs > re) { [rs, re] = [re, rs]; } // swap inverted range
    if (!rs || !re || rs > re) return;    // skip zero/empty
    for (const iso of expandRange(rs, re)) {
      (unavailable[who] = unavailable[who] || {});
      (unavailable[who][iso] = unavailable[who][iso] || []);
      if (!unavailable[who][iso].includes(rec.note)) unavailable[who][iso].push(rec.note);
    }
  };

  for (const rec of ordered) {
    if (rec.type === "holiday") {
      let rs = rec.start, re = rec.end;
      if (rs > re) { [rs, re] = [re, rs]; }
      for (const iso of expandRange(rs, re)) {
        if (iso >= s && iso <= e) holidaysAdded.add(iso);
      }
      // A named holiday also means that person is off work (unavailable).
      if (rec.name && rec.name.trim()) addUnavailable(rec.name, rec);
    } else if (rec.type === "unavailable") {
      // Explicit "Unavailable": that person is off work (whole day) on those
      // dates. Unlike a named holiday, this does NOT make the date a holiday.
      if (rec.name && rec.name.trim()) addUnavailable(rec.name, rec);
    } else if (rec.type === "deploy" || rec.type === "morning" || rec.type === "weekend") {
      const target = manualShifts[rec.type === "deploy" ? "deployment" : rec.type];
      let rs = rec.start, re = rec.end;
      if (rs > re) { [rs, re] = [re, rs]; }
      for (const iso of expandRange(rs, re)) {
        if (!target[iso]) target[iso] = { name: rec.name, manual: true }; // first wins
      }
    }
  }

  return { holidaysAdded, unavailable, manualShifts };
}

/* ------------------------- Short-date & manual-deploy parsing --------------
   Users enter date ranges without a year (e.g. "9-2,9-5,9-11,9-18,9-19") and can
   manually lock who is on Deployment ("9-2:Andy, 9-5:Tina"). The year is
   inferred from the selected schedule range. All helpers here are DOM-free so
   they run in the Node harness.
  --------------------------------------------------------------------------- */

// Resolve a month(1-12) & day(1-31) to the ISO date that falls inside
// [startISO..endISO]. Returns null when it doesn't fit (or is invalid).
// If the range spans two years and the day-of-year fits both, prefer start-year.
function yearFor(m, d, startISO, endISO) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const st = parseISO(startISO), en = parseISO(endISO);
  const mmp = String(m).padStart(2, "0"), ddp = String(d).padStart(2, "0");
  const origYear = String(st.getFullYear());
  const cand = `${origYear}-${mmp}-${ddp}`;
  if (cand >= startISO && cand <= endISO) return cand;
  // Try the end year too (range spanning two calendar years).
  const endYear = String(en.getFullYear());
  if (endYear !== origYear) {
    const cand2 = `${endYear}-${mmp}-${ddp}`;
    if (cand2 >= startISO && cand2 <= endISO) return cand2;
  }
  return null;
}

// Parse a free-text list of short M-D dates into contiguous ISO ranges, e.g.
//   "9-2,9-5,9-11,9-18,9-19" -> [{s:'2026-09-02',e:'2026-09-02'}, ..., {2026-09-18..2026-09-19}]
// Consecutive calendar days collapse into one range (including across months).
// Returns [{ startISO, endISO }] ascending; invalid/out-of-range tokens dropped.
function parseShortDates(raw, startISO, endISO) {
  const all = new Set();
  if (typeof raw === "string") {
    for (const tok of raw.split(/[\n,]/)) {
      const t = tok.trim();
      if (!t) continue;
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(t);
      if (!m) continue;
      const iso = yearFor(+m[1], +m[2], startISO, endISO);
      if (iso) all.add(iso);
    }
  }
  const sorted = [...all].sort();
  const ranges = [];
  for (const iso of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && dayPlus(last.endISO, 1) === iso) {
      last.endISO = iso; // extend existing range
    } else {
      ranges.push({ startISO: iso, endISO: iso });
    }
  }
  return ranges;
}

// Parse manual deployment locks "9-2:Andy, 9-5:Tina" into { iso: name }.
// Names must match the colleague list exactly. Unknown names / bad tokens are
// ignored. First one wins for a duplicated date.
function parseManualDeployments(raw, startISO, endISO, names) {
  const nameSet = new Set(names || []);
  const out = {};
  if (typeof raw === "string") {
    for (const tok of raw.split(/[\n,]/)) {
      const t = tok.trim();
      if (!t) continue;
      const m = /^(\d{1,2})-(\d{1,2})\s*:\s*([^:]+)$/.exec(t);
      if (!m) continue;
      const name = m[3].trim();
      if (!nameSet.has(name)) continue;
      const iso = yearFor(+m[1], +m[2], startISO, endISO);
      if (iso && !(iso in out)) out[iso] = name;
    }
  }
  return out;
}

/* ------------------------- Per-scope count helpers ------------------------
   Fairness is tracked across SIX independent scopes (each balanced on its own):
     morning, deployment, thursday, wsat, wsun, hcount
   `weekend` (= wsat+wsun+hcount) is the merged Weekend Support column-preserved
   value, and `total` (= morning+deployment+weekend) is the cross-axis balance
   used by Rule 10. These helpers keep weekend/total consistent with the leaves.
  --------------------------------------------------------------------------- */

function newCounts(names) {
  const counts = {};
  for (const n of names) {
    counts[n] = {
      morning: 0, deployment: 0, thursday: 0,
      wsat: 0, wsun: 0, hcount: 0, weekend: 0, total: 0,
    };
  }
  return counts;
}

// Increment one leaf scope; refresh the derived weekend/total.
// `total` = morning + deployment + wsat + wsun + h (the fixed-spec formula:
// a Thursday deployment counts ONLY in `thursday`, never in `deployment` or
// `total`). `weekend` = wsat + wsun + h.
function addCount(counts, name, key, delta) {
  counts[name][key] = (counts[name][key] || 0) + delta;
  const c = counts[name];
  c.weekend = (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
  c.total =
    (c.morning || 0) + (c.deployment || 0) +
    (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
  return counts;
}

// Recompute weekend & total from the leaf scopes for every colleague.
function syncDerivedCounts(counts, names) {
  for (const n of names) {
    const c = counts[n];
    c.weekend = (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
    c.total =
      (c.morning || 0) + (c.deployment || 0) +
      (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
  }
  return counts;
}

// Add a Deployment assignment to a colleague's counts. A Thursday deployment is
// counted ONLY in the independent `thursday` scope (its own fairness tier, per
// the fixed spec) — it is NOT reflected in `deployment` nor in `total`. Any
// other day's deployment counts toward `deployment`. `date` is an ISO string.
function addDeployCount(counts, who, date, delta) {
  return addCount(counts, who, isoWeekday(date) === 3 ? "thursday" : "deployment", delta);
}

// Spread (max-min) of a given scope across all colleagues.
function countSpread(counts, names, key) {
  const arr = names.map((n) => counts[n][key] || 0);
  if (!arr.length) return 0;
  return Math.max(...arr) - Math.min(...arr);
}

/* ------------------------- Scheduling engine ------------------------------
   Mirrors build_schedule() in the Python prototype:
     unavailable: { name: { iso: [note, ...] } }
     manualDeployments: { iso: name } (optional) — user-locked Deployment.
   Returns { rows, counts }. On a manual deployment day the deployment is used
   directly (and marked deploymentManual) but still blocks next-day morning.
  --------------------------------------------------------------------------- */

function buildSchedule(start, end, names, holidays, unavailable, manualShifts, opts) {
  if (!names.length) return { rows: [], counts: {} };
  // opts (optional 7th param): { mPlusDAccepted?: Set<string> } — colleagues who
  // are willing to pull Morning + Deployment on the same day (a relief valve);
  // for them the same-day m+d penalty is dropped so the heavy-day pattern lands
  // on their shoulders instead of spreading fatigue across everyone else.
  opts = opts || {};
  const mPlusDAccepted = opts.mPlusDAccepted || new Set();
  // manualShifts (optional 6th param): { morning?, deployment?, weekend? }
  // each keyed by iso -> { name, manual:true }. First wins per date.
  manualShifts = manualShifts || {};
  const manualMorning = manualShifts.morning || {};
  const manualDeployment = manualShifts.deployment || {};
  const manualWeekend = manualShifts.weekend || {};

  const days = [];
  for (let d = start; d <= end; d = dayPlus(d, 1)) days.push(d);

  const counts = newCounts(names);

  // Track, per day, who worked ANY shift (soft "no consecutive days" goal) and
  // who was assigned Deployment (Rule 1: weekend person must differ from the
  // previous day's Deployment person).
  const workedByDay = {};      // iso -> Set of names
  const deploymentByDay = {};  // iso -> name
  const weekendPersonByDay = {}; // iso -> name (weekend support only)

  // Hard rest rule (original rules #4/#5): a person who did Deployment or
  // Weekend Support yesterday cannot do Morning Health Check today. Rebuilt
  // each day from that day's worked set — never accumulated across days.
  let cannotMorningToday = new Set();

  const rows = [];

  // Rule-1 violation: person worked Weekend Support on X but was Deployment on X-1.
  const violatedRule1 = (iso, person) => {
    const prev = dayPlus(iso, -1);
    return deploymentByDay[prev] === person;
  };

  // General successiveness (relaxed). A person may repeat on two ADJACENT
  // weekend-shift days ONLY when those days sit in different scopes with neither
  // being the holiday scope (wsat+wsun — the calendar weekend) — see
  // successivenessAllowed. Same-scope / holiday-touching repeats stay blocked.
  // Returns the nearest prior populated support as { day, person }; the DATE is
  // needed so the caller can compare scopes. weekendShiftDays is in order.
  const weekendShiftDays = days.filter((d) => needsWeekendShift(d, holidays));
  const prevSupport = (day) => {
    const idx = weekendShiftDays.indexOf(day);
    for (let k = idx - 1; k >= 0; k--) {
      const d = weekendShiftDays[k];
      if (weekendPersonByDay[d]) return { day: d, person: weekendPersonByDay[d] };
    }
    return null;
  };

  // Pre-pass: total number of workdays (Morning+Deployment days) in range, for
  // the per-shift evenness target. Also maintain a per-day role count per person
  // so the "3 shifts within a rolling 2-day window" (tandem overload) can be
  // detected — a follow-up day's assignment is evaluated against what happened.
  const workdayCount = days.filter((day) => !needsWeekendShift(day, holidays)).length;
  const roleCountByDay = {}; // iso -> { name: #roles assigned that day }
  // Fair per-shift target (equal share across colleagues) for evenness pressure.
  const perShiftTarget = workdayCount / names.length;

  // Thursday-deployment fairness (Rule 5): t is its own scope. When the number
  // of Thursdays exceeds the number of staff, surplus Thursday deployments go to
  // the colleague with the LOWEST deployment count (relaxing strict t-spread).
  const weekdays = days.filter((d) => !needsWeekendShift(d, holidays));
  const thursdayCount = weekdays.filter((d) => isoWeekday(d) === 3).length;
  const thuTarget = Math.floor(thursdayCount / names.length);
  // Precompute the index position of each day within weekendShiftDays for O(1).
  const wsIndex = {};
  weekendShiftDays.forEach((d, i) => { wsIndex[d] = i; });

  // ---- "Sudoku-first" pre-scan pass ---------------------------------------
  // Before any greedy/fairness logic runs, scan EVERY weekend-shift day and
  // prelock the single-available colleague into that day's Weekend Support.
  // When exactly one staff member is available on a weekend-shift day, that
  // person is the UNIQUE solution for the cell — so we lock them in up-front,
  // before the per-day greedy and the post-passes (rebalance/reduceFatigue/
  // rule10) could reassign them elsewhere. This is scoped to WEEKEND cells
  // only: workday Morning/Deployment coverage stays owned by the in-day greedy,
  // because the rest rule ("no Morning the day after Deployment/Weekend") is
  // cross-day and can only be resolved in date order (a pre-scan cannot know
  // yesterday's assignment without running the greedy). Availability is the
  // ONLY hard constraint, so a single-available day must never be left blank.
  //
  // Consecutive single-available weekend days (e.g. Sat+Sun both have only one
  // free person) are BOTH prelocked and flagged forced — same as the greedy's
  // own Level-1 relaxation would do, and under-filling the second would be a
  // coverage violation. A saved manual Weekend lock always wins over the
  // pre-scan (first-wins precedence, manual is honored only if that person is
  // available). Bookkeeping (counts / workedByDay / weekendPersonByDay) is done
  // once, by the day-loop's consume path below — the pre-scan itself only
  // builds the map, so nothing can drift out of sync.
  // ---------------------------------------------------------------------------
  const sudokuWeekend = {};   // iso -> name (single-available person, prelocked)
  if (!manualShifts.weekend) manualShifts.weekend = {};
  for (const day of weekendShiftDays) {
    // A manual Weekend lock that will actually be honored (its holder is
    // available) wins over the pre-scan. But if the manual-locked person is
    // UNAVAILABLE, their lock is dropped by the day-loop (line ~813), so the
    // coverage-first pre-scan must still run — otherwise the sole-available
    // colleague is not prelocked and post-passes could reassign them.
    const lockedName = manualShifts.weekend[day] && manualShifts.weekend[day].name;
    if (lockedName && !(unavailable[lockedName] && unavailable[lockedName][day])) continue;
    const avail = names.filter((n) => !(unavailable[n] && unavailable[n][day]));
    if (avail.length === 1) {
      sudokuWeekend[day] = avail[0];
    }
  }

  // ---- "Sudoku-first" pre-scan, WORKDAY variant ------------------------------
  // Same single-available logic, but for workday Morning + Deployment: when
  // exactly one colleague is available on a workday they are the UNIQUE cover
  // for BOTH cells, so prelock them into the m+d double up-front. The greedy
  // consumes this (below) and post-passes (`lockedIn`) treat it as immovable.
  // A manual Morning/Deployment lock that is ACTUALLY honored (holder available
  // or user-hard-override) for a DIFFERENT person means the pair already has a
  // distinct occupant, so no prelock. A dropped manual lock (holder unavailable
  // and not overridden) is ignored — the sole-available colleague must still be
  // prelocked (mirrors the weekend pre-scan's manual treatment).
  const availableOn = (n, day) => !(unavailable[n] && unavailable[n][day]);
  const sudokuWeekday = {};   // iso -> name (sole-available person, prelocked as m+d)
  for (const day of weekdays) {
    const mdl = manualDeployment[day];
    const mml = manualMorning[day];
    const held = (lock) => lock && lock.name && (availableOn(lock.name, day) || lock.override);
    const heldMdl = held(mdl), heldMml = held(mml);
    // Harden: scoop only the single-available case with no distinct manual occupant.
    const avail = names.filter((n) => availableOn(n, day));
    if (avail.length === 1) {
      const sole = avail[0];
      const conflicts = (heldMdl && mdl.name !== sole) || (heldMml && mml.name !== sole);
      if (!conflicts) sudokuWeekday[day] = sole;
    }
  }

  for (const day of days) {
    // A day is a WORK day (Morning + Deployment) only when it is neither a
    // calendar weekend nor a public holiday. Holidays — even when they fall on
    // a weekday — are covered by the Weekend Support shift only, so no
    // Morning/Deployment is scheduled on them.
    const weekendShift = needsWeekendShift(day, holidays);
    const weekdayShift = !weekendShift;

    // Build display notes for this date.
    const notes = [];
    for (const name of names) {
      const rec = unavailable[name] || {};
      const dayNotes = rec[day];
      if (dayNotes) {
        for (const note of dayNotes) notes.push(`${name} (${note})`);
      }
    }

    const availableFor = (name) => !(unavailable[name] && unavailable[name][day]);

    let morning = "";
    let morningManual = false;
    let morningForced = false;
    let deployment = "";
    let deploymentManual = false;
    let deploymentSudoku = false;
    let weekendForced = false;
    let weekendSudoku = false;

    const manualDeployLock = manualDeployment[day];
    const manualDeployForDay = manualDeployLock && manualDeployLock.name;
    // A USER HARD-OVERRIDE ({override:true}) is honored EVEN if that person is
    // unavailable that day — the user explicitly assigned them, so the schedule
    // must recompute around it (warn, don't forbid). A normal manual lock is
    // only honored if the holder is available (availability stays hard unless
    // overridden).
    const deplLocked = manualDeployForDay && (availableFor(manualDeployForDay) || manualDeployLock.override);
    const manualMorningLock = manualMorning[day];
    const manualMorningForDay = manualMorningLock && manualMorningLock.name;
    const mornLocked = manualMorningForDay && (availableFor(manualMorningForDay) || manualMorningLock.override);

    // ---- Workday shifts: Morning Health Check + Deployment -----------------
    // On a workday (Mon–Fri, not a public holiday) Morning and Deployment are
    // chosen TOGETHER as the (Deployment D, Morning M) pair. The PURE per-shift
    // evenness metric (max*1000+sum) keeps both counts balanced, and on top of
    // that we STRONGLY prefer to avoid a colleague working consecutive calendar
    // days (especially Deployment is tiring: it runs after the workday), and we
    // prefer two DISTINCT people (Morning != Deployment) so one person does not
    // pull BOTH shifts. The consecutive-days preference is weighted so it can
    // out-rank a small evenness gap (a returning colleague still catches up, but
    // spread out) — only a big count imbalance can force consecutive work.
    if (weekdayShift) {
      const sd = sudokuWeekday[day];
      if (sd && !deplLocked && !mornLocked) {
        // Workday "sudoku-first": the pre-scan locked the sole-available colleague
        // into BOTH the Morning and Deployment cells (they are the unique cover for
        // the day). Assign directly, skip the fair-pair search (there is no choice),
        // and flag forced so validateAll carves out any rest/successiveness breach
        // it causes. deploymentSudoku marks it immovable to the post-passes.
        deployment = sd;
        deploymentSudoku = true;
        morning = sd;
        morningForced = true;
        addDeployCount(counts, deployment, day, 1);
        addCount(counts, morning, "morning", 1);
      } else {
        const dCands = deplLocked ? [manualDeployForDay] : names.filter((n) => availableFor(n));
      // Hard rest rule: a person who did Deployment or Weekend Support yesterday
      // is blocked from today's Morning (Deployment carries no such tomorrow
      // block, so the deployment candidate pool is unaffected). A manual Morning
      // lock is still honored regardless.
      //
      // "Sudoku" invariant: like the weekend fallback, the Morning cell on a
      // workday is NEVER left blank while any colleague is available. If the
      // rest rule empties the pool (e.g. the only available people all worked
      // yesterday), we relax `cannotMorningToday` so the day still has a Morning
      // Health Check; that relaxation is flagged as forced.
      let mCands = mornLocked
        ? [manualMorningForDay]
        : names.filter((n) => availableFor(n) && !cannotMorningToday.has(n));
      if (!mCands.length && !mornLocked) {
        mCands = names.filter((n) => availableFor(n));
        if (mCands.length) morningForced = true;
      }

      // Scores each candidate pair. Per-shift BALANCE is the STRICT, non-negotiable
      // first priority (the user's stated primary goal). The evenness term is scaled
      // so that a single shift-count deviation (1_000_000) is far larger than the
      // sum of ALL fatigue penalties (< 10_000), so fatigue can ONLY break an exact
      // count tie, never out-rank a count imbalance. We still try hard, as the
      // tie-break, to avoid the tiring patterns — consecutive Deployment, a single
      // person pulling >=3 shifts in 2 days, consecutive calendar-day work, and a
      // same-day Morning+Deployment double — but each only kicks in among equally
      // even candidates. Any residual fatigue we cannot remove this way is a FORCED
      // cost of keeping the counts fair, and is flagged red for the staff to bear.
      const DEPCONS_W = 2500; // D did Deployment yesterday (consecutive deploy)
      const TANDEM_W = 3000;  // a single person would reach >=3 shifts in 2 days
      const CONSEC_W = 1500;  // general: a person in this pair worked yesterday
      const SAME_W = 1000;    // D===M same-day overlap: mildly disliked
      // 3-day consecutive DEPLOYMENT is a HARD red (user's "2-day ceiling, 3-day
      // unacceptable" rule; see computeFlags). It must be STRICTLY avoided BEFORE
      // evenness is consulted — the user wants m/d spread out first, and Andy's
      // m+d used only when spreading is impossible. A dominant weight guarantees
      // the greedy never voluntarily puts anyone on a 3rd consecutive deployment
      // day while a non-streak candidate exists. Only when EVERY candidate would
      // hit the streak does the coverage-sudoku / forced-relaxation path take over.
      const DEPCONSEC3_W = 40000; // just above TIER2_W(30000): prefers spreading deployment again a 3rd consecutive day, but lets reduceFatigue resolve residuals

      let bestD = "", bestM = "", bestTotal = Infinity;
      const yesterdayDay = dayPlus(day, -1);
      const yesterdayWorked = workedByDay[yesterdayDay] || new Set();
      const yesterdayRoles = roleCountByDay[yesterdayDay] || {};
      // Tier weights (fixed-spec 公平目標 §28): 檔1 = wsat/wsun/t/h balance strictly
      // dominates 檔2 = m/d balance. TIER1_W > TIER2_W, and the gap is wide enough
      // that no realistic tier-2 count spread (≈22 < 34) can out-rank a single
      // tier-1 point, so Thursday `t` stays even FIRST even when a Morning pairing
      // would otherwise pull a (D,M) pair toward the less-even t option. Both stay
      // far above the max fatigue weight (~8000) so evenness still out-ranks fatigue.
      const TIER1_W = 1000000; // wsat / wsun / t / hcount
      const TIER2_W = 30000;   // m / d (d excludes Thursday); ~13x the max fatigue sum
      for (const D of dCands) {
        for (const M of mCands) {
          // Per-shift evenness: independent axes, least-count. Deployment balance only
          // considers Deployment counts; Morning balance only Morning counts. The
          // person with the fewest shifts of that type is preferred, which keeps
          // each shift even and naturally respects unequal availability (someone
          // who was out just stays low while present differently). The tier weight
          // makes evenness strictly dominate fatigue, so the count target is
          // always met before fatigue is ever consulted.
          //
          // Thursday deployment (t) is its own 檔1 scope. On a Thursday the D axis
          // weights the thursday count; when the number of Thursdays EXCEEDS the
          // number of staff (surplus case), once everyone is at the shared base
          // (thuTarget) the surplus falls through to the LOWEST deployment-count
          // colleague, relaxing strict t-spread.
          const isThu = isoWeekday(day) === 3;
          let depEven;
          if (isThu) {
            if (thursdayCount > names.length) {
              const inBase = names.some((n) => availableFor(n) && counts[n].thursday < thuTarget);
              depEven = inBase ? counts[D].thursday + 1 : counts[D].deployment + 1;
            } else {
              depEven = counts[D].thursday + 1;
            }
          } else {
            depEven = counts[D].deployment + 1;
          }
          const morNext = counts[M].morning + 1;
          const depAxisW = isThu ? TIER1_W : TIER2_W;
          const evenness = depEven * depAxisW + morNext * TIER2_W;

          // D doing Deployment yesterday (consecutive deployment).
          const depConsec = deploymentByDay[yesterdayDay] === D ? 1 : 0;
          // Would D reach a 3-day streak (deployed yesterday AND the day before)?
          const depConsec3 = deploymentByDay[yesterdayDay] === D && deploymentByDay[dayPlus(day, -2)] === D ? 1 : 0;

          // Would any single person reach >=3 shifts across today+yesterday?
          const tandemD = (yesterdayRoles[D] || 0) + (D === M ? 2 : 1);
          const tandemM = (yesterdayRoles[M] || 0) + 1;
          const tandem = tandemD >= 3 || tandemM >= 3 ? 1 : 0;

          const consec = (yesterdayWorked.has(D) ? 1 : 0) + (D !== M && yesterdayWorked.has(M) ? 1 : 0);
          // Same-day Morning+Deployment: last resort, but a colleague who
          // explicitly accepts it (mPlusDAccepted) gets no penalty so the engine
          // can route the heavy day to them instead of spreading it.
          const same = (D === M && !mPlusDAccepted.has(D)) ? 1 : 0;
          const total =
            evenness +
            DEPCONSEC3_W * depConsec3 +
            DEPCONS_W * depConsec +
            TANDEM_W * tandem +
            CONSEC_W * consec +
            SAME_W * same;
          if (total < bestTotal) {
            bestTotal = total; bestD = D; bestM = M;
          }
        }
      }
      // ---- Ladder level 2: Andy takes up a same-day m+d (fixed-spec §35.2) ----
      // When the day's chosen pair IS an unavoidable m+d double, prefer routing the
      // double onto the designated volunteer (mPlusDAccepted, default Andy) FIRST,
      // before spreading it to other colleagues. This is a ladder-priority override,
      // not a tie-break: it applies whenever switching the holder to Andy keeps the
      // 檔2 (deployment / morning) scope spreads within MAX_SPREAD=2 AND Andy has
      // not already absorbed more doubles than the next tier's fair share. The
      // volunteer's SAME_W=0 (vs non-volunteer SAME_W=1000) already biases tie-breaks
      // toward them; this gate makes the preference hold even when Andy's raw count
      // is marginally less even, as the spec demands.
      if (bestM !== "" && bestD === bestM) {
        const andy = names.find((n) => mPlusDAccepted.has(n));
        if (andy && andy !== bestD && availableFor(andy) && !deplLocked && !mornLocked) {
          const swapTo = bestD; // current double-holder (a non-volunteer)
          const dSpreadAfter = Math.max(...names.map((n) => counts[n].deployment + (n === andy ? 1 : n === swapTo ? -1 : 0))) -
                               Math.min(...names.map((n) => counts[n].deployment + (n === andy ? 1 : n === swapTo ? -1 : 0)));
          const mSpreadAfter = Math.max(...names.map((n) => counts[n].morning + (n === andy ? 1 : n === swapTo ? -1 : 0))) -
                               Math.min(...names.map((n) => counts[n].morning + (n === andy ? 1 : n === swapTo ? -1 : 0)));
          if (dSpreadAfter <= 2 && mSpreadAfter <= 2) {
            bestD = andy; bestM = andy; // route the double onto the volunteer
          }
        }
      }
      if (bestM !== "") {
        deployment = bestD;
        deploymentManual = deplLocked && bestD === manualDeployForDay;
        morning = bestM;
        morningManual = mornLocked && bestM === manualMorningForDay;
        addDeployCount(counts, deployment, day, 1);
        addCount(counts, morning, "morning", 1);
      }
      }
    } else if (deplLocked) {
      // Weekend / holiday: a manual Deployment lock is still honored (no auto
      // Morning/Deployment those days unless locked).
      deployment = manualDeployForDay;
      deploymentManual = true;
      addDeployCount(counts, deployment, day, 1);
    }

    // ---- Weekend Support (Sat/Sun/public holidays) ---------------------------
    let weekend = "";
    let weekendManual = false;
    if (weekendShift) {
      const manualLock = manualWeekend[day];
      const manual = manualLock && manualLock.name;
      const prelocked = sudokuWeekend[day];
      if (manual && (availableFor(manual) || manualLock.override)) {
        // A manual (or user hard-override) weekend lock. Overrides honored even
        // when unavailable, per "warn, don't forbid".
        weekend = manual;
        weekendManual = true;
        if (!availableFor(manual)) weekendForced = true; // violates availability (warned below)
        addCount(counts, weekend, weekendScope(day, holidays), 1);
      } else if (prelocked && availableFor(prelocked)) {
        // From the sudoku-first pre-scan: only this colleague is available, so it
        // is the UNIQUE solution for the cell. Lock it in before the fair greedy
        // runs, so post-passes cannot reassign them elsewhere. Also flagged forced
        // so validateAll carves out any successiveness / Rule-1 breach it causes.
        weekend = prelocked;
        weekendForced = true;
        weekendSudoku = true;
        addCount(counts, weekend, weekendScope(day, holidays), 1);
      } else {
        // Eligible pool: available, not Rule-1-eligible (differs from yesterday's
        // Deployment), differs from today's Deployment person (no double-booking
        // into both shifts same day), and — for successiveness — differs from the
        // previous adjacent weekend-shift support person UNLESS that adjacent
        // pair is a legitimate wsat+wsun weekend (successivenessAllowed).
        const scope = weekendScope(day, holidays);
        const prev = prevSupport(day);
        let pool = names.filter(
          (n) =>
            availableFor(n) &&
            n !== deployment &&
            !violatedRule1(day, n) &&
            !(prev && prev.person === n && !successivenessAllowed(prev.day, day, holidays))
        );
        // --- "Sudoku" invariant: a needed shift is ALWAYS filled whenever at
        // least one colleague is available. The successiveness, Rule-1, and
        // avoid-double-book filters are PREFERENCES that get relaxed, one level
        // at a time, rather than ever leave the cell blank. Only hard
        // unavailability wins over filling the cell. ----
        weekendForced = false; 
        if (!pool.length) {
          // Level 1: drop successiveness (only the adjacent-support clash is real).
          pool = names.filter(
            (n) => availableFor(n) && n !== deployment && !violatedRule1(day, n)
          );
          if (pool.length) weekendForced = true;
        }
        if (!pool.length) {
          // Level 2: drop successiveness AND yesterday's-Deployment rule, keep
          // only the "nobody pulls both weekend + today's deployment" preference.
          pool = names.filter(
            (n) => availableFor(n) && n !== deployment
          );
          if (pool.length) weekendForced = true;
        }
        if (!pool.length) {
          // Level 3 (absolute last resort): ANY available colleague carries the
          // support, even if it means the same person is booked into Deployment
          // too that day. Flagged red below for the staff to bear.
          pool = names.filter((n) => availableFor(n));
          if (pool.length) weekendForced = true;
        }
        if (pool.length) {
          // Per-scope fairness first (STRICT): the day's scope (wsat/wsun/hcount)
          // is balanced independently, so 4 Saturdays / 6 staff stay as equal as
          // possible without being diluted by Sundays or holidays. Among candidates
          // with an EQUAL scope count, prefer someone who did not work yesterday
          // (avoid consecutive days); this is only a tie-break and can never out-rank
          // keeping the scope counts even.
          const workedYesterday = workedByDay[dayPlus(day, -1)] || new Set();
          const WS_CONSEC_W = 2500;
          weekend = pool.reduce((best, n) => {
            const score = (i) => counts[i][scope] * 1000000 + (workedYesterday.has(i) ? WS_CONSEC_W : 0);
            return score(n) < score(best) ? n : best;
          });
          addCount(counts, weekend, scope, 1);
        }
      }
    }

    // Record who worked each shift today (for the consecutive-days soft goal and
    // Rule 1 / export bookkeeping).
    const workedToday = new Set();
    if (morning) workedToday.add(morning);
    if (deployment) workedToday.add(deployment);
    if (weekend) workedToday.add(weekend);
    if (workedToday.size) workedByDay[day] = workedToday;
    if (deployment) deploymentByDay[day] = deployment;
    if (weekend) weekendPersonByDay[day] = weekend;

    // Role count per person today (1 or 2 when someone does both Morning +
    // Deployment). Used by the next day's tandem-overload check.
    roleCountByDay[day] = {};
    if (morning) roleCountByDay[day][morning] = (roleCountByDay[day][morning] || 0) + 1;
    if (deployment) roleCountByDay[day][deployment] = (roleCountByDay[day][deployment] || 0) + 1;
    if (weekend) roleCountByDay[day][weekend] = (roleCountByDay[day][weekend] || 0) + 1;

    // Rebuild the hard rest rule for tomorrow: today's Deployment and Weekend
    // Support people are blocked from tomorrow's Morning Health Check. Rebuilt
    // per day (never accumulated) — a real-bug guard retained from the prototype.
    cannotMorningToday = new Set([deployment, weekend].filter(Boolean));

    rows.push({
      date: day,
      label: dateLabel(day),
      isWeekend: needsWeekendShift(day, holidays),
      morning,
      morningManual,
      morningForced,
      deployment,
      deploymentManual,
      deploymentSudoku,
      weekend,
      weekendManual,
      weekendForced,
      weekendSudoku,
      notAvailable: notes.join(", "),
    });
  }

  // ---- Realrebance: scope-aware Weekend Support toward even distribution ----
  // A bounded local-search pass that moves a weekend-support assignment from an
  // over-assigned (or simply movable) colleague to another, closing the gap to
  // each person's ideal PER-SCOPE target (wsat / wsun / h count independently),
  // while preserving availability, successiveness (differ from both the previous
  // and next adjacent weekend-shift support person), Rule 1 (difference from the
  // previous day's Deployment), and never moving a manual-locked weekend. Each
  // move keeps total weekend slots constant. This is a pure per-scope evenness
  // pass; the "no consecutive days" soft goal is only consulted to break exact
  // ties and is never allowed to break evenness.
  const weekendRows = [];
  rows.forEach((r, idx) => {
    if (r.isWeekend && r.weekend) {
      weekendRows.push({
        idx, day: r.date, person: r.weekend,
        manual: r.weekendManual || r.weekendSudoku, // sudoku-prelocked = immovable here too
        scope: weekendScope(r.date, holidays),
      });
    }
  });
  // Next adjacent weekend-shift support person {day, person} (known now that
  // all rows exist). The DATE lets callers compare scopes for the relaxed
  // successiveness rule (wsat+wsun is fine).
  const nextSupport = (day) => {
    const idx = wsIndex[day];
    if (idx === undefined) return null;
    for (let k = idx + 1; k < weekendShiftDays.length; k++) {
      const d = weekendShiftDays[k];
      if (weekendPersonByDay[d]) return { day: d, person: weekendPersonByDay[d] };
    }
    return null;
  };
  if (weekendRows.length > 0) {
    // Per-scope ideal: base + (first `rem`) within each scope's own slot count.
    const scopeSlots = {};
    for (const w of weekendRows) scopeSlots[w.scope] = (scopeSlots[w.scope] || 0) + 1;
    const idealByScope = {};
    for (const sc of Object.keys(scopeSlots)) {
      const total = scopeSlots[sc];
      const base = Math.floor(total / names.length);
      const rem = total % names.length;
      const ideal = {};
      names.forEach((n, i) => { ideal[n] = base + (i < rem ? 1 : 0); });
      idealByScope[sc] = ideal;
    }

    const devBefore = () => {
      let s = 0;
      for (const sc of Object.keys(idealByScope)) {
        for (const n of names) s += Math.abs(counts[n][sc] - idealByScope[sc][n]);
      }
      return s;
    };
    const supportOf = (day) => weekendPersonByDay[day] || null;
    const mayAssign = (w, cand) => {
      if (cand === w.person) return false;
      if (unavailable[cand] && unavailable[cand][w.day]) return false;
      if (violatedRule1(w.day, cand)) return false;
      if (cand === rows[w.idx].deployment) return false; // no same-day double-booking
      // Successiveness: `cand` may repeat from/to an adjacent weekend-shift day
      // only when that adjacent pair is a legitimate wsat+wsun weekend.
      const pv = prevSupport(w.day), nx = nextSupport(w.day);
      if (pv && pv.person === cand && !successivenessAllowed(pv.day, w.day, holidays)) return false;
      if (nx && nx.person === cand && !successivenessAllowed(w.day, nx.day, holidays)) return false;
      return true;
    };
    // Consecutive-day overlap count across weekend assignments (soft goal only).
    const consecOverlaps = () => {
      let c = 0;
      for (const w of weekendRows) {
        const prev = workedByDay[dayPlus(w.day, -1)];
        const next = workedByDay[dayPlus(w.day, 1)];
        if (prev && prev.has(w.person)) c++;
        if (next && next.has(w.person)) c++;
      }
      return c;
    };

    let swaps = 0;
    let moved = true;
    while (moved && swaps < 200) {
      moved = false;
      let bestMove = null; // { w, cand, gain }
      let bestGain = 0;
      for (const w of weekendRows) {
        if (w.manual) continue; // never move a manual-locked weekend
        for (const cand of names) {
          if (!mayAssign(w, cand)) continue;
          const before = devBefore();
          // simulate: w.person -> cand (same scope, weekend count unchanged)
          addCount(counts, w.person, w.scope, -1);
          addCount(counts, cand, w.scope, 1);
          const after = devBefore();
          addCount(counts, cand, w.scope, -1);
          addCount(counts, w.person, w.scope, 1);
          const gain = before - after;
          if (gain <= 0) continue;
          // Prefer larger gain; tie-break on the soft consecutive-days goal.
          if (gain > bestGain) {
            bestGain = gain; bestMove = { w, cand };
          }
        }
      }
      if (bestMove) {
        const { w, cand } = bestMove;
        addCount(counts, w.person, w.scope, -1);
        addCount(counts, cand, w.scope, 1);
        rows[w.idx].weekend = cand;
        weekendPersonByDay[w.day] = cand;
        const worked = workedByDay[w.day] || new Set();
        worked.delete(w.person);
        worked.add(cand);
        workedByDay[w.day] = worked;
        w.person = cand;
        swaps++;
        moved = true;
      }
    }

    // Once counts are already even (no improving evenness move), optionally reduce
    // consecutive-day overlaps without disturbing evenness — bounded to avoid churn.
    swaps = 0;
    moved = true;
    while (moved && swaps < 50) {
      moved = false;
      let bestMove = null;
      let bestCons = consecOverlaps();
      for (const w of weekendRows) {
        if (w.manual) continue;
        if (devBefore() !== 0) continue; // only optimize consec when counts are even
        for (const cand of names) {
          if (!mayAssign(w, cand)) continue;
          addCount(counts, w.person, w.scope, -1);
          addCount(counts, cand, w.scope, 1);
          if (devBefore() !== 0) { addCount(counts, cand, w.scope, -1); addCount(counts, w.person, w.scope, 1); continue; }
          const cons = consecOverlaps();
          addCount(counts, cand, w.scope, -1);
          addCount(counts, w.person, w.scope, 1);
          if (cons < bestCons) { bestCons = cons; bestMove = { w, cand }; }
        }
      }
      if (bestMove) {
        const { w, cand } = bestMove;
        addCount(counts, w.person, w.scope, -1);
        addCount(counts, cand, w.scope, 1);
        rows[w.idx].weekend = cand;
        weekendPersonByDay[w.day] = cand;
        const worked = workedByDay[w.day] || new Set();
        worked.delete(w.person);
        worked.add(cand);
        workedByDay[w.day] = worked;
        w.person = cand;
        swaps++;
        moved = true;
      }
    }
  }

  // ---- Count-preserving fatigue reduction ----------------------------------
  // Strict evenness (already enforced by the greedy) guarantees each per-shift
  // count is as even as possible. That greedy can, however, create AVOIDABLE
  // tiring orderings (e.g. a returning colleague scheduled for Deployment several
  // days running to "catch up"). reduceFatigue() relocates which DAY a person
  // works a given shift column between two dates — never changing how many of that
  // column they work — so final counts (and thus evenness) stay identical, while
  // consecutive-Deployment / three-in-two / same-day-overlap are stripped out.
  // Whatever patterns remain after this pass are the genuinely-unavoidable cost of
  // keeping the counts fair, and are flagged red below for the staff to bear.
  reduceFatigue(rows, names, unavailable, manualShifts, holidays, mPlusDAccepted);
  // Then relieve the days adjacent to a forced same-day M+D row (workday sudoku
  // prelock) by relocating any avoidable X-1 Deployment / X+1 Morning off that
  // colleague. Must run AFTER reduceFatigue (which would otherwise "fix" the
  // relaxation) and BEFORE rule10Pass (which re-balances from this schedule).
  neighborRelax(rows, names, unavailable, mPlusDAccepted);
  // Unwind any residual "3+ duties in two days" tandems by relocating a single
  // adjacent Deployment/Morning off the overloaded colleague. Gated by validateAll
  // + per-scope spread, so it removes the inhumane stacking WITHOUT sacrificing
  // fairness (unlike a penalized objective). Count-changing, so it must run before
  // the finalCounts recompute below.
  relieveTandems(rows, names, unavailable, mPlusDAccepted);
  // relocate moves in the fatigue pass change individual counts, so recompute the
  // per-person shift totals from the final rows before reporting them.
  const finalCounts = newCounts(names);
  for (const r of rows) {
    if (r.morning) addCount(finalCounts, r.morning, "morning", 1);
    if (r.deployment) addDeployCount(finalCounts, r.deployment, r.date, 1);
    if (r.weekend) addCount(finalCounts, r.weekend, weekendScope(r.date, holidays), 1);
  }
  syncDerivedCounts(finalCounts, names);
  // Copy the freshly-derived counts back into the shared `counts` object.
  for (const n of names) Object.assign(counts[n], finalCounts[n]);
  // Rule 10: cross-axis comprehensive fairness pass (transfers allow only total
  // spread reduction, never worsening any per-scope spread past MAX_SPREAD).
  rule10Pass(rows, names, unavailable, holidays, counts);
  computeFlags(rows, names, mPlusDAccepted); // sets row.forced (possibly empty) on every row

  return { rows, counts };
}

// ---------------------------------------------------------------------------
// Self-contained helpers for the post-pass. They re-derive every needed map from
// the `rows` array, so they never fall out of sync with the schedule.
// ---------------------------------------------------------------------------

// Rebuild the per-day role-count map { iso -> { name: #duties } } for the
// "too many shifts in 2 days" check.
function rolesByDayFromRows(rows) {
  const map = {};
  for (const r of rows) {
    map[r.date] = {};
    if (r.morning) map[r.date][r.morning] = (map[r.date][r.morning] || 0) + 1;
    if (r.deployment) map[r.date][r.deployment] = (map[r.date][r.deployment] || 0) + 1;
    if (r.weekend) map[r.date][r.weekend] = (map[r.date][r.weekend] || 0) + 1;
  }
  return map;
}

// Detect every tiring pattern on every row and write the human-readable "must
// bear it" message into row.forced. Also return the total weighted flag count,
// which the swap loop uses as its strictly-decreasing objective (consecutive
// Deployment is the most-tiring, hence heaviest weight).
function computeFlags(rows, names, mPlusDAccepted) {
  mPlusDAccepted = mPlusDAccepted || new Set();
  const roleMap = rolesByDayFromRows(rows);
  const byDate = {};
  for (const r of rows) byDate[r.date] = r;
  let total = 0;
  for (const r of rows) {
    const forced = [];
    const prevRow = byDate[dayPlus(r.date, -1)];
    // NOTE: same-day Morning + Deployment is intentionally NOT flagged red —
    // per the user's rule it is a tolerated compromise for EVERYONE (not just
    // the mPlusDAccepted volunteers). Only consecutive-M is the "least-acceptable"
    // red. consecutive-D is likewise a tolerated compromise and is not flagged.
    // 2. Consecutive 2-day MORNING — the LEAST-acceptable pattern (user ladder):
    //    the same person does Morning on back-to-back workdays. A weekend/holiday
    //    between breaks adjacency (that intermediate day has no morning, so
    //    prevRow.morning is empty and cannot match). Soft avoidance: flagged red
    //    only when it could not be avoided without breaking evenness / coverage.
    if (r.morning && prevRow && prevRow.morning === r.morning) {
      forced.push(`${r.morning} does Morning Health Check on consecutive days (${dateLabel(prevRow.date)} & ${r.label}).`);
      total += 4;
    }
    // 2b. Consecutive 3-day DEPLOYMENT — the user's ceiling rule: 2 consecutive
    //     deployment days is the tolerated upper bound, but a THIRD consecutive
    //     calendar-day Deployment by the same person is a HARD red. A weekend or
    //     holiday between breaks adjacency (those days carry no auto-deployment,
    //     so prevRow.deployment is empty and cannot match). The greedy is taught
    //     to spread deployment first (see DEPCONSEC3_W) so this only surfaces as a
    //     genuine last-resort when spreading is physically impossible.
    if (r.deployment && prevRow && prevRow.deployment === r.deployment) {
      const twoBack = byDate[dayPlus(r.date, -2)];
      if (twoBack && twoBack.deployment === r.deployment) {
        forced.push(`${r.deployment} does Deployment on 3 consecutive days (${dateLabel(twoBack.date)} .. ${r.label}).`);
        total += 4;
      }
    }
    // 4. Rest-rule / Rule-1 overburden — d→m (Morning the day after a Deployment)
    //    is a HARD red (fixed-spec §30): flagged red EVEN when forced (sole-available).
    //    w→m (Morning the day after Weekend Support) is a DIFFERENT, tolerated
    //    last-resort compromise (fixed-spec §35 level 5) — NOT red; we just record
    //    it on row.hasWtoM so the renderer can style it amber/informational.
    if (r.morning && prevRow && prevRow.deployment === r.morning)
      forced.push(`${r.morning} must do Morning the day after Deployment (${dateLabel(prevRow.date)}).`);
    if (r.morning && prevRow && prevRow.weekend === r.morning)
      r.hasWtoM = true; // tolerated w→m compromise, not a red violation
    if (r.weekend && prevRow && prevRow.deployment === r.weekend)
      forced.push(`${r.weekend} does Weekend Support the day after Deployment (${dateLabel(prevRow.date)}).`);
    // 3. >=3 duties by one person across two consecutive days (tandem overload).
    const prev = dayPlus(r.date, -1);
    if (prev && roleMap[prev]) {
      const mine = roleMap[prev] || {};
      const today = roleMap[r.date] || {};
      for (const n of names) {
        const two = (mine[n] || 0) + (today[n] || 0);
        if (two >= 3) {
          forced.push(`${n} bears ${two} shifts across ${dateLabel(r.date)} & the previous day.`);
          total += 2;
        }
      }
    }
    // NOTE: consecutive-DEPLOYMENT is intentionally NOT flagged red — the user
    // classifies it as a tolerated compromise (same status as Andy's accepted
    // m+d), so it is deliberately omitted here to reduce red text.
    r.forced = forced;
  }
  return total;
}

// Drain every hard rule across the whole range. Returns true only when the
// current schedule is fully valid. This is deliberately a full-range check run
// on candidate swaps (O(days x staff) — trivial for a ≤31-day schedule) so we
// NEVER hand-reason per-field swap validity, which is where correctness bugs hide.
function validateAll(rows, names, unavailable) {
  const byDay = {};
  for (const r of rows) byDay[r.date] = r;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const duties = [r.morning, r.deployment, r.weekend].filter(Boolean);
    // Availability.
    for (const n of duties) {
      if (unavailable[n] && unavailable[n][r.date]) return false;
    }
    // Day-type: Morning/Deployment only on weekdays (not holidays/weekends);
    // Weekend only on weekend/holiday days.
    if (r.isWeekend) {
      if (r.morning) return false;
      if (r.deployment && !r.deploymentManual) return false;
      if (!r.weekend && duties.length) return false; // weekend day must not hold M/D
    } else {
      if (r.weekend && !r.weekendManual) return false;
    }
    // Double-booking guard: a person may appear in Morning AND Deployment (the
    // documented last-resort), but never in the Weekend column together with
    // either weekday duty. A FORCED weekend (only one colleague available) is a
    // documented exception — the cell is filled even if it means a double-book.
    if (r.weekend && (r.weekend === r.morning || r.weekend === r.deployment) && !r.weekendForced) return false;
  }
  // Rest rule + Rule 1 across consecutive days.
  for (const r of rows) {
    const py = byDay[dayPlus(r.date, -1)];
    if (!py) continue;
    // Rest rule: no Morning today by the person who did Deployment/Weekend yesterday.
    // A FORCED morning (only available people all worked yesterday) is exempt.
    if (r.morning && (py.deployment === r.morning || py.weekend === r.morning) && !r.morningForced) return false;
    // Rule 1: Weekend Support today differs from yesterday's Deployment person.
    // A FORCED weekend (only one colleague available) is exempt — the Sudoku rule
    // says the sole available person MUST cover it even after deploying yesterday.
    if (r.weekend && py.deployment === r.weekend && !r.weekendForced) return false;
    // User's deployment-ceiling rule: 2 consecutive Deployment days is the upper
    // bound; a THIRD consecutive calendar-day Deployment by the same person is a
    // hard violation. A sudoku-forced day (only one person available) is exempt —
    // coverage wins, exactly like the other forced relaxations. Runs in validateAll
    // so EVERY post-pass (reduceFatigue / neighborRelax / rule10Pass) rejects any
    // swap that would manufacture a 3-day deployment streak.
    const pb = byDay[dayPlus(r.date, -2)];
    if (r.deployment && !r.deploymentSudoku && py.deployment === r.deployment && pb && pb.deployment === r.deployment) return false;
  }
  // Successiveness ("h, wsat, wsun cannot be successive person"): the weekend-
  // support person on a weekend-shift day must differ from the support person on
  // the PREVIOUS adjacent weekend-shift day. Adjacent weekend-shift days are
  // consecutive calendar days both needing a weekend shift (rows are consecutive
  // by date). This subsumes the old Sat != Sun rule AND covers holiday adjacency
  // (e.g. Sunday + Monday public holiday).
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.isWeekend && b.isWeekend && a.weekend && b.weekend && a.weekend === b.weekend && !(a.weekendForced || b.weekendForced)
        && !(isWeekendISO(a.date) && isWeekendISO(b.date))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Neighbor-relax: after reduceFatigue, relieve the days ADJACENT to a forced
// same-day M+D row (the workday-sudoku prelock). The forced person P owns both
// cells on X — if P is ALSO on X-1's Deployment or X+1's Morning, they would be
// grinding 3 days running. Each such (avoidably) adjacent assignment is moved to
// another available colleague who passes validateAll, preferably an
// mPlusDAccepted volunteer (e.g. Andy), and only when it never increases the
// red-count (consecutive-M / d+m / w+m / d+s) nor blows a scope's spread past
// MAX_SPREAD. Runs AFTER reduceFatigue (so reduceFatigue never "fixes" the
// relaxation back into a same-day double) and BEFORE rule10Pass (which re-balances
// from this relaxed schedule). Every move is a single-cell relocate; counts are
// re-derived by the caller afterwards.
// ---------------------------------------------------------------------------
function neighborRelax(rows, names, unavailable, mPlusDAccepted) {
  mPlusDAccepted = mPlusDAccepted || new Set();
  const byDate = {};
  for (const r of rows) byDate[r.date] = r;
  const MAX_SPREAD = 2;
  const redCount = () => {
    let c = 0;
    for (const r of rows) {
      const py = byDate[dayPlus(r.date, -1)];
      if (r.morning && py && (py.deployment === r.morning || py.weekend === r.morning)) c++; // d+m / w+m
      if (r.weekend && py && py.deployment === r.weekend) c++; // d+s
      if (r.morning && py && py.morning === r.morning) c++; // consecutive-M
    }
    return c;
  };
  const scopeSpread = (field) => {
    const t = {};
    for (const n of names) t[n] = 0;
    for (const r of rows) { const v = r[field]; if (v) t[v]++; }
    const nums = names.map((n) => t[n]);
    return Math.max(...nums) - Math.min(...nums);
  };
  // Prefer an mPlusDAccepted target (the volunteer) so the burden lands on a
  // willing someone, other things equal.
  const targets = names.slice().sort((a, b) =>
    mPlusDAccepted.has(a) === mPlusDAccepted.has(b) ? 0 : mPlusDAccepted.has(a) ? -1 : 1
  );
  const before = redCount();
  for (const x of rows) {
    // Only forced same-day M+D rows (workday sudoku prelock) are the trigger.
    if (!(x.deploymentSudoku && x.morning && x.deployment && x.morning === x.deployment)) continue;
    const P = x.morning;
    // --- X-1 Deployment side ---
    const p1 = byDate[dayPlus(x.date, -1)];
    if (p1 && p1.deployment === P && !p1.deploymentManual && !p1.deploymentSudoku) {
      for (const q of targets) {
        if (q === P || (unavailable[q] && unavailable[q][p1.date])) continue;
        const saved = p1.deployment;
        p1.deployment = q;
        const valid = validateAll(rows, names, unavailable);
        const okRed = redCount() <= before;
        const okSpread = scopeSpread("deployment") <= MAX_SPREAD;
        p1.deployment = saved;
        if (valid && okRed && okSpread) { p1.deployment = q; break; }
      }
    }
    // --- X+1 Morning side ---
    const p2 = byDate[dayPlus(x.date, 1)];
    if (p2 && p2.morning === P && !p2.morningManual && !p2.deploymentSudoku) {
      for (const q of targets) {
        if (q === P || (unavailable[q] && unavailable[q][p2.date])) continue;
        const saved = p2.morning;
        p2.morning = q;
        const valid = validateAll(rows, names, unavailable);
        const okRed = redCount() <= before;
        const okSpread = scopeSpread("morning") <= MAX_SPREAD;
        p2.morning = saved;
        if (valid && okRed && okSpread) { p2.morning = q; break; }
      }
    }
  }
}

// Tandem-relief pass: unwind any "one person pulls >=3 duties across two
// consecutive calendar days" (the inhumane m+m / d+m stacking the user rejects)
// by relocating a SINGLE adjacent Deployment/Morning off the overloaded person to
// another available colleague. Unlike a crude cost-weight, every move is gated by
// validateAll (hard rules, incl. the 3-day-deployment ceiling) AND a per-scope
// spread cap, so removing a tandem never sacrifices fairness (the regression that
// a penalized objective caused on hard-coverage months). Prefers handing the
// relieved cell to an mPlusDAccepted volunteer (e.g. Andy) when possible. Runs
// AFTER neighborRelax so the forced-double relaxation happens first, and BEFORE
// rule10Pass which re-balances from the relaxed schedule.
// ---------------------------------------------------------------------------
function relieveTandems(rows, names, unavailable, mPlusDAccepted) {
  mPlusDAccepted = mPlusDAccepted || new Set();
  const byDate = {};
  for (const r of rows) byDate[r.date] = r;
  const MAX_SPREAD = 2;
  const isManual = (r, col) =>
    col === "deployment" ? r.deploymentManual : col === "morning" ? r.morningManual : r.weekendManual;
  const fixed = (r, col) =>
    isManual(r, col) ||
    (col === "deployment" && (r.deploymentSudoku)) ||
    (col === "morning" && (r.morningForced || r.deploymentSudoku)) ||
    (col === "weekend" && (r.weekendSudoku || r.weekendForced));
  const scopeSpread = (field) => {
    const t = {};
    for (const n of names) t[n] = 0;
    for (const r of rows) { const v = r[field]; if (v) t[v]++; }
    const nums = names.map((n) => t[n]);
    return Math.max(...nums) - Math.min(...nums);
  };
  const roleCount = (day) => {
    const m = {};
    const rr = byDate[day];
    if (rr) {
      for (const who of [rr.morning, rr.deployment, rr.weekend]) if (who) m[who] = (m[who] || 0) + 1;
    }
    return m;
  };
  // Repeatedly scan the whole range; each iteration that finds an overload
  // relocates ONE adjacent Deployment/Morning off the overloaded colleague and
  // then KEEPS scanning (does not break out of the row loop), so EVERY tandem
  // in range is relieved — not just the first few. The outer fixed-point loop is
  // a safety net for the rare case where relocating one tandem enables another;
  // the per-pass `moved` flag tells us when no progress remains.
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (const r of rows) {
      const today = roleCount(r.date);
      const prev = roleCount(dayPlus(r.date, -1));
      const overloaded = names.filter((n) => (today[n] || 0) + (prev[n] || 0) >= 3);
      if (!overloaded.length) continue;
      const P = overloaded[0];
      // Try relocating P's cell on THIS day (or the previous day) to another
      // available colleague, guarded by validateAll + spread. Prefer giving the
      // relieved cell to an mPlusDAccepted volunteer when one exists.
      const targets = names.slice().sort((a, b) =>
        mPlusDAccepted.has(a) === mPlusDAccepted.has(b) ? 0 : mPlusDAccepted.has(a) ? -1 : 1);
      let relocated = false;
      for (const [day, col] of [["today","deployment"],["today","morning"],["prev","deployment"],["prev","morning"]]) {
        const rr = day === "today" ? r : byDate[dayPlus(r.date, -1)];
        if (!rr || rr[col] !== P || fixed(rr, col)) continue;
        for (const q of targets) {
          if (q === P || (unavailable[q] && unavailable[q][rr.date])) continue;
          const saved = rr[col];
          rr[col] = q;
          const valid = validateAll(rows, names, unavailable);
          const okSpread = scopeSpread(col) <= MAX_SPREAD;
          rr[col] = saved;
          if (valid && okSpread) { rr[col] = q; relocated = true; break; }
        }
        if (relocated) break;
      }
      if (relocated) moved = true;
      // Continue to the next row — do NOT break the row loop, so later tandems
      // (including ones this relocation may have unmasked) are relieved too.
    }
    if (!moved) break;
  }
}

// Count-preserving local-search pass: relocate WHICH day a person works a given
// shift column between two non-manual days (a 2-way swap), keeping every person's
// per-shift total identical (so final evenness is provably untouched), while
// strictly decreasing the weighted tiring-flag count. Runs Deployment, then
// Morning, then Weekend, each as a bounded fixed-point loop. After this, any
// residual flags are genuinely-unavoidable (kept red).
function reduceFatigue(rows, names, unavailable, manualShifts, holidays, mPlusDAccepted) {
  // Optional 6th-arg shape reused for the manual-lock gate.
  manualShifts = manualShifts || {};
  holidays = holidays || new Set();
  mPlusDAccepted = mPlusDAccepted || new Set();
  const dayIsManual = (r, col) =>
    col === "deployment" ? r.deploymentManual : col === "morning" ? r.morningManual : r.weekendManual;
  // A cell is IMMOVABLE if the user manually locked it OR the sudoku-first
  // pre-scan prelocked it (single-available staff). reduceFatigue must never
  // relocate those. The weekend column carries a weekend sudoku lock; a weekday
  // sudoku lock forces BOTH the deployment and morning cells of that day.
  const lockedIn = (r, col) =>
    dayIsManual(r, col) ||
    (col === "weekend" && r.weekendSudoku) ||
    (r.deploymentSudoku && (col === "deployment" || col === "morning"));
  const cols = ["deployment", "morning", "weekend"];
  const asWeekday = (r) => !r.isWeekend;

  const countsOf = () => {
    const c = newCounts(names);
    for (const r of rows) {
      if (r.morning) addCount(c, r.morning, "morning", 1);
      if (r.deployment) addDeployCount(c, r.deployment, r.date, 1);
      if (r.weekend) addCount(c, r.weekend, weekendScope(r.date, holidays), 1);
    }
    syncDerivedCounts(c, names);
    return c;
  };
  const spread = (arr) => Math.max(...arr) - Math.min(...arr);
  const morningByDay = () => {
    const m = {}; for (const r of rows) if (r.morning) m[r.date] = r.morning; return m;
  };
  const roleByDay = () => {
    const m = {};
    for (const r of rows) {
      m[r.date] = {};
      if (r.morning) m[r.date][r.morning] = (m[r.date][r.morning] || 0) + 1;
      if (r.deployment) m[r.date][r.deployment] = (m[r.date][r.deployment] || 0) + 1;
      if (r.weekend) m[r.date][r.weekend] = (m[r.date][r.weekend] || 0) + 1;
    }
    return m;
  };

  // Objective. The CSV spread of EVERY scope (m, d, t, wsat, wsun, h) is held to
  // at most MAX_SPREAD (hard cap → huge penalty); within that, we minimize a
  // weighted combo of the flag-worthy tiring patterns, ordered by how the team
  // ranks them (least→most acceptable):
  //   0   — consecutive Deployment, and a same-day M+D held by an mPlusDAccepted
  //         volunteer (e.g. Andy): tolerated compromises, cost nothing.
  //   LOW — a same-day M+D held by a NON-volunteer (a real red flag).
  //   HIGH— two consecutive days of Morning (the least-acceptable red).
  // The pass trades a little spread to remove red flags, but never lets any
  // scope drift past "接近平均".
  const MAX_SPREAD = 2;
  const RED_W = 8, CONS_M_W = 16, SPREAD_W = 1;
  const SCOPE_KEYS = ["morning", "deployment", "thursday", "wsat", "wsun", "hcount"];
  const cost = () => {
    const c = countsOf();
    let hard = 0, totalSpread = 0;
    for (const key of SCOPE_KEYS) {
      const s = spread(names.map((n) => c[n][key]));
      if (s > MAX_SPREAD) hard += 1e6;
      totalSpread += s;
    }
    let red = 0, cm = 0;
    const mp = morningByDay();
    for (const r of rows) {
      // A same-day M+D double held by a colleague who EXPLICITLY accepts it
      // (mPlusDAccepted, e.g. Andy) costs 0 red — to them it is the relief valve,
      // not a violation. The relocate pass therefore prefers to reroute an
      // unavoidable double OFF a non-volunteer and ONTO Andy (strictly lowers
      // cost by RED_W), while the MAX_SPREAD cap keeps every scope even → 公平.
      if (r.morning && r.deployment && r.morning === r.deployment && !mPlusDAccepted.has(r.morning)) red++;
      // Two consecutive workday Mornings by the same person = the least-accepted
      // pattern; HIGH weight so the pass avoids it hardest.
      if (r.morning && mp[dayPlus(r.date, -1)] === r.morning) cm++;
    }
    return hard + totalSpread * SPREAD_W + red * RED_W + cm * CONS_M_W;
  };

  // A JOINT local-search loop. Each iteration scans TWO kinds of moves and
  // applies the single globally-best improving one:
  //   (1) same-column 2-way swap between two candidate days (count-preserving),
  //   (2) single-day relocate of a Deployment/Morning to a different available
  //       person on that same day (count-changing — this is what lets the pass
  //       BREAK a same-day M+D red day by handing one side to another colleague).
  // Every candidate is gated by validateAll (hard rules), so nothing can break
  // availability / rest / Rule-1 / Sat≠Sun. Bounded iterations → always fast.
  const budget = 800;
  for (let iter = 0; iter < budget; iter++) {
    const before = cost();
    let best = null; // { apply: fn, total }
    // --- same-column 2-way swaps ---
    for (const col of cols) {
      const hosts = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => (col === "weekend" ? r.isWeekend : asWeekday(r)))
        .filter(({ r }) => Boolean(r[col]) && !lockedIn(r, col));
      for (let a = 0; a < hosts.length; a++) {
        for (let b = a + 1; b < hosts.length; b++) {
          const ra = hosts[a].r, rb = hosts[b].r, ia = hosts[a].i, ib = hosts[b].i;
          if (ra[col] === rb[col]) continue;
          const va = ra[col], vb = rb[col];
          ra[col] = vb; rb[col] = va;
          const ok = validateAll(rows, names, unavailable);
          const t = ok ? cost() : Infinity;
          ra[col] = va; rb[col] = vb;
          if (t < before && t < (best ? best.total : Infinity)) {
            best = { total: t, apply: () => { rows[ia][col] = vb; rows[ib][col] = va; } };
          }
        }
      }
    }
    // --- single-day relocate (count-changing) on weekdays ---
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.isWeekend) continue;
      for (const col of ["deployment", "morning"]) {
        if (!r[col] || lockedIn(r, col)) continue;
        const cur = r[col];
        for (const nx of names) {
          if (nx === cur) continue;
          if (unavailable[nx] && unavailable[nx][r.date]) continue; // must be available
          r[col] = nx;
          const ok = validateAll(rows, names, unavailable);
          const t = ok ? cost() : Infinity;
          r[col] = cur;
          if (t < before && t < (best ? best.total : Infinity)) {
            best = { total: t, apply: () => { rows[i][col] = nx; } };
          }
        }
      }
    }
    if (!best) break; // fixed point: no strict improvement in any move
    best.apply();
  }
}

// ---------------------------------------------------------------------------
// Rule 10 — cross-axis "comprehensive fairness". After the per-scope greedy +
// rebalance + fatigue passes have each scope as even as possible, some staff may
// still land on a HIGHER TOTAL shift count than others (top of every scope at
// once). This count-preserving local search transfers a single shift from a
// colleague who is ABOVE their fair share in a scope to the colleague with the
// LOWEST `total` shift count, whenever doing so strictly shrinks the `total`
// spread (max − min) WITHOUT pushing any per-scope spread past MAX_SPREAD.
// Every candidate move is gated by validateAll (hard rules incl. successiveness),
// never moves a manual-locked shift, and updates `counts` in place.
// ---------------------------------------------------------------------------
function rule10Pass(rows, names, unavailable, holidays, counts) {
  holidays = holidays || new Set();
  if (names.length < 2) return;
  const MAX_SPREAD = 2;
  // Cross-axis total balancing across the scopes that feed `total` (fixed-spec:
  // total = morning + deployment + wsat + wsun + hcount). Non-Thursday
  // `deployment` is deliberately absent: it is a 檔2 scope whose evenness the
  // greedy already enforces, and adding it here lets total-balancing crowd out
  // the 檔1 weekend transfers (rule10Pass applies one best move per iteration),
  // regressing wsat/wsun/hcount evenness. Thursday is transferable via its own
  // `thursday` scope (field `deployment`, Thu-only).
  const scopes = ["morning", "thursday", "wsat", "wsun", "hcount"];
  // The row field that carries each scope, and its single leaf-count key.
  const fieldOf = (sc) =>
    sc === "morning" ? "morning" : sc === "thursday" ? "deployment" : "weekend";
  const leafOf = (sc) => (sc === "thursday" ? "deployment" : sc);
  const manualOf = (r, sc) =>
    fieldOf(sc) === "morning" ? (r.morningManual)
      : fieldOf(sc) === "deployment" ? (r.deploymentManual)
      : (r.weekendManual || r.weekendSudoku); // sudoku-prelocked weekend is immovable here too
  const totalSpread = () => countSpread(counts, names, "total");

  // Red-aware guard: rule10Pass may equalize cross-axis `total` counts, but it
  // must never REINTRODUCE a tiring pattern that the earlier passes already
  // removed — otherwise "fairer totals" silently buys back the red flags the
  // user wants gone. Mirror exactly what computeFlags flags on a pair of
  // consecutive rows: consecutive-2-day Morning, d→m (Morning after Deployment),
  // d→wsun (Weekend Support after Deployment), and the >=3-shifts-in-2-days
  // tandem overload. A transfer that does not strictly increase this count is
  // allowed (it may equal it); anything that would add a red is rejected no
  // matter how much it helps `total` fairness.
  const fatigueCount = () => {
    const byIso = {};
    for (const r of rows) byIso[r.date] = r;
    let c = 0;
    for (const r of rows) {
      const py = byIso[dayPlus(r.date, -1)];
      if (!py) continue;
      if (r.morning && py.morning === r.morning) c++;          // consecutive morning
      if (r.morning && py.deployment === r.morning) c++;       // d→m
      if (r.weekend && py.deployment === r.weekend) c++;       // d→wsun
      // w→m (Morning after Weekend Support) is a TOLERATED last-resort in
      // computeFlags (informational, not a forced red flag), but it is still a
      // fatigue pattern rule10Pass must not newly introduce while balancing
      // totals — so it participates in the "do not worsen fatigue" gate.
      if (r.morning && py.weekend === r.morning) c++;          // w→m
    }
    // Tandem overload: >=3 duties in any 2 consecutive calendar days.
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (dayPlus(a.date, 1) !== b.date) continue;
      const roles = {};
      for (const rr of [a, b]) {
        for (const who of [rr.morning, rr.deployment, rr.weekend]) {
          if (!who) continue;
          roles[who] = (roles[who] || 0) + 1;
        }
      }
      for (const who of Object.keys(roles)) if (roles[who] >= 3) c++;
    }
    return c;
  };
  const fatigueBefore = fatigueCount();

  // Weekend-shift adjacency (ordered) so successiveness is an O(1) local check.
  const weekendRows = [];
  const wsIndexLocal = {};
  rows.forEach((r, i) => { if (r.isWeekend) { wsIndexLocal[r.date] = weekendRows.length; weekendRows.push(r); } });

  const budget = 60;
  let considered = 0; // hard cap on validateAll calls (the expensive gate)
  for (let iter = 0; iter < budget; iter++) {
    const beforeTotal = totalSpread();
    if (beforeTotal < 2) break; // already as even as transferable
    let best = null, bestGain = 0;
    scan:
    for (const sc of scopes) {
      // Total-imbalance targeting: a scope can donate as long as moving a unit
      // from a high-total colleague to a low-total one strictly shrinks the
      // `total` spread without pushing the MOVED leaf spread past MAX_SPREAD.
      // (The per-scope strict evenness was already enforced by the greedy; this
      // pass only equalizes cross-axis totals within that per-scope cap.)
      const f = fieldOf(sc);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const from = r[f];
        if (!from || manualOf(r, sc)) continue;
        // Day/scope eligibility for this candidate donor row.
        if (sc === "thursday") { if (isoWeekday(r.date) !== 3) continue; }
        else if (sc !== "morning") { if (!r.isWeekend || weekendScope(r.date, holidays) !== sc) continue; }
        for (const to of names) {
          if (to === from) continue;
          if (counts[to].total >= counts[from].total) continue; // must reduce total spread
          // Require the donor to have STRICTLY more of this scope than the
          // acceptor, so the transfer NARROWS (never widens) this scope's spread.
          // Per-scope fairness dominates total-targeting (user's strict rules).
          if ((counts[to][sc] || 0) >= (counts[from][sc] || 0)) continue;
          // --- cheap localized feasibility (avoids the O(n) validateAll) ---
          if (unavailable[to] && unavailable[to][r.date]) continue;
          if (sc === "morning") {
            // Rest rule: `to` can't morning today if yesterday's Deploy/Weekend was `to`.
            const py = i > 0 ? rows[i - 1] : null;
            if (py && (py.deployment === to || py.weekend === to)) continue;
          } else if (f === "weekend") {
            // No same-day double-booking, and successiveness vs adjacent weekend
            // days (relaxed: repeating onto the adjacent day is OK when that pair
            // is a legitimate wsat+wsun weekend).
            if (r.morning === to || r.deployment === to) continue;
            const idx = wsIndexLocal[r.date];
            const prevR = idx > 0 ? weekendRows[idx - 1] : null;
            const nextR = idx < weekendRows.length - 1 ? weekendRows[idx + 1] : null;
            if (prevR && prevR.weekend === to && !successivenessAllowed(prevR.date, r.date, holidays)) continue;
            if (nextR && nextR.weekend === to && !successivenessAllowed(r.date, nextR.date, holidays)) continue;
          } else {
            // deployment / thursday donor: don't double-book into the same day's weekend.
            if (r.weekend === to) continue;
          }
          // --- total-spread improvement quick check ---
          // A transfer moves one shift; a thursday transfer moves `deployment`
          // AND `thursday` (so it changes `total` by ±2), everything else ±1.
          const delta = sc === "thursday" ? 2 : 1;
          const totals = names.map((n) => counts[n].total + (n === from ? -delta : n === to ? delta : 0));
          const afterSpread = Math.max(...totals) - Math.min(...totals);
          const gain = beforeTotal - afterSpread;
          if (gain <= 0) continue;
          // --- validateAll as a final safety gate on this genuine candidate ---
          considered++;
          const saved = r[f];
          r[f] = to;
          const leaf = leafOf(sc);
          counts[from][leaf]--; counts[to][leaf]++;
          if (sc === "thursday") { counts[from].thursday--; counts[to].thursday++; }
          syncDerivedCounts(counts, names);
          const valid = validateAll(rows, names, unavailable);
          const newScopeSpread = sc === "thursday"
            ? countSpread(counts, names, "deployment")
            : countSpread(counts, names, leaf);
          if (valid && newScopeSpread <= MAX_SPREAD && fatigueCount() <= fatigueBefore && gain > bestGain) {
            best = { r, f, from, to, sc, leaf };
            bestGain = gain;
          }
          // revert
          r[f] = saved;
          counts[from][leaf]++; counts[to][leaf]--;
          if (sc === "thursday") { counts[from].thursday++; counts[to].thursday--; }
          syncDerivedCounts(counts, names);
          if (considered > 4000) break scan; // hard cap on validateAll work
        }
      }
    }
    if (!best) break;
    // Apply the single globally-best improving transfer.
    best.r[best.f] = best.to;
    counts[best.from][best.leaf]--; counts[best.to][best.leaf]++;
    if (best.sc === "thursday") { counts[best.from].thursday--; counts[best.to].thursday++; }
    syncDerivedCounts(counts, names);
  }
}

/* ------------------------- Manual cell overrides + rule reporting --------- */

// Annotate every schedule cell with the rule(s) it violates — "warn, don't
// forbid". Runs AFTER buildSchedule; pure read-only (no count mutation). Writes,
// per row:
//   row.morningViol      : [string, ...]  rules the morning cell breaks
//   row.deploymentViol   : [string, ...]  rules the deployment cell breaks
//   row.weekendViol      : [string, ...]  rules the weekend cell breaks
// These are what renderPreview surfaces (e.g. "violates: rest rule (morning
// 9/5 by Thursday deploy 9/4)"). A user HARD-OVERRIDE that puts an unavailable
// person on shift is therefore accepted, but flagged here.
function annotateViolations(rows, names, unavailable, holidays, mPlusDAccepted) {
  unavailable = unavailable || {};
  holidays = holidays || new Set();
  mPlusDAccepted = mPlusDAccepted || new Set();
  const byDate = {};
  for (const r of rows) byDate[r.date] = r;
  const deplByDay = {};    // iso -> person deployed that day
  const weekendByDay = {}; // iso -> person doing weekend support that day (incl holidays)
  for (const r of rows) { if (r.deployment) deplByDay[r.date] = r.deployment; }
  for (const r of rows) { if (r.weekend) weekendByDay[r.date] = r.weekend; }
  // Ordered list of weekend/holiday days so we can check successiveness.
  const wsDays = rows.filter((r) => r.isWeekend).map((r) => r.date);
  const prevWs = (iso) => {
    const i = wsDays.indexOf(iso);
    for (let k = i - 1; k >= 0; k--) {
      const d = wsDays[k];
      if (weekendByDay[d]) return { day: d, person: weekendByDay[d] };
    }
    return null;
  };
  const nextWs = (iso) => {
    const i = wsDays.indexOf(iso);
    for (let k = i + 1; k < wsDays.length; k++) {
      const d = wsDays[k];
      if (weekendByDay[d]) return { day: d, person: weekendByDay[d] };
    }
    return null;
  };
  // Per-day role count (for the 3-shifts-in-2-days overload check).
  const roles = {}; // iso -> { name: count }
  for (const r of rows) {
    roles[r.date] = {};
    if (r.morning) roles[r.date][r.morning] = 1;
    if (r.deployment) roles[r.date][r.deployment] = (roles[r.date][r.deployment] || 0) + 1;
    if (r.weekend) roles[r.date][r.weekend] = (roles[r.date][r.weekend] || 0) + 1;
  }
  const broke = (viol, msg) => { if (!viol.includes(msg)) viol.push(msg); };

  for (const r of rows) {
    const vM = (r.morningViol = r.morningViol || []);
    const vD = (r.deploymentViol = r.deploymentViol || []);
    const vW = (r.weekendViol = r.weekendViol || []);
    const prev = byDate[dayPlus(r.date, -1)];
    const prevDepl = prev ? prev.deployment : null;
    const prevWeek = prev ? prev.weekend : null;
    const prevMorning = prev ? prev.morning : null;

    // ---- Availability (the ONLY hard rule; overridden cells still warned) ----
    if (r.morning && unavailable[r.morning] && unavailable[r.morning][r.date])
      broke(vM, `unavailable: ${r.morning} is marked unavailable on ${r.label}`);
    if (r.deployment && unavailable[r.deployment] && unavailable[r.deployment][r.date])
      broke(vD, `unavailable: ${r.deployment} is marked unavailable on ${r.label}`);
    if (r.weekend && unavailable[r.weekend] && unavailable[r.weekend][r.date])
      broke(vW, `unavailable: ${r.weekend} is marked unavailable on ${r.label}`);

    // ---- Day-type: the wrong shift on the wrong kind of day ----
    if (r.isWeekend) {
      if (r.morning) broke(vM, "day-type: Morning on a weekend/holiday (unless manually set)");
      if (r.deployment && !r.deploymentManual) broke(vD, "day-type: Deployment on a weekend/holiday (unless manually set)");
    } else if (r.weekend && !r.weekendManual) {
      broke(vW, "day-type: Weekend support on a working day (unless manually set)");
    }

    // ---- Rest rule: Morning the day after a Deployment (d→m, §30) is a HARD
    // red — flagged even when forced (sole-available). Morning after Weekend
    // Support (w→m, §35 level 5) is a TOLERATED last-resort compromise: it is an
    // informational note, not a red violation.
    if (r.morning && prevDepl === r.morning)
      broke(vM, `rest rule: ${r.morning} did Deployment yesterday (${dayPlus(r.date, -1)})`);
    if (r.morning && prevWeek === r.morning)
      broke(vM, `tolerated compromise (w→m): ${r.morning} did Weekend Support the previous day (${dayPlus(r.date, -1)}) — last-resort relief, not a violation`);

    // ---- Consecutive 2-day Morning (the least-acceptable pattern) ----
    // The same person does Morning on back-to-back workdays. A weekend/holiday
    // between breaks adjacency (that intermediate day has no morning, so
    // prevMorning is empty and cannot match). Soft warning (warn, don't forbid).
    if (r.morning && prevMorning === r.morning && !r.morningForced)
      broke(vM, `consecutive morning: ${r.morning} also did Morning Health Check yesterday (${dayPlus(r.date, -1)})`);

    // ---- Rule 1: Weekend person must differ from yesterday's Deployment ----
    // Flagged even when forced (sole-available) — the extra fatigue is still borne
    // and must surface for the staff to see, so no weekendForced exemption here.
    if (r.weekend && prevDepl === r.weekend)
      broke(vW, `Rule 1: ${r.weekend} did Deployment yesterday (${dayPlus(r.date, -1)})`);

    // ---- Successiveness: differ from prev & next adjacent weekend-shift person.
    // Relaxed: repeating onto the adjacent day is NOT a violation when that
    // adjacent pair is a legitimate wsat+wsun calendar weekend — so e.g. a Sun(wsun)
    // followed by the next Sat(wsat) no longer flags. Only same-scope / holiday
    // repeats (unsuccessiveAllowed) are flagged. ----
    if (r.weekend) {
      const p = prevWs(r.date), n = nextWs(r.date);
      if (p && p.person === r.weekend && !r.weekendForced && !successivenessAllowed(p.day, r.date, holidays))
        broke(vW, `successiveness: ${r.weekend} also covered the previous weekend/holiday (${p.day})`);
      if (n && n.person === r.weekend && !r.weekendForced && !successivenessAllowed(r.date, n.day, holidays))
        broke(vW, `successiveness: ${r.weekend} also covers the next weekend/holiday (${n.day})`);
    }

    // ---- Same-day overlap: person double-booked into weekend + a weekday duty ----
    if (r.weekend && (r.weekend === r.morning || r.weekend === r.deployment) && !r.weekendForced)
      broke(vW, "double-book: same person also does Morning/Deployment same day");

    // ---- Same-day Morning + Deployment by one person. Per the user's rule this
    // is NOT flagged red at all — neither for a non-volunteer nor for an accepted
    // one. It is a tolerated compromise the optimizer only *tries to avoid* via the
    // reduceFatigue cost ladder, but never surfaces as a violation. (Consecutive-M
    // is the single least-acceptable pattern, flagged above; consecutive-D is the
    // other tolerated compromise and is deliberately not flagged either.)

    // ---- 3 duties in a rolling 2-day window (tandem overload) ----
    const prevRoles = roles[dayPlus(r.date, -1)];
    if (prevRoles) {
      const mine = prevRoles && roles[r.date];
      if (mine) {
        for (const n of Object.keys(prevRoles)) {
          const two = (prevRoles[n] || 0) + (mine[n] || 0);
          if (two >= 3) {
            const bit = `overload: ${n} has ${two} shifts across ${r.label} & yesterday`;
            if (mine[n] && r.morning === n) broke(vM, bit);
            if (mine[n] && r.deployment === n) broke(vD, bit);
            if (mine[n] && r.weekend === n) broke(vW, bit);
          }
        }
      }
    }
  }
}

// Commit an individual Preview cell edit into `manualOverrides` and refresh.
// `col` is "morning" | "deployment" | "weekend"; `value` is a colleague name
// ('' to clear). Blanking removes the override so the scheduler owns the cell.
function setManualOverride(iso, col, value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!manualOverrides[iso]) manualOverrides[iso] = {};
  manualOverrides[iso][col] = v;
  if (Object.keys(manualOverrides[iso]).every((k) => manualOverrides[iso][k] === "")) {
    delete manualOverrides[iso]; // all edited columns cleared -> restore scheduler control
  }
  updateAll();
}

// Build a <select> for inline editing of a Preview cell. Options = all
// colleagues + a blank "clear" option. Colleagues unavailable that day are
// greyed-out (disabled) so the user is discouraged from assigning them, though
// the current override (if any) is still selectable so it can be edited/cleared.
function editableCellSelect(iso, col, names, unavailable) {
  const sel = document.createElement("select");
  sel.className = "cell-edit-select";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— clear —";
  sel.appendChild(blank);
  for (const n of names) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    // An unavailable staff member is greyed out for the shift they can't do.
    if (unavailable && unavailable[n] && unavailable[n][iso]) {
      opt.disabled = true;
      opt.textContent = `${n} (unavailable)`;
    }
    sel.appendChild(opt);
  }
  sel.dataset.iso = iso;
  sel.dataset.col = col;
  sel.addEventListener("change", () => {
    setManualOverride(sel.dataset.iso, sel.dataset.col, sel.value);
  });
  return sel;
}

/* ------------------------- Preview rendering ----------------------------- */

function renderPreview(rows, namesList, unavailable) {
  const wrap = document.getElementById("preview-wrap");
  const tbody = document.getElementById("preview-tbody");
  tbody.innerHTML = "";
  // Column index -> the row field + shift name it edits. Columns 1..3 (Morning,
  // Deployment, Weekend) are user-editable; Date(0) and Unavailable(4) are not.
  const editCols = [
    { i: 1, field: "morning" },
    { i: 2, field: "deployment" },
    { i: 3, field: "weekend" },
  ];
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.isWeekend) tr.className = "weekend-row";
    const flagged = (r.forced && r.forced.length > 0) || false;
    const cells = [r.label, r.morning, r.deployment, r.weekend, r.notAvailable];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      if (i === 0) td.className = "date-cell";
      if (i === 4 && v) td.className = "avail-cell";
      // Manual overrides / saved locks are marked bold (cols 1..3).
      const manual =
        (i === 1 && r.morningManual) ||
        (i === 2 && r.deploymentManual) ||
        (i === 3 && r.weekendManual);
      if (manual) td.classList.add("deploy-manual");
      // A staff cell that carries a duty today gets flagged red when the day could
      // not avoid a tiring (consecutive / double-shift / overload) pattern.
      if (flagged && i >= 1 && i <= 3 && v) td.classList.add("flag-cell");

      if (editCols.some((c) => c.i === i)) {
        // Editable staff cell: clicking swaps it for an inline dropdown so the
        // user can hand-assign / clear right in the table.
        td.classList.add("cell-edit");
        td.dataset.iso = r.date;
        td.dataset.field = editCols.find((c) => c.i === i).field;
        td.textContent = v || "";
        // Surface the rule(s) this cell violates (e.g. from a user hard-override
        // that forced an unavailable person or broke rest/successiveness). This
        // is a WARNING — the change is honored, never forbidden.
        const field = editCols.find((c) => c.i === i).field;
        const violKey = field === "morning" ? "morningViol" : field === "deployment" ? "deploymentViol" : "weekendViol";
        const viols = r[violKey];
        if (viols && viols.length) {
          td.classList.add("rule-viol"); // distinct amber warning styling
          td.title = "⚠ violates:\n" + viols.join("\n");
        } else {
          td.title = "Click to edit";
        }
        td.addEventListener("click", () => {
          if (td.querySelector("select")) return; // dropdown already open
          const sel = editableCellSelect(r.date, td.dataset.field, namesList, unavailable);
          // Preselect the current value (if it is still a valid option).
          if (v) sel.value = v;
          td.textContent = "";
          td.appendChild(sel);
          sel.focus();
        });
      } else {
        td.textContent = v || "";
      }
      tr.appendChild(td);
    });
    if (flagged) {
      tr.children[0].classList.add("flag-date");
      tr.children[0].title = r.forced.join("\n");
    }
    tbody.appendChild(tr);
  }
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "No days in range.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  wrap.classList.remove("hidden");
}

function renderCounts(namesList, counts) {
  const tbody = document.getElementById("counts-tbody");
  tbody.innerHTML = "";
  const keys = ["morning", "deployment", "thursday", "wsat", "wsun", "hcount", "total"];
  const sums = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const n of namesList) {
    const c = counts[n] || { morning: 0, deployment: 0, thursday: 0, wsat: 0, wsun: 0, hcount: 0, total: 0 };
    const tr = document.createElement("tr");
    [n, c.morning, c.deployment, c.thursday, c.wsat, c.wsun, c.hcount, c.total].forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
    for (const k of keys) sums[k] += (c[k] || 0);
  }
  // Footer: per-column Total and Average (mean across colleagues).
  const avg = (k) => (namesList.length ? sums[k] / namesList.length : 0);
  const roundAvg = (v) => (Number.isInteger(v) ? v : +v.toFixed(2));
  const tfoot = document.getElementById("counts-tfoot");
  if (tfoot) tfoot.innerHTML = "";
  const totalTr = document.createElement("tr");
  totalTr.className = "counts-total";
  [ "Total", ...keys.map((k) => sums[k]) ].forEach((v) => {
    const td = document.createElement("td");
    td.textContent = v;
    totalTr.appendChild(td);
  });
  const avgTr = document.createElement("tr");
  avgTr.className = "counts-avg";
  [ "Average", ...keys.map((k) => roundAvg(avg(k))) ].forEach((v) => {
    const td = document.createElement("td");
    td.textContent = v;
    avgTr.appendChild(td);
  });
  if (tfoot) { tfoot.appendChild(totalTr); tfoot.appendChild(avgTr); }
}

// Render a flat, copyable log of every violation / "must-bear" message that the
// Preview tooltips and matrix flags surface per-cell. Purely informational — the
// user can read (or copy) the list and hand it back as feedback; nothing here
// changes the schedule. Aggregates BOTH sources into one table:
//   • column-specific breaks (row.morningViol / deploymentViol / weekendViol) —
//     the amber "⚠ violates:" tooltips on editable cells
//   • forced "must bear it" patterns (row.forced) — the red date/matrix flags
// Omitted (by design): Manual/override edits that introduce no break, and the
// tolerated compromises the engine deliberately does NOT flag (same-day m+d,
// consecutive-Deployment).
const VIOL_COLS = [
  { key: "morningViol",    shift: "Morning(M)" },
  { key: "deploymentViol", shift: "Deployment(D)" },
  { key: "weekendViol",    shift: "Weekend(W)" },
];
function renderViolations(rows) {
  const panel = document.getElementById("violation-panel");
  const tbody = document.getElementById("violation-tbody");
  const summaryEl = document.getElementById("violation-summary");
  if (!panel || !tbody) return;
  tbody.innerHTML = "";
  const lines = []; // { date, label, who, issue } for the table + text log

  for (const r of rows) {
    // A) Column-specific tooltip violations.
    for (const c of VIOL_COLS) {
      const viols = r[c.key];
      if (viols && viols.length) {
        const person =
          (c.key === "morningViol" && r.morning) ||
          (c.key === "deploymentViol" && r.deployment) ||
          (c.key === "weekendViol" && r.weekend) ||
          "?";
        for (const msg of viols) lines.push({ date: r.date, label: r.label, who: `${person} · ${c.shift}`, issue: msg });
      }
    }
    // B) Forced "must bear it" flags (date cell / matrix).
    if (r.forced && r.forced.length) {
      for (const msg of r.forced) {
        // The message already leads with the colleague(s) name; just tag the source.
        lines.push({ date: r.date, label: r.label, who: "—", issue: `${msg} [forced]` });
      }
    }
  }

  // Sort chronologically by date (rows are already in order, but stay safe).
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Summary line + table.
  if (lines.length) {
    panel.classList.remove("hidden");
    const forcedCount = lines.filter((l) => l.issue.includes("[forced]")).length;
    const violCount = lines.length - forcedCount;
    summaryEl.textContent =
      `${lines.length} item(s): ${violCount} column violation(s), ${forcedCount} must-bear (forced) pattern(s). ` +
      "These are the same messages you see by hovering — copy them below to report why each flag exists.";
    for (const l of lines) {
      const tr = document.createElement("tr");
      [l.label, l.who, l.issue].forEach((v) => {
        const td = document.createElement("td");
        if (v === l.who && v === "—") td.className = "muted";
        td.textContent = v;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  } else {
    panel.classList.add("hidden");
    summaryEl.textContent = "No violations — schedule is fully clean.";
  }
}

/* ------------------------- Availability matrix --------------------------- */

function renderMatrix(rows, namesList, unavailable) {
  const panel = document.getElementById("matrix-panel");
  const thead = document.getElementById("matrix-head");
  const tbody = document.getElementById("matrix-body");
  if (!panel || !thead || !tbody) return;
  if (!rows.length || !namesList.length) {
    panel.classList.add("hidden");
    return;
  }

  const dates = rows.map((r) => r.date);
  const byDate = {};
  for (const r of rows) byDate[r.date] = r;

  // Weekend columns get a tinted header.
  const weekdayInitial = (iso) =>
    ["一", "二", "三", "四", "五", "六", "日"][isoWeekday(iso)];
  const mmdd = (iso) => iso.slice(5);

  // Header row: blank corner + one <th> per date.
  const headTr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "matrix-corner";
  corner.textContent = "Colleague \\ Date";
  headTr.appendChild(corner);
  for (const iso of dates) {
    const th = document.createElement("th");
    // Tint weekend AND holiday columns using the row's isWeekend flag (which
    // is set from the active holiday union via needsWeekendShift), not just the
    // calendar weekend — so holiday-only dates read as distinguishable too.
    const isWe = byDate[iso] && byDate[iso].isWeekend;
    th.className = isWe ? "matrix-date matrix-weekend" : "matrix-date";
    th.textContent = `${mmdd(iso)}\n${weekdayInitial(iso)}`;
    th.title = iso;
    headTr.appendChild(th);
  }
  thead.innerHTML = "";
  thead.appendChild(headTr);

  // Body: one row per colleague.
  tbody.innerHTML = "";
  for (const name of namesList) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.className = "matrix-name";
    th.textContent = name;
    tr.appendChild(th);
    for (const iso of dates) {
      const td = document.createElement("td");
      const rec = unavailable[name] || {};
      const dayNotes = rec[iso];
      const row = byDate[iso];
      td.className = "matrix-cell";

      if (dayNotes && dayNotes.length) {
        // Unavailable wins: orange + short note.
        td.classList.add("matrix-unavail");
        td.textContent = dayNotes[0];
        td.title = `${name} unavailable (${dayNotes.join(", ")})`;
      } else if (row && row.morning === name) {
        td.classList.add("matrix-morning");
        if (row.morningManual) {
          td.classList.add("matrix-morning-manual");
          td.textContent = "M*";
          td.title = "Morning duty (manual)";
        } else {
          td.textContent = "M";
          td.title = "Morning duty";
        }
      } else if (row && row.deployment === name) {
        td.classList.add("matrix-deploy");
        if (row.deploymentManual) {
          td.classList.add("matrix-deploy-manual");
          td.textContent = "D*";
          td.title = "Deployment duty (manual)";
        } else {
          td.textContent = "D";
          td.title = "Deployment duty";
        }
      } else if (row && row.weekend === name) {
        td.className = "matrix-weekend-duty";
        if (row.weekendManual) {
          td.classList.add("matrix-weekend-manual");
          td.textContent = "W*";
          td.title = "Weekend Support (manual)";
        } else {
          td.textContent = "W";
          td.title = "Weekend Support";
        }
      } else {
        // Physically available, no duty assigned to this staff today.
        td.classList.add("matrix-avail");
      }
      // Flag the on-duty staff cell red when this date had to bear a tiring
      // (consecutive / double-shift / overload) pattern the fairness rule forced.
      if (row && row.forced && row.forced.length > 0 &&
          [row.morning, row.deployment, row.weekend].includes(name)) {
        td.classList.add("matrix-flag");
        td.title = row.forced.join(" | ");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  panel.classList.remove("hidden");
}

/* ------------------------- .xls export (HTML table) ----------------------
   Excel reads an HTML table saved with the .xls extension. We embed the same
   structure + inline styles as the on-screen preview, with the summary table
   on top (matching the Python openpyxl layout).
 --------------------------------------------------------------------------- */

function exportToXLS(rows, counts, namesList, unavailable) {
  // Summary table: one row per colleague. Columns cover each fairness scope.
  let summaryRows = "";
  for (const n of namesList) {
    const c = counts[n] || { morning: 0, deployment: 0, thursday: 0, wsat: 0, wsun: 0, hcount: 0, weekend: 0, total: 0 };
    let naTotal = 0;
    if (unavailable[n]) naTotal = Object.values(unavailable[n]).reduce((s, arr) => s + arr.length, 0);
    summaryRows += `<tr style="border:1px solid #000;background:#fff">
      <td style="border:1px solid #000;padding:4px">${esc(n)}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.morning}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.deployment}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.thursday}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.wsat}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.wsun}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.hcount}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.weekend}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.total}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${naTotal || ""}</td>
    </tr>`;
  }

  // Main schedule table.
  let mainRows = "";
  for (const r of rows) {
    const bg = r.isWeekend ? "background:#FBE5D6" : "";
    const naStyle = r.notAvailable ? "background:#FCE4D6" : "";
    const mStyle = r.morningManual ? "font-weight:bold;" : "";
    const depStyle = r.deploymentManual ? "font-weight:bold;" : "";
    const wStyle = r.weekendManual ? "font-weight:bold;" : "";
    const flag = (r.forced && r.forced.length > 0) || false;
    const flagStyle = "background:#F8D7DA;color:#842029;font-weight:bold;";
    const flagMsg = flag ? ` title="${esc(r.forced.join("\n"))}"` : "";
    // Flag the date cell red when this date carries an unavoidable tiring pattern.
    const dateStyle = (flag ? flagStyle : "") + bg;
    mainRows += `<tr style="border:1px solid #000">
      <td style="border:1px solid #000;padding:4px;font-weight:bold;${dateStyle}"${flagMsg}>${esc(r.label)}</td>
      <td style="border:1px solid #000;padding:4px;${flag && r.morning ? flagStyle : ""}${mStyle}">${esc(r.morning)}</td>
      <td style="border:1px solid #000;padding:4px;${flag && r.deployment ? flagStyle : ""}${depStyle}">${esc(r.deployment)}</td>
      <td style="border:1px solid #000;padding:4px;${flag && r.weekend ? flagStyle : ""}${wStyle}">${esc(r.weekend)}</td>
      <td style="border:1px solid #000;padding:4px;${naStyle}">${esc(r.notAvailable)}</td>
    </tr>`;
  }

  const html =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Schedule</x:Name>
<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
  .sumh {background:#D9D9D9;font-weight:bold;text-align:center;border:1px solid #000}
  .mainh {background:#D9D9D9;font-weight:bold;text-align:center;border:1px solid #000}
  td {mso-number-format:"\\@";}
</style>
</head>
<body>
<table>
  <tr>
    <th class="sumh">Colleague Name</th>
    <th class="sumh">Morning (m)</th>
    <th class="sumh">Deploy (d)</th>
    <th class="sumh">Thu (t)</th>
    <th class="sumh">WSat</th>
    <th class="sumh">WSun</th>
    <th class="sumh">Holiday (h)</th>
    <th class="sumh">Weekend</th>
    <th class="sumh">Total</th>
    <th class="sumh">Unavailable</th>
  </tr>
  ${summaryRows}
</table>
<br/>
<table>
  <tr>
    <th class="mainh" style="background:#D9D9D9">Date</th>
    <th class="mainh" style="background:#DDEBF7">Morning Health Check (08:45~)</th>
    <th class="mainh" style="background:#E7E6E6">Deployment</th>
    <th class="mainh" style="background:#DDEBF7">Weekend Support</th>
    <th class="mainh" style="background:#FCE4D6">Unavailable</th>
  </tr>
  ${mainRows}
</table>
</body>
</html>`;

  return html;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function downloadXLS(rows, counts, namesList, unavailable, start, end) {
  const html = exportToXLS(rows, counts, namesList, unavailable);
  const blob = new Blob(["\ufeff" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `duty_schedule_${start.replace(/-/g, "")}_${end.replace(/-/g, "")}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ------------------------- UI wiring ------------------------------------- */

let records = []; // {name, start(iso), end(iso), note}

// Manual cell overrides entered by the user directly in the Preview table.
// Key = ISO date; value = only the columns the user changed:
//   { morning?: name | "", deployment?: name | "", weekend?: name | "" }
// An absent key means "follow the generated schedule"; an empty-string value
// means the user explicitly CLEARED that cell. Applied on top of the scheduler
// output (after all buildSchedule passes) so the user always has the final say.
// In-memory only, like `records` (reset on reload).
let manualOverrides = {}; // { iso: { morning?, deployment?, weekend? } }

function loadHKHolidays() {
  if (hkLoading) return; // never overlap fetches
  hkLoading = true;
  const spanYears = (() => {
    const s = document.getElementById("startDate").value;
    const e = document.getElementById("endDate").value;
    if (!s || !e) return [];
    return neededYears(s > e ? e : s, s > e ? s : e);
  })();
  fetch(HK_ENDPOINT)
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then((payload) => {
      hkCache = parseHKPayload(payload);
      for (const y of Object.keys(hkCache)) {
        if (!hkCache[y].size) delete hkCache[y];
      }
      // Loaded only if every spanned year is covered by cache or static.
      for (const y of spanYears) {
        if (!(hkCache[y] && hkCache[y].size) && !STATIC_HK_HOLIDAYS[y]) {
          hkLoaded = false;
          updateAll();
          return;
        }
      }
      hkLoaded = true;
      updateAll();
    })
    .catch(() => {
      // Any failure (network, CORS, parse): leave a clean empty cache.
      hkCache = {};
      hkLoaded = false;
      updateAll();
    })
    .finally(() => {
      hkLoading = false;
    });
}

function updateAll() {
  const start = document.getElementById("startDate").value;
  const end = document.getElementById("endDate").value;
  const namesRaw = document.getElementById("names").value;

  if (!start || !end) return;
  let s = start, e = end;
  if (s > e) { [s, e] = [e, s]; }

  const names = parseNames(namesRaw);
  const spanYears = neededYears(s, e);

  // Active holiday set = static fallback + fetched cache (spanned years) +
  //                     declared "Holiday" records.
  const holidays = staticHolidaysForYears(spanYears);
  for (const y of spanYears) {
    const set = hkCache[y];
    if (set) for (const iso of set) holidays.add(iso);
  }

  // Derive holidays-added, unavailable map, and manual shifts from the unified
  // `records` array (DOM-free pure helper; see buildSchedule).
  const derived = deriveFromRecords(records, s, e);
  for (const iso of derived.holidaysAdded) holidays.add(iso);
  const unavailable = derived.unavailable;
  const manualShifts = derived.manualShifts;

  // Status line for HK holidays.
  const st = document.getElementById("hk-status");
  if (st) {
    const cachedYears = spanYears.filter((y) => hkCache[y] && hkCache[y].size);
    if (cachedYears.length === spanYears.length) {
      st.textContent = `HK public holidays: loaded (${spanYears.join(", ")})`;
    } else if (spanYears.every((y) => STATIC_HK_HOLIDAYS[y])) {
      st.textContent = "HK public holidays: using built-in list";
    } else {
      st.textContent = "HK public holidays: unavailable offline — weekends only";
    }
  }

  const mPlusDEl = document.getElementById("mplusd");
  const mPlusDAccepted = mPlusDEl ? new Set(parseNames(mPlusDEl.value)) : new Set();

  // ---- Merge the user's inline cell edits into the scheduler INPUT ----
  // A cell edit becomes a hard lock ({override:true}) inside `manualShifts`,
  // so buildSchedule recomputes the WHOLE range around it (方案 A): the lock is
  // honored even if the person is unavailable that day (warn, don't forbid),
  // and every OTHER cell is re-assigned to fit. This replaces the old "patch
  // the output afterwards" override layer.
  for (const iso of Object.keys(manualOverrides)) {
    const over = manualOverrides[iso];
    if (iso < s || iso > e) continue; // out of range: leave stored but unused
    for (const col of ["morning", "deployment", "weekend"]) {
      if (!(col in over)) continue;
      const name = over[col].trim ? over[col].trim() : over[col];
      // "clear" (''): no override on this column → scheduler re-owns it.
      if (!name) continue;
      const bucket = manualShifts[col] = manualShifts[col] || {};
      // User hard-override wins over any derived manual lock / first-wins.
      bucket[iso] = { name, manual: true, override: true };
    }
  }

  const { rows, counts } = buildSchedule(s, e, names, holidays, unavailable, manualShifts, { mPlusDAccepted });

  // Annotate every cell with the rule(s) it violates (warn, don't forbid). Pure
  // read-only pass; attaches {morningViol, deploymentViol, weekendViol} strings.
  annotateViolations(rows, names, unavailable, holidays);

  // Swap the swapped start/end back into the download filename.
  renderPreview(rows, names, unavailable);
  renderCounts(names, counts);
  renderRecordsList();
  renderMatrix(rows, names, unavailable);
  renderViolations(rows);

  // Store for download / preview.
  window.__export = { rows, counts, names, unavailable, manualShifts, start: s, end: e };

  const hasRows = rows.length > 0;
  document.getElementById("export-btn").disabled = !hasRows;
  document.getElementById("preview-xls-btn").disabled = !hasRows;
}

/* Render the exact exportToXLS HTML into the Excel-preview iframe. The export
   produces a self-contained <html> document (its own <style>), so an <iframe>
   via srcdoc keeps it isolated and lets a long schedule scroll internally
   without blooming the page layout. */
function renderXLSPreview() {
  const ex = window.__export;
  const area = document.getElementById("xls-preview-area");
  const panel = document.getElementById("xls-preview-panel");
  if (!ex || !area || !panel) return;
  area.srcdoc = exportToXLS(ex.rows, ex.counts, ex.names, ex.unavailable);
  panel.classList.remove("hidden");
}

function closeXLSPreview() {
  const panel = document.getElementById("xls-preview-panel");
  if (panel) panel.classList.add("hidden");
}

/* Human-readable one-line summary of a typed record, used in the records list. */
function recordSummary(rec) {
  const when = `${rec.start} → ${rec.end}`;
  const who = rec.name ? `${rec.name} · ` : "";
  switch (rec.type) {
    case "holiday":
      return rec.name
        ? `${rec.name} unavailable (Holiday) · ${when}`
        : `Holiday · ${when}`;
    case "deploy":   return `${who}Deployment · ${when}`;
    case "morning":  return `${who}Morning · ${when}`;
    case "weekend":  return `${who}Weekend · ${when}`;
    default:         return `${who}Unavailable · ${when}`;
  }
}

/* Render every record (holidays, unavailability, and manual shifts) into the
   sidebar list, each with a delete button. Removing a record re-solves the
   whole schedule from the remaining `records`. */
function renderRecordsList() {
  const box = document.getElementById("records-list");
  box.innerHTML = "";
  if (!records.length) {
    box.innerHTML = '<p class="muted">No records yet.</p>';
    return;
  }
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const row = document.createElement("div");
    row.className = "record";
    const label = document.createElement("span");
    label.textContent = recordSummary(rec);
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.className = "del";
    del.title = "Remove record";
    del.addEventListener("click", () => {
      records.splice(i, 1);
      updateAll();
    });
    row.appendChild(label);
    row.appendChild(del);
    box.appendChild(row);
  }
}

/* ------------------------- Entry point ---------------------------------- */

/* Unified "Add Record" form handler.

   The single form has a shift-kind selector (#rec-kind) plus one free-text
   input (#rec-line) that accepts the "Name: sep1,5,20-23" format. Everything
   becomes a row in the shared `records` array (with a `type` field), which is
   the single source for the schedule AND the removable records list:

     - Holiday, name-less    -> {type:'holiday', name:''} : dates become holidays
     - Holiday, named        -> {type:'holiday', name:X}  : dates are holidays
                               AND X is unavailable those days (off work)
     - Unavailable           -> {type:'unavailable'}      : X is off work (whole day)
                               on those dates (does NOT make the date a holiday)
     - Manual Deployment     -> {type:'deploy'}           : locks X into Deployment
     - Manual Morning        -> {type:'morning'}          : locks X into Morning
     - Manual Weekend        -> {type:'weekend'}          : locks X into Weekend

   After any add the input clears and updateAll() rebuilds the schedule. DOM-
   touching only; the parse helpers it calls are DOM-free. */
function submitUnifiedRecord() {
  const err = document.getElementById("rec-unified-error");
  const kind = document.getElementById("rec-kind").value; // holiday|unavailable|deploy|morning|weekend
  const lineEl = document.getElementById("rec-line");
  const promptFor = {
    holiday: 'e.g. sep1,5,20-23 — or "Andy: sep1,5" to mark a colleague off that day (holiday).',
    unavailable: "e.g. Andy: sep1,5 (that colleague is off work those days)",
    deploy: 'e.g. Andy: sep7-20 (dates are honored even on weekends)',
    morning: "e.g. Tina: sep2,5,11",
    weekend: "e.g. Tina: sep2,5,11",
  };
  const raw = (lineEl.value || "").trim();
  if (!raw) { if (err) err.textContent = "Enter dates first: " + promptFor[kind]; return; }
  let s = document.getElementById("startDate").value;
  let e = document.getElementById("endDate").value;
  if (!s || !e) { if (err) err.textContent = "Set a date range first."; return; }
  if (s > e) { [s, e] = [e, s]; }

  // Split a leading "Name: " prefix from the rest of the expression.
  const colonAt = raw.indexOf(":");
  const name = colonAt >= 0 ? raw.slice(0, colonAt).trim() : "";
  const expr = (colonAt >= 0 ? raw.slice(colonAt + 1) : raw).trim();
  const names = parseNames(document.getElementById("names").value);

  // Manual shift kinds require a colleague name; Holiday does not.
  if (kind !== "holiday" && !name) {
    if (err) err.textContent = `Enter the colleague first, e.g. ${promptFor[kind]}.`;
    return;
  }
  if (name && names.length && !names.includes(name)) {
    if (err) err.textContent = `Unknown colleague "${name}".`;
    return;
  }

  const dates = resolveDateExpr(expr, s, e);
  if (!dates.length) {
    if (err) err.textContent = "No valid dates within the selected range.";
    return;
  }

  const type = { holiday: "holiday", unavailable: "unavailable", deploy: "deploy", morning: "morning", weekend: "weekend" }[kind];
  const note = kind === "holiday" ? "Holiday" : (kind === "unavailable" ? "Unavailable" : "");
  for (const r of groupContiguous(dates)) {
    const key = `${type}|${name}|${r.start}|${r.end}`;
    if (!records.some((x) => `${x.type}|${x.name}|${x.start}|${x.end}` === key)) {
      records.push({ type, name, start: r.start, end: r.end, note });
    }
  }

  lineEl.value = "";
  if (err) err.textContent = "";
  updateAll();
}

/* Bulk-import records (one per non-empty line, "Name: sep1,5,20-23" format).
   The fastest way to load a whole month of availability / holidays / manual
   locks at once (e.g. from a fixed schedule CSV's "Not available" column).
   Each line is parsed like the single Add Record form and deduped against the
   existing `records` (same {type}|{name}|{start}|{end} key); already-present
   rows are skipped, the rest are appended. A line is skipped only when no valid
   date in the range resolves; malformed/unknown-name lines are skipped with a
   note. DOM-touching; reuses the DOM-free parse helpers. */
function submitBulkRecords() {
  const err = document.getElementById("bulk-error");
  const lineEl = document.getElementById("bulk-line");
  const kind = document.getElementById("bulk-kind").value;
  const names = parseNames(document.getElementById("names").value);
  let s = document.getElementById("startDate").value;
  let e = document.getElementById("endDate").value;
  if (!s || !e) { if (err) err.textContent = "Set a date range first."; return; }
  if (s > e) { [s, e] = [e, s]; }

  const rawLines = (lineEl.value || "")
    .split(/[\r\n]+/).map((L) => L.trim()).filter(Boolean);
  if (!rawLines.length) { if (err) err.textContent = "Paste at least one line first."; return; }

  const type = { holiday: "holiday", unavailable: "unavailable", deploy: "deploy", morning: "morning", weekend: "weekend" }[kind];
  const note = kind === "holiday" ? "Holiday" : (kind === "unavailable" ? "Unavailable" : "");
  const nameSet = new Set(names);
  let added = 0, rejected = 0;
  const rejectedMsgs = [];

  for (const raw of rawLines) {
    const colonAt = raw.indexOf(":");
    const name = colonAt >= 0 ? raw.slice(0, colonAt).trim() : "";
    const expr = (colonAt >= 0 ? raw.slice(colonAt + 1) : raw).trim();
    // Manual / unavailable kinds require a colleague name; only Holiday needs none.
    if (kind !== "holiday") {
      if (!name) { rejected++; rejectedMsgs.push(`\u201C${raw}\u201D (no colleague name)`); continue; }
      if (nameSet.size && !nameSet.has(name)) { rejected++; rejectedMsgs.push(`\u201C${raw}\u201D (unknown colleague "${name}")`); continue; }
    }
    const dates = resolveDateExpr(expr, s, e);
    if (!dates.length) { rejected++; rejectedMsgs.push(`\u201C${raw}\u201D (no valid dates)`); continue; }
    for (const r of groupContiguous(dates)) {
      const key = `${type}|${name}|${r.start}|${r.end}`;
      if (!records.some((x) => `${x.type}|${x.name}|${x.start}|${x.end}` === key)) {
        records.push({ type, name, start: r.start, end: r.end, note });
        added++;
      }
    }
  }

  if (err) {
    const parts = [`Imported ${added} record(s).`];
    if (rejected) parts.push(`${rejected} line(s) skipped.`);
    if (rejectedMsgs.length) parts.push("Details: " + rejectedMsgs.slice(0, 5).join("; "));
    err.textContent = parts.join(" ");
  }
  if (added) lineEl.value = "";
  updateAll();
}

function init() {
  // Default date range: today .. +30 days.
  document.getElementById("startDate").value = isoDay(0);
  document.getElementById("endDate").value = isoDay(30);

  // The single "Add Record" form is the only way to create records.
  const addUnified = document.getElementById("add-unified");
  if (addUnified) addUnified.addEventListener("click", submitUnifiedRecord);
  const recLine = document.getElementById("rec-line");
  if (recLine) {
    recLine.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); submitUnifiedRecord(); }
    });
  }

  // Bulk Import: one button parses every non-empty line into records.
  const addBulk = document.getElementById("add-bulk");
  if (addBulk) addBulk.addEventListener("click", submitBulkRecords);
  const bulkLine = document.getElementById("bulk-line");
  if (bulkLine) {
    bulkLine.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitBulkRecords(); }
    });
  }

  // Live updates when the date range or colleague names change. (Records are
  // added/removed through the Add Record form and its list; those already call
  // updateAll(), so they are not re-wired here.)
  ["startDate", "endDate", "names", "mplusd"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateAll);
  });

  document.getElementById("export-btn").addEventListener("click", () => {
    const ex = window.__export;
    if (ex) downloadXLS(ex.rows, ex.counts, ex.names, ex.unavailable, ex.start, ex.end);
  });

  document.getElementById("preview-xls-btn").addEventListener("click", renderXLSPreview);
  const pvClose = document.getElementById("xls-preview-close");
  if (pvClose) pvClose.addEventListener("click", closeXLSPreview);

  updateAll();
  loadHKHolidays(); // kick off; falls back to static offline. No blocking.
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

/* ------------------------- Node test harness ------------------------------
   Under Node there is no `document`, so the DOM-touching sections above must
   not run. When a test harness requires this file with a `globalThis` shim, we
   expose the pure engine pieces so headless validation can run. In the browser
   none of this branch executes.
  --------------------------------------------------------------------------- */

if (typeof globalThis !== "undefined" && typeof document === "undefined") {
  module.exports = {
    buildSchedule,
    expandRange,
    neededYears,
    parseHKPayload,
    parseNames,
    parseHolidays,
    needsWeekendShift,
    needsWeekdayShift,
    weekendScope,
    isWeekendISO,
    isoWeekday,
    dayPlus,
    toISO,
    yearFor,
    parseShortDates,
    parseManualDeployments,
    parseManualShifts,
    resolveDateExpr,
    groupContiguous,
    deriveFromRecords,
    MONTH_ABBRS,
    STATIC_HK_HOLIDAYS,
  };
}