#!/usr/bin/env bash
# Creates a VPN profile for every person in users.txt who doesn't have one yet,
# and downloads all of them into profiles/.
#
# users.txt format, one per line:   Name: email@example.com
# (the colon is optional; only the name is sent to the server)

source "$(dirname "$0")/lib/common.sh"
load_state
[[ -f "$USERS_FILE" ]] || die "users.txt not found"

names=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
  raw="$(awk '{print $1}' <<<"$line")"
  name="$(sanitize_name "$raw")"
  [[ -n "$name" ]] || { warn "skipping unreadable line: $line"; continue; }
  if [[ " ${names[*]-} " == *" $name "* ]]; then
    warn "duplicate name '$name' in users.txt — skipped (give them distinct first words)"
    continue
  fi
  names+=("$name")
done < "$USERS_FILE"

((${#names[@]})) || die "No users found in users.txt"
info "Users in users.txt: ${names[*]}"

# One SSH session creates everything that is missing.
vpn_ssh "for n in ${names[*]}; do vpn-user exists \$n || vpn-user add \$n; done"

for name in "${names[@]}"; do
  fetch_profile "$name"
  ok "profiles/$name.conf"
done
info "${#names[@]} profiles are in $PROFILES_DIR (each .conf is a secret — send it only to its owner)"
