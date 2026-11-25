#!/usr/bin/env bash
# Stop the VPN. All users are disconnected until ./start.sh.
#   ./stop.sh              stop WireGuard only (server stays up)
#   ./stop.sh --poweroff   also shut the droplet down
#
# Note: DigitalOcean bills a powered-off droplet at the full rate.
# To stop paying, use ./destroy.sh.

source "$(dirname "$0")/lib/common.sh"
load_state

vpn_ssh "systemctl stop wg-quick@wg0"
ok "WireGuard stopped — users are disconnected"

if [[ "${1:-}" == "--poweroff" ]]; then
  load_token
  info "Shutting the droplet down"
  doctl compute droplet-action shutdown "$DROPLET_ID" --wait >/dev/null
  ok "Droplet is off (still billed; ./start.sh brings it back)"
fi
