#!/usr/bin/env bash
# One-time: copy the pi/.env secrets that had no 1Password item into a new
# dev-secrets item `phrpi-span-env`, one field per key, read verbatim from the
# Pi's live .env over ssh. Run on the laptop (needs `op` unlocked). Prints only
# field names, never values.
#
#   pi/tools/seed_phrpi_span_env.sh [nico@phrpi.local]
set -euo pipefail

HOST="${1:-nico@phrpi.local}"
VAULT=dev-secrets
ITEM=phrpi-span-env
SECRET_KEYS=(INFLUXDB_TOKEN INFLUXDB_PASSWORD GRAFANA_PASSWORD SPAN_ACCESS_TOKEN)
TEXT_KEYS=(REPORT_EMAIL)

if op item list --vault "$VAULT" --format json | jq -e --arg t "$ITEM" 'any(.[]; .title == $t)' >/dev/null; then
  echo "1Password item $ITEM already exists in $VAULT; not touching it." >&2
  exit 1
fi

# Everything after the first '=', exactly as the Pi has it (quotes included),
# so the rendered file reproduces each line byte for byte.
remote_value() {
  ssh "$HOST" "sed -n 's/^$1=//p' ~/SPAN/pi/.env | head -n 1"
}

fields=()
for key in "${SECRET_KEYS[@]}" "${TEXT_KEYS[@]}"; do
  value="$(remote_value "$key")"
  if [ -z "$value" ]; then
    echo "No $key= line on $HOST; aborting before creating anything." >&2
    exit 1
  fi
  kind=password
  for t in "${TEXT_KEYS[@]}"; do [ "$key" = "$t" ] && kind=text; done
  fields+=("$key[$kind]=$value")
done

op item create --vault "$VAULT" --category "API Credential" --title "$ITEM" "${fields[@]}" --format json \
  | jq -r '"Created \(.title) with fields:", (.fields[] | select(.value != null) | "  \(.label)")'
