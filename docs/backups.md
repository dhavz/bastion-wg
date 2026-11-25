# Backups & restore

## Automatic nightly backups

The portal backs the server up every night after the configured hour (default 03:00), when no
backup exists for that day yet, into `backups/`. Older backups are deleted after
`BACKUP_KEEP_DAYS` (default 30). Change the hour and retention on **Administration → Settings**.

Each backup contains:

- the server WireGuard keys,
- every user (keys, preshared keys, allowed IPs),
- the blocking settings,
- the recorded history (`usage.db`).

You can also take one on demand from the portal (Server page) or from the terminal:

```bash
./backup.sh
```

## Restore

```bash
./restore.sh                # most recent backup
./restore.sh backups/FILE   # a specific one
```

This writes the users and settings onto the **current** server. Use it after rebuilding a lost
server (see below) or to roll back.

## Rebuilding a lost server

```bash
./setup.sh        # builds a fresh droplet + firewall, installs WireGuard
./restore.sh      # puts the users and settings back
```

The new droplet gets a **new IP**, so:

- every user must re-import their re-downloaded `.conf`, and
- `./build-guide.sh` must be re-run so the PDF shows the new address.

## What is *not* in a backup

The portal's own data — accounts, settings and the **audit log** — lives in
`.state/portal.db` on the management machine, not on the server, so it is not part of a server
backup. Keep your whole management-machine working copy (including `.state/`, `keys/`,
`profiles/`) backed up somewhere safe and private; these are git-ignored for good reason.

> `backups/` is the only copy of the server keys that exists off the droplet. Guard it.
