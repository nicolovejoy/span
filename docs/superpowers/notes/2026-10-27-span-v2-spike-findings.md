# SPAN v2 / MQTT spike findings (#26) — 2026-10-27

Spike for the v1 REST sunset (2026-12-31). Script: `pi/v2_spike.py` (`register`, `capture`).
Capture: 15 min, 2026-10-28 03:24–03:39Z, 21,601 messages, compared against the live v1
collector's Influx points over the same window. Panel firmware `spanos3/r202639/04`; SPAN's
docs repo has a matching `specs/r202639/` (openapi + homie schema).

## Auth

- Registered by door-switch proximity (3x door, `proximityProven` flips on `GET /api/v2/status`;
  the proof is single-use). The proximity response includes the `hopPassphrase`; the script
  immediately re-registers with it for a full-privilege client, same as SPAN's `span-auth`.
  Two clients now exist on the panel: `span-collector-20261027-…` (reduced) and `…-full`.
- Secrets (`accessToken`, `ebusBrokerPassword`, `hopPassphrase`): 1Password `dev-secrets` →
  `span-panel-v2-client`; local copy `~/.span-v2-creds.json` (0600) on the laptop. Not yet on the Pi.
- Broker: `span-<serial>.local:8883`, username = serial, TLS against the panel's own CA
  (`GET /api/v2/certificate/ca`). The `.local` name resolves on the LAN; hostname check passes.
- Reading is unrestricted: any registered client may subscribe to `ebus/#`.

## Mapping to what v1 writes today — all confirmed live

- **Circuit IDs:** all 21 v2 circuit device IDs equal the v1 `circuit_id` tags; `info/name`
  equals the v1 `name` tag. Collector v2 can write the same series; no history discontinuity.
- **Circuit energy:** v1 `consumedEnergyWh` = `ebus/5/<circuit>/meter/exported-energy` (Wh);
  `producedEnergyWh` = `meter/imported-energy`. (SPAN's power-and-energy-conventions.md.)
- **Circuit power:** v1 `instantPowerW` = `meter/active-power`, **same sign** (loads negative in
  both; median v2/v1 ratio 1.00 on every circuit above 20 W except one noisy ~15 W outlet).
- **Panel:** `<serial>-lugs-up meter/active-power` ≈ `grid_power_w`;
  `<serial>-lugs-dn meter/active-power` ≈ `feedthrough_power_w` (same sign);
  `<serial>-lugs-up meter/imported-energy` ≈ panel `consumed_energy_wh`, exported ≈ produced (0).

## The headline: v1's ~15-min energy batching is a v1 artifact

- v2 pushes power every ~1 s and energy every 1–2 s (circuit `exported-energy` median 2 s;
  lugs energy 1 s), continuously increasing.
- v1 counters sat flat, then all jumped together at 03:31:22Z. At that instant, v1's new value
  equalled v2's value **to within 0.2 Wh on all 10 circuits that jumped** (e.g. heat pump +267.6 Wh,
  v2−v1 = 0.0). So v1 is a delayed snapshot of the *same* accumulator, not a separate counter.
- Implication: after cutover, counter steps arrive smoothly every 30 s instead of in ~15-min
  lumps. The rollup tasks' plausibility bound (10 kWh + 50 kW × elapsed) stays valid and can stay
  as is; the "never bound a step by implied power alone" caveat was about v1 batching and becomes
  moot for v2 data, but keep the restart guard (previous reading non-zero).
- v1's `Circuit` schema has an `energyAccumUpdateTimeS` field — the batch timestamp — undocumented.

## Restart / lifecycle signal (v2 `/status` has no uptime)

From SPAN's r202639 CHANGELOG and README (via research subagent):
- All `$state`, `$description` and property topics are retained; an identical payload is not
  republished; the full device tree is republished whenever the panel reconnects to the broker.
- Root device `$state`: clean shutdown publishes retained `disconnected`; `lost` = ungraceful;
  restart goes `init` → `ready`. Logging these transitions with timestamps is the restart signal
  #26 step 3 wanted.

## Pitfalls to design around

- **Unseen ≠ zero.** SpanPanel/span#259: a client that filled not-yet-received properties with
  0.0 after a retained replay produced fake counter resets. Collector v2 must skip a field it has
  not received yet, never write 0. (The v1 collector's `.get(..., 0)` is exactly this bug shape.)
- v2 feedthrough (`lugs-dn`) energy came from the wrong internal source until r202621
  (spanio/SPAN-API-Client-Docs#13) and is computed from two counters that can decrease
  (SpanPanel/span#234). We store only feedthrough *power*, which matched v1.
- Community reports of lower counters after panel resets/firmware updates (SpanPanel/span#87,
  #240; the HA integration ships "energy dip compensation") — consistent with our 2026-10-26
  rebase; the rollup guard handles it.
- Publish cadence/rate limits are undocumented; measured above.

## Still to port off v1

`pi/collector.py`, `span_client.py`, `pi/hvac_probe.py`, `status.sh` (its `/api/v1/status`
uptime read has no v2 equivalent — use v2 `/status` for reachability + firmware).
