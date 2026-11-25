#!/usr/bin/env bash
# Restore a backup onto the current server (e.g. after rebuilding with ./setup.sh).
#   ./restore.sh                      newest backup
#   ./restore.sh backups/<file>.tar.gz
#
# If the server IP changed since the backup, existing user profiles are rewritten
# to the new IP and re-downloaded — users must then import the new .conf.

source "$(dirname "$0")/lib/common.sh"
load_state

file="${1:-$(ls -t "$BACKUPS_DIR"/wireguard-*.tar.gz 2>/dev/null | head -1)}"
[[ -n "$file" && -f "$file" ]] || die "No backup found. Usage: ./restore.sh backups/<file>.tar.gz"

read -r -p "Replace the server's WireGuard config with $(basename "$file")? [y/N] " a
[[ "${a:-n}" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }

vpn_ssh "systemctl stop wg-quick@wg0; tar -C /etc -xzf - && \
  sed -i 's/^SERVER_IP=.*/SERVER_IP=\"$SERVER_IP\"/' /etc/wireguard/vpn.env && \
  sed -i -E 's/^Endpoint = .*/Endpoint = $SERVER_IP:$CLIENT_PORT/' /etc/wireguard/clients/*.conf 2>/dev/null; \
  systemctl start wg-quick@wg0" < "$file"
ok "Restored. Re-downloading profiles"

for name in $(vpn_ssh "ls /etc/wireguard/clients 2>/dev/null | sed 's/\.conf\$//'"); do
  fetch_profile "$name"; ok "profiles/$name.conf"
done
