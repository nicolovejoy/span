# Collector v2 (SPAN MQTT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1-REST-polling collector with one that subscribes to the panel's local MQTT broker, writing the same Influx series, before SPAN removes v1 on 2026-12-31 (#26).

**Architecture:** A pure module (`pi/span_v2.py`) holds the latest value of every Homie property and turns it into the existing `panel` / `circuit` rows. A thin I/O process (`pi/collector_v2.py`) feeds it from a paho-mqtt subscription and writes a snapshot every 30 s, so every downstream consumer (rollup tasks, classifiers, emails, dashboard) is untouched. It first runs in shadow mode, writing `*_v2` measurements next to v1 for a few days of comparison, then cuts over.

**Tech Stack:** Python 3.11, paho-mqtt ≥ 2 (`CallbackAPIVersion.VERSION2`), influxdb-client, unittest (the existing `pi/test_*.py` style), Docker Compose on the Pi.

**Spec:** `docs/superpowers/notes/2026-10-27-span-v2-spike-findings.md`. Reference capture code: `pi/v2_spike.py`.

## Global Constraints

- Series names stay verbatim. `panel`: fields `grid_power_w`, `feedthrough_power_w`, `consumed_energy_wh`, `produced_energy_wh`. `circuit`: tags `circuit_id`, `name`; fields `power_w`, `consumed_energy_wh`, `produced_energy_wh`, `relay_state` (1 = `CLOSED`, else 0). `collector_poll`: tags `host="phrpi"`, `result`, `error`; field `points`.
- Mapping (topic = `ebus/5/<device-id>/<capability>/<property>`):
  - `<serial>-lugs-up` `meter/active-power` → `panel.grid_power_w`
  - `<serial>-lugs-dn` `meter/active-power` → `panel.feedthrough_power_w`
  - `<serial>-lugs-up` `meter/imported-energy` → `panel.consumed_energy_wh`
  - `<serial>-lugs-up` `meter/exported-energy` → `panel.produced_energy_wh`
  - circuit `meter/active-power` → `power_w`; `meter/exported-energy` → `consumed_energy_wh`; `meter/imported-energy` → `produced_energy_wh`; `switch/relay` → `relay_state`; `info/name` → `name` tag; device id → `circuit_id` tag.
- No sign flips: v2 signs already match what v1 stored.
- A device is a circuit iff its own `$description` JSON has `"type": "energy.ebus.device.circuit"`.
- **Never write 0 for a property not yet received.** Omit the field. A circuit with no fields gets no point.
- Snapshot cadence `POLL_INTERVAL=30` s (the rollup `.flux` tasks and `collector_health.py` assume 30 s).
- `MEASUREMENT_SUFFIX` env var (default `""`) is appended to `panel`, `circuit`, `collector_poll`, `panel_lifecycle`. Shadow mode uses `_v2`.
- **1Password is the source of truth for all of `pi/.env`.** The Pi's `.env` is generated from `pi/.env.tpl` by `pi/render_env.sh` (Task 0) and is never hand-edited again. Template syntax is the same as `pi/backup/span-backup.env.tpl`: `KEY={{ op://dev-secrets/<item>/<field> }}`.
- `collector-v2` gets its secrets as compose file secrets (`/run/secrets/…`, the cloudflared pattern), with **no `env_file`**, so they don't appear in `docker inspect`. Env names: `SPAN_SERIAL`, `SPAN_V2_BROKER_PASSWORD`, `INFLUXDB_TOKEN`. Each is read from `$NAME_FILE` when set, else `$NAME`. `SPAN_V2_BROKER_HOST` defaults to `span-<serial>.local`.
- The repo is public. Use the fake serial `ab-0000-00000` in tests. Never commit the real serial, captures or credentials.
- Pi test run: `cd pi && uv run --python 3.11 --with pytest --with httpx --with influxdb-client --with tzdata --with matplotlib --with paho-mqtt pytest -q`. The 5 known `test_weekly_report.py` failures are pre-existing. No new failures allowed.

