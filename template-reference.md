# Hand-made Schedule Template — September 2026 (Reference)

> **Purpose.** A hand-crafted "ideal" duty roster submitted by the staff for review.
> This file keeps it as a reference so the engine rules can be double-checked against
> what a human considered acceptable. It documents what the template *matches*,
> what *rule breaches* it contains, and which breaches are genuine compromises.

- **Period:** 2026-09-01 → 2026-09-30
- **Staff (4):** Andy, Jessica, Tina, Alan
- **Public holiday:** 2026-09-26 (Sat)

---

## 1. The schedule table

Columns match the app's preview (`Morning`, `Deployment`, `Weekend Support`) with the
template's 4th duty column **"Weekend Morning health check"** mapped to the app's
**Weekend Support** (see §4 mapping note).

| Date | Morning (08:45~) | Deployment | Weekend Support | Not available |
|------|------------------|------------|-----------------|---------------|
| 星期二 2026 09 01 | Andy | Tina | — | — |
| 星期三 2026 09 02 | Alan | Andy | — | Jessica (night), Tina (TO) |
| 星期四 2026 09 03 | Tina | Jessica | — | — |
| 星期五 2026 09 04 | Andy | Andy | — | — |
| 星期六 2026 09 05 | — | — | Jessica | Tina |
| 星期日 2026 09 06 | — | — | Andy | — |
| 星期一 2026 09 07 | Tina | Alan | — | Andy (VL) |
| 星期二 2026 09 08 | Jessica | Tina | — | Andy (VL) |
| 星期三 2026 09 09 | Alan | Jessica | — | Andy (VL) |
| 星期四 2026 09 10 | Tina | Alan | — | Andy (VL) |
| 星期五 2026 09 11 | Jessica | Jessica | — | Andy (VL), Tina (night) |
| 星期六 2026 09 12 | — | — | Tina | Jessica, Andy |
| 星期日 2026 09 13 | — | — | Jessica | Andy |
| 星期一 2026 09 14 | Jessica | Tina | — | Andy (VL) |
| 星期二 2026 09 15 | Alan | Jessica | — | Andy (VL) |
| 星期三 2026 09 16 | Tina | Alan | — | Jessica (night), Andy |
| 星期四 2026 09 17 | Jessica | Tina | — | Andy (VL) |
| 星期五 2026 09 18 | Alan | Alan | — | Andy (VL), Tina (night) (AP2 HC) |
| 星期六 2026 09 19 | — | — | Alan | Jessica, Andy, Tina |
| 星期日 2026 09 20 | — | — | Tina | Jessica, Andy |
| 星期一 2026 09 21 | Andy | Andy | — | Jessica (TO) |
| 星期二 2026 09 22 | Alan | Tina | — | Jessica (TO) |
| 星期三 2026 09 23 | Andy | Alan | — | Jessica (TO) |
| 星期四 2026 09 24 | Tina | Andy | — | Jessica (TO) |
| 星期五 2026 09 25 | Alan | Jessica | — | Tina (TO) |
| 星期六 2026 09 26 | — | — | Andy | Tina |
| 星期日 2026 09 27 | — | — | Alan | Jessica |
| 星期一 2026 09 28 | Jessica | Andy | — | — |
| 星期二 2026 09 29 | Tina | Jessica | — | — |
| 星期三 2026 09 30 | Andy | Andy | — | — |

---

## 2. Does the template match the stated unavailable list? — ✅ YES

Cross-checked every cell against the list below; the "Not available" column is **identical**
to the list, and **no colleague is assigned on any day they marked unavailable**.

- **Andy 7–20** → marked/absent exactly on 09/07–09/20 (incl. VL through the weekend). First appearance back: 09/21 (outside range). ✅
- **Tina 2, 5, 11, 18, 19, 25, 26** → marked on all 7 dates; never assigned on those days. ✅
- **Jessica 2 (deploy shift), 12, 16 (deploy shift), 19–24, 27** → marked on all 10 dates; never assigned on those days. ✅
- **Public holiday 26/9** → 09/26 is a Sat holiday; template treats it as a weekend-shift day (Weekend Support = Andy). ✅

> Note: the template's `night` / `TO` / `VL` memos are human annotations. In the app they
> collapse to a plain "unavailable" on that date; the person is treated as off-duty for
> Morning / Deployment / Weekend regardless of the memo.

---

## 3. Per-person scope counts (fairness) — ✅ perfectly balanced

| Person | Morning (m) | Deployment (d) | Thu (t) | wsat | wsun | hcount | Total (m+d+weekend) |
|--------|-------------|----------------|---------|------|------|--------|---------------------|
| Andy | 5 | 6 | 1 | 1 | 1 | 0 | **13** |
| Jessica | 5 | 6 | 1 | 1 | 1 | 0 | **13** |
| Tina | 6 | 5 | 1 | 1 | 1 | 0 | **13** |
| Alan | 6 | 5 | 1 | 1 | 1 | 0 | **13** |

Each fairness scope is even (m, d, thu, and weekend each within 1), and the grand total is
`13 / 13 / 13 / 13`. This roster was clearly balanced by hand.

---

## 4. Mapping note: "Weekend Morning health check"

The app has **no morning-on-weekend shift**. Morning is strictly Mon–Fri (non-holiday); a
weekend/holiday day runs only **Weekend Support**. So the template's 4th duty column maps to
the engine's **Weekend Support** scope (`wsat` / `wsun` / `hcount`). If those entries were
intended as a *literal morning task on Saturday/Sunday*, the engine would treat them as a
**day-type violation** (a weekend row may not hold a Morning cell). Interpreted as Weekend
Support (as done here), they are valid.

---

## 5. Rule breaches in the template (against the app's rules)

### 🔴 5a. Rest rule — Morning the day after Weekend (avoidable choice)
- **2026-09-14 (Mon): Jessica** does Morning, having done **Weekend Support on 09-13 (Sun)**.
  - App message: `rest rule: Jessica worked Weekend yesterday (2026-09-13)`.
  - **Status: avoidable.** On 09/14 the Morning-available pool is {Jessica, Tina, Alan}
    (Andy off 7–20). Giving Jessica the shift was a *fairness/evenness trade*, not forced.

### 🔴 5b. Rule 1 — Weekend the day after Deployment (forced / unavoidable)
- **2026-09-19 (Sat): Alan** does Weekend Support, having done **Deployment on 09-18 (Fri)**.
  - App message: `Rule 1: Alan did Deployment yesterday (2026-09-18)`.
  - **Status: unavoidable.** On 09/19 the Weekend-available pool is **{Alan} only**
    (Andy off 7–20, Jessica off 19–24/27, Tina off 18/19/25/26). Alan is the **sole available**
    colleague, so the coverage-first ("Sudoku") rule forces him to cover. The app would flag it
    **forced + red** ("must bear it," exempt from the hard gate but still surfaced for the staff).

### 🟡 5c. Same-day Morning + Deployment (tolerated compromise, NOT flagged)
- **2026-09-04 Andy**, **2026-09-11 Jessica**, **2026-09-18 Alan**, **2026-09-21 Andy**, **2026-09-30 Andy**
- Per the app's current rule, same-day M+D is a **tolerated compromise** (opt-in relief valve,
  default `mplusd = Andy`), so the engine does **not** show it as a red violation — it only
  tries to minimise it via the fatigue cost ladder. Not a breach by the current rule.

### ✅ 5d. No other breaches
- **No successive-weekend breach:** adjacent weekend-shift pairs all differ in scope correctly;
  e.g. 09/13 Jessica (wsun) → 09/19 Alan (wsat) / 09/20 Tina (wsun) … the wsat↔wsun relaxation
  means a Sun(wsun)→next-Sat(wsat) repeat is now *allowed* anyway.
- **No consecutive-morning breach:** no colleague does Morning on back-to-back *workdays*.
- **No 3-shifts-in-2-day (tandem) overload** across the roster.
- **Thursday (t) fairness** even: Andy/Jessica/Tina/Alan each 1 Thursday deployment.

---

## 6. Summary

| Item | Result |
|------|--------|
| Template == unavailable list | ✅ identical |
| Not-available honoured (no assignment while off) | ✅ |
| Per-scope & total fairness | ✅ 13/13/13/13 |
| Rest rule (Morning after Weekend) | ❌ 09-14 Jessica — **avoidable** compromise |
| Rule 1 (Weekend after Deployment) | ❌ 09-19 Alan — **forced** (sole available), "must bear" |
| Same-day M+D | 🟡 tolerated (4–5 days) |
| Successiveness / consecutive-M / tandem / t-fairness | ✅ clear |

**Interpretation:** the template is a clean, evenly-balanced roster that fully honours
availability. Its only hard-rule bumps are (a) an **avoidable** rest-rule trade on 09-14
chosen for evenness, and (b) an **unavoidable** Rule-1 overload on 09-19 where Alan is the
sole available staff member. If pasted into the app, those two dates would surface as red
"must-bear" flags; everything else would render clean.