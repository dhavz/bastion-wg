#!/usr/bin/env bash
# Restart WireGuard (users reconnect automatically within a few seconds).
#   ./restart.sh            restart the VPN service
#   ./restart.sh --reboot   reboot the whole server

source "$(dirname "$0")/lib/common.sh"
load_state

if [[ "${1:-}" == "--reboot" ]]; then
  info "Rebooting server"
  vpn_ssh "systemctl reboot" || true
  sleep 15
  wait_for_ssh
else
  vpn_ssh "systemctl restart wg-quick@wg0"
fi
vpn_ssh "systemctl is-active wg-quick@wg0" >/dev/null && ok "VPN is running"