## Review Focus

1. **Broker disconnect / panel restart.** While disconnected, write no `panel`/`circuit` rows, only a failing `collector_poll`. After reconnect, the retained replay restores state without zero-filling. Pinned in Task 2 (`test_disconnected_writes_no_rows`) and Task 1 (`test_unseen_fields_omitted`).
2. **Values arriving before `$description`.** Retained replay order isn't guaranteed. Store values for unknown devices, and include the device once its `$description` lands. Pinned in Task 1 (`test_values_before_description`).
3. **Empty payload.** In Homie an empty retained payload clears the property. Drop the stored value, don't parse it as 0. Pinned in Task 1 (`test_empty_payload_clears`).
4. **Non-numeric payload on a numeric property.** Skip that field and keep the rest of the point. Pinned in Task 1 (`test_bad_number_skipped`).
5. **Circuit renamed in the SPAN app.** The new `info/name` becomes the `name` tag on the next snapshot, the same behaviour as v1. Pinned in Task 1 (`test_rename_uses_latest_name`).

---

### Task 0: `pi/.env` rendered from 1Password

**Files:**
- Create: `pi/.env.tpl`, `pi/render_env.sh`, `pi/tools/seed_phrpi_span_env.sh`
- Delete: `pi/.env.example` (the template replaces it). Modify: `CLAUDE.md` § Credentials, the only live reference, to point at `pi/.env.tpl` + `pi/render_env.sh`.

**1Password references** (vault `dev-secrets`):
- `CLOUDFLARE_TUNNEL_TOKEN` → `phrpi-cloudflared-tunnel-token/credential`
- `RESEND_API_KEY` → `SPAN-resend-API-key/credential` (the value check in Step 4 confirms it's the key the Pi actually uses)
- `SPAN_SERIAL` → `span-panel-v2-client/serial`; `SPAN_V2_BROKER_PASSWORD` → `span-panel-v2-client/ebusBrokerPassword`
- `INFLUXDB_TOKEN`, `INFLUXDB_PASSWORD`, `GRAFANA_PASSWORD`, `SPAN_ACCESS_TOKEN` (v1, removed at cutover), `REPORT_EMAIL` → new item `phrpi-span-env`, one field per name
- Non-secrets (`HVAC_COOL_ALERT`, any other flags) are plain `KEY=value` lines in the template.

**Scripts** (bash, run on the laptop by Nico, since `op` needs his unlock; no bare backslashes in anything he pastes):
- `pi/tools/seed_phrpi_span_env.sh`: one-time setup. Over ssh, reads the five keys above from `~/SPAN/pi/.env` on the Pi verbatim, everything after the first `=`, and runs `op item create --vault dev-secrets --category "API Credential" --title phrpi-span-env` with one `[password]` field per key (`REPORT_EMAIL` as `[text]`). It refuses to run if the item already exists and prints nothing but the created item's field names.
- `pi/render_env.sh [--host nico@phrpi.local]`:
  1. `op inject -i pi/.env.tpl` piped over ssh into `~/SPAN/pi/.env.new` with `umask 077`.
  2. On the Pi, prints **names only**: keys only in `.env` (would be dropped), keys only in `.env.new` (added), and `same`/`DIFFERS` per shared key, comparing whole lines exactly.
  3. Prompts `Swap in .env.new? [y/N]`. On yes: `cp .env .env.bak && mv .env.new .env`; on no: deletes `.env.new`. Restarts nothing; it prints the compose command to run next instead.

- [ ] **Step 1: Write `pi/.env.tpl`** with every key in `pi/.env.example`, plus `HVAC_COOL_ALERT=1`, `SPAN_SERIAL` and `SPAN_V2_BROKER_PASSWORD`, using the references above.
- [ ] **Step 2: Write both scripts.** Check: `bash -n pi/render_env.sh pi/tools/seed_phrpi_span_env.sh` prints nothing.
- [ ] **Step 3: Nico runs `pi/tools/seed_phrpi_span_env.sh`.** Expected: the 5 field names of the new `phrpi-span-env` item.
- [ ] **Step 4: Nico runs `pi/render_env.sh` and answers N the first time.** Pass: no dropped keys, the only added keys are `SPAN_SERIAL` and `SPAN_V2_BROKER_PASSWORD`, and every shared key is `same`. A dropped key means it's missing from the template: add it (to `phrpi-span-env` if secret) and re-run. A `DIFFERS` means the wrong 1Password item, or quoting: fix and re-run. Don't proceed until it's clean.
- [ ] **Step 5: Nico re-runs it and answers y.** No restart is needed: every existing value is identical, and nothing reads the two new keys yet.
- [ ] **Step 6: Commit:** `git add pi/.env.tpl pi/render_env.sh pi/tools/seed_phrpi_span_env.sh CLAUDE.md && git rm pi/.env.example && git commit -m "pi: render .env from 1Password via .env.tpl"`.

### Task 1: Pure panel state + snapshot rows

**Files:**
- Create: `pi/span_v2.py`
- Test: `pi/test_span_v2.py`

**Interfaces:**
- Produces:
  - `parse_topic(topic: str) -> tuple[str, str] | None`. `"ebus/5/<dev>/<cap>/<prop>"` → `(dev, "cap/prop")`, and `"ebus/5/<dev>/$state"` → `(dev, "$state")`. Anything else (other prefixes, `/set` topics) → `None`.
  - `class PanelState` with `__init__(self, serial: str)` and attributes `values: dict[tuple[str, str], str]`, `device_types: dict[str, str]`, `last_update: float | None` (epoch seconds of the last message on any `<serial>-lugs-up` meter property).
  - `PanelState.apply(self, topic: str, payload: str, now: float) -> dict | None`. Updates state and returns a lifecycle event `{"state": str, "firmware": str | None}` when the root device's `$state` or `info/firmware-version` changes value (including the first time it's seen). Otherwise `None`.
  - `PanelState.rows(self) -> list[dict]`. Each row is `{"measurement": "panel" | "circuit", "tags": dict[str, str], "fields": dict[str, float | int]}`. At most one panel row (omitted if it has no fields), plus one row per circuit that has at least one field and a known name.

