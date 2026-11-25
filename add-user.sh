#!/usr/bin/env bash
# Interactive: create one VPN user and download their profile.
#   ./add-user.sh            (asks for everything)
#   ./add-user.sh alice      (name given, still asks for optional email)

source "$(dirname "$0")/lib/common.sh"
load_state

raw="${1:-}"
if [[ -z "$raw" ]]; then
  read -r -p "New user's name (e.g. alice): " raw
fi
name="$(sanitize_name "$raw")"
[[ -n "$name" ]] || die "Name must contain letters or digits."
[[ "$name" == "$raw" ]] || info "Using profile name '$name'"

if vpn_ssh "vpn-user exists $name" </dev/null; then
  warn "User '$name' already exists."
  read -r -p "Re-download their existing profile? [Y/n] " a
  [[ "${a:-y}" =~ ^[Yy]$ ]] || exit 0
else
  email=""
  if [[ -t 0 ]]; then read -r -p "Email for users.txt (optional, Enter to skip): " email; fi
  vpn_ssh "vpn-user add $name" </dev/null
  if ! grep -qiE "^${name}[: ]" "$USERS_FILE" 2>/dev/null; then
    # keep users.txt as the roster
    [[ -s "$USERS_FILE" && -n "$(tail -c1 "$USERS_FILE")" ]] && echo >> "$USERS_FILE"
    echo "$(tr '[:lower:]' '[:upper:]' <<<"${name:0:1}")${name:1}: $email" >> "$USERS_FILE"
  fi
fi

fetch_profile "$name"
ok "Profile saved: profiles/$name.conf   QR code: profiles/$name.png"

if [[ -t 0 ]]; then
  read -r -p "Show QR code now (for the phone app)? [y/N] " a
  [[ "${a:-n}" =~ ^[Yy]$ ]] && vpn_ssh "vpn-user qr $name"
fi
echo "Send profiles/$name.conf and docs/VPN-User-Guide.pdf to the user."
