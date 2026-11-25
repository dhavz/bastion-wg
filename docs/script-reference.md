# Script reference

All scripts live in the project root and source `lib/common.sh`. Run them from that directory.

## Provisioning & lifecycle

| Script | Purpose |
|---|---|
| `./setup.sh` | Idempotent provisioning: SSH key → droplet + firewall → install/harden WireGuard → profiles. Safe to re-run. |
| `./destroy.sh` | Permanently delete the droplet and its cloud firewall. Prompts for the droplet name. **Billing stops.** |
| `./start.sh` | Start the VPN; powers the droplet on first if it was shut down. |
| `./stop.sh [--poweroff]` | Stop WireGuard; `--poweroff` also shuts the droplet down (still billed while off). |
| `./restart.sh [--reboot]` | Restart WireGuard, or `--reboot` the whole server. |

## Users & profiles

| Script | Purpose |
|---|---|
| `./add-user.sh [name]` | Create a user; download their `.conf` and QR `.png`. |
| `./remove-user.sh [name]` | Revoke a user immediately. |
| `./list-users.sh` | List users with last-seen and data used. |
| `./create-profiles.sh` | Create a profile for everyone in `users.txt` who lacks one. |
| `./test-profile.sh <name>` | Connect with a profile from a Docker container and verify end to end. |

## Monitoring & operations

| Script | Purpose |
|---|---|
| `./status.sh` | Droplet state, VPN service, load, traffic, connected users. |
| `./ssh.sh [command]` | Root shell on the server, or run a single command. |
| `./backup.sh` | Download server keys + all users to `backups/`. |
| `./restore.sh [file]` | Restore a backup onto the current server. |
| `./build-guide.sh` | Rebuild `docs/VPN-User-Guide.pdf` with the current server IP. |

## Portal

```
./portal.sh start | restart | stop | status | logs | password | new-password
```

See [Portal accounts & roles](portal-accounts.md).

## SOCKS proxy helper

```
./socks.sh up | status | allow [ip] | down
```

A separate, temporary testing tool — see [SOCKS proxy helper](socks-proxy.md).

## Server-side tools (installed in `/usr/local/sbin`)

Run via `./ssh.sh <tool> …`:

| Tool | Purpose |
|---|---|
| `vpn-user` | Add/remove/list WireGuard peers. |
| `vpn-status` | Service and peer status. |
| `vpn-usage` | Per-user usage (`vpn-usage top` for totals). |
| `vpn-block` | Manage website block lists (`show`, `set`, `refresh`, `update`, `list`). |

## Configuration

- `config.env` — server settings (region, size, ports, DNS, logging, retention).
- `users.txt` — roster, `Name: email` per line (git-ignored; see `users.example.txt`).
- `DOToken` — DigitalOcean API token (git-ignored; see `DOToken.example`).
