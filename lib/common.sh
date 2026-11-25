#!/usr/bin/env bash
# Shared helpers. Sourced by every script in the project root.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.state"
STATE_FILE="$STATE_DIR/server.env"
KEY_FILE="$ROOT/keys/vpn_ed25519"
PROFILES_DIR="$ROOT/profiles"
BACKUPS_DIR="$ROOT/backups"
USERS_FILE="$ROOT/users.txt"

# shellcheck disable=SC1091
source "$ROOT/config.env"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed. $2"; }

load_token() {
  [[ -f "$ROOT/DOToken" ]] || die "DOToken file not found in $ROOT"
  DIGITALOCEAN_ACCESS_TOKEN="$(tr -d '[:space:]' < "$ROOT/DOToken")"
  export DIGITALOCEAN_ACCESS_TOKEN
  need doctl "Install with: brew install doctl"
}

load_state() {
  [[ -f "$STATE_FILE" ]] || die "No server yet. Run ./setup.sh first."
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  [[ -n "${SERVER_IP:-}" && -n "${DROPLET_ID:-}" ]] || die "$STATE_FILE is incomplete. Re-run ./setup.sh."
}

save_state() {
  mkdir -p "$STATE_DIR"
  cat > "$STATE_FILE" <<EOF
DROPLET_ID="$DROPLET_ID"
SERVER_IP="$SERVER_IP"
EOF
}

SSH_OPTS=(
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
  -o "UserKnownHostsFile=$STATE_DIR/known_hosts"
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o LogLevel=ERROR
)

# vpn_ssh <remote command...>   Run a command on the server as root.
vpn_ssh() { ssh -i "$KEY_FILE" "${SSH_OPTS[@]}" "root@$SERVER_IP" "$@"; }

# vpn_scp <local> <remote-path>  Copy a file to the server.
vpn_scp() { scp -q -i "$KEY_FILE" "${SSH_OPTS[@]}" "$1" "root@$SERVER_IP:$2"; }

wait_for_ssh() {
  info "Waiting for SSH on $SERVER_IP ..."
  local i
  for i in $(seq 1 60); do
    if ssh -i "$KEY_FILE" "${SSH_OPTS[@]}" -o BatchMode=yes "root@$SERVER_IP" true 2>/dev/null; then ok "SSH is up"; return 0; fi
    sleep 5
  done
  die "Server did not accept SSH within 5 minutes."
}

droplet_status() { doctl compute droplet get "$DROPLET_ID" --format Status --no-header; }

# sanitize_name <raw>  ->  lowercase profile name, [a-z0-9_-], max 15 chars
# (15 is the Linux interface-name limit; the profile filename becomes the tunnel name).
sanitize_name() {
  local n
  n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  printf '%s' "${n:0:15}"
}

# fetch_profile <name>  Download <name>.conf and <name>.png (QR code) into profiles/.
fetch_profile() {
  local name="$1"
  mkdir -p "$PROFILES_DIR"
  chmod 700 "$PROFILES_DIR"
  vpn_ssh "vpn-user show $name" > "$PROFILES_DIR/$name.conf"
  vpn_ssh "vpn-user qr-png $name" > "$PROFILES_DIR/$name.png"
  chmod 600 "$PROFILES_DIR/$name.conf" "$PROFILES_DIR/$name.png"
}
