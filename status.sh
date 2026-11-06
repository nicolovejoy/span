#!/bin/bash
# status.sh — one-shot health probe of the whole SPAN stack, runnable from any
# machine on the LAN. Read-only. Exits non-zero if any check FAILs.
#
#   ./status.sh            # everything
#   SPAN_PI=192.168.5.50 ./status.sh   # override Pi address (default: phrpi.local, IP fallback)
#
# Needs pi/.env (INFLUXDB_TOKEN) for the freshness checks; SSH to the Pi for
# the backup/disk/docker section (skipped gracefully if unreachable).

set -u
cd "$(dirname "$0")"

PANEL=${SPAN_PANEL:-192.168.4.72}
PI=${SPAN_PI:-phrpi.local}
PI_IP_FALLBACK=192.168.5.50
SSH_TARGET=${SPAN_PI_SSH:-nico@phrpi.local}
TUNNEL_URL=https://span.pianohouseproject.org
ORG=home
BUCKET=span

fail=0
ok()   { printf '  OK    %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
skip() { printf '  SKIP  %s\n' "$1"; }

# mDNS from macOS is flaky per-query — resolve .local once and use the raw IP
# for every probe; fall back to the known static IP if resolution fails.
case "$PI" in
    *.local)
        ip=$(dscacheutil -q host -a name "$PI" 2>/dev/null | awk '/ip_address/{print $2; exit}')
        [ -z "$ip" ] && ip=$(getent hosts "$PI" 2>/dev/null | awk '{print $1; exit}')
        PI=${ip:-$PI_IP_FALLBACK}
        ;;
esac
echo "SPAN status — panel $PANEL, pi $PI"

# --- Reachability -----------------------------------------------------------
code=$(curl -s -m 4 -o /dev/null -w '%{http_code}' "http://$PANEL/api/v2/status" || true)
[ "$code" = 200 ] && ok "panel API" || bad "panel API — HTTP ${code:-timeout}"

if curl -s -m 4 "http://$PI:8086/health" | grep -q '"status": *"pass"'; then
    ok "InfluxDB"
else
    bad "InfluxDB — no healthy response from $PI:8086"
fi

if curl -s -m 4 "http://$PI:3000/api/health" | grep -q '"database": *"ok"'; then
    ok "Grafana"
else
    bad "Grafana — no healthy response from $PI:3000"
fi

code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$TUNNEL_URL" || true)
case "$code" in
    200|302) ok "dashboard ($TUNNEL_URL → $code)" ;;
    *)       bad "dashboard ($TUNNEL_URL) — HTTP ${code:-timeout}" ;;
esac

# Observer endpoint (UptimeRobot + daily email watch this): {"ok":true,checks:[...]}
health=$(curl -s -m 10 "$TUNNEL_URL/api/health" || true)
if echo "$health" | grep -q '"ok":true'; then
    ok "health endpoint — all checks pass"
elif [ -n "$health" ]; then
    bad "health endpoint — $(echo "$health" | head -c 200)"
else
    bad "health endpoint — no response"
fi

# Grafana rides the phrpi CF tunnel — a 200/302 here proves tunnel + CF Access are up.
code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://grafana.pianohouseproject.org || true)
case "$code" in
    200|302) ok "CF tunnel via grafana.pianohouseproject.org → $code" ;;
    *)       bad "CF tunnel via grafana.pianohouseproject.org — HTTP ${code:-timeout}" ;;
esac

# --- Data freshness ----------------------------------------------------------
TOKEN=""
[ -f pi/.env ] && TOKEN=$(grep -m1 '^INFLUXDB_TOKEN=' pi/.env | cut -d= -f2-)

