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

/* ------------------------- Parsing helpers ------------------------------- */

function parseNames(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHolidays(raw) {
  const out = new Set();
  for (const tok of raw.split(/[\n,]/)) {
    const t = tok.trim();
    if (!t) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) out.add(t);
  }
  return out;
}

function needsWeekdayShift(iso) {
  return !isWeekendISO(iso);
}

function needsWeekendShift(iso, holidays) {
  return isWeekendISO(iso) || holidays.has(iso);
}

/* ------------------------- Scheduling engine ------------------------------
   Mirrors build_schedule() in the Python prototype:
     unavailable: { name: { iso: [note, ...] } }
   Returns { rows, counts }.
 --------------------------------------------------------------------------- */

function buildSchedule(start, end, names, holidays, unavailable) {
  if (!names.length) return { rows: [], counts: {} };

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
    const weekdayShift = needsWeekdayShift(day);
    const weekendShift = needsWeekendShift(day, holidays);

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

    // ---- Morning Health Check (weekday only) -----------------------------
    let morning = "";
    if (weekdayShift) {
      const pool = names.filter((n) => availableFor(n) && !cannotMorningToday.has(n));
      if (pool.length) {
        morning = pool.reduce((best, n) =>
          counts[n].morning < counts[best].morning ? n : best
        );
        counts[morning].morning++;
      }
    }

    // ---- Deployment (weekday only) ---------------------------------------
    let deployment = "";
    if (weekdayShift) {
      const pool = names.filter(availableFor);
      if (pool.length) {
        deployment = pool.reduce((best, n) => {
          const kBest = counts[best].deployment + (best === morning ? 0.5 : 0);
          const kN = counts[n].deployment + (n === morning ? 0.5 : 0);
          return kN < kBest ? n : best;
        });
        counts[deployment].deployment++;
      }
    }

    // ---- Weekend Morning Health Check ------------------------------------
    let weekend = "";
    if (weekendShift) {
      const pool = names.filter(availableFor);
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

    // Rest rule: today's deployment/weekend people are blocked from tomorrow's morning.
    cannotMorningToday = new Set([deployment, weekend].filter(Boolean));

    rows.push({
      date: day,
      label: dateLabel(day),
      isWeekend: needsWeekendShift(day, holidays),
      morning,
      deployment,
      weekend,
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
    mainRows += `<tr style="border:1px solid #000">
      <td style="border:1px solid #000;padding:4px;font-weight:bold;${bg}">${esc(r.label)}</td>
      <td style="border:1px solid #000;padding:4px">${esc(r.morning)}</td>
      <td style="border:1px solid #000;padding:4px">${esc(r.deployment)}</td>
      <td style="border:1px solid #000;padding:4px">${esc(r.weekend)}</td>
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
    <th class="sumh">Weekend Morning health check (08:45~)</th>
    <th class="sumh">Not available</th>
  </tr>
  ${summaryRows}
</table>
<br/>
<table>
  <tr>
    <th class="mainh" style="background:#D9D9D9">Date</th>
    <th class="mainh" style="background:#DDEBF7">Morning Health Check (08:45~)</th>
    <th class="mainh" style="background:#E7E6E6">Deployment</th>
    <th class="mainh" style="background:#DDEBF7">Weekend Morning health check (08:45~)</th>
    <th class="mainh" style="background:#FCE4D6">Not available</th>
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

let records = []; // {name, date(iso), note}

function updateAll() {
  const start = document.getElementById("startDate").value;
  const end = document.getElementById("endDate").value;
  const namesRaw = document.getElementById("names").value;
  const holidaysRaw = document.getElementById("holidays").value;

  if (!start || !end) return;
  let s = start, e = end;
  if (s > e) { [s, e] = [e, s]; }

  const names = parseNames(namesRaw);
  const holidays = parseHolidays(holidaysRaw);

  // Build unavailable map { name: { iso: [notes] } }
  const unavailable = {};
  for (const rec of records) {
    (unavailable[rec.name] = unavailable[rec.name] || {});
    (unavailable[rec.name][rec.date] = unavailable[rec.name][rec.date] || []);
    if (!unavailable[rec.name][rec.date].includes(rec.note)) {
      unavailable[rec.name][rec.date].push(rec.note);
    }
  }

  const { rows, counts } = buildSchedule(s, e, names, holidays, unavailable);

  // Swap the swapped start/end back into the download filename.
  renderPreview(rows);
  renderCounts(names, counts);
  renderRecordsList();

  // Store for download.
  window.__export = { rows, counts, names, unavailable, start: s, end: e };

  document.getElementById("export-btn").disabled = !rows.length;
}

function renderRecordsList() {
  const box = document.getElementById("records-list");
  box.innerHTML = "";
  if (!records.length) {
    box.innerHTML = '<p class="muted">No unavailability records yet.</p>';
    return;
  }
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const row = document.createElement("div");
    row.className = "record";
    const label = document.createElement("span");
    label.textContent = `${rec.name} · ${rec.date} · ${rec.note}`;
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.className = "del";
    del.dataset.idx = i;
    del.addEventListener("click", () => {
      records.splice(i, 1);
      updateAll();
    });
    row.appendChild(label);
    row.appendChild(del);
    box.appendChild(row);
  }
}

function populateNameOptions() {
  const names = parseNames(document.getElementById("names").value);
  const sel = document.getElementById("rec-name");
  sel.innerHTML = "";
  for (const n of names) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }
}

/* ------------------------- Entry point ---------------------------------- */

function init() {
  // Default date range: today .. +30 days.
  document.getElementById("startDate").value = isoDay(0);
  document.getElementById("endDate").value = isoDay(30);

  document.getElementById("add-rec").addEventListener("click", () => {
    const name = document.getElementById("rec-name").value;
    const date = document.getElementById("rec-date").value;
    const note = document.getElementById("rec-note").value.trim();
    if (!name || !date || !note) {
      document.getElementById("rec-error").textContent = "Name, date and note are required.";
      return;
    }
    if (!records.some((r) => r.name === name && r.date === date && r.note === note)) {
      records.push({ name, date, note });
    }
    document.getElementById("rec-note").value = "";
    document.getElementById("rec-error").textContent = "";
    updateAll();
  });

  // Re-render colleague dropdown when names change.
  document.getElementById("names").addEventListener("input", populateNameOptions);

  // Live updates on any input.
  ["startDate", "endDate", "names", "holidays"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateAll);
  });

  document.getElementById("export-btn").addEventListener("click", () => {
    const ex = window.__export;
    if (ex) downloadXLS(ex.rows, ex.counts, ex.names, ex.unavailable, ex.start, ex.end);
  });

  populateNameOptions();
  updateAll();
}

document.addEventListener("DOMContentLoaded", init);