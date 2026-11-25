#!/usr/bin/env bash
# Download the server's WireGuard config (server keys + all users) to backups/.
# With this file the VPN can be rebuilt on a new server via ./restore.sh.

source "$(dirname "$0")/lib/common.sh"
load_state

mkdir -p "$BACKUPS_DIR"; chmod 700 "$BACKUPS_DIR"
out="$BACKUPS_DIR/wireguard-$(date +%Y%m%d-%H%M%S).tar.gz"
vpn_ssh "tar -C /etc -czf - wireguard" > "$out"
chmod 600 "$out"
tar -tzf "$out" >/dev/null || die "Backup archive is corrupt: $out"
ok "Backup saved: $out"
