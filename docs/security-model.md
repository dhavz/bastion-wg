# Security model

## Server hardening

- **SSH is key-only.** Password authentication is disabled. The server private key
  (`keys/vpn_ed25519`) exists only on your management machine and inside backups — it is
  **not** in this repository.
- **Two firewalls.** A DigitalOcean cloud firewall (attached by tag) and host `ufw`. Only
  these are open inbound: SSH (22/tcp), WireGuard (UDP 51820), and the client port (UDP 443)
  when it differs. Everything else is dropped.
- **Full tunnel.** All client traffic exits at the droplet. IPv6 from clients is captured and
  refused so it cannot leak around the VPN.
- **User isolation.** VPN users cannot reach each other's devices.
- **Per-user crypto.** Each user has their own key pair and preshared key; revoking one does
  not affect the others.
- **Unattended upgrades.** Security updates install automatically; if a reboot is needed it
  happens in a set window and the VPN self-recovers in under a minute.
- **Throughput tuning.** BBR congestion control, larger UDP buffers, MSS clamping.

## Portal

- **Plain HTTP, LAN only.** The portal is intended for a trusted local network. Anyone able
  to watch LAN traffic could capture a password or a downloaded profile. **Do not forward its
  port to the internet.** If you need remote access, put it behind a VPN or a reverse proxy
  with TLS and authentication that you control.
- **Password storage.** Account passwords are stored only as scrypt hashes (n=2¹⁴). Sessions
  are in-memory tokens with a configurable lifetime.
- **Least privilege.** The viewer role can see everything but change nothing and cannot
  download profiles, QR codes or backups.
- **Audit log.** Every mutating action is recorded against the account that performed it.
- **Secrets at rest.** The mail password and the audit log live in `.state/portal.db`, which
  is git-ignored.

## What must never be committed

`DOToken`, `keys/`, `.state/`, `profiles/`, `backups/`, `users.txt`, and any generated PDF are
all in `.gitignore`. They contain API tokens, private keys, server addresses and personal
data. This public repository ships **code and documentation only**.

## Threat notes

- The management machine is the crown jewel: it holds the SSH key and the only off-droplet
  copy of the server keys. Keep it encrypted and backed up.
- Website logging/blocking is DNS-based and can be bypassed by encrypted DNS; it is a
  management aid, not a security control.
- Monitoring users' activity has **legal** implications — see
  [Monitoring, privacy & the law](monitoring-and-privacy.md).
