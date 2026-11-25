#!/usr/bin/env bash
# Temporary SOCKS5 proxy on its own small droplet (separate from the VPN server).
#
#   ./socks.sh up        create the droplet and start the proxy
#   ./socks.sh status    show the address and who may use it
#   ./socks.sh allow     let the network you are on now use it as well (or: allow 1.2.3.4)
#   ./socks.sh down      delete the droplet and its firewall (billing stops)
#
# The proxy has no password (Firefox cannot send one to a SOCKS proxy), so the cloud
# firewall only lets the listed public addresses reach it. Everyone else is dropped.

source "$(dirname "$0")/lib/common.sh"
load_token
need jq "Install with: brew install jq"

S_NAME="socks-test-01"
S_SIZE="s-1vcpu-1gb"
S_TAG="socks-test"
S_FW="socks-test-fw"
S_PORTS="443 80 1080"   # the proxy listens on all of these; 443/80 slip through VDI/guest egress that blocks 1080
S_STATE="$STATE_DIR/socks.env"

S_ID=""; S_IP=""; S_ALLOWED=""
# shellcheck disable=SC1090
[[ -f "$S_STATE" ]] && source "$S_STATE"

save() { printf 'S_ID="%s"\nS_IP="%s"\nS_ALLOWED="%s"\n' "$S_ID" "$S_IP" "$S_ALLOWED" > "$S_STATE"; }
my_ip() {
  local ip
  ip="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me)"
  [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "Could not work out this network's public address."
  printf '%s' "$ip"
}
s_ssh() { ssh -i "$KEY_FILE" "${SSH_OPTS[@]}" "root@$S_IP" "$@"; }

firewall() {
  local rules="" a p id
  for a in $S_ALLOWED; do
    rules+="protocol:tcp,ports:22,address:$a/32 "
    for p in $S_PORTS; do rules+="protocol:tcp,ports:$p,address:$a/32 "; done
  done
  local out="protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0"
  id="$(doctl compute firewall list -o json | jq -r --arg n "$S_FW" '.[] | select(.name==$n) | .id' | head -1)"
  if [[ -z "$id" ]]; then
    doctl compute firewall create --name "$S_FW" --tag-names "$S_TAG" \
      --inbound-rules "${rules% }" --outbound-rules "$out" >/dev/null
  else
    doctl compute firewall update "$id" --name "$S_FW" --tag-names "$S_TAG" \
      --inbound-rules "${rules% }" --outbound-rules "$out" >/dev/null
  fi
}

show() {
  echo "    Proxy address : $S_IP"
  echo "    Ports         : $S_PORTS   (SOCKS v5, no username or password; try 443 first from a VDI)"
  echo "    Usable from   : $S_ALLOWED"
}

case "${1:-status}" in
  up)
    FP="$(ssh-keygen -E md5 -lf "$KEY_FILE.pub" | awk '{print $2}' | sed 's/^MD5://')"
    doctl compute tag create "$S_TAG" >/dev/null 2>&1 || true
    S_ID="$(doctl compute droplet list --format ID,Name --no-header | awk -v n="$S_NAME" '$2==n {print $1; exit}')"
    if [[ -z "$S_ID" ]]; then
      info "Creating droplet $S_NAME ($S_SIZE, $REGION)"
      S_ID="$(doctl compute droplet create "$S_NAME" --region "$REGION" --size "$S_SIZE" --image "$IMAGE" \
        --ssh-keys "$FP" --tag-name "$S_TAG" --wait --format ID --no-header)"
    fi
    S_IP="$(doctl compute droplet get "$S_ID" --format PublicIPv4 --no-header)"
    [[ -n "$S_ALLOWED" ]] || S_ALLOWED="$(my_ip)"
    save
    firewall; ok "Cloud firewall in place"
    SERVER_IP="$S_IP" wait_for_ssh
    info "Installing the proxy"
    s_ssh "bash -s" <<EOF
set -e
export DEBIAN_FRONTEND=noninteractive
cloud-init status --wait >/dev/null 2>&1 || true
apt-get update -qq
apt-get install -y -qq dante-server >/dev/null
IF="\$(ip -4 route show default | awk '{print \$5; exit}')"
INTERNAL=""
for p in $S_PORTS; do INTERNAL="\${INTERNAL}internal: 0.0.0.0 port = \$p"\$'\n'; done
cat > /etc/danted.conf <<CONF
logoutput: syslog
\${INTERNAL}external: \$IF
socksmethod: none
clientmethod: none
user.privileged: root
user.unprivileged: nobody
client pass { from: 0.0.0.0/0 to: 0.0.0.0/0 log: error }
socks pass { from: 0.0.0.0/0 to: 0.0.0.0/0 log: connect error }
CONF
systemctl enable -q danted
systemctl restart danted
systemctl is-active danted
EOF
    ok "Proxy is running"; show ;;
  status)
    [[ -n "$S_ID" ]] || { echo "No proxy droplet. Create it with ./socks.sh up"; exit 0; }
    doctl compute droplet get "$S_ID" --format Name,Region,Memory,Status,PublicIPv4
    show ;;
  allow)
    [[ -n "$S_ID" ]] || die "No proxy droplet. Run ./socks.sh up first."
    NEW="${2:-$(my_ip)}"
    [[ "$NEW" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "'$NEW' is not an IPv4 address."
    [[ " $S_ALLOWED " == *" $NEW "* ]] || S_ALLOWED="$S_ALLOWED $NEW"
    save; firewall; ok "Allowed $NEW"; show ;;
  down)
    [[ -n "$S_ID" ]] && doctl compute droplet delete "$S_ID" --force
    FW="$(doctl compute firewall list -o json | jq -r --arg n "$S_FW" '.[] | select(.name==$n) | .id' | head -1)"
    [[ -n "$FW" ]] && doctl compute firewall delete "$FW" --force
    doctl compute tag delete "$S_TAG" --force >/dev/null 2>&1 || true
    [[ -n "$S_IP" ]] && ssh-keygen -R "$S_IP" -f "$STATE_DIR/known_hosts" >/dev/null 2>&1 || true
    rm -f "$S_STATE"
    ok "Proxy droplet and firewall deleted" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
