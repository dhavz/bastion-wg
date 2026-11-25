#!/usr/bin/env bash
# Show every VPN user, when they were last connected, and how much data they used
# (counters reset when WireGuard restarts).

source "$(dirname "$0")/lib/common.sh"
load_state
vpn_ssh "vpn-user list"
