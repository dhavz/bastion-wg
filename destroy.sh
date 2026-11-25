#!/usr/bin/env bash
# PERMANENTLY delete the droplet and its cloud firewall. Billing stops.
# A final backup is taken first. All user profiles stop working.

source "$(dirname "$0")/lib/common.sh"
load_token
load_state

warn "This deletes droplet '$DROPLET_NAME' ($SERVER_IP) and firewall '$FIREWALL_NAME'."
read -r -p "Type the droplet name to confirm: " a
[[ "$a" == "$DROPLET_NAME" ]] || { echo "Cancelled."; exit 0; }

if [[ "$(droplet_status)" == "active" ]]; then
  "$ROOT/backup.sh" || warn "Backup failed — continuing is your call."
  read -r -p "Proceed with deletion? [y/N] " b
  [[ "${b:-n}" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
fi

doctl compute droplet delete "$DROPLET_ID" --force
FW_ID="$(doctl compute firewall list -o json | jq -r --arg n "$FIREWALL_NAME" '.[] | select(.name==$n) | .id' | head -1)"
[[ -n "$FW_ID" ]] && doctl compute firewall delete "$FW_ID" --force
rm -f "$STATE_FILE" "$STATE_DIR/known_hosts"
ok "Server deleted. Local keys, profiles and backups were left in place."
