/* Headless validation for the SAT engine (no DOM required). Run: node sat_validate_test.js */
const E = require("./sat.js");

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log(`  ok  ${msg}`); }
  else { fail++; console.log(`FAIL  ${msg}`); }
}

console.log("== resolveDateExpr (month-abbr + bare days + ISO) ==");
{
  const r = E.resolveDateExpr("sep1,5,20-23", "2026-09-01", "2026-10-31");
  check(JSON.stringify(r) === JSON.stringify(["2026-09-01","2026-09-05","2026-09-20","2026-09-21","2026-09-22","2026-09-23"]), "sep1,5,20-23 resolves across 1,5,20-23");
  const iso = E.resolveDateExpr("2026-10-01", "2026-09-01", "2026-12-31");
  check(JSON.stringify(iso) === JSON.stringify(["2026-10-01"]), "ISO date resolves");
  const outRange = E.resolveDateExpr("2026-08-30", "2026-09-01", "2026-09-30");
  check(outRange.length === 0, "out-of-range ISO dropped");
  // Backward range "sep28-2" is clamped to a same-month min..max (existing
  // parser convention) -> resolves to Sep 2..28, NOT empty.
  const backward = E.resolveDateExpr("sep28-2", "2026-09-01", "2026-10-31");
  check(backward[0] === "2026-09-02" && backward[backward.length-1] === "2026-09-28", "backward range clamped to same-month min..max");
}

console.log("== groupContiguous ==");
{
  const g = E.groupContiguous(["2026-09-01","2026-09-02","2026-09-03","2026-09-05"]);
  check(g.length === 2, "1-3 contiguous, 5 single");
  check(g[0].start === "2026-09-01" && g[0].end === "2026-09-03", "first range bound");
}

console.log("== parseHolidays (new signature accepts range) ==");
{
  const h = E.parseHolidays("sep7-9\n2026-10-01", "2026-09-01", "2026-12-31");
  check(h.has("2026-09-07") && h.has("2026-09-08") && h.has("2026-09-09") && h.has("2026-10-01"), "holidays from abbr+ISO");
  check(!h.has("2026-09-06") && !h.has("2026-10-02"), "no spurious holidays");
}

console.log("== parseManualShifts (name-first unified) ==");
{
  const m = E.parseManualShifts("Andy: sep7-9\nTina: sep2,5,11", "2026-09-01", "2026-10-31", ["Andy","Tina"]);
  check(m["2026-09-07"] && m["2026-09-07"].name === "Andy", "Andy sep7-9");
  check(m["2026-09-09"] && m["2026-09-09"].manual === true, "Andy range end 09-09");
  check(m["2026-09-02"] && m["2026-09-02"].name === "Tina", "Tina sep2");
  check(m["2026-09-05"] && m["2026-09-05"].name === "Tina", "Tina sep5");
  check(m["2026-09-11"] && m["2026-09-11"].name === "Tina", "Tina sep11");
  check(m["2026-09-03"] === undefined, "no bare-day leak before month context");
  const unknown = E.parseManualShifts("Bob: sep1", "2026-09-01", "2026-09-30", ["Andy"]);
  check(Object.keys(unknown).length === 0, "unknown name ignored");
}

console.log("== buildSchedule with manualMorning/manualWeekend ==");
{
  const names = ["Andy", "Jessica", "Tina", "Alan"];
  const hols = E.parseHolidays("", "2026-09-01", "2026-10-31");
  const manualMorning = E.parseManualShifts("Tina: sep2,9", "2026-09-01", "2026-10-31", names);
  const manualWeekend = E.parseManualShifts("Alan: sep5,6", "2026-09-01", "2026-10-31", names);
  // deployment empty; manual parsing of legacy + unified both handled in UI; here test keys exist.
  const res = E.buildSchedule("2026-09-01", "2026-09-30", names, hols, {}, { morning: manualMorning, deployment: {}, weekend: manualWeekend });
  const byDate = new Map(res.rows.map((r) => [r.date, r]));
  // 2026-09-02 is a Wednesday -> morning manual -> Tina + morningManual flag
  check(byDate.get("2026-09-02").morning === "Tina", "manual morning Tina on 09-02");
  check(byDate.get("2026-09-02").morningManual === true, "morningManual flag set");
  // 2026-09-05 is Saturday -> weekend manual -> Alan
  check(byDate.get("2026-09-05").weekend === "Alan", "manual weekend Alan on Sat 09-05");
  check(byDate.get("2026-09-05").weekendManual === true, "weekendManual flag set");
}

