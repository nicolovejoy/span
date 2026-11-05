# Email Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SPAN's four emails (weekly briefing, anomaly, data-gap, cool alert) client-safe, linked into the dashboard, HVAC-split aware, and honest about how long an anomaly has been going on.

**Architecture:** One new pure module `pi/email_kit.py` (style inlining, text part, wrapper, dashboard deep links) that `pi/daily_report.py` renders through; the HVAC split reuses `hvac_mode` intervals already queried by `query_hvac_mode_intervals`; anomaly episode age extends the existing `report_baseline` JSON state. Everything stays deterministic Python f-strings — no template engine, no LLM in alert text.

**Tech Stack:** Python 3.11 stdlib only (no new dependencies — the Pi image installs a fixed set), pytest/unittest, Resend HTTP API.

**Spec:** No separate spec. Source of truth is the 2026-11-05 conversation with Nico (approved order: test-stub fix, email kit, links, HVAC split, then alert recalibration) plus prompt-lab's answer at `~/src/.handoff/span-prompt-lab.md` (entry "2026-11-05 prompt-lab → span: how prompt-lab formats its emails") and Nico's five requests: links from alert emails to the relevant dashboard part; HVAC heat vs cooling vs hot water in the email; several links into dashboard detail from the briefing; 12-month trend uses accurate EV data (already fixed in the rollups, 2026-10-27 — verify only, see Out of scope); recalibrate alerts. Rulings made without a spec are provisional.

## Global Constraints

- Branch `email-overhaul` (already created off `wall-connector-poller`). Never push, merge, or deploy to the Pi.
- Run the Pi suite with: `cd /Users/nico/src/span/pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata --with matplotlib pytest -q`. Baseline at plan start: 256 pass, 5 fail (all 5 in `test_weekly_report.py`; Task 1 fixes them). No task may leave a previously passing test failing.
- Python stdlib only for new code. Tests must not touch the network, InfluxDB, or Resend.
- Every new `pi/*.py` module the container imports needs a `COPY` line in `pi/Dockerfile` (a missing one crashloops `daily-report`).
- Timestamps UTC at rest, Pacific on display. Never build a date from `.isoformat()[:10]` or `toISOString().slice(0,10)`; use `LOCAL_TZ` / `local_day_utc_range` already in `daily_report.py`.
- Email subjects carry the whole message (existing convention). Existing subject strings must not change except where a task says so.
- `DRY_RUN=1` must keep working in `send_email` (logs instead of sending).
- Reader-facing text stays inline in `daily_report.py` renderers (this repo has no French/copy-module convention).
- Dashboard base URL comes from env `DASHBOARD_URL`, default `https://span.pianohouseproject.org`. Link format is the explorer's intent URL: `/?range=<7d|30d|1y…>&show=<Category>` or absolute window `/?from=<epoch_ms>&to=<epoch_ms>&show=<Category>` (see `web/lib/url-state.ts`: `from`/`to` are epoch milliseconds, `show` is comma-joined with commas literal, `drill=<Category>` requires that category in `show`).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Review Focus

- A day with no `hvac_mode` rows (classifier down, or before 2026-01-04): the HVAC split is omitted, nothing raises, no empty table renders.
- Baseline median 0 (`result.pct is None`) anomaly path: still renders, still gets its link.
- An anomaly state file written before this change (entries without `since`): loads without `KeyError`, episode age falls back to the last alert date.
- DST: a deep link for 2026-11-01 (25-hour Pacific day) spans exactly 25 hours of epoch milliseconds.
- Text and HTML escaping: a category or circuit name containing `&` or `<` appears escaped in HTML and unescaped in the text part; `&` inside an `href` is `&amp;`.

---

### Task 1: Shared matplotlib stub so the weekly-report tests run in the full suite

Root cause (verified): `test_cool_alert.py` and `test_weekly_report.py` each stub matplotlib only `if "matplotlib" not in sys.modules`. Pytest imports `test_cool_alert.py` first, whose minimal stub wins, so `test_weekly_report.py`'s fuller stub (with `subplots`, `ticker.StrMethodFormatter`) never installs. The 5 failures are order-dependent, not logic bugs.

**Files:**
- Create: `pi/conftest.py`
- Modify: `pi/test_weekly_report.py` (remove the now-duplicate matplotlib stub block, keep `httpx`/`influxdb_client` stubs), `pi/test_cool_alert.py` (same)
- Test: the existing 5 failing tests are the verification

