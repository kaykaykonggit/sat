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
// `total` = morning + deployment + thursday + wsat + wsun + h (the user's
// formula: a Thursday deployment counts in BOTH `deployment` and `thursday`).
function addCount(counts, name, key, delta) {
  counts[name][key] = (counts[name][key] || 0) + delta;
  const c = counts[name];
  c.weekend = (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
  c.total =
    (c.morning || 0) + (c.deployment || 0) + (c.thursday || 0) +
    (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
  return counts;
}

// Recompute weekend & total from the leaf scopes for every colleague.
function syncDerivedCounts(counts, names) {
  for (const n of names) {
    const c = counts[n];
    c.weekend = (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
    c.total =
      (c.morning || 0) + (c.deployment || 0) + (c.thursday || 0) +
      (c.wsat || 0) + (c.wsun || 0) + (c.hcount || 0);
  }
  return counts;
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

  // General successiveness ("h, wsat, wsun cannot be successive person"):
  // the weekend-support person on a weekend-shift day must differ from the
  // support person on the PREVIOUS adjacent weekend-shift day (forward
  // processing automatically guarantees the "next" side too, and subsumes the
  // old Sat != Sun rule). weekendShiftDays lists weekend-shift days in order.
  const weekendShiftDays = days.filter((d) => needsWeekendShift(d, holidays));
  const prevSupport = (day) => {
    const idx = weekendShiftDays.indexOf(day);
    for (let k = idx - 1; k >= 0; k--) {
      const d = weekendShiftDays[k];
      if (weekendPersonByDay[d]) return weekendPersonByDay[d];
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
    let weekendForced = false;

    const manualDeployForDay = manualDeployment[day] && manualDeployment[day].name;
    const deplLocked = manualDeployForDay && availableFor(manualDeployForDay);
    const manualMorningForDay = manualMorning[day] && manualMorning[day].name;
    const mornLocked = manualMorningForDay && availableFor(manualMorningForDay);

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

      let bestD = "", bestM = "", bestTotal = Infinity;
      const yesterdayDay = dayPlus(day, -1);
      const yesterdayWorked = workedByDay[yesterdayDay] || new Set();
      const yesterdayRoles = roleCountByDay[yesterdayDay] || {};
      for (const D of dCands) {
        for (const M of mCands) {
          // Per-shift evenness: independent axes, least-count. Deployment balance only
          // considers Deployment counts; Morning balance only Morning counts. The
          // person with the fewest shifts of that type is preferred, which keeps
          // each shift even and naturally respects unequal availability (someone
          // who was out just stays low while present differently). The 1_000_000
          // multiplier makes evenness strictly dominate, so the count target is
          // always met before fatigue is ever consulted.
          //
          // Thursday deployment (t) is its own scope. On a Thursday the D axis
          // weights the thursday count; when the number of Thursdays EXCEEDS the
          // number of staff (surplus case), once everyone is at the shared base
          // (thuTarget) the surplus falls through to the LOWEST deployment-count
          // colleague (Rule 5), relaxing strict t-spread.
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
          const evenness = depEven * 1000000 + morNext * 1000000;

          // D doing Deployment yesterday (consecutive deployment).
          const depConsec = deploymentByDay[yesterdayDay] === D ? 1 : 0;

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
            DEPCONS_W * depConsec +
            TANDEM_W * tandem +
            CONSEC_W * consec +
            SAME_W * same;
          if (total < bestTotal) {
            bestTotal = total; bestD = D; bestM = M;
          }
        }
      }
      if (bestM !== "") {
        deployment = bestD;
        deploymentManual = deplLocked && bestD === manualDeployForDay;
        morning = bestM;
        morningManual = mornLocked && bestM === manualMorningForDay;
        addCount(counts, deployment, "deployment", 1);
        if (isoWeekday(day) === 3) addCount(counts, deployment, "thursday", 1);
        addCount(counts, morning, "morning", 1);
      }
    } else if (deplLocked) {
      // Weekend / holiday: a manual Deployment lock is still honored (no auto
      // Morning/Deployment those days unless locked).
      deployment = manualDeployForDay;
      deploymentManual = true;
      addCount(counts, deployment, "deployment", 1);
      if (isoWeekday(day) === 3) addCount(counts, deployment, "thursday", 1);
    }

    // ---- Weekend Support (Sat/Sun/public holidays) ---------------------------
    let weekend = "";
    let weekendManual = false;
    if (weekendShift) {
      const manual = manualWeekend[day] && manualWeekend[day].name;
      if (manual && availableFor(manual)) {
        weekend = manual;
        weekendManual = true;
        addCount(counts, weekend, weekendScope(day, holidays), 1);
      } else {
        // Eligible pool: available, not Rule-1-eligible (differs from yesterday's
        // Deployment), differs from today's Deployment person (no double-booking
        // into both shifts same day), and differs from the previous adjacent
        // weekend-shift support person ("h, wsat, wsun cannot be successive
        // person" — this subsumes the old Sat != Sun rule via forward processing).
        const scope = weekendScope(day, holidays);
        const prev = prevSupport(day);
        let pool = names.filter(
          (n) =>
            availableFor(n) &&
            n !== deployment &&
            !violatedRule1(day, n) &&
            n !== prev
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
      weekend,
      weekendManual,
      weekendForced,
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
        idx, day: r.date, person: r.weekend, manual: r.weekendManual,
        scope: weekendScope(r.date, holidays),
      });
    }
  });
  // Next adjacent weekend-shift support person (known now that all rows exist).
  const nextSupport = (day) => {
    const idx = wsIndex[day];
    if (idx === undefined) return null;
    for (let k = idx + 1; k < weekendShiftDays.length; k++) {
      const d = weekendShiftDays[k];
      if (weekendPersonByDay[d]) return weekendPersonByDay[d];
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
      if (cand === prevSupport(w.day)) return false;      // prev successiveness
      if (cand === nextSupport(w.day)) return false;      // next successiveness
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
  reduceFatigue(rows, names, unavailable, manualShifts, holidays);
  // relocate moves in the fatigue pass change individual counts, so recompute the
  // per-person shift totals from the final rows before reporting them.
  const finalCounts = newCounts(names);
  for (const r of rows) {
    if (r.morning) addCount(finalCounts, r.morning, "morning", 1);
    if (r.deployment) {
      addCount(finalCounts, r.deployment, "deployment", 1);
      if (isoWeekday(r.date) === 3) addCount(finalCounts, r.deployment, "thursday", 1);
    }
    if (r.weekend) addCount(finalCounts, r.weekend, weekendScope(r.date, holidays), 1);
  }
  syncDerivedCounts(finalCounts, names);
  // Copy the freshly-derived counts back into the shared `counts` object.
  for (const n of names) Object.assign(counts[n], finalCounts[n]);
  // Rule 10: cross-axis comprehensive fairness pass (transfers allow only total
  // spread reduction, never worsening any per-scope spread past MAX_SPREAD).
  rule10Pass(rows, names, unavailable, holidays, counts);
  computeFlags(rows, names); // sets row.forced (possibly empty) on every row

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
function computeFlags(rows, names) {
  const roleMap = rolesByDayFromRows(rows);
  const deplByDay = {};
  for (const r of rows) if (r.deployment) deplByDay[r.date] = r.deployment;
  let total = 0;
  for (const r of rows) {
    const forced = [];
    // 1. Same-day Morning + Deployment by one person.
    if (r.morning && r.deployment && r.morning === r.deployment) {
      forced.push(`${r.morning} bears both Morning Health Check & Deployment this day (no fair alternative).`);
    }
    // 2. >=3 duties by one person across two consecutive days.
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
    // 3. Consecutive Deployment (today + yesterday).
    if (r.deployment && deplByDay[prev] === r.deployment) {
      forced.push(`${r.deployment} deploys on consecutive days — tiring (after-hours duty).`);
      total += 3;
    }
    if (r.morning && r.deployment && r.morning === r.deployment) total += 1;
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
  }
  // Successiveness ("h, wsat, wsun cannot be successive person"): the weekend-
  // support person on a weekend-shift day must differ from the support person on
  // the PREVIOUS adjacent weekend-shift day. Adjacent weekend-shift days are
  // consecutive calendar days both needing a weekend shift (rows are consecutive
  // by date). This subsumes the old Sat != Sun rule AND covers holiday adjacency
  // (e.g. Sunday + Monday public holiday).
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.isWeekend && b.isWeekend && a.weekend && b.weekend && a.weekend === b.weekend && !(a.weekendForced || b.weekendForced)) return false;
  }
  return true;
}

// Count-preserving local-search pass: relocate WHICH day a person works a given
// shift column between two non-manual days (a 2-way swap), keeping every person's
// per-shift total identical (so final evenness is provably untouched), while
// strictly decreasing the weighted tiring-flag count. Runs Deployment, then
// Morning, then Weekend, each as a bounded fixed-point loop. After this, any
// residual flags are genuinely-unavoidable (kept red).
function reduceFatigue(rows, names, unavailable, manualShifts, holidays) {
  // Optional 6th-arg shape reused for the manual-lock gate.
  manualShifts = manualShifts || {};
  holidays = holidays || new Set();
  const dayIsManual = (r, col) =>
    col === "deployment" ? r.deploymentManual : col === "morning" ? r.morningManual : r.weekendManual;
  const cols = ["deployment", "morning", "weekend"];
  const asWeekday = (r) => !r.isWeekend;

  const countsOf = () => {
    const c = newCounts(names);
    for (const r of rows) {
      if (r.morning) addCount(c, r.morning, "morning", 1);
      if (r.deployment) {
        addCount(c, r.deployment, "deployment", 1);
        if (isoWeekday(r.date) === 3) addCount(c, r.deployment, "thursday", 1);
      }
      if (r.weekend) addCount(c, r.weekend, weekendScope(r.date, holidays), 1);
    }
    syncDerivedCounts(c, names);
    return c;
  };
  const spread = (arr) => Math.max(...arr) - Math.min(...arr);
  const deplByDay = () => {
    const d = {}; for (const r of rows) if (r.deployment) d[r.date] = r.deployment; return d;
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
  // weighted combo of the same-day M+D "red" days and consecutive- Deployment
  // (the user's most-tiring concern). This lets the pass trade a little spread
  // to remove red flags, but never lets any scope drift past "接近平均".
  const MAX_SPREAD = 2;
  const RED_W = 8, CONSEC_W = 12, SPREAD_W = 1;
  const SCOPE_KEYS = ["morning", "deployment", "thursday", "wsat", "wsun", "hcount"];
  const cost = () => {
    const c = countsOf();
    let hard = 0, totalSpread = 0;
    for (const key of SCOPE_KEYS) {
      const s = spread(names.map((n) => c[n][key]));
      if (s > MAX_SPREAD) hard += 1e6;
      totalSpread += s;
    }
    let red = 0, cc = 0;
    const dp = deplByDay();
    for (const r of rows) {
      if (r.morning && r.deployment && r.morning === r.deployment) red++;
      if (r.deployment && dp[dayPlus(r.date, -1)] === r.deployment) cc++;
    }
    return hard + totalSpread * SPREAD_W + red * RED_W + cc * CONSEC_W;
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
        .filter(({ r }) => Boolean(r[col]) && !dayIsManual(r, col));
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
        if (!r[col] || dayIsManual(r, col)) continue;
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
  const scopes = ["morning", "thursday", "wsat", "wsun", "hcount"];
  // The row field that carries each scope, and its single leaf-count key.
  const fieldOf = (sc) =>
    sc === "morning" ? "morning" : sc === "thursday" ? "deployment" : "weekend";
  const leafOf = (sc) => (sc === "thursday" ? "deployment" : sc);
  const manualOf = (r, sc) =>
    fieldOf(sc) === "morning" ? r.morningManual
      : fieldOf(sc) === "deployment" ? r.deploymentManual
      : r.weekendManual;
  const totalSpread = () => countSpread(counts, names, "total");

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
            // No same-day double-booking, and successiveness vs adjacent weekend days.
            if (r.morning === to || r.deployment === to) continue;
            const idx = wsIndexLocal[r.date];
            const prevP = idx > 0 ? weekendRows[idx - 1].weekend : null;
            const nextP = idx < weekendRows.length - 1 ? weekendRows[idx + 1].weekend : null;
            if (prevP === to || nextP === to) continue;
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
          if (valid && newScopeSpread <= MAX_SPREAD && gain > bestGain) {
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

/* ------------------------- Preview rendering ----------------------------- */

function renderPreview(rows, namesList) {
  const wrap = document.getElementById("preview-wrap");
  const tbody = document.getElementById("preview-tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.isWeekend) tr.className = "weekend-row";
    const flagged = (r.forced && r.forced.length > 0) || false;
    const cells = [r.label, r.morning, r.deployment, r.weekend, r.notAvailable];
    cells.forEach((v, i) => {
      const td = document.createElement("td");
      td.textContent = v || "";
      if (i === 0) td.className = "date-cell";
      if (i === 4 && v) td.className = "avail-cell";
      // Manual overrides are marked bold (morning=1, deployment=2, weekend=3).
      const manual =
        (i === 1 && r.morningManual) ||
        (i === 2 && r.deploymentManual) ||
        (i === 3 && r.weekendManual);
      if (manual) td.classList.add("deploy-manual");
      // A staff cell that carries a duty today gets flagged red when the day could
      // not avoid a tiring (consecutive / double-shift / overload) pattern.
      if (flagged && i >= 1 && i <= 3 && v) td.classList.add("flag-cell");
      tr.appendChild(td);
    });
    if (flagged) {
      // Flag the date cell too and give the row a readable "must bear" tooltip.
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
  for (const n of namesList) {
    const c = counts[n] || { morning: 0, deployment: 0, thursday: 0, wsat: 0, wsun: 0, hcount: 0, total: 0 };
    const tr = document.createElement("tr");
    [n, c.morning, c.deployment, c.thursday, c.wsat, c.wsun, c.hcount, c.total].forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
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
  const { rows, counts } = buildSchedule(s, e, names, holidays, unavailable, manualShifts, { mPlusDAccepted });

  // Swap the swapped start/end back into the download filename.
  renderPreview(rows);
  renderCounts(names, counts);
  renderRecordsList();
  renderMatrix(rows, names, unavailable);

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