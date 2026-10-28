# Template for pi/.env on phrpi. 1Password is the source of truth; never
# hand-edit the Pi's .env. Change a value in 1Password (or a plain line here),
# then render and swap it in from the laptop:
#
#     pi/render_env.sh
#
# Same rules as pi/backup/span-backup.env.tpl: op inject parses this entire
# file, comments included, so secret references appear only on the real
# assignment lines below, never in prose. Every key the Pi needs must be
# listed here: render_env.sh shows any key that would be dropped before it
# swaps the file in.

# SPAN v1 REST token (pi/collector.py). Delete at the v2 cutover (#26).
SPAN_ACCESS_TOKEN={{ op://dev-secrets/phrpi-span-env/SPAN_ACCESS_TOKEN }}

# SPAN v2 MQTT client (pi/collector_v2.py), registered 2026-10-27 by door
# proximity. The serial is private only to keep it out of this public repo.
SPAN_SERIAL={{ op://dev-secrets/span-panel-v2-client/serial }}
SPAN_V2_BROKER_PASSWORD={{ op://dev-secrets/span-panel-v2-client/ebusBrokerPassword }}

# InfluxDB
INFLUXDB_PASSWORD={{ op://dev-secrets/phrpi-span-env/INFLUXDB_PASSWORD }}
INFLUXDB_TOKEN={{ op://dev-secrets/phrpi-span-env/INFLUXDB_TOKEN }}

# Grafana
GRAFANA_PASSWORD={{ op://dev-secrets/phrpi-span-env/GRAFANA_PASSWORD }}

# Cloudflare Tunnel (shared beyond SPAN; see CLAUDE.md before rotating)
CLOUDFLARE_TUNNEL_TOKEN={{ op://dev-secrets/phrpi-cloudflared-tunnel-token/credential }}

# Daily Report Email (via Resend)
RESEND_API_KEY={{ op://dev-secrets/SPAN-resend-API-key/credential }}
REPORT_EMAIL={{ op://dev-secrets/phrpi-span-env/REPORT_EMAIL }}
# Optional: override the From address. Default uses span.pianohouseproject.org.
# Must be an address on a Resend-verified domain.
# REPORT_FROM=SPAN Monitor <energy@span.pianohouseproject.org>

# Optional: override the default Seattle city-center coordinates used by
# weather_poller.py for hourly outdoor temperature (LATITUDE/LONGITUDE).
# Hourly temp doesn't vary enough across a few miles to need rooftop-exact
# values -- only set these for a meaningfully different location.
# Note: weather points carry no location tag, so changing these later
# silently overwrites the previous location's history at the same
# timestamps -- there's no way to tell old and new coordinates apart in Influx.
# LATITUDE=47.6062
# LONGITUDE=-122.3321

# Daily 7am email when the heat pump ran `cool`-labeled intervals yesterday
# (>= HVAC_COOL_ALERT_MIN_MINUTES, default 15). On for heating season -- with
# the thermostats on heat, any cooling means the Stiebel ran on its own comfort
# setpoint. Set to 0 for cooling season or it fires every warm day.
HVAC_COOL_ALERT=1