console.log("== legacy parseShortDates still works ==");
{
  const r = E.parseShortDates("9-2,9-5", "2026-09-01", "2026-09-30");
  check(r.length === 2, "two short-date ranges");
}

console.log("== manual deployment honored on weekends (Jessica / Sat 12 Sep 2026) ==");
{
  const names = ["Andy", "Jessica", "Tina", "Alan"];
  const hols = E.parseHolidays("", "2026-09-01", "2026-09-30");
  const manualDeployment = { "2026-09-12": { name: "Jessica", manual: true } };
  const res = E.buildSchedule(
    "2026-09-01", "2026-09-30", names, hols, {},
    { morning: {}, deployment: manualDeployment, weekend: {} }
  );
  const row = res.rows.find((r) => r.date === "2026-09-12");
  check(row && row.deployment === "Jessica", "Jessica appears in Deployment on Sat 09-12");
  check(row && row.deploymentManual === true, "deploymentManual flag set on Sat 09-12");
  check(row && row.weekend !== "Jessica", "Jessica not double-booked into Weekend-morning same day");
  check(res.counts.Jessica.deployment >= 1, "Jessica deployment count >= 1 (manual Sat counted; she also auto-deploys on weekdays)");
}

console.log("== deriveFromRecords (unified records -> engine inputs) ==");
{
  const recs = [
    { type: "holiday", name: "",    start: "2026-09-07", end: "2026-09-09", note: "Holiday" },
    { type: "holiday", name: "Andy", start: "2026-09-30", end: "2026-09-30", note: "Holiday" },
    { type: "deploy",  name: "Jessica", start: "2026-09-12", end: "2026-09-12", note: "" },
    { type: "morning", name: "Tina", start: "2026-09-02", end: "2026-09-02", note: "" },
    { type: "weekend", name: "Alan", start: "2026-09-05", end: "2026-09-05", note: "" },
  ];
  const d = E.deriveFromRecords(recs, "2026-09-01", "2026-09-30");
  check(d.holidaysAdded.has("2026-09-07") && d.holidaysAdded.has("2026-09-09"), "name-less holiday adds dates");
  check(d.holidaysAdded.has("2026-09-30"), "named holiday also adds holiday date");
  check(d.unavailable.Andy && d.unavailable.Andy["2026-09-30"].includes("Holiday"), "named holiday marks Andy unavailable");
  check(!d.unavailable.Jessica, "deploy record does NOT mark unavailable");
  check(d.manualShifts.deployment["2026-09-12"].name === "Jessica", "deploy record -> manualShifts.deployment");
  check(d.manualShifts.morning["2026-09-02"].name === "Tina", "morning record -> manualShifts.morning");
  check(d.manualShifts.weekend["2026-09-05"].name === "Alan", "weekend record -> manualShifts.weekend");
  check(d.manualShifts.weekend["2026-09-05"].manual === true, "manual flag set");
}

console.log("== deriveFromRecords + buildSchedule end-to-end (weekend deployment) ==");
{
  const names = ["Andy", "Jessica", "Tina", "Alan"];
  const recs = [{ type: "deploy", name: "Jessica", start: "2026-09-12", end: "2026-09-12", note: "" }];
  const d = E.deriveFromRecords(recs, "2026-09-01", "2026-09-30");
  const res = E.buildSchedule("2026-09-01", "2026-09-30", names, d.holidaysAdded, d.unavailable, d.manualShifts);
  const row = res.rows.find((r) => r.date === "2026-09-12");
  check(row.deployment === "Jessica" && row.deploymentManual === true, "end-to-end: Jessica deployed on Sat 09-12");
  check(row.weekend !== "Jessica", "end-to-end: Jessica not also weekend-morning");
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);