- [ ] **Step 1: Write the failing tests** in `pi/test_span_v2.py` (unittest, like `test_collector_health.py`). Build state from a list of `(topic, payload)` helpers with `SERIAL = "ab-0000-00000"`, a circuit `"c1"` whose `$description` is `{"type": "energy.ebus.device.circuit"}`, and lugs devices `f"{SERIAL}-lugs-up"` / `-lugs-dn`:
  - `test_parse_topic`: `parse_topic("ebus/5/c1/meter/active-power") == ("c1", "meter/active-power")`; `parse_topic("ebus/5/c1/$state") == ("c1", "$state")`; `parse_topic("ebus/5/c1/switch/relay/set") is None`; `parse_topic("homie/5/c1/x/y") is None`.
  - `test_panel_row_mapping`: lugs-up `active-power` "1148.0", lugs-dn `active-power` "143.1", lugs-up `imported-energy` "4101891.5", lugs-up `exported-energy` "0.0" → the panel row's fields equal `{"grid_power_w": 1148.0, "feedthrough_power_w": 143.1, "consumed_energy_wh": 4101891.5, "produced_energy_wh": 0.0}`, tags `{}`.
  - `test_circuit_row_mapping`: c1 `info/name` "Heat pump (HP)", `active-power` "-29.3", `exported-energy` "90443.1", `imported-energy` "0.0", `switch/relay` "CLOSED" → tags `{"circuit_id": "c1", "name": "Heat pump (HP)"}`, fields `{"power_w": -29.3, "consumed_energy_wh": 90443.1, "produced_energy_wh": 0.0, "relay_state": 1}`. Relay "OPEN" → `relay_state` 0.
  - `test_unseen_fields_omitted`: c1 with name and only `active-power` → the circuit row has exactly `{"power_w": ...}`, with no energy keys and no zeros.
  - `test_values_before_description`: values for c1 applied before its `$description` → no circuit row. After the `$description` is applied → row present with those values.
  - `test_non_circuit_device_ignored`: a device whose `$description` type is `energy.ebus.device.lugs`, or unparseable JSON, never yields a circuit row.
  - `test_empty_payload_clears`: `active-power` "5.0" then "" → `power_w` absent.
  - `test_bad_number_skipped`: `active-power` "abc", `exported-energy` "10.0" → fields `{"consumed_energy_wh": 10.0}`.
  - `test_rename_uses_latest_name`: `info/name` "A" then "B" → tag `name == "B"`.
  - `test_lifecycle_events`: root `$state` "ready" → returns `{"state": "ready", "firmware": None}`; the same "ready" again → `None`; `info/firmware-version` "spanos3/r202639/04" → returns `{"state": "ready", "firmware": "spanos3/r202639/04"}`; `$state` "init" → event with `state == "init"`.
  - `test_last_update_tracks_lugs_meter`: applying lugs-up `meter/active-power` at `now=100.0` sets `last_update == 100.0`; a circuit message at 200.0 leaves it at 100.0.

- [ ] **Step 2: Run to confirm they fail**
Run: `cd pi && python3 -m unittest test_span_v2 -v`
Expected: `ModuleNotFoundError: No module named 'span_v2'`

- [ ] **Step 3: Implement `pi/span_v2.py`** to the interfaces above. Pure: no I/O and no imports beyond the stdlib. Keep the topic→field mapping as two module-level dicts (`PANEL_FIELDS`, `CIRCUIT_FIELDS`) mapping `(device-suffix or "circuit", "cap/prop")` to field names, copied from Global Constraints.

- [ ] **Step 4: Run to confirm they pass**
Run: `cd pi && python3 -m unittest test_span_v2 -v`
Expected: all OK.

- [ ] **Step 5: Commit**
```bash
git add pi/span_v2.py pi/test_span_v2.py
git commit -m "pi: span_v2 pure Homie state -> panel/circuit rows (#26)"
```

### Task 2: Poll health classification

**Files:**
- Modify: `pi/span_v2.py`
- Test: `pi/test_span_v2.py`

**Interfaces:**
- Consumes: `PanelState` from Task 1.
- Produces: `poll_result(state: PanelState, now: float, connected: bool, stale_after_s: float = 90.0) -> tuple[str, str]`, returning `(result, error)`, where `result` ∈ `ok`, `panel_fail`, `circuits_fail`, `both_fail` and `error` ∈ `none`, `disconnected`, `stale`, `no_circuits`. Also `snapshot_rows(state, now, connected, stale_after_s=90.0) -> list[dict]`, which returns `state.rows()` only when `poll_result(...)[0] == "ok"` or `"circuits_fail"` (the panel row alone), and `[]` otherwise.

Rules: if not connected → `("both_fail", "disconnected")`. If `last_update` is `None` or older than `stale_after_s` → `("both_fail", "stale")`. Why 90 s: lugs-up power republishes every ~1 s, but identical payloads are suppressed, so allow slack. If no circuit rows → `("circuits_fail", "no_circuits")`. Otherwise `("ok", "none")`. Circuits can't be judged stale by age, because an idle circuit legitimately never republishes.

- [ ] **Step 1: Write the failing tests**: `test_disconnected_writes_no_rows` (a fully populated state with `connected=False` → `poll_result == ("both_fail", "disconnected")`, `snapshot_rows == []`); `test_stale_panel` (`last_update=0`, `now=91` → `("both_fail", "stale")`); `test_no_circuits` (panel only → `("circuits_fail", "no_circuits")`, and `snapshot_rows` returns just the panel row); `test_ok` (panel + one circuit, fresh → `("ok", "none")`).
- [ ] **Step 2: Run, expect failure:** `cd pi && python3 -m unittest test_span_v2 -v` → `AttributeError`/`ImportError` on `poll_result`.
- [ ] **Step 3: Implement** both functions in `pi/span_v2.py`.
- [ ] **Step 4: Run, expect pass** (same command).
- [ ] **Step 5: Commit:** `git commit -m "pi: span_v2 poll_result / snapshot_rows (#26)"`.

### Task 3: collector_v2 process

**Files:**
- Create: `pi/collector_v2.py`
- Test: `pi/test_collector_v2.py`

**Interfaces:**
- Consumes: `PanelState`, `snapshot_rows`, `poll_result` (Tasks 1–2).
- Produces:
  - `to_points(rows: list[dict], suffix: str, ts: datetime) -> list[Point]`: measurement = `row["measurement"] + suffix`.
  - `poll_point(result: str, error: str, n_points: int, panel_age_s: float | None, suffix: str, ts: datetime) -> Point`: measurement `"collector_poll" + suffix`, tags `host="phrpi"`, `result`, `error`; fields `points` (int) and `panel_age_ms` (int; omitted when age is `None`). The v1 fields `panel_ms`/`circuits_ms` are request timings that have no MQTT meaning, so drop them.
  - `lifecycle_point(event: dict, suffix: str, ts: datetime) -> Point`: measurement `"panel_lifecycle" + suffix`, string field `state`, string field `firmware` when not `None`.
  - CLI: `python collector_v2.py [--dry-run]`. `--dry-run` prints line protocol to stdout instead of writing to Influx, so it can run from the laptop.

Process shape:
- `env_secret(name: str) -> str | None`: returns the stripped contents of the file named by `$NAME_FILE` if that variable is set, else `$NAME`. Test: `test_env_secret_prefers_file` (with both set, the file wins; with only `$NAME`, its value is returned; with neither, `None`).
- Read env (secrets via `env_secret`): `SPAN_SERIAL`, `SPAN_V2_BROKER_PASSWORD`, `INFLUXDB_TOKEN`, `SPAN_V2_BROKER_HOST` (default `span-<serial>.local`), `SPAN_PANEL_IP` (default `192.168.4.72`), `POLL_INTERVAL` (30), `MEASUREMENT_SUFFIX` (""), plus the existing `INFLUXDB_*`. Exit with a logged error if the serial or password is missing (not needed with `--dry-run` for Influx vars).
- At startup, fetch the CA PEM from `http://$SPAN_PANEL_IP/api/v2/certificate/ca` into a temp file (exit if no `BEGIN CERTIFICATE`), then `tls_set(ca_certs=...)` with hostname checking **on**.
- paho client (`CallbackAPIVersion.VERSION2`): `client_id=f"span-collector-v2{suffix}"`, username = serial. `on_connect` subscribes `ebus/5/#` and sets `connected=True`; `on_disconnect` sets it False. Call `reconnect_delay_set(1, 60)`, then `connect_async` + `loop_start` so paho reconnects on its own. **No LWT** (the broker discards LWTs on SPAN topics).
- `on_message` calls `state.apply(...)` under a `threading.Lock`. A returned lifecycle event is written immediately (best-effort; log failures).
- The main loop every `POLL_INTERVAL`, under the lock: `snapshot_rows` → `to_points` → write, then the `poll_point`. If the Influx write fails, the poll result becomes `write_fail`, mirroring `collector.py`. Never let an exception kill the loop.

