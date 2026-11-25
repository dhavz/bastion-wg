#!/usr/bin/env bash
# Health check: droplet, VPN service, load, bandwidth used, and users.

source "$(dirname "$0")/lib/common.sh"
load_token
load_state

info "Droplet"
doctl compute droplet get "$DROPLET_ID" --format Name,Region,Memory,VCPUs,Status,PublicIPv4

if [[ "$(droplet_status)" != "active" ]]; then
  warn "Droplet is not running. Use ./start.sh"
  exit 1
fi

echo
info "Server"
vpn_ssh 'bash -s' <<'EOF'
source /etc/wireguard/vpn.env
wan="$(ip -4 route show default | awk '{print $5; exit}')"
printf 'WireGuard service : %s\n' "$(systemctl is-active wg-quick@wg0)"
printf 'Listening on      : %s, UDP %s (profiles) and %s\n' "$SERVER_IP" "${CLIENT_PORT:-$WG_PORT}" "$WG_PORT"
printf 'Uptime / load     : %s\n' "$(uptime | sed 's/^ *//')"
printf 'Memory            : %s\n' "$(free -h | awk '/^Mem/ {print $3 " used of " $2}')"
printf 'Disk              : %s\n' "$(df -h / | awk 'NR==2 {print $3 " used of " $2 " (" $5 ")"}')"
printf 'Traffic since boot: %s out, %s in (DO counts outbound against the transfer allowance)\n' \
  "$(numfmt --to=iec --suffix=B < /sys/class/net/$wan/statistics/tx_bytes)" \
  "$(numfmt --to=iec --suffix=B < /sys/class/net/$wan/statistics/rx_bytes)"
[ -f /var/run/reboot-required ] && echo 'Note              : a reboot is pending for security updates (happens automatically at 08:30 UTC)'
echo
vpn-user list
EOF
