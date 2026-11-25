#!/usr/bin/env bash
# One-time (re-runnable) provisioning:
#   1. creates the SSH key in keys/
#   2. creates the DigitalOcean droplet (region from config.env) + cloud firewall
#   3. installs and hardens WireGuard on it
#   4. creates a profile for everyone in users.txt
#
# Re-running is safe: an existing droplet, keys and users are reused.

source "$(dirname "$0")/lib/common.sh"
load_token
need jq "Install with: brew install jq"

# ---- 1. SSH key -------------------------------------------------------------
mkdir -p "$ROOT/keys" "$STATE_DIR"
chmod 700 "$ROOT/keys" "$STATE_DIR"
if [[ ! -f "$KEY_FILE" ]]; then
  info "Generating SSH key keys/vpn_ed25519"
  ssh-keygen -q -t ed25519 -N "" -C "vpn-admin" -f "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"
FINGERPRINT="$(ssh-keygen -E md5 -lf "$KEY_FILE.pub" | awk '{print $2}' | sed 's/^MD5://')"

if ! doctl compute ssh-key get "$FINGERPRINT" >/dev/null 2>&1; then
  info "Uploading public key to DigitalOcean as '$DO_SSH_KEY_NAME'"
  doctl compute ssh-key import "$DO_SSH_KEY_NAME" --public-key-file "$KEY_FILE.pub" >/dev/null
fi
ok "SSH key ready"

# ---- 2. Droplet + firewall --------------------------------------------------
doctl compute tag create "$TAG" >/dev/null 2>&1 || true

DROPLET_ID="$(doctl compute droplet list --format ID,Name --no-header | awk -v n="$DROPLET_NAME" '$2==n {print $1; exit}')"
if [[ -z "$DROPLET_ID" ]]; then
  info "Creating droplet $DROPLET_NAME ($SIZE, $REGION, $IMAGE) — takes about a minute"
  DROPLET_ID="$(doctl compute droplet create "$DROPLET_NAME" \
      --region "$REGION" --size "$SIZE" --image "$IMAGE" \
      --ssh-keys "$FINGERPRINT" --tag-names "$TAG" \
      --enable-monitoring --wait --format ID --no-header)"
else
  ok "Droplet $DROPLET_NAME already exists (id $DROPLET_ID)"
  [[ "$(droplet_status)" == "active" ]] || doctl compute droplet-action power-on "$DROPLET_ID" --wait >/dev/null
fi
SERVER_IP="$(doctl compute droplet get "$DROPLET_ID" --format PublicIPv4 --no-header)"
[[ -n "$SERVER_IP" ]] || die "Could not read the droplet's public IP."
save_state
ok "Server IP: $SERVER_IP"

ANY="address:0.0.0.0/0,address:::/0"
IN_RULES="protocol:tcp,ports:22,$ANY protocol:udp,ports:$WG_PORT,$ANY protocol:icmp,$ANY"
[[ "$CLIENT_PORT" == "$WG_PORT" ]] || IN_RULES="$IN_RULES protocol:udp,ports:$CLIENT_PORT,$ANY"
OUT_RULES="protocol:tcp,ports:all,$ANY protocol:udp,ports:all,$ANY protocol:icmp,$ANY"
FW_ID="$(doctl compute firewall list -o json | jq -r --arg n "$FIREWALL_NAME" '.[] | select(.name==$n) | .id' | head -1)"
if [[ -z "$FW_ID" ]]; then
  info "Creating cloud firewall $FIREWALL_NAME (SSH + WireGuard only)"
  doctl compute firewall create --name "$FIREWALL_NAME" \
    --inbound-rules "$IN_RULES" --outbound-rules "$OUT_RULES" --tag-names "$TAG" >/dev/null
else
  doctl compute firewall update "$FW_ID" --name "$FIREWALL_NAME" \
    --inbound-rules "$IN_RULES" --outbound-rules "$OUT_RULES" --tag-names "$TAG" >/dev/null
fi
ok "Cloud firewall in place"

# ---- 3. Install WireGuard ---------------------------------------------------
wait_for_ssh
info "Installing WireGuard on the server"
vpn_scp "$ROOT/server/install.sh" /root/install.sh
vpn_scp "$ROOT/server/vpn-user" /usr/local/sbin/vpn-user
vpn_scp "$ROOT/server/vpn-status" /usr/local/sbin/vpn-status
vpn_scp "$ROOT/server/vpn-usage" /usr/local/sbin/vpn-usage
vpn_scp "$ROOT/server/vpn-block" /usr/local/sbin/vpn-block
vpn_ssh "chmod 700 /root/install.sh /usr/local/sbin/vpn-user /usr/local/sbin/vpn-status /usr/local/sbin/vpn-usage /usr/local/sbin/vpn-block && \
  SERVER_IP=$(printf %q "$SERVER_IP") WG_PORT=$(printf %q "$WG_PORT") CLIENT_PORT=$(printf %q "$CLIENT_PORT") WG_NET=$(printf %q "$WG_NET") \
  CLIENT_DNS=$(printf %q "$CLIENT_DNS") USAGE_RETENTION_DAYS=$(printf %q "${USAGE_RETENTION_DAYS:-30}") LOG_WEBSITES=$(printf %q "${LOG_WEBSITES:-no}") SITE_RETENTION_DAYS=$(printf %q "${SITE_RETENTION_DAYS:-30}") bash /root/install.sh"
ok "WireGuard installed and running"

# ---- 4. Profiles ------------------------------------------------------------
if [[ -f "$USERS_FILE" ]]; then
  "$ROOT/create-profiles.sh"
fi

echo
ok "Setup complete. Server: $SERVER_IP   Profiles: $PROFILES_DIR"
echo "    Next: ./status.sh   ./add-user.sh   ./manage.sh"
