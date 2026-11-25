#!/usr/bin/env bash
# Open a root shell on the VPN server, or run one command.
#   ./ssh.sh
#   ./ssh.sh wg show

source "$(dirname "$0")/lib/common.sh"
load_state
if (($#)); then vpn_ssh "$@"; else exec ssh -t -i "$KEY_FILE" "${SSH_OPTS[@]}" "root@$SERVER_IP"; fi
