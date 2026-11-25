#!/usr/bin/env bash
# Web management portal (runs in Docker on this machine, reachable on the LAN).
#
#   ./portal.sh start      build and start the portal
#   ./portal.sh stop       stop it
#   ./portal.sh restart    rebuild and restart
#   ./portal.sh status     is it running, and at which address
#   ./portal.sh logs       follow the portal's log
#   ./portal.sh password   show the starting password of the "admin" account
#   ./portal.sh new-password   locked out? give the "admin" account a new password and restart
#
# People sign in with their own portal account (Administration tab in the portal).
# The first account is "admin"; PORTAL_PASSWORD in .state/portal.env is its starting
# password. Changing it in the portal does not change this file, so if "password" no
# longer works, use "new-password".

source "$(dirname "$0")/lib/common.sh"
load_state
need docker "Install Docker Desktop and start it."

NAME="vpn-portal"
ENV_FILE="$STATE_DIR/portal.env"

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
PORTAL_PORT=8844
PORTAL_PASSWORD=$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 20)
EOF
fi
chmod 600 "$ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"

urls() {
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  echo "    This machine : http://localhost:$PORTAL_PORT"
  [[ -n "$ip" ]] && echo "    On the LAN   : http://$ip:$PORTAL_PORT"
  echo "    Sign in as   : admin (starting password: ./portal.sh password)"
}

start() {
  info "Building the portal image"
  docker build -q -t "$NAME" "$ROOT/portal" >/dev/null
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped \
    -p "0.0.0.0:$PORTAL_PORT:8080" \
    -e PORTAL_PASSWORD="$PORTAL_PASSWORD" \
    -e PORTAL_LOG_DAYS="${USAGE_RETENTION_DAYS:-30}" \
    -e BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}" \
    -e TZ="$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')" \
    -v "$ROOT:/data" "$NAME" >/dev/null
  local i
  for i in $(seq 1 30); do
    curl -fs -o /dev/null "http://localhost:$PORTAL_PORT/" && { ok "Portal is running"; urls; return; }
    sleep 1
  done
  docker logs --tail 30 "$NAME"
  die "The portal did not start."
}

case "${1:-status}" in
  start|restart) start ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 && ok "Portal stopped" || echo "Portal was not running." ;;
  status)
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == "true" ]]; then
      ok "Portal is running"; urls
    else
      echo "Portal is not running. Start it with ./portal.sh start"
    fi ;;
  logs) docker logs -f --tail 100 "$NAME" ;;
  password) echo "$PORTAL_PASSWORD" ;;
  new-password)
    umask 077
    printf 'PORTAL_PORT=%s\nPORTAL_PASSWORD=%s\n' "$PORTAL_PORT" "$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 20)" > "$ENV_FILE"
    source "$ENV_FILE"; start
    echo "    Account      : admin"
    echo "    New password : $PORTAL_PASSWORD" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
