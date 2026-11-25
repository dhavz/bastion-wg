#!/usr/bin/env bash
# Interactive menu for day-to-day VPN administration.

cd "$(dirname "$0")"

while true; do
  cat <<'EOF'

  ===== Bastion =====
   1) Status and connected users
   2) Add a user
   3) Remove a user
   4) List users
   5) Create profiles for everyone in users.txt
   6) Show a user's QR code
   7) Start VPN
   8) Stop VPN
   9) Restart VPN
  10) Back up server config
  11) SSH into the server
  12) Rebuild the user guide PDF
  13) Test a user's profile from Docker
  14) Web portal: start and show address
  15) Web portal: stop
   q) Quit
EOF
  read -r -p "  Choose: " c || exit 0
  echo
  case "$c" in
    1) ./status.sh ;;
    2) ./add-user.sh ;;
    3) ./remove-user.sh ;;
    4) ./list-users.sh ;;
    5) ./create-profiles.sh ;;
    6) read -r -p "User name: " n; [[ "$n" =~ ^[a-z0-9_-]+$ ]] && ./ssh.sh "vpn-user qr $n" || echo "Invalid name." ;;
    7) ./start.sh ;;
    8) ./stop.sh ;;
    9) ./restart.sh ;;
    10) ./backup.sh ;;
    11) ./ssh.sh ;;
    12) ./build-guide.sh ;;
    13) read -r -p "User name: " n; ./test-profile.sh "$n" ;;
    14) ./portal.sh start ;;
    15) ./portal.sh stop ;;
    q|Q) exit 0 ;;
    *) echo "Unknown choice." ;;
  esac || true
done
