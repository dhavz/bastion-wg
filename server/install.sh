#!/usr/bin/env bash
# Runs ON THE SERVER as root (uploaded and executed by ./setup.sh).
# Safe to re-run: existing WireGuard keys and peers are kept.
#
# Required env: SERVER_IP WG_PORT CLIENT_PORT WG_NET CLIENT_DNS

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

: "${SERVER_IP:?}" "${WG_PORT:?}" "${CLIENT_PORT:?}" "${WG_NET:?}" "${CLIENT_DNS:?}"
WG_NET6="fd42:42:42"
LOG_WEBSITES="${LOG_WEBSITES:-no}"
UPSTREAM_DNS="$CLIENT_DNS"
# With website logging on, users' devices ask this server for DNS instead of a public resolver.
[[ "$LOG_WEBSITES" == "yes" ]] && CLIENT_DNS="$WG_NET.1"

echo "--> waiting for first-boot tasks to finish"
cloud-init status --wait >/dev/null 2>&1 || true

echo "--> installing packages"
APT=(apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold)
"${APT[@]}" update
"${APT[@]}" install wireguard-tools iptables qrencode ufw unattended-upgrades

echo "--> kernel settings (forwarding, BBR, larger UDP buffers)"
cat > /etc/sysctl.d/99-vpn.conf <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 5000
EOF
modprobe tcp_bbr 2>/dev/null || true
echo tcp_bbr > /etc/modules-load.d/bbr.conf
sysctl -q --system

echo "--> swap file (keeps the box stable under memory pressure)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "--> SSH: keys only"
cat > /etc/ssh/sshd_config.d/00-vpn-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl reload ssh

echo "--> automatic security updates (reboot 08:30 UTC only when required)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52vpn-auto-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "08:30";
EOF

echo "--> WireGuard config"
umask 077
mkdir -p /etc/wireguard/clients
cat > /etc/wireguard/vpn.env <<EOF
SERVER_IP="$SERVER_IP"
WG_PORT="$WG_PORT"
CLIENT_PORT="$CLIENT_PORT"
WG_NET="$WG_NET"
WG_NET6="$WG_NET6"
CLIENT_DNS="$CLIENT_DNS"
USAGE_RETENTION_DAYS="${USAGE_RETENTION_DAYS:-30}"
LOG_WEBSITES="$LOG_WEBSITES"
SITE_RETENTION_DAYS="${SITE_RETENTION_DAYS:-30}"
EOF

# NAT + forwarding rules, applied when wg0 comes up and removed when it goes down.
cat > /etc/wireguard/fw.sh <<'EOF'
#!/usr/bin/env bash
set -u
source /etc/wireguard/vpn.env
WAN="$(ip -4 route show default | awk '{print $5; exit}')"
case "$1" in up) A=-A; I=-I ;; down) A=-D; I=-D ;; *) exit 1 ;; esac
r() { "$@" 2>/dev/null || [ "$A" = "-D" ]; }
# VPN clients -> internet, replies back in.
r iptables $I FORWARD -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
r iptables $I FORWARD -i wg0 -o "$WAN" -j ACCEPT
# Clients cannot reach each other.
r iptables $I FORWARD -i wg0 -o wg0 -j DROP
r iptables -t nat $A POSTROUTING -s "$WG_NET.0/24" -o "$WAN" -j MASQUERADE
# Website logging: every DNS lookup from a VPN user goes to the resolver on this server,
# including from devices set to use some other DNS server.
if [ "${LOG_WEBSITES:-no}" = "yes" ]; then
  r iptables -t nat $A PREROUTING -i wg0 -p udp --dport 53 -j REDIRECT --to-ports 53
  r iptables -t nat $A PREROUTING -i wg0 -p tcp --dport 53 -j REDIRECT --to-ports 53
fi
# Also accept WireGuard on CLIENT_PORT (e.g. 443/udp) by redirecting it to the real port.
if [ "$CLIENT_PORT" != "$WG_PORT" ]; then
  r iptables -t nat $A PREROUTING -i "$WAN" -p udp --dport "$CLIENT_PORT" -j REDIRECT --to-ports "$WG_PORT"
fi
# Avoid stalled connections caused by oversized packets inside the tunnel.
r iptables -t mangle $A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
r iptables -t mangle $A FORWARD -i wg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
# IPv6 is captured by the tunnel and refused here, so it can never leak around the VPN
# and apps fall back to IPv4 immediately.
r ip6tables $I FORWARD -i wg0 -j REJECT --reject-with icmp6-adm-prohibited
exit 0
EOF
chmod 700 /etc/wireguard/fw.sh

if [[ ! -f /etc/wireguard/wg0.conf ]]; then
  cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = $WG_NET.1/24, $WG_NET6::1/64
ListenPort = $WG_PORT
PrivateKey = $(wg genkey)
PostUp = /etc/wireguard/fw.sh up
PostDown = /etc/wireguard/fw.sh down
EOF
  echo "    created new server keys"
else
  echo "    existing wg0.conf kept"
fi

# Point every existing profile at the current address and client port (keys are unchanged).
shopt -s nullglob
for f in /etc/wireguard/clients/*.conf; do
  grep -qx "Endpoint = $SERVER_IP:$CLIENT_PORT" "$f" || sed -i -E "s/^Endpoint = .*/Endpoint = $SERVER_IP:$CLIENT_PORT/" "$f"
  grep -qx "DNS = $CLIENT_DNS" "$f" || sed -i -E "s/^DNS = .*/DNS = $CLIENT_DNS/" "$f"
done
shopt -u nullglob

echo "--> host firewall"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow "$WG_PORT"/udp >/dev/null
[[ "$LOG_WEBSITES" == "yes" ]] && ufw allow in on wg0 to any port 53 >/dev/null
ufw --force enable >/dev/null

if [[ "$LOG_WEBSITES" == "yes" ]]; then
  echo "--> website logging (DNS resolver for VPN users)"
  mkdir -p /etc/dnsmasq.d /etc/systemd/system/dnsmasq.service.d
  {
    echo "# Written by install.sh. Answers DNS for VPN users only and logs each lookup."
    echo "interface=wg0"
    echo "except-interface=lo"
    echo "bind-dynamic"
    echo "no-resolv"
    echo "no-hosts"
    for s in ${UPSTREAM_DNS//,/ }; do echo "server=$s"; done
    echo "cache-size=10000"
    echo "log-queries"
    echo "log-facility=/var/log/vpn-dns.log"
    # Tells Firefox not to switch to its own encrypted DNS, which would bypass the log.
    echo "local=/use-application-dns.net/"
  } > /etc/dnsmasq.d/vpn.conf
  printf '[Service]\nRestart=always\nRestartSec=2\n' > /etc/systemd/system/dnsmasq.service.d/restart.conf
  touch /var/log/vpn-dns.log && chmod 600 /var/log/vpn-dns.log
  "${APT[@]}" install dnsmasq >/dev/null
  chown dnsmasq /var/log/vpn-dns.log 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable -q dnsmasq
else
  if systemctl list-unit-files dnsmasq.service >/dev/null 2>&1; then
    systemctl disable -q --now dnsmasq 2>/dev/null || true
  fi
  rm -f /etc/dnsmasq.d/vpn.conf
fi

echo "--> usage recording (one reading a minute)"
cat > /etc/systemd/system/vpn-usage.service <<'EOF'
[Unit]
Description=Record VPN usage per user

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vpn-usage collect
EOF
cat > /etc/systemd/system/vpn-usage.timer <<'EOF'
[Unit]
Description=Record VPN usage every minute

[Timer]
OnCalendar=*:*:00
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/vpn-block.service <<'EOF'
[Unit]
Description=Refresh VPN website block lists

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vpn-block refresh
EOF
cat > /etc/systemd/system/vpn-block.timer <<'EOF'
[Unit]
Description=Refresh VPN website block lists daily

[Timer]
OnCalendar=*-*-* 09:10:00
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF
touch /etc/dnsmasq.d/vpn-block.conf 2>/dev/null || true
systemctl daemon-reload
systemctl enable -q --now vpn-usage.timer vpn-block.timer

echo "--> starting WireGuard"
systemctl enable -q wg-quick@wg0
systemctl restart wg-quick@wg0
[[ "$LOG_WEBSITES" == "yes" ]] && systemctl restart dnsmasq
wg show wg0 | head -4
echo "--> done"