- [ ] **Step 1: Write the failing tests**: `test_to_points_suffix` (a panel row with suffix `_v2` → line protocol starts with `panel_v2 `); `test_poll_point_fields` (`poll_point("ok", "none", 22, 0.8, "", ts).to_line_protocol()` contains `collector_poll,`, `host=phrpi`, `points=22i`, `panel_age_ms=800i`); `test_poll_point_no_age` (`panel_age_s=None` → no `panel_age_ms`); `test_lifecycle_point` (`{"state": "init", "firmware": None}` → `panel_lifecycle` with `state="init"` and no `firmware`).
- [ ] **Step 2: Run, expect failure:** `cd pi && python3 -m unittest test_collector_v2 -v` → `ModuleNotFoundError`.
- [ ] **Step 3: Implement** `pi/collector_v2.py` per the shape above.
- [ ] **Step 4: Run the full Pi suite.** Use the command in Global Constraints with `--with paho-mqtt`. Expected: everything that passed before still passes, plus the new tests; only the 5 known `test_weekly_report.py` failures remain.
- [ ] **Step 5: Live dry run from the laptop** (LAN). Run: `cd pi && SPAN_SERIAL=$(jq -r .serialNumber ~/.span-v2-creds.json) SPAN_V2_BROKER_PASSWORD=$(jq -r .ebusBrokerPassword ~/.span-v2-creds.json) POLL_INTERVAL=10 uv run --with paho-mqtt --with httpx --with influxdb-client python collector_v2.py --dry-run` for ~40 s. Expected: a `panel_lifecycle` line with `state="ready"`, then each cycle prints one `panel` line with 4 fields, 21 `circuit` lines, and `collector_poll` with `result=ok`. Check that no line carries the serial. The tags are only `circuit_id` and `name`.
- [ ] **Step 6: Commit:** `git add pi/collector_v2.py pi/test_collector_v2.py && git commit -m "pi: collector_v2 MQTT snapshot writer with --dry-run (#26)"`.

### Task 4: Shadow deploy on the Pi

**Files:**
- Modify: `pi/Dockerfile`: add `paho-mqtt` to the `pip install` line; `COPY span_v2.py .` and `COPY collector_v2.py .` (per memory: a new `pi/*.py` needs a COPY line).
- Modify: `pi/docker-compose.yml`:
  - Under the top-level `secrets:`, next to `tunnel_token`, add `span_serial: {environment: SPAN_SERIAL}`, `span_v2_broker_password: {environment: SPAN_V2_BROKER_PASSWORD}` and `influxdb_token: {environment: INFLUXDB_TOKEN}`.
  - New service `collector-v2` next to `collector`: `build: .`, `restart: unless-stopped`, **no `env_file`**, and `secrets: [span_serial, span_v2_broker_password, influxdb_token]`.
  - `environment:` `INFLUXDB_URL=http://influxdb:8086`, `INFLUXDB_ORG=home`, `INFLUXDB_BUCKET=span`, `SPAN_PANEL_IP=192.168.4.72`, `POLL_INTERVAL=30`, `MEASUREMENT_SUFFIX=_v2`, plus `SPAN_SERIAL_FILE` / `SPAN_V2_BROKER_PASSWORD_FILE` / `INFLUXDB_TOKEN_FILE` pointing at `/run/secrets/<name>`.
  - `command: ["python", "-u", "collector_v2.py"]`; `extra_hosts: ["span-${SPAN_SERIAL}.local:192.168.4.72"]` (a container can't resolve mDNS, and this keeps TLS hostname verification on; the serial in `docker inspect` is fine, since it's only private to keep it out of the public repo); `depends_on: [influxdb]`.

