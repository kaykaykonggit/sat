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

  for (const rec of records) {
    if (rec.type === "holiday") {
      let rs = rec.start, re = rec.end;
      if (rs > re) { [rs, re] = [re, rs]; }
      for (const iso of expandRange(rs, re)) {
        if (iso >= s && iso <= e) holidaysAdded.add(iso);
      }
      // A named holiday also means that person is off work (unavailable).
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

/* ------------------------- Scheduling engine ------------------------------
   Mirrors build_schedule() in the Python prototype:
     unavailable: { name: { iso: [note, ...] } }
     manualDeployments: { iso: name } (optional) — user-locked Deployment.
   Returns { rows, counts }. On a manual deployment day the deployment is used
   directly (and marked deploymentManual) but still blocks next-day morning.
  --------------------------------------------------------------------------- */

function buildSchedule(start, end, names, holidays, unavailable, manualShifts) {
  if (!names.length) return { rows: [], counts: {} };
  // manualShifts (optional 6th param): { morning?, deployment?, weekend? }
  // each keyed by iso -> { name, manual:true }. First wins per date.
  manualShifts = manualShifts || {};
  const manualMorning = manualShifts.morning || {};
  const manualDeployment = manualShifts.deployment || {};
  const manualWeekend = manualShifts.weekend || {};

  const days = [];
  for (let d = start; d <= end; d = dayPlus(d, 1)) days.push(d);

  const counts = {};
  for (const n of names) {
    counts[n] = {
      morning: 0,
      deployment: 0,
      weekend: 0,
    };
  }

  let cannotMorningToday = new Set();
  let lastWeekendPerson = null;
  const rows = [];

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

    // ---- Workday shifts: Morning Health Check + Deployment -----------------
    // On a workday (Mon–Fri, not a public holiday) two SEPARATE colleagues are
    // on duty: Morning Health Check and Deployment. Each shift is balanced
    // independently (equal-ish Deployment days, equal-ish Morning days), so the
    // two are chosen TOGETHER each day as the pair that keeps BOTH counts most
    // even (never the same person on both shifts). A manual Deployment lock is
    // honored on ANY day type (even weekend/holiday); a manual Morning lock is
    // honored on workdays.
    let morning = "";
    let morningManual = false;
    let deployment = "";
    let deploymentManual = false;

    const manualDeployForDay = manualDeployment[day] && manualDeployment[day].name;
    if (manualDeployForDay && availableFor(manualDeployForDay)) {
      deployment = manualDeployForDay;
      deploymentManual = true;
      counts[deployment].deployment++; // totals reflect who actually worked
    }

    if (weekdayShift) {
      const manualMorningForDay = manualMorning[day] && manualMorning[day].name;
      const hasManualMorning = manualMorningForDay && availableFor(manualMorningForDay);

      // Morning manual lock (if any): honored on a workday.
      if (hasManualMorning) {
        morning = manualMorningForDay;
        morningManual = true;
        counts[morning].morning++;
      }

      if (deployment) {
        // Deployment already locked (manual). Auto Morning where available,
        // distinct from the deployment person and not rest-blocked.
        if (!hasManualMorning) {
          const pool = names.filter(
            (n) => availableFor(n) && n !== deployment && !cannotMorningToday.has(n)
          );
          if (pool.length) {
            morning = pool.reduce((best, n) =>
              counts[n].morning < counts[best].morning ? n : best
            );
            counts[morning].morning++;
          }
        }
      } else if (hasManualMorning) {
        // Auto Deployment (manual Morning is fixed): balance Deployment days,
        // never the manual-morning person.
        const pool = names.filter((n) => availableFor(n) && n !== manualMorningForDay);
        if (pool.length) {
          deployment = pool.reduce((best, n) =>
            counts[n].deployment < counts[best].deployment ? n : best
          );
          counts[deployment].deployment++;
        }
      } else {
        // Fully auto: choose the (Deployment, Morning) pair that best balances
        // BOTH counts. Minimise the larger predicted count first, then the total,
        // so neither shift drifts.
        const dPool = names.filter((n) => availableFor(n));
        const mPool = names.filter((n) => availableFor(n) && !cannotMorningToday.has(n));
        let bestD = "", bestM = "", bestScore = Infinity;
        for (const d of dPool) {
          for (const mm of mPool) {
            if (d === mm) continue; // never the same person on both shifts
            const depNext = counts[d].deployment + 1;
            const morNext = counts[mm].morning + 1;
            const score = Math.max(depNext, morNext) * 1000 + (depNext + morNext);
            if (score < bestScore) { bestScore = score; bestD = d; bestM = mm; }
          }
        }
        if (bestM !== "") {
          deployment = bestD; counts[deployment].deployment++;
          morning = bestM; counts[morning].morning++;
        }
      }
    }

    // ---- Weekend Support (Sat/Sun/public holidays) ---------------------------
    let weekend = "";
    let weekendManual = false;
    if (weekendShift) {
      // Manual override: use the locked-in name if valid AND available.
      const manual = manualWeekend[day] && manualWeekend[day].name;
      if (manual && availableFor(manual)) {
        weekend = manual;
        weekendManual = true;
        counts[weekend].weekend++;
        if (isWeekendISO(day)) lastWeekendPerson = weekend;
      } else {
        // Exclude today's (manual) deployment person from the Weekend Support
        // pool so a colleague who is deployed on a weekend isn't double-booked
        // into both the Deployment and the Weekend Support shift.
        const pool = names.filter((n) => availableFor(n) && n !== deployment);
        if (pool.length) {
          weekend = pool.reduce((best, n) => {
            const sameB = best === lastWeekendPerson ? 1 : 0;
            const sameN = n === lastWeekendPerson ? 1 : 0;
            const kB = [sameB, counts[best].weekend].join(".");
            const kN = [sameN, counts[n].weekend].join(".");
            return kN < kB ? n : best;
          });
          counts[weekend].weekend++;
          if (isWeekendISO(day)) lastWeekendPerson = weekend;
        }
      }
    }

    // Rest rule: today's deployment/weekend people are blocked from tomorrow's morning.
    cannotMorningToday = new Set([deployment, weekend].filter(Boolean));

    rows.push({
      date: day,
      label: dateLabel(day),
      isWeekend: needsWeekendShift(day, holidays),
      morning,
      morningManual,
      deployment,
      deploymentManual,
      weekend,
      weekendManual,
      notAvailable: notes.join(", "),
    });
  }

  return { rows, counts };
}

/* ------------------------- Preview rendering ----------------------------- */

function renderPreview(rows, namesList) {
  const wrap = document.getElementById("preview-wrap");
  const tbody = document.getElementById("preview-tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.isWeekend) tr.className = "weekend-row";
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
      tr.appendChild(td);
    });
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
    const c = counts[n] || { morning: 0, deployment: 0, weekend: 0 };
    const tr = document.createElement("tr");
    [n, c.morning, c.deployment, c.weekend].forEach((v) => {
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
  // Summary table: one row per colleague.
  let summaryRows = "";
  for (const n of namesList) {
    const c = counts[n] || { morning: 0, deployment: 0, weekend: 0 };
    let naTotal = 0;
    if (unavailable[n]) naTotal = Object.values(unavailable[n]).reduce((s, arr) => s + arr.length, 0);
    summaryRows += `<tr style="border:1px solid #000;background:#fff">
      <td style="border:1px solid #000;padding:4px">${esc(n)}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.morning}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.deployment}</td>
      <td style="border:1px solid #000;padding:4px;text-align:center">${c.weekend}</td>
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
    mainRows += `<tr style="border:1px solid #000">
      <td style="border:1px solid #000;padding:4px;font-weight:bold;${bg}">${esc(r.label)}</td>
      <td style="border:1px solid #000;padding:4px;${mStyle}">${esc(r.morning)}</td>
      <td style="border:1px solid #000;padding:4px;${depStyle}">${esc(r.deployment)}</td>
      <td style="border:1px solid #000;padding:4px;${wStyle}">${esc(r.weekend)}</td>
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
    <th class="sumh">Morning Health Check (08:45~)</th>
    <th class="sumh">Deployment</th>
    <th class="sumh">Weekend Support</th>
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

  const { rows, counts } = buildSchedule(s, e, names, holidays, unavailable, manualShifts);

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
     - Manual Deployment     -> {type:'deploy'}           : locks X into Deployment
     - Manual Morning        -> {type:'morning'}          : locks X into Morning
     - Manual Weekend        -> {type:'weekend'}          : locks X into Weekend

   After any add the input clears and updateAll() rebuilds the schedule. DOM-
   touching only; the parse helpers it calls are DOM-free. */
function submitUnifiedRecord() {
  const err = document.getElementById("rec-unified-error");
  const kind = document.getElementById("rec-kind").value; // holiday|deploy|morning|weekend
  const lineEl = document.getElementById("rec-line");
  const promptFor = {
    holiday: 'e.g. sep1,5,20-23 — or "Andy: sep1,5" to mark a colleague off that day (holiday).',
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

  const type = { holiday: "holiday", deploy: "deploy", morning: "morning", weekend: "weekend" }[kind];
  const note = kind === "holiday" ? "Holiday" : "";
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
  ["startDate", "endDate", "names"].forEach((id) => {
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