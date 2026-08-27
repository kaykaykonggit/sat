# SAT — Shift Arrangement Tool

A **zero-dependency, browser-only** shift-scheduling web app. Pure HTML + vanilla
JavaScript — no build tooling, no frameworks, no third-party libraries. It
generates a duty shift schedule and exports it to a styled **Excel-compatible
`.xls`** file entirely in the browser.

Deploys as a static site to **Cloudflare Pages** (free) — no server, no backend.

## Features

- **Sidebar inputs**: date range, colleague names, public holidays, and a
  per-person unavailability form (with a live records list + delete button).
- **Live preview**: schedule renders as a table in the browser, plus a
  per-person shift-count summary.
- **Constraint-aware scheduler**:
  - Morning Health Check + Deployment on weekdays (Mon–Fri, excluding holidays).
  - Weekend Morning Health Check on Sat/Sun/public holidays.
  - Even distribution of all three shift types across colleagues.
  - Rest rules: no Morning Health Check the day after a Deployment or a
    Weekend Support shift.
  - Weekend separation: Saturday and Sunday assigned to different people.
  - Minimized same-day Morning + Deployment overlap.
  - Strictly respects all unavailability records.
- **One-click export** of a styled, Excel-readable `.xls` — generated as an HTML
  table (Excel opens it directly and honors the fills/borders/Chinese dates).

## Run locally

No install needed, and there are no dependencies — just serve the folder over
HTTP so all assets load:

```bash
# Python 3 (stdlib), no packages required:
python -m http.server 8501
# then open http://localhost:8501
```

Or use any static server (`npx serve .`, VS Code Live Server, etc.).

## Deploy to Cloudflare Pages

Three options, all using only the static files in this repo.

**Option A — Git integration (recommended).** Push the repo to GitHub/GitLab,
create a Cloudflare Pages project pointing at it, and set:
- Build command: *(empty)*
- Build output directory: `/` (repo root — the static files are already built)

**Option B — Wrangler CLI (direct upload).**

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name sat-shift-schedule
```

**Option C — Dashboard direct upload.** Cloudflare Dashboard → Workers & Pages →
Create → Pages → **Upload assets** → drop `index.html`, `sat.js`, `style.css`.

No `_redirects`, service worker, or build step are needed — the app is a single
static page with no client-side routing.

## Usage

1. Pick the **start / end dates** in the sidebar.
2. Edit **colleague names** (comma- or newline-separated; defaults to
   `Andy, Jessica, Tina, Alan`).
3. Add **public holidays** as `YYYY-MM-DD, ...` if any fall inside the range.
4. Add **unavailability** records (colleague + date + reason such as `Night`,
   `VL`, `TO`); they appear in a list below and can be deleted.
5. Review the **Preview** and **Shift Counts** tables.
6. Click **⬇️ Download Excel Schedule** to save the `.xls`.

## Exported file layout

- **Summary table** (top): one row per colleague with totals for Morning,
  Deployment, Weekend morning, and Not-available records. Gray header.
- **Main schedule table** below it: rows per date labelled like
  `星期四 2026 07 23` (Chinese weekday + date); weekend/holiday dates get a
  peach fill, the Not-available column turns orange when populated; all cells
  have thin borders and centered text.

## Project layout

```
index.html     # app shell: sidebar + main view + tables + export button
sat.js         # scheduling engine + preview rendering + .xls export + wiring
style.css      # styling (sidebar, tables, fills)
wrangler.toml  # optional Wrangler CLI config for Cloudflare Pages
```

## Notes / limits

- All logic runs in the browser; unavailability records live in memory for the
  session and reset on page reload (no server or storage used).
- The exported `.xls` uses the legacy HTML-table format Excel still reads. Excel
  may show a one-time "file format and extension don't match" prompt on first
  open — choose **Yes** / **Open**. It carries the same layout as the on-screen
  preview (gray summary header, Chinese weekdays, peach weekend fill, orange
  Not-available fill, thin borders).
- Schedules are generated greedily (even-count tie-breaking) and are not an
  optimal solver; for typical team sizes (2–10 people) results are balanced.
- If start/end dates are inverted, the app swaps them automatically.
- Malformed holiday dates and empty colleague names are safely ignored.

---
*Legacy:* `app.py` + `requirements.txt` are the original **Streamlit** prototype
(same scheduling rules, true `.xlsx` via openpyxl). It is superseded by the
static version and kept as a reference / headless validation harness only.