#!/usr/bin/env bash
# End-to-end test of a user profile from this machine, inside a throwaway Docker
# container (your own network connection is not touched).
#
#   ./test-profile.sh <name>
#
# The container imports profiles/<name>.conf exactly as a user would, connects,
# and checks that traffic exits from the VPN server.
# Don't run this for a profile whose owner is connected right now: two devices on
# one profile interrupt each other.

source "$(dirname "$0")/lib/common.sh"
load_state
need docker "Install Docker Desktop and start it."

name="$(sanitize_name "${1:-}")"
[[ -n "$name" ]] || die "Usage: ./test-profile.sh <name>"
conf="$PROFILES_DIR/$name.conf"
[[ -f "$conf" ]] || die "No such profile: $conf"

info "Testing profiles/$name.conf from a Docker container"
# The DNS server named in the profile; the container switches to it once the tunnel is up,
# as the WireGuard app would.
dns="$(awk -F'[=,]' '/^DNS/ {gsub(/ /, "", $2); print $2; exit}' "$conf")"
docker run --rm -i --privileged --dns 1.1.1.1 \
  --sysctl net.ipv6.conf.all.disable_ipv6=0 \
  -e EXPECT_IP="$SERVER_IP" -e PROFILE_DNS="${dns:-1.1.1.1}" alpine:3.22 sh -s <<EOF
set -u
apk add -q --no-cache wireguard-tools iptables ip6tables curl bash >/dev/null 2>&1 || { echo "FAIL: could not install tools in the container"; exit 1; }
mkdir -p /etc/wireguard && umask 077
# The DNS line needs resolvconf, which containers lack; DNS is set with --dns instead
# and still travels through the tunnel.
grep -v '^DNS' > /etc/wireguard/vpn.conf <<'CONF'
$(cat "$conf")
CONF

pass=0; fail=0
check() { if [ "\$2" = ok ]; then pass=\$((pass+1)); echo "  PASS  \$1"; else fail=\$((fail+1)); echo "  FAIL  \$1"; fi; }

before="\$(curl -4 -s --max-time 10 https://ifconfig.me || true)"
echo "  Public IP before connecting : \${before:-unknown}"

wg-quick up vpn >/tmp/up.log 2>&1 || { cat /tmp/up.log; echo "  FAIL  tunnel did not come up"; exit 1; }
echo "nameserver \$PROFILE_DNS" > /etc/resolv.conf
sleep 2

after="\$(curl -4 -s --max-time 15 https://ifconfig.me || true)"
echo "  Public IP after connecting  : \${after:-none}"
echo "  Connected to                : \$(wg show vpn endpoints | awk '{print \$2}')"

[ -n "\$(wg show vpn latest-handshakes | awk '\$2>0')" ] && r=ok || r=no;         check "WireGuard handshake completed" \$r
[ "\$after" = "\$EXPECT_IP" ] && r=ok || r=no;                                   check "Exit IP is the VPN server (\$EXPECT_IP)" \$r
[ -n "\$before" ] && [ "\$before" != "\$after" ] && r=ok || r=no;                 check "Exit IP changed from the local one" \$r
geo="\$(curl -4 -s --max-time 15 https://ipinfo.io/city), \$(curl -4 -s --max-time 15 https://ipinfo.io/country)"
[ -n "\$geo" ] && [ "\$geo" != ", " ] && r=ok || r=no;                              check "Server location reported as: \$geo" \$r
curl -4 -s -o /dev/null --max-time 15 https://www.google.com && r=ok || r=no;    check "DNS lookup (via \$PROFILE_DNS) and HTTPS browsing through the tunnel" \$r
curl -6 -s -o /dev/null --max-time 6 https://ifconfig.me && r=no || r=ok;        check "IPv6 cannot leak around the VPN" \$r
spd="\$(curl -4 -sL -o /dev/null --max-time 30 -w '%{speed_download}' https://proof.ovh.net/files/100Mb.dat || echo 0)"
mbps="\$(awk -v s="\$spd" 'BEGIN{printf "%.0f", s*8/1000000}')"
[ "\$mbps" -ge 5 ] && r=ok || r=no;                                              check "Download speed through the tunnel: \$mbps Mbps" \$r

wg-quick down vpn >/dev/null 2>&1
echo
echo "  \$pass passed, \$fail failed"
[ "\$fail" -eq 0 ]
EOF
rc=$?
echo
info "What the server saw"
vpn_ssh "vpn-user list" </dev/null | grep -E "^(USER|$name) "
exit $rc