**Interfaces:**
- Produces: `pi/conftest.py` which, at import (before any test module is collected), installs the stub modules `matplotlib`, `matplotlib.pyplot`, `matplotlib.dates`, `matplotlib.ticker` into `sys.modules` exactly as `test_weekly_report.py` does today (including `_FakeMplObject` with `get_ylim`/`twinx`/`yaxis` special cases, `plt.subplots`, `plt.close`, `ticker.StrMethodFormatter`, and `matplotlib.ticker` attribute set on the `matplotlib` module). It must install unconditionally-if-absent so real matplotlib is never imported during the suite.

- [ ] **Step 1: Run the suite and confirm the 5 baseline failures** (command in Global Constraints). Expected: `5 failed, 256 passed`.
- [ ] **Step 2: Create `pi/conftest.py`** by moving the stub block from `test_weekly_report.py` into it, wrapped in a function called at module import.
- [ ] **Step 3: Delete the matplotlib stub blocks from both test files** (leave every other stub). Both files must still run standalone with `python3 test_cool_alert.py`-style invocation per their docstrings is NOT required to keep working under pytest-only; note in each docstring that pytest's `conftest.py` provides the matplotlib stub.
- [ ] **Step 4: Run the suite.** Expected: `0 failed`, at least 261 passed.
- [ ] **Step 5: Commit** — `pi: shared matplotlib test stub in conftest.py (fixes 5 order-dependent weekly-report failures)`

---

### Task 2: `email_kit` — inlined styles, text part, client-safe wrapper

**Files:**
- Create: `pi/email_kit.py`, `pi/test_email_kit.py`
- Modify: `pi/daily_report.py` (`send_email`, the four HTML templates, `build_weekly_html`, remove the `CSS` constant and any `{CSS}` use), `pi/Dockerfile` (add `COPY email_kit.py .` next to the `daily_report.py` COPY line)

**Interfaces:**
- Produces in `pi/email_kit.py`:
  - `inline_styles(html: str) -> str` — adds a `style="…"` attribute to bare `<h2>`, `<h3>`, `<table>`, `<th>`, `<td>`, `<p>` tags that lack one, using the values from today's `CSS` block (h2: `color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:8px`; h3: `color:#2c3e50;margin-top:24px`; table: `border-collapse:collapse;width:100%;margin:8px 0`; th/td: `padding:6px 12px;text-align:left;border-bottom:1px solid #eee`; th additionally `background:#f8f9fa;font-weight:600`). `<table class="summary">` right-aligns every `td` except the first column's: emit `text-align:right` on those cells (first cell of each row stays left). Tags that already have `style=` are left untouched. Pure string function; no HTML parser dependency beyond `re`/`html.parser`.
  - `html_to_text(html: str) -> str` — plain-text body: drop `<style>`/`<head>` content and `<img>`; `<h2>`/`<h3>` become a line followed by a blank line; `</p>`, `</tr>`, `<br>` become newlines; table cells in a row are joined with ` | `; `<a href="U">label</a>` becomes `label (U)`; entities unescaped (`html.unescape`); runs of 3+ newlines collapse to 2; result stripped.
  - `wrap_email(body: str) -> str` — returns a complete document: `<!DOCTYPE html>`, `<meta charset>`, `<meta name="color-scheme" content="light dark">`, a `<style>` block containing only a `@media (prefers-color-scheme: dark)` override (body/`h2`/`h3` text colors light, `th` background dark, borders dark), and a `<body>` holding `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">` around `inline_styles(body)`. No background color is set on body (clients invert; the dark block handles Apple Mail).
- Changes in `daily_report.py`: `send_email(html, subject)` now POSTs `{"from","to","subject","html","text": html_to_text(html)}`; every renderer that returned `<!DOCTYPE html>…{CSS}…` now returns `wrap_email(body)` instead (weekly, anomaly, gap, cool). Rendered subjects are unchanged.

