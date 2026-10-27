#!/usr/bin/env bash
#
# Create-or-update the InfluxDB downsampling tasks defined in influx_tasks/*.flux.
#
# Idempotent: safe to run any number of times. A task that does not exist is
# created; one that does is updated in place (same task ID, so its run history
# is preserved) and forced back to `active`.
#
# Run this on the Pi, from the pi/ directory:
#
#   ./provision_influx_tasks.sh
#   ./provision_influx_tasks.sh --dry-run
#
# Auth: the influxdb container ships an active `influx` CLI config holding a
# valid admin token, so no credentials are needed here by default. Override with
# INFLUXDB_TOKEN / INFLUXDB_ORG in the environment if that ever changes, e.g.
#   set -a; . ./.env; set +a; ./provision_influx_tasks.sh
# No secret is read from disk or echoed by this script.

set -euo pipefail

CONTAINER="${INFLUXDB_CONTAINER:-influxdb}"
ORG="${INFLUXDB_ORG:-home}"
TASK_DIR="$(cd "$(dirname "$0")" && pwd)/influx_tasks"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

# Flags must sit immediately after the subcommand: the influx CLI stops parsing
# flags at the first positional argument (the '-' stdin marker), so these cannot
# be appended at the end.
AUTH=(--org "$ORG")
# `influx task update` has no --org flag (the task ID is global); passing one
# fails with "flag provided but not defined: -org" (hit 2026-10-27).
UPDATE_AUTH=()
if [[ -n "${INFLUXDB_TOKEN:-}" ]]; then
  AUTH+=(--token "$INFLUXDB_TOKEN")
  UPDATE_AUTH+=(--token "$INFLUXDB_TOKEN")
fi

if ! docker exec "$CONTAINER" true 2>/dev/null; then
  echo "error: container '$CONTAINER' is not running (start the stack first)" >&2
  exit 1
fi

shopt -s nullglob
files=("$TASK_DIR"/*.flux)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "error: no .flux files in $TASK_DIR" >&2
  exit 1
fi

# One listing for all lookups. Tab-separated: ID<TAB>Name<TAB>...
existing="$(docker exec "$CONTAINER" influx task list "${AUTH[@]}" --hide-headers || true)"

for f in "${files[@]}"; do
  base="$(basename "$f" .flux)"

  # The task's real identity is the name inside `option task`, not the filename.
  # Bail if they disagree — otherwise renaming a file silently creates a second
  # task while the original keeps running, and both write the same points.
  declared="$(sed -n 's/.*option task[[:space:]]*=[[:space:]]*{[[:space:]]*name:[[:space:]]*"\([^"]*\)".*/\1/p' "$f")"
  if [[ -z "$declared" ]]; then
    echo "error: $f has no 'option task = {name: ...}'" >&2
    exit 1
  fi
  if [[ "$declared" != "$base" ]]; then
    echo "error: $f declares task name '$declared' but is named '$base.flux'" >&2
    exit 1
  fi

  id="$(printf '%s\n' "$existing" | awk -F'\t' -v n="$declared" '$2 == n { print $1; exit }')"

  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ -n "$id" ]]; then
      echo "would UPDATE $declared (id $id)"
    else
      echo "would CREATE $declared"
    fi
    continue
  fi

  if [[ -n "$id" ]]; then
    # `-` (stdin) is rejected by `task update` ("unknown command '-'"); --file
    # on the exec'd stdin works.
    docker exec -i "$CONTAINER" influx task update "${UPDATE_AUTH[@]}" \
      --id "$id" --status active --file /dev/stdin <"$f" >/dev/null
    echo "updated $declared (id $id)"
  else
    docker exec -i "$CONTAINER" influx task create "${AUTH[@]}" - <"$f" >/dev/null
    echo "created $declared"
  fi
done

echo
docker exec "$CONTAINER" influx task list "${AUTH[@]}"
