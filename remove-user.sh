#!/usr/bin/env bash
# Interactive: revoke a VPN user. Their profile stops working immediately.
#   ./remove-user.sh [name]

source "$(dirname "$0")/lib/common.sh"
load_state

raw="${1:-}"
if [[ -z "$raw" ]]; then
  vpn_ssh "vpn-user list" </dev/null
  echo
  read -r -p "User to remove: " raw
fi
name="$(sanitize_name "$raw")"
[[ -n "$name" ]] || die "No name given."
vpn_ssh "vpn-user exists $name" </dev/null || die "No such user '$name'."

read -r -p "Revoke VPN access for '$name'? This cannot be undone. [y/N] " a
[[ "${a:-n}" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }

vpn_ssh "vpn-user remove $name"
rm -f "$PROFILES_DIR/$name.conf" "$PROFILES_DIR/$name.png"
if [[ -f "$USERS_FILE" ]]; then
  grep -viE "^${name}[: ]" "$USERS_FILE" > "$USERS_FILE.tmp" || true
  mv "$USERS_FILE.tmp" "$USERS_FILE"
fi
ok "Removed '$name' from the server, profiles/ and users.txt"