- [ ] **Step 1: Write failing tests in `pi/test_email_kit.py`:**
  - `test_inline_styles_adds_style_to_bare_tags`: `inline_styles("<h2>x</h2>")` contains `<h2 style="color:#2c3e50`.
  - `test_inline_styles_keeps_existing_style`: `inline_styles('<p style="color:red">x</p>')` is returned unchanged.
  - `test_summary_table_right_aligns_non_first_cells`: for `<table class="summary"><tr><td>a</td><td>1</td></tr></table>` the first `<td` has no `text-align:right` and the second does.
  - `test_html_to_text_links_and_entities`: `html_to_text('<h2>A &amp; B</h2><p>see <a href="https://x.test/?a=1&amp;b=2">here</a></p>')` equals `"A & B\n\nsee here (https://x.test/?a=1&b=2)"`.
  - `test_html_to_text_table_rows`: a two-cell row becomes `"Lights | 3.2 kWh"`.
  - `test_wrap_email_is_complete_and_has_dark_block`: output starts with `<!DOCTYPE html>`, contains `color-scheme` and `prefers-color-scheme: dark`, contains no `<style>` other than the single dark-mode block, and the body's div carries `max-width:600px`.
- [ ] **Step 2: Run `pytest pi/test_email_kit.py -q`.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `pi/email_kit.py`** with the signatures above.
- [ ] **Step 4: Run `pytest pi/test_email_kit.py -q`.** Expected: PASS.
- [ ] **Step 5: Wire `daily_report.py`:** `send_email` text part, the four renderers via `wrap_email`, delete `CSS`. Add test `test_send_email_posts_text_part` in `pi/test_email_kit.py` that patches `daily_report.httpx.post` and asserts the JSON body has a non-empty `text` and `DRY_RUN=1` posts nothing. Add `COPY email_kit.py .` to `pi/Dockerfile`.
- [ ] **Step 6: Run the full suite.** Expected: 0 failed. Then `cd pi && DRY_RUN=1 INFLUXDB_TOKEN=x RESEND_API_KEY=x REPORT_EMAIL=x@y.z python3 -c "import daily_report as d, datetime as dt; s,h=d.render_cool_email(dt.date(2026,11,4), d.CoolStats(30,2,1.2,None)); print(h[:300])"` runs without error and prints a document starting `<!DOCTYPE html>`.
- [ ] **Step 7: Commit** — `pi: email_kit — inlined styles, text part, dark-mode-aware wrapper for all four emails`

---

### Task 3: Dashboard deep links in every email that has a dashboard view

**Files:**
- Modify: `pi/email_kit.py` (add `dash_url`), `pi/daily_report.py` (`DASHBOARD_URL` env constant, anomaly/cool/weekly renderers), `pi/test_email_kit.py`, `pi/test_weekly_report.py`
- Test: `pi/test_email_kit.py`, `pi/test_weekly_report.py`

**Interfaces:**
- Consumes: Task 2's `wrap_email`; existing `local_day_utc_range(d: date) -> tuple[datetime, datetime]` and `LOCAL_TZ` in `daily_report.py`.
- Produces: `dash_url(base: str, *, range_: str | None = None, show: tuple[str, ...] = (), start: datetime | None = None, end: datetime | None = None, drill: str | None = None) -> str` in `email_kit.py`. Returns `base + "/?" + params`, params joined by `&` in the order `range`, `from`, `to`, `show`, `drill`. `start`/`end` (tz-aware) become epoch milliseconds (`int(dt.timestamp() * 1000)`); `range_` and `start/end` are mutually exclusive (raise `ValueError` if both). `show` values comma-joined, commas literal, each value `urllib.parse.quote`d with `safe=""` except the joining commas. Trailing `/` on `base` is stripped. `daily_report.py` gains `DASHBOARD_URL = os.getenv("DASHBOARD_URL", "https://span.pianohouseproject.org")` and a helper `day_link(target_date: date, category: str | None = None, drill: bool = False) -> str` that builds the Pacific-day window link.
- Link placement (rulings, binding): anomaly email — each category block ends with `<p><a href="{day_link(target_date, category, drill=True)}">Open {category} on {weekday} in the dashboard</a></p>`; cool email — one link `day_link(target_date, "HVAC")`; weekly briefing — a closing section `render_explore_links(ctx)` added to the end of `WEEKLY_SECTIONS` with three links: the week (`from`/`to` = Monday 00:00 to next Monday 00:00 Pacific, all categories), the week filtered to HVAC, and `range_="1y"` labelled "12-month trend". The data-gap email gets no link (its data lives in Grafana behind Cloudflare Access, not the explorer).

