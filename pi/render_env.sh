#!/usr/bin/env bash
# Render pi/.env.tpl from 1Password and swap it in as the Pi's ~/SPAN/pi/.env.
# Run on the laptop (needs `op` unlocked); the Pi has no 1Password.
#
#   pi/render_env.sh [nico@phrpi.local]
#
# Writes .env.new on the Pi (mode 600), then prints key NAMES only: keys the
# swap would drop, keys it would add, and same/DIFFERS for each shared key.
# Asks before swapping; keeps the old file as .env.bak. Restarts nothing.
set -euo pipefail

HOST="${1:-nico@phrpi.local}"
TPL="$(cd "$(dirname "$0")" && pwd)/.env.tpl"
REMOTE_DIR='~/SPAN/pi'

# Render locally first so a bad reference fails before anything touches the Pi.
rendered="$(op inject -i "$TPL")"
printf '%s\n' "$rendered" | ssh "$HOST" "umask 077 && cat > $REMOTE_DIR/.env.new"
unset rendered

ssh "$HOST" "cd $REMOTE_DIR && bash -s" <<'REMOTE'
set -euo pipefail
keys() { sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$1" | sort -u; }
dropped=$(comm -23 <(keys .env) <(keys .env.new))
added=$(comm -13 <(keys .env) <(keys .env.new))
echo "Would drop: ${dropped:-(none)}" | tr '\n' ' '; echo
echo "Would add:  ${added:-(none)}" | tr '\n' ' '; echo
for k in $(comm -12 <(keys .env) <(keys .env.new)); do
  if [ "$(grep -m1 "^$k=" .env)" = "$(grep -m1 "^$k=" .env.new)" ]; then
    echo "  same     $k"
  else
    echo "  DIFFERS  $k"
  fi
done
REMOTE

read -r -p "Swap in .env.new? [y/N] " answer
if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
  ssh "$HOST" "cd $REMOTE_DIR && cp -p .env .env.bak && mv .env.new .env && chmod 600 .env"
  echo "Swapped. Old file kept as $REMOTE_DIR/.env.bak. Nothing restarted: a container"
  echo "picks up changed values when recreated (docker compose up -d --no-deps SERVICE)."
else
  ssh "$HOST" "rm -f $REMOTE_DIR/.env.new"
  echo "Left .env untouched; removed .env.new."
fi