- [ ] **Step 1: Make the edits; check config locally.** Run: `cd pi && docker compose config --services`. Expected: the list includes `collector-v2`. (If docker isn't available on the laptop, do this check on the Pi in Step 3.)
- [ ] **Step 2: Commit and push the branch.** `git commit -m "pi: collector-v2 shadow service (#26)" && git push -u origin v2-collector`.
- [ ] **Step 3: Secrets are already on the Pi** from Task 0. Verify without revealing: `ssh nico@phrpi.local 'grep -c "^SPAN_V2_BROKER_PASSWORD=." ~/SPAN/pi/.env'` → `1`. Then confirm no secret shows in inspect after Step 4: `docker inspect <collector-v2 container> | grep -c -i -E "BROKER_PASSWORD=|INFLUXDB_TOKEN="` → `0` (only the `_FILE` paths may appear).
- [ ] **Step 4: Deploy.** On the Pi: `cd ~/SPAN && git fetch && git checkout v2-collector && cd pi && docker compose build collector-v2 && docker compose up -d --no-deps collector-v2`. `--no-deps` avoids recreating `influxdb`, the same lesson as the backfill recipe. **Don't rebuild or recreate `collector`.**
- [ ] **Step 5: Verify.** `docker logs --tail 20 span-pi-collector-v2-1` (or whatever compose names it; check with `docker compose ps`) shows connected with no TLS errors. A Flux query for the last 5 min shows ~10 `panel_v2` points, 21 distinct `circuit_id` in `circuit_v2`, and `collector_poll_v2` all `result=ok`. Then switch the Pi checkout back to `main` once this branch merges (memory: the Pi checkout can sit on a stale branch).

### Task 5: Side-by-side comparison, then cutover

**Files:**
- Create: `pi/tools/compare_v2.sh` (same style as `pi/tools/compare_energy_fields.sh`): runs Flux over ssh via `docker exec influxdb influx query`.
- Modify at cutover: `pi/docker-compose.yml`, `pi/Dockerfile` (`CMD`), `status.sh`, `CLAUDE.md`, `pi/influx_tasks/README.md` (the `collector_poll` field table).

- [ ] **Step 1: Write `compare_v2.sh DAYS`.** For each of the last N complete Pacific days, per circuit: `consumed_energy_wh` (last − first) in `circuit` vs `circuit_v2`, plus mean `power_w`. Print rows that miss the pass bar. **Pass bar:**
  - daily energy per circuit agrees within max(1%, 50 Wh), since v1's ≤15-min batch lag only shifts energy across the midnight boundary;
  - mean power agrees within max(2%, 5 W);
  - `collector_poll_v2` has `result=ok` coverage ≥ v1's for the same day.
- [ ] **Step 2: After ≥3 full days of shadow data,** run it and report results to Nico. **Stop here for his go-ahead** before cutting over.
- [ ] **Step 3: Cutover** (with Nico's OK, and before 2026-12-31). `collector` service: take over `collector-v2`'s definition (command, secrets, `_FILE` env, `extra_hosts`, no `env_file`) with `MEASUREMENT_SUFFIX=""`, then delete the `collector-v2` service. Remove `SPAN_ACCESS_TOKEN` from `pi/.env.tpl` and its field from `phrpi-span-env`, and have Nico re-run `pi/render_env.sh` (expected: one dropped key, `SPAN_ACCESS_TOKEN`). Update the rotation wording in the `phrpi-cloudflared-tunnel-token` item's notes ("update this item, then run `pi/render_env.sh`"); that's Nico's edit. Dockerfile `CMD` → `collector_v2.py`. `docker compose up -d --no-deps --build collector`, then `docker compose rm -sf collector-v2`. Verify that `/api/health` (https://span.pianohouseproject.org/api/health) stays 200 and `./status.sh` is green.
- [ ] **Step 4: Port `status.sh`**: change the panel probe from `/api/v1/status` to `/api/v2/status`.
- [ ] **Step 5: Docs.** In `CLAUDE.md`, replace "All secrets are in `pi/.env`" and the cloudflared rotation steps with the `pi/.env.tpl` → `render_env.sh` flow. Update the `collector.py` architecture entry to say it's retired in favour of `collector_v2.py`, and update the `SPAN API` section and #26 in Next Steps. Update the `collector_poll` table in `pi/influx_tasks/README.md` (`panel_age_ms` replaces `panel_ms`/`circuits_ms`; new `error` values). Leave the `*_v2` shadow measurements in place; they're harmless, and Nico can drop them later.
- [ ] **Step 6: Commit, PR, merge** per the usual flow.

## Out of scope (follow-ups to file on #26)

- Port or retire `span_client.py` and `pi/hvac_probe.py` (both v1, both still die on 2026-12-31).
- Surface `panel_lifecycle` in the anomaly email ("panel restarted" instead of reporting usage).
- Automatic re-registration with the stored `hopPassphrase` if the broker password is ever revoked.