- [ ] **Step 1: Write failing tests:**
  - `test_dash_url_range`: `dash_url("https://h.test/", range_="7d", show=("HVAC",))` == `"https://h.test/?range=7d&show=HVAC"`.
  - `test_dash_url_window_is_epoch_ms`: `start=datetime(2026,11,4,8,0,tzinfo=UTC)`, `end=…+1h` gives `from=1793779200000&to=1793782800000` (compute the literal from the datetimes; the test asserts the literal).
  - `test_dash_url_rejects_range_and_window_together` (`ValueError`).
  - `test_dash_url_show_commas_literal`: `show=("HVAC","Lights")` → `show=HVAC,Lights`; drill appended as `&drill=HVAC`.
  - `test_day_link_dst_fall_back_is_25_hours` (in `test_weekly_report.py`): parse `from`/`to` out of `dr.day_link(date(2026,11,1))`; `(to-from) == 25*3600*1000`.
  - `test_anomaly_email_links_each_category` : render with one alert whose `result.pct is None` (median-0 path) and one normal; both HTML blocks contain `href="https://span.pianohouseproject.org/?from=` and the text part (via `html_to_text`) contains the URL.
  - `test_weekly_html_has_explore_links`: `build_weekly_html` output contains exactly three `href=` values starting with the dashboard base, one containing `range=1y`.
  - `test_href_ampersands_are_escaped`: in the rendered anomaly HTML, every `&` inside an `href` is `&amp;`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `dash_url`, `DASHBOARD_URL`, `day_link`, `render_explore_links`, and the anomaly/cool link lines. Use `html.escape(url, quote=True)` when writing a URL into an `href`.
- [ ] **Step 4: Run the full suite.** Expected: 0 failed.
- [ ] **Step 5: Commit** — `pi: dashboard deep links in anomaly, cool and weekly emails`

---

### Task 4: HVAC heat / cool / hot-water split in the briefing and the HVAC anomaly

**Files:**
- Modify: `pi/daily_report.py` (`WeeklyContext`, `build_weekly_context`, new `mode_kwh`, `render_hvac_split_block`, `WEEKLY_SECTIONS`, `render_anomaly_email`, `generate_anomaly_check`), `pi/test_weekly_report.py`
- Test: `pi/test_weekly_report.py`

**Interfaces:**
- Consumes: existing `query_hvac_mode_intervals(query_api, start: str, stop: str) -> list[dict]` (dicts `{"start", "mode", "energy_kwh"}`), `flux_ts`, `local_day_utc_range`, Task 3's `day_link`.
- Produces:
  - `mode_kwh(intervals: list[dict]) -> dict[str, float]` — pure; sums `energy_kwh` per `mode` for modes in `("heat","cool","hot_water","idle","ambiguous")` (unknown modes ignored), always returns all five keys (0.0 when absent).
  - `WeeklyContext` gains `hvac_modes: dict[str, float]` and `hvac_modes_prev: dict[str, float]` (this week and the prior week, from `mode_kwh` over Monday–Monday Pacific windows). Both default to empty dicts so existing constructors in tests keep working.
  - `render_hvac_split_block(ctx: WeeklyContext) -> str` — returns `""` when `sum(ctx.hvac_modes.values()) == 0`. Otherwise an `<h3>Heat pump by mode</h3>` and a `summary` table with rows Heat, Cool, Hot water and Other (idle + ambiguous summed), columns kWh this week, % of total, kWh last week. Values with `.1f`. Placed immediately after `render_hvac_block` in `WEEKLY_SECTIONS`.
  - `render_anomaly_email(target_date, alerts, top_circuits, mode_split: dict[str, float] | None = None)` — new optional kwarg; when the alert category is `HVAC` and `mode_split` has any nonzero value, add `<p>Heat X.X · Cool Y.Y · Hot water Z.Z kWh that day.</p>` under that block. `generate_anomaly_check` queries the target day's intervals only when `HVAC` is among the alerts and passes `mode_kwh(...)`.

- [ ] **Step 1: Write failing tests:**
  - `test_mode_kwh_sums_and_zero_fills`: intervals heat 0.5 + heat 0.25 + hot_water 1.0 → `{"heat":0.75,"cool":0.0,"hot_water":1.0,"idle":0.0,"ambiguous":0.0}`; an interval with mode `"weird"` is ignored.
  - `test_hvac_split_block_empty_without_data`: `render_hvac_split_block` on a context with empty `hvac_modes` returns `""`.
  - `test_hvac_split_block_rows`: with heat 6.0, cool 0.0, hot_water 2.0, last-week heat 4.0 the HTML contains `Heat`, `6.0`, `75%` (6/8), and `4.0`.
  - `test_anomaly_hvac_block_shows_mode_split`: HVAC alert with `mode_split={"heat":3.2,"cool":0.0,"hot_water":1.1,"idle":0.0,"ambiguous":0.0}` → HTML contains `Heat 3.2` and `Hot water 1.1`; a Lights alert with the same kwarg shows no mode line.
  - `test_anomaly_without_mode_split_unchanged`: existing call signature (3 args) still renders.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the above. `build_weekly_context` must tolerate an empty query result (returns zero-filled dicts) and must not raise if the `hvac_mode` query errors — log a warning and leave the dicts empty.
