# SPAN Smart Panel Monitor

Local observability for a SPAN Smart Panel: a collector on a Raspberry Pi subscribes to the
panel's own MQTT broker (SPAN API v2), stores readings in InfluxDB, and a Next.js dashboard and
Grafana visualize them.

## Layout

- `pi/` — the Docker stack that runs on the Pi (collector, detectors, weekly/daily emails, InfluxDB, Grafana). Setup: `pi/SETUP.md`.
- `web/` — the power-explorer dashboard (Next.js, Vercel-hosted).
- `status.sh` — one-shot health check of the whole stack, run from any machine on the LAN.
- `docs/roadmap.md` — what's next and why.

## Usage

```bash
./status.sh                           # health check
ssh nico@phrpi.local                  # the stack lives on the Pi
cd SPAN/pi && docker compose up -d    # start / update it there
```

Secrets are never hand-edited: `pi/.env` is rendered from 1Password with `pi/render_env.sh`.

The original v1 REST terminal client (`span_client.py`) was removed on 2026-11-13; SPAN retires
the v1 API on 2026-12-31. It remains in git history.