# age_s <measurement> <field> <lookback> → seconds since last point, or "" on no data
age_s() {
    local flux="from(bucket:\"$BUCKET\") |> range(start:-$3)
        |> filter(fn:(r)=>r._measurement==\"$1\" and r._field==\"$2\")
        |> group() |> last() |> keep(columns:[\"_time\"])"
    local t
    t=$(curl -s -m 8 -X POST "http://$PI:8086/api/v2/query?org=$ORG" \
        -H "Authorization: Token $TOKEN" \
        -H 'Content-Type: application/vnd.flux' -H 'Accept: application/csv' \
        -d "$flux" | grep -m1 '^,_result' | cut -d, -f4 | tr -d '\r')
    [ -n "$t" ] || return 0
    python3 -c "
import re
from datetime import datetime, timezone
s = re.sub(r'\.\d+', '', '$t').replace('Z', '+00:00')
t = datetime.fromisoformat(s)
print(int((datetime.now(timezone.utc) - t).total_seconds()))"
}

if [ -z "$TOKEN" ]; then
    skip "freshness checks — no INFLUXDB_TOKEN (pi/.env missing)"
else
    a=$(age_s circuit power_w 30m)
    if   [ -z "$a" ];      then bad "collector — no raw point in 30m"
    elif [ "$a" -le 120 ]; then ok "collector — last raw point ${a}s ago"
    else                        bad "collector — last raw point ${a}s ago (expect ≤120s)"
    fi

    # circuit_5m tail lag is 1–6 min by contract (pi/influx_tasks/README.md)
    a=$(age_s circuit_5m power_w_mean 2h)
    if   [ -z "$a" ];      then bad "rollup circuit_5m — no point in 2h"
    elif [ "$a" -le 900 ]; then ok "rollup circuit_5m — last point ${a}s ago"
    else                        warn "rollup circuit_5m — last point ${a}s ago (expect ≤900s)"
    fi

    a=$(age_s circuit_1h power_w_mean 6h)
    if   [ -z "$a" ];       then bad "rollup circuit_1h — no point in 6h"
    elif [ "$a" -le 7800 ]; then ok "rollup circuit_1h — last point ${a}s ago"
    else                         warn "rollup circuit_1h — last point ${a}s ago (expect ≤7800s)"
    fi

    for ev in bath_event charge_event; do
        a=$(age_s "$ev" duration_min 14d)
        [ -z "$a" ] && a=$(age_s "$ev" duration_s 14d)
        if [ -n "$a" ]; then
            ok "$ev — most recent $((a / 3600))h ago (info)"
        else
            warn "$ev — none in 14d (info)"
        fi
    done

    # Yesterday's poll coverage — Pacific calendar day, converted to UTC RFC3339
    # for the range. distinct(column:"_time") yields a time-typed _value, which
    # count() can't aggregate directly (Flux: "unsupported aggregate column type
    # time"), so remap to 1 and sum instead — same distinct-timestamp count.
    yday=$(TZ=America/Los_Angeles date -v-1d +%Y-%m-%d)
    start_epoch=$(TZ=America/Los_Angeles date -j -f '%Y-%m-%d %H:%M:%S' "$yday 00:00:00" +%s)
    end_epoch=$(TZ=America/Los_Angeles date -j -v+1d -f '%Y-%m-%d %H:%M:%S' "$yday 00:00:00" +%s)
    start=$(date -u -r "$start_epoch" +%Y-%m-%dT%H:%M:%SZ)
    end=$(date -u -r "$end_epoch" +%Y-%m-%dT%H:%M:%SZ)
    expected=$(( (end_epoch - start_epoch) / 30 ))

    flux="from(bucket:\"$BUCKET\") |> range(start:$start, stop:$end)
        |> filter(fn:(r)=>r._measurement==\"circuit\" and r._field==\"power_w\")
        |> group() |> distinct(column:\"_time\")
        |> map(fn:(r)=>({r with _value: 1})) |> group() |> sum()"
    present=$(curl -s -m 10 -X POST "http://$PI:8086/api/v2/query?org=$ORG" \
        -H "Authorization: Token $TOKEN" \
        -H 'Content-Type: application/vnd.flux' -H 'Accept: application/csv' \
        -d "$flux" | grep -m1 '^,_result' | cut -d, -f4 | tr -d '\r')

    if [ -n "$present" ] && [ "$expected" -gt 0 ]; then
        pct=$(python3 -c "print(f'{100*$present/$expected:.1f}')")
        ok "poll coverage yesterday ($yday) — $present/$expected, ${pct}%"
    else
        warn "poll coverage yesterday ($yday) — query failed or no data"
    fi
fi

# --- On-Pi checks (best-effort) ----------------------------------------------
if ssh -o BatchMode=yes -o ConnectTimeout=4 "$SSH_TARGET" true 2>/dev/null; then
    down=$(ssh -o BatchMode=yes "$SSH_TARGET" \
        "docker ps -a --filter 'status=exited' --filter 'status=restarting' --format '{{.Names}}'" 2>/dev/null)
    if [ -z "$down" ]; then
        ok "docker — all containers up"
    else
        bad "docker — not running: $(echo "$down" | tr '\n' ' ')"
    fi

    last_backup=$(ssh -o BatchMode=yes "$SSH_TARGET" \
        "systemctl show span-backup.timer -p LastTriggerUSec --value" 2>/dev/null)
    if [ -n "$last_backup" ] && [ "$last_backup" != "n/a" ]; then
        ok "backup timer — last trigger: $last_backup"
    else
        bad "backup timer — no LastTriggerUSec (timer not installed or never ran)"
    fi

    disk=$(ssh -o BatchMode=yes "$SSH_TARGET" "df -h / | tail -1 | awk '{print \$5\" used (\"\$4\" free)\"}'" 2>/dev/null)
    pct=${disk%%\%*}
    if [ -n "$disk" ] && [ "${pct:-100}" -lt 85 ]; then
        ok "disk — $disk"
    else
        warn "disk — $disk"
    fi
else
    skip "on-Pi checks (docker, backup timer, disk) — SSH to $SSH_TARGET unavailable"
fi

exit $fail