- [ ] **Step 4: Run the full suite.** Expected: 0 failed.
- [ ] **Step 5: Commit** — `pi: HVAC heat/cool/hot-water split in weekly briefing and HVAC anomaly email`

---

### Task 5: Anomaly episode age (NEW / Day N) from the existing suppression state

**Files:**
- Modify: `pi/report_baseline.py` (`SuppressionState`, `load_state`, `save_state`), `pi/daily_report.py` (`generate_anomaly_check`, `render_anomaly_email`), `pi/test_report_baseline.py`, `pi/test_weekly_report.py`
- Test: `pi/test_report_baseline.py`, `pi/test_weekly_report.py`

**Interfaces:**
- Consumes: existing `SuppressionState(last_alert_date, last_z)` dataclass, `load_state(path, category)`, `save_state(path, category, alert_date, z)`, `clear_state(path, category)`; episode semantics from `should_alert` (alert once per episode, re-alert only if |z| worsens >25%; `clear_state` ends an episode).
- Produces:
  - `SuppressionState` gains `since: date | None = None`. `load_state` reads `entry.get("since")`, falling back to `entry["date"]` when absent (pre-change files). `save_state` keeps an existing entry's `since` (episode start) and sets `since = alert_date` only for a new entry. The JSON entry becomes `{"date","z","since"}`.
  - `render_anomaly_email(target_date, alerts, top_circuits, mode_split=None, episode_since: dict[str, date] | None = None)` — per category block, first paragraph prefix: `NEW today` (bold) when `episode_since` is missing the category or equals `target_date`; otherwise `Day N since {Mon D}` where `N = (target_date - since).days + 1`. The subject gains the suffix ` · day N` only when N > 1 (single-alert subjects only; multi-category subject unchanged).
  - `generate_anomaly_check` passes `episode_since` built from the state it saves for each alerting category.

- [ ] **Step 1: Write failing tests:**
  - `test_save_state_keeps_episode_start` (temp dir): save for 2026-11-01 then 2026-11-03 → `load_state(...).since == date(2026,11,1)` and `last_alert_date == date(2026,11,3)`.
  - `test_clear_state_then_save_starts_new_episode`: clear, save 2026-11-05 → `since == date(2026,11,5)`.
  - `test_load_state_legacy_entry_without_since`: write `{"HVAC": {"date": "2026-11-02", "z": 4.1}}` by hand → `since == date(2026,11,2)`, no exception.
  - `test_anomaly_email_new_today_label`: `episode_since={}` → HTML contains `NEW today`; subject has no `day`.
  - `test_anomaly_email_day_n_label_and_subject_suffix`: `since=date(2026,11,2)`, target 2026-11-04 → HTML contains `Day 3 since Nov 2` and the single-alert subject ends with ` · day 3`.
  - `test_anomaly_multi_category_subject_unchanged`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the above; keep `should_alert` untouched.
- [ ] **Step 4: Run the full suite.** Expected: 0 failed.
- [ ] **Step 5: Commit** — `pi: anomaly emails say NEW today or Day N since …, backed by episode-start state`

---

## Out of scope (separate plans, need Nico's input)

- **Away mode / pause link.** Needs a place to store `paused_until` and a signed endpoint to receive the click (Vercel route cannot write to the Pi directly; options are an Influx write from the web app or a small endpoint behind the Cloudflare tunnel). Nico has not picked pause-link vs dashboard-setting yet. Overlaps issue #8.
- **Cold-weather suppression (#3) and weather-aware baselines.** Needs a design pass on `report_baseline` using the `weather` measurement.
- **12-month EV accuracy.** The rollup fix shipped 2026-10-27; verifying the 12-month chart reads the corrected `circuit_1h` data is a read-only check against the live Pi, not a code task here.
- **Deploying to the Pi** (rebuild `daily-report`, a `--date` test send with `DRY_RUN=1` first) — after the branch is reviewed and merged.
