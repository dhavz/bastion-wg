#!/usr/bin/env bash
# Start the VPN. Powers the droplet on first if it was shut down.

source "$(dirname "$0")/lib/common.sh"
load_token
load_state

if [[ "$(droplet_status)" != "active" ]]; then
  info "Droplet is off — powering on"
  doctl compute droplet-action power-on "$DROPLET_ID" --wait >/dev/null
fi
wait_for_ssh
vpn_ssh "systemctl enable -q wg-quick@wg0 && systemctl start wg-quick@wg0"
ok "VPN is running on $SERVER_IP (UDP $CLIENT_PORT and $WG_PORT)"
