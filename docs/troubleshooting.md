# Troubleshooting

## A user can't connect

1. **Wrong or stale profile.** After rebuilding the server or changing `LOG_WEBSITES`, every
   profile changes — re-send the current `profiles/<name>.conf`.
2. **Same profile on two devices.** One profile per device; sharing one makes both drop.
3. **Network blocks UDP 443.** WireGuard also listens on UDP 51820; confirm the firewall and
   the user's network. `./status.sh` shows the service state.
4. **User suspended.** Check the portal or `./list-users.sh`.

## Verify the tunnel works

```bash
./test-profile.sh <name>
```

Connects with that profile from a Docker container and checks traffic exits at the server.

## Portal won't start

- Docker must be installed and running (`./portal.sh` checks for it).
- `./portal.sh logs` shows the container log.
- Locked out of the `admin` account: `./portal.sh new-password`.
- Can't see new UI features after an update: hard-refresh the browser — the portal versions
  its assets, but a cached page can linger.

## Portal shows "docker is required" over SSH

If you drive the management machine remotely, Docker/Homebrew may not be on the non-interactive
`PATH`. Prefix commands with:

```bash
export PATH=/opt/homebrew/bin:$PATH
```

## Website logging/blocking not working

- Both require `LOG_WEBSITES="yes"`; after changing it, re-run `./setup.sh` and re-send
  profiles.
- Apps/browsers using **encrypted DNS** (DoH/DoT) bypass DNS-based logging and blocking.
- Only block lists that are *in use* are refreshed daily.

## Server seems down

```bash
./status.sh                 # droplet + service state
./start.sh                  # powers on if the droplet was shut down
./ssh.sh systemctl status wg-quick@wg0
```

Unattended security updates may reboot the server in its maintenance window; the VPN returns
by itself within about a minute.

## Running low on transfer

Droplet size sets the monthly allowance (e.g. `s-2vcpu-2gb` = 3 TB). Resize without changing
the IP or any profile:

```bash
./stop.sh --poweroff
export DIGITALOCEAN_ACCESS_TOKEN=$(cat DOToken)
doctl compute droplet-action resize <droplet-id> --size s-2vcpu-4gb --wait   # id in .state/server.env
./start.sh
```
