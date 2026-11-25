"""Bastion management portal.

Runs in a container on the admin's machine. Talks to the VPN server over SSH
(using keys/vpn_ed25519) and to DigitalOcean with the token in DOToken.
The project folder is mounted at /data, so the portal and the shell scripts
share the same profiles/, backups/ and users.txt.
"""
import csv
import gzip
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import smtplib
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

DATA = Path(os.environ.get("VPN_DATA", "/data"))
STATIC = Path(__file__).parent / "static"
PASSWORD = os.environ["PORTAL_PASSWORD"]
NAME_RE = re.compile(r"^[a-z0-9_-]{1,15}$")
BACKUP_RE = re.compile(r"^wireguard-\d{8}-\d{6}\.tar\.gz$")
EMAIL_RE = re.compile(r"^[^@\s:]+@[^@\s:]+\.[^@\s:]+$")
ACCOUNT_RE = re.compile(r"^[a-z0-9._-]{2,32}$")
CONNECTED_WITHIN = 180  # seconds since last handshake that still counts as connected

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------- config ----
def state():
    text = (DATA / ".state" / "server.env").read_text()
    return dict(re.findall(r'^(\w+)="?([^"\n]*)"?$', text, re.M))


def do_token():
    return (DATA / "DOToken").read_text().strip()


KEY = Path("/tmp/vpn_key")


def ssh(command, stdin=None, timeout=40, binary=False):
    """Run a command on the VPN server. Returns stdout; raises HTTPException on failure."""
    if not KEY.exists():
        shutil.copy(DATA / "keys" / "vpn_ed25519", KEY)
        KEY.chmod(0o600)
    args = [
        "ssh", "-i", str(KEY),
        "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={DATA}/.state/known_hosts", "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=10", "-o", "LogLevel=ERROR", "-o", "BatchMode=yes",
        "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/cm-%C", "-o", "ControlPersist=120",
        f"root@{state()['SERVER_IP']}", command,
    ]
    try:
        p = subprocess.run(args, input=stdin, capture_output=True, timeout=timeout,
                           stdin=None if stdin is not None else subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "The VPN server did not answer in time.")
    if p.returncode != 0:
        msg = p.stderr.decode(errors="replace").strip().splitlines()
        raise HTTPException(502, (msg[-1] if msg else "The VPN server could not be reached over SSH.")
                            .replace("vpn-user: ", "").replace("vpn-block: ", ""))
    return p.stdout if binary else p.stdout.decode(errors="replace")


def do_api(path, method="GET", body=None):
    req = urllib.request.Request(
        "https://api.digitalocean.com" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {do_token()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


# ------------------------------------------------------------------ auth ----
# Portal accounts live in the portal database. Two roles: "admin" can do everything,
# "viewer" can look but not change anything or download profiles and backups.
sessions = {}          # token -> {"user", "role", "exp"}
failures = {}          # ip -> [count, locked_until]
auth_lock = threading.Lock()
MIN_PASSWORD = 10


def client_ip(request: Request):
    return request.client.host if request.client else "?"


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    return salt, hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def check_password(password):
    if len(password) < MIN_PASSWORD:
        raise HTTPException(400, f"Use a password of at least {MIN_PASSWORD} characters.")
    if len(password) > 200:
        raise HTTPException(400, "That password is too long.")
    return password


def account_row(username):
    with log_lock, portal_db() as db:
        return db.execute("SELECT username, name, role, salt, hash, disabled FROM accounts WHERE username = ?",
                          (username,)).fetchone()


def set_password(username, password):
    salt, digest = hash_password(password)
    with log_lock, portal_db() as db:
        db.execute("UPDATE accounts SET salt = ?, hash = ? WHERE username = ?", (salt, digest, username))


def drop_sessions(username, keep=None):
    with auth_lock:
        for token in [t for t, v in sessions.items() if v["user"] == username and t != keep]:
            sessions.pop(token, None)


def bootstrap_accounts():
    """The first start creates the account "admin" with the password from ./portal.sh password.
    Running ./portal.sh new-password later resets that account, as the way back in."""
    mark = hashlib.sha256(PASSWORD.encode()).hexdigest()
    with log_lock, portal_db() as db:
        count = db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
    if count and setting("bootstrap_mark", "") == mark:
        return
    salt, digest = hash_password(PASSWORD)
    with log_lock, portal_db() as db:
        db.execute("INSERT INTO accounts (username, name, role, salt, hash, disabled, created) VALUES ('admin', "
                   "'Administrator', 'admin', ?, ?, 0, ?) ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, "
                   "hash = excluded.hash, role = 'admin', disabled = 0", (salt, digest, time.time()))
    set_setting("bootstrap_mark", mark)
    if count:
        drop_sessions("admin")
        log(None, "Reset the admin account password", "from ./portal.sh new-password")


def require_login(request: Request):
    token = request.cookies.get("vpn_session", "")
    with auth_lock:
        sess = sessions.get(token)
        if not sess or sess["exp"] < time.time():
            sessions.pop(token, None)
            raise HTTPException(401, "Sign in to continue.")
    if request.method not in ("GET", "HEAD"):
        if request.headers.get("x-portal") != "1":
            raise HTTPException(403, "Request blocked.")
        if sess["role"] != "admin" and request.url.path not in ("/api/logout", "/api/me/password"):
            raise HTTPException(403, "Your account can view the portal but not change anything.")
    request.state.user = sess["user"]
    return sess


def require_admin(request: Request):
    sess = require_login(request)
    if sess["role"] != "admin":
        raise HTTPException(403, "Only an administrator can do that.")
    return sess


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"     # always check for a newer page
    return response


@app.post("/api/login")
async def login(request: Request, response: Response):
    ip = client_ip(request)
    now = time.time()
    with auth_lock:
        count, locked = failures.get(ip, [0, 0])
        if locked > now:
            raise HTTPException(429, f"Too many attempts. Try again in {int(locked - now) + 1} seconds.")
    body = await request.json()
    username = str(body.get("username", "")).strip().lower()[:32]
    password = str(body.get("password", ""))[:200]
    row = account_row(username)
    salt, digest = hash_password(password, row[3] if row else b"0" * 16)
    if not row or row[5] or not hmac.compare_digest(digest, row[4]):
        with auth_lock:
            count += 1
            failures[ip] = [count, now + 60 if count % 5 == 0 else 0]
        log(request, "Sign-in failed", username, who=username)
        raise HTTPException(401, "That username or password is not right.")
    token = secrets.token_urlsafe(32)
    hours = setting("session_hours")
    with auth_lock:
        failures.pop(ip, None)
        sessions[token] = {"user": row[0], "role": row[2], "exp": now + hours * 3600}
    with log_lock, portal_db() as db:
        db.execute("UPDATE accounts SET last_login = ? WHERE username = ?", (now, row[0]))
    response.set_cookie("vpn_session", token, max_age=hours * 3600,
                        httponly=True, samesite="strict", path="/")
    log(request, "Signed in", "", who=row[0])
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request, response: Response, _=Depends(require_login)):
    sessions.pop(request.cookies.get("vpn_session", ""), None)
    response.delete_cookie("vpn_session", path="/")
    return {"ok": True}


@app.get("/api/me")
def me(sess=Depends(require_login)):
    row = account_row(sess["user"])
    return {"username": sess["user"], "name": row[1] if row else "", "role": sess["role"]}


@app.post("/api/me/password")
async def change_own_password(request: Request, sess=Depends(require_login)):
    body = await request.json()
    row = account_row(sess["user"])
    _, digest = hash_password(str(body.get("current", ""))[:200], row[3])
    if not hmac.compare_digest(digest, row[4]):
        raise HTTPException(400, "Your current password is not right.")
    set_password(sess["user"], check_password(str(body.get("new", ""))))
    drop_sessions(sess["user"], keep=request.cookies.get("vpn_session", ""))
    log(request, "Changed own password", "")
    return {"ok": True}


# -------------------------------------------------------------- accounts ----
def admins_left(excluding):
    with log_lock, portal_db() as db:
        return db.execute("SELECT COUNT(*) FROM accounts WHERE role = 'admin' AND disabled = 0 AND username != ?",
                          (excluding,)).fetchone()[0]


@app.get("/api/accounts")
def accounts(_=Depends(require_admin)):
    with log_lock, portal_db() as db:
        rows = db.execute("SELECT username, name, role, disabled, created, last_login FROM accounts "
                          "ORDER BY username").fetchall()
    return {"accounts": [{"username": u, "name": n, "role": r, "disabled": bool(d), "created": c, "last_login": l}
                         for u, n, r, d, c, l in rows]}


@app.post("/api/accounts")
async def add_account(request: Request, _=Depends(require_admin)):
    body = await request.json()
    username = str(body.get("username", "")).strip().lower()
    if not ACCOUNT_RE.match(username):
        raise HTTPException(400, "Use 2 to 32 characters for the username: lowercase letters, digits, dot, - or _.")
    role = body.get("role")
    if role not in ("admin", "viewer"):
        raise HTTPException(400, "Choose a role.")
    name = str(body.get("name", "")).strip()[:60]
    salt, digest = hash_password(check_password(str(body.get("password", ""))))
    try:
        with log_lock, portal_db() as db:
            db.execute("INSERT INTO accounts (username, name, role, salt, hash, disabled, created) "
                       "VALUES (?,?,?,?,?,0,?)", (username, name, role, salt, digest, time.time()))
    except sqlite3.IntegrityError:
        raise HTTPException(400, "That username is already taken.")
    log(request, "Added portal account", f"{username} ({role})")
    return {"ok": True}


@app.put("/api/accounts/{username}")
async def edit_account(username: str, request: Request, sess=Depends(require_admin)):
    body = await request.json()
    row = account_row(username)
    if not row:
        raise HTTPException(404, "No such account.")
    role = body.get("role", row[2])
    disabled = bool(body.get("disabled", row[5]))
    name = str(body.get("name", row[1])).strip()[:60]
    if role not in ("admin", "viewer"):
        raise HTTPException(400, "Choose a role.")
    loses_admin = row[2] == "admin" and not row[5] and (role != "admin" or disabled)
    if loses_admin and username == sess["user"]:
        raise HTTPException(400, "You cannot remove your own administrator access. Ask another administrator.")
    if loses_admin and not admins_left(username):
        raise HTTPException(400, "This is the only administrator. Make another one first.")
    changes = []
    if role != row[2]:
        changes.append(f"role {role}")
    if disabled != bool(row[5]):
        changes.append("turned off" if disabled else "turned on")
    if name != row[1]:
        changes.append("renamed")
    with log_lock, portal_db() as db:
        db.execute("UPDATE accounts SET role = ?, disabled = ?, name = ? WHERE username = ?",
                   (role, int(disabled), name, username))
    if body.get("password"):
        set_password(username, check_password(str(body["password"])))
        changes.append("new password")
    if role != row[2] or disabled or body.get("password"):
        drop_sessions(username, keep=request.cookies.get("vpn_session", "") if username == sess["user"] else None)
    log(request, "Changed portal account", f"{username}: {', '.join(changes) or 'no change'}")
    return {"ok": True}


@app.delete("/api/accounts/{username}")
def delete_account(username: str, request: Request, sess=Depends(require_admin)):
    row = account_row(username)
    if not row:
        raise HTTPException(404, "No such account.")
    if username == sess["user"]:
        raise HTTPException(400, "You cannot delete the account you are signed in with.")
    if row[2] == "admin" and not row[5] and not admins_left(username):
        raise HTTPException(400, "This is the only administrator. Make another one first.")
    with log_lock, portal_db() as db:
        db.execute("DELETE FROM accounts WHERE username = ?", (username,))
    drop_sessions(username)
    log(request, "Deleted portal account", username)
    return {"ok": True}


# -------------------------------------------------------------- activity ----
# The portal's own audit log: who did what through the portal, kept in a small database
# on this machine and trimmed to the retention period.
PORTAL_DB = DATA / ".state" / "portal.db"
log_lock = threading.RLock()
db_ready = False


def portal_db():
    global db_ready
    db = sqlite3.connect(PORTAL_DB, timeout=20)
    if not db_ready:
        db.execute("CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, time REAL NOT NULL, "
                   "source TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')")
        db.execute("CREATE INDEX IF NOT EXISTS activity_time ON activity (time)")
        if "who" not in [c[1] for c in db.execute("PRAGMA table_info(activity)")]:
            db.execute("ALTER TABLE activity ADD COLUMN who TEXT NOT NULL DEFAULT ''")
        db.execute("CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', "
                   "role TEXT NOT NULL, salt BLOB NOT NULL, hash BLOB NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, "
                   "created REAL NOT NULL, last_login REAL)")
        db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.commit()
        db_ready = True
    return db


# Settings an administrator can change in the portal. Kept in the portal database.
SETTING_DEFAULTS = {
    "session_hours": 12,
    "log_days": int(os.environ.get("PORTAL_LOG_DAYS", "30") or 30),
    "backup_keep_days": int(os.environ.get("BACKUP_KEEP_DAYS", "30") or 30),
    "backup_hour": 3,                 # local time on this machine
}
settings_cache = {}


def setting(key, default=None):
    if key not in settings_cache:
        with log_lock, portal_db() as db:
            row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        settings_cache[key] = json.loads(row[0]) if row else SETTING_DEFAULTS.get(key, default)
    return settings_cache[key]


def set_setting(key, value):
    with log_lock, portal_db() as db:
        db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   (key, json.dumps(value)))
    settings_cache[key] = value


def import_old_log():
    """One-time move of the earlier text log into the database."""
    old = DATA / ".state" / "portal-activity.log"
    if not old.exists():
        return
    with log_lock, portal_db() as db:
        for line in old.read_text().splitlines():
            try:
                e = json.loads(line)
                db.execute("INSERT INTO activity (time, source, action, detail) VALUES (?,?,?,?)",
                           (e["time"], e.get("from", ""), e["action"], e.get("detail", "")))
            except (ValueError, KeyError):
                pass
    old.unlink()


def log(request, action, detail, who=None):
    if who is None:
        who = getattr(request.state, "user", "") if request is not None else "automatic"
    with log_lock, portal_db() as db:
        db.execute("INSERT INTO activity (time, source, action, detail, who) VALUES (?,?,?,?,?)",
                   (time.time(), client_ip(request) if request is not None else "", action, detail, who))
        db.execute("DELETE FROM activity WHERE time < ?", (time.time() - setting("log_days") * 86400,))


@app.get("/api/activity")
def activity(_=Depends(require_login)):
    with log_lock, portal_db() as db:
        rows = db.execute("SELECT time, source, action, detail, who FROM activity ORDER BY id DESC LIMIT 5000").fetchall()
    return {"retention_days": setting("log_days"),
            "entries": [{"time": t, "from": "" if src == "automatic" else src, "action": act, "detail": det,
                         "who": who or ("automatic" if src == "automatic" else "")}
                        for t, src, act, det, who in rows]}


@app.get("/api/activity/export")
def activity_export(request: Request, _=Depends(require_login)):
    with log_lock, portal_db() as db:
        rows = db.execute("SELECT time, source, action, detail, who FROM activity ORDER BY id DESC").fetchall()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["time_utc", "account", "action", "detail", "from_address"])
    for t, src, act, det, who in rows:
        w.writerow([iso(t), who, act, det, src])
    return Response(out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="vpn-portal-activity.csv"'})


# ---------------------------------------------------------------- roster ----
ROSTER = DATA / "users.txt"
roster_lock = threading.Lock()


def roster():
    """name -> email, from users.txt ('Name: email' per line)."""
    out = {}
    if ROSTER.exists():
        for line in ROSTER.read_text().splitlines():
            parts = line.split()
            if not parts or line.lstrip().startswith("#"):
                continue
            name = re.sub(r"[^a-z0-9_-]", "", parts[0].lower())[:15]
            out[name] = parts[1] if len(parts) > 1 else ""
    return out


def roster_set(name, email=None):
    """Add/replace a roster line, or remove it when email is None."""
    with roster_lock:
        lines = ROSTER.read_text().splitlines() if ROSTER.exists() else []
        keep = [l for l in lines
                if not l.split() or re.sub(r"[^a-z0-9_-]", "", l.split()[0].lower())[:15] != name]
        if email is not None:
            keep.append(f"{name.capitalize()}: {email}".rstrip())
        ROSTER.write_text("\n".join(keep) + "\n")


# -------------------------------------------------------------- location ----
# Where a connection comes from, looked up in DB-IP's free databases (https://db-ip.com,
# CC BY 4.0). They are downloaded to this machine and refreshed monthly, so users'
# addresses are never sent to an outside service.
GEO_DIR = DATA / ".state" / "geo"
geo_readers = {}
geo_cache = {}
geo_lock = threading.Lock()


def geo_update():
    GEO_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    months = [now.strftime("%Y-%m"), (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")]
    for kind in ("city", "asn"):
        target = GEO_DIR / f"{kind}.mmdb"
        if target.exists() and time.time() - target.stat().st_mtime < 35 * 86400:
            continue
        for month in months:
            tmp = GEO_DIR / f"{kind}.download"
            try:
                url = f"https://download.db-ip.com/free/dbip-{kind}-lite-{month}.mmdb.gz"
                req = urllib.request.Request(url, headers={"User-Agent": "curl/8.7.1"})   # the default Python client name is refused
                with urllib.request.urlopen(req, timeout=300) as r, tmp.open("wb") as f:
                    shutil.copyfileobj(gzip.GzipFile(fileobj=r), f)
                tmp.replace(target)
                with geo_lock:
                    geo_readers.pop(kind, None)
                    geo_cache.clear()
                break
            except Exception:
                tmp.unlink(missing_ok=True)


def geo(ip):
    """{'country', 'code', 'city', 'org'} for an address; empty strings when unknown."""
    out = {"country": "", "code": "", "city": "", "org": ""}
    if not ip:
        return out
    with geo_lock:
        if ip in geo_cache:
            return geo_cache[ip]
        try:
            import maxminddb
            for kind in ("city", "asn"):
                path = GEO_DIR / f"{kind}.mmdb"
                if kind not in geo_readers and path.exists():
                    geo_readers[kind] = maxminddb.open_database(str(path))
            c = geo_readers["city"].get(ip) if "city" in geo_readers else None
            if c:
                out["country"] = (c.get("country", {}).get("names") or {}).get("en", "")
                out["code"] = c.get("country", {}).get("iso_code", "")
                out["city"] = (c.get("city", {}).get("names") or {}).get("en", "")
            a = geo_readers["asn"].get(ip) if "asn" in geo_readers else None
            if a:
                out["org"] = a.get("autonomous_system_organization", "")
        except Exception:
            return out
        if len(geo_readers) == 2:
            geo_cache[ip] = out
        return out


# A device's operating system is not visible through WireGuard. This guesses it from the
# background check-ins each system makes, as seen in the website log.
DEVICE_HINTS = {
    "Windows": ("msftconnecttest.com", "msftncsi.com", "windowsupdate.com", "events.data.microsoft.com"),
    "Apple": ("captive.apple.com", "push.apple.com", "icloud.com", "mesu.apple.com", "gs.apple.com"),
    "Android": ("connectivitycheck.gstatic.com", "connectivitycheck.android.com", "android.clients.google.com",
                "android.googleapis.com"),
    "Linux": ("connectivity-check.ubuntu.com", "archive.ubuntu.com", "fedoraproject.org", "debian.org",
              "archlinux.org", "alpinelinux.org"),
}
device_cache = {"at": 0.0, "data": {}}


def device_guesses():
    if time.time() - device_cache["at"] > 600:
        device_cache["at"] = time.time()
        try:
            rows = json.loads(ssh(f"vpn-usage sites --since {int(time.time()) - 30 * 86400}", timeout=30))["rows"]
            score = {}
            for row in rows:
                name, domain, hits = row[0], row[2], row[3]
                for family, marks in DEVICE_HINTS.items():
                    if any(domain == m or domain.endswith("." + m) for m in marks):
                        score.setdefault(name, {}).setdefault(family, 0)
                        score[name][family] += hits
            device_cache["data"] = {n: max(f, key=f.get) for n, f in score.items()}
        except Exception:
            pass
    return device_cache["data"]


# ---------------------------------------------------------------- status ----
status_lock = threading.Lock()
cache = {"at": 0.0, "data": None, "prev": None}
history = deque(maxlen=240)   # (time, download bits/s, upload bits/s), about 12 minutes
droplet_cache = {"at": 0.0, "data": None}
month_cache = {"at": 0.0, "data": None}


def droplet_info():
    if time.time() - droplet_cache["at"] > 45:
        try:
            d = do_api(f"/v2/droplets/{state()['DROPLET_ID']}")["droplet"]
            droplet_cache["data"] = {
                "name": d["name"], "status": d["status"], "region": d["region"]["name"],
                "size": d["size_slug"], "vcpus": d["vcpus"], "memory_mb": d["memory"],
                "disk_gb": d["disk"], "price_monthly": d["size"]["price_monthly"],
                "transfer_tb": d["size"]["transfer"], "created": d["created_at"],
                "image": f'{d["image"]["distribution"]} {d["image"]["name"]}',
            }
        except Exception as e:  # keep the last good answer; the portal still works without it
            droplet_cache["data"] = droplet_cache["data"] or {"error": str(e)}
        droplet_cache["at"] = time.time()
    return droplet_cache["data"]


def month_transfer():
    """Approximate outbound transfer this calendar month, from DigitalOcean's bandwidth metrics."""
    if time.time() - month_cache["at"] > 600:
        try:
            now = datetime.now(timezone.utc)
            start = int(now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
            created = (droplet_info() or {}).get("created")
            if created:   # asking for time before the server existed returns nothing useful
                start = max(start, int(datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()) - 300)
            end = int(now.timestamp())
            megabits = 0.0
            chunk = 3 * 86400   # short windows keep DigitalOcean's sampling fine enough to add up
            for a in range(start, end, chunk):
                b = min(a + chunk, end)
                r = do_api(f"/v2/monitoring/metrics/droplet/bandwidth?host_id={state()['DROPLET_ID']}"
                           f"&interface=public&direction=outbound&start={a}&end={b}")
                for series in r["data"]["result"]:
                    v = series["values"]
                    for i in range(1, len(v)):
                        megabits += (float(v[i][1]) + float(v[i - 1][1])) / 2 * (v[i][0] - v[i - 1][0])
            month_cache["data"] = {"bytes": int(megabits * 125000), "month": now.strftime("%B")}
        except Exception:
            month_cache["data"] = month_cache["data"] or None
        month_cache["at"] = time.time()
    return month_cache["data"]


def build_status():
    drop = droplet_info() or {}
    try:
        raw = json.loads(ssh("vpn-status", timeout=15))
    except HTTPException as e:
        return {"reachable": False, "error": e.detail, "droplet": drop, "users": [],
                "history": list(history), "month": month_transfer()}

    prev = cache["prev"]
    dt = raw["time"] - prev["time"] if prev else 0
    emails = roster()
    devices = device_guesses()
    now = raw["time"]
    total_down = total_up = 0.0
    old = {u["name"]: u for u in prev["users"]} if prev else {}
    for u in raw["users"]:
        o = old.get(u["name"])
        u["down_bps"] = u["up_bps"] = 0.0
        if o and 0 < dt < 60:
            u["down_bps"] = max(0, u["downloaded"] - o["downloaded"]) * 8 / dt
            u["up_bps"] = max(0, u["uploaded"] - o["uploaded"]) * 8 / dt
        u["email"] = emails.get(u["name"], "")
        u["connected"] = bool(u["enabled"] and u["handshake"] and now - u["handshake"] < CONNECTED_WITHIN)
        u["endpoint_ip"] = u["endpoint"].rsplit(":", 1)[0] if u["endpoint"] else ""
        u["location"] = geo(u["endpoint_ip"])
        u["device"] = devices.get(u["name"], "")
        total_down += u["down_bps"]
        total_up += u["up_bps"]

    cpu = None
    if prev and raw["cpu_total"] > prev["cpu_total"]:
        cpu = 100 * (1 - (raw["cpu_idle"] - prev["cpu_idle"]) / (raw["cpu_total"] - prev["cpu_total"]))
    if prev and 0 < dt < 60:
        history.append([round(now), round(total_down), round(total_up)])
    cache["prev"] = raw

    return {
        "reachable": True, "time": now, "droplet": drop, "month": month_transfer(),
        "service": raw["service"], "boot_enabled": raw["boot_enabled"],
        "uptime": raw["uptime"], "load": raw["load"], "cpus": raw["cpus"],
        "cpu_percent": None if cpu is None else round(max(0, min(100, cpu)), 1),
        "mem_total": raw["mem_total"], "mem_used": raw["mem_total"] - raw["mem_available"],
        "disk_total": raw["disk_total"], "disk_used": raw["disk_total"] - raw["disk_free"],
        "net_rx": raw["net_rx"], "net_tx": raw["net_tx"],
        "reboot_required": raw["reboot_required"], "kernel": raw["kernel"], "os": raw["os"],
        "server_ip": raw["server_ip"], "wg_port": raw["wg_port"], "client_port": raw["client_port"],
        "dns": raw["dns"], "public_key": raw["public_key"],
        "site_logging": raw.get("site_logging", "off"), "usage_timer": raw.get("usage_timer", "unknown"),
        "down_bps": total_down, "up_bps": total_up,
        "users": raw["users"], "history": list(history),
    }


def current_status(max_age=2.5):
    with status_lock:
        if cache["data"] is None or time.time() - cache["at"] > max_age:
            cache["data"] = build_status()
            cache["at"] = time.time()
        return cache["data"]


@app.get("/api/status")
def status(_=Depends(require_login)):
    return current_status()


def refresh():
    cache["at"] = 0


# ----------------------------------------------------------------- users ----
def valid_name(name):
    if not NAME_RE.match(name or ""):
        raise HTTPException(400, "Use 1 to 15 characters: lowercase letters, digits, - or _.")
    return name


def save_local_profile(name):
    folder = DATA / "profiles"
    folder.mkdir(exist_ok=True)
    conf = ssh(f"vpn-user show {name}")
    (folder / f"{name}.conf").write_text(conf)
    (folder / f"{name}.png").write_bytes(ssh(f"vpn-user qr-png {name}", binary=True))
    for f in (folder / f"{name}.conf", folder / f"{name}.png"):
        f.chmod(0o600)


@app.post("/api/users")
async def add_user(request: Request, _=Depends(require_admin)):
    body = await request.json()
    name = valid_name(str(body.get("name", "")).strip().lower())
    email = str(body.get("email", "")).strip()
    if email and not EMAIL_RE.match(email):
        raise HTTPException(400, "That email address does not look right.")
    ssh(f"vpn-user add {name}")
    roster_set(name, email)
    save_local_profile(name)
    log(request, "Added user", name)
    refresh()
    return {"ok": True, "name": name}


@app.delete("/api/users/{name}")
def delete_user(name: str, request: Request, _=Depends(require_admin)):
    valid_name(name)
    ssh(f"vpn-user remove {name}")
    roster_set(name, None)
    for ext in ("conf", "png"):
        (DATA / "profiles" / f"{name}.{ext}").unlink(missing_ok=True)
    log(request, "Deleted user", name)
    refresh()
    return {"ok": True}


@app.post("/api/users/{name}/{action}")
def toggle_user(name: str, action: str, request: Request, _=Depends(require_admin)):
    valid_name(name)
    if action not in ("suspend", "resume"):
        raise HTTPException(404)
    ssh(f"vpn-user {'disable' if action == 'suspend' else 'enable'} {name}")
    log(request, "Suspended user" if action == "suspend" else "Resumed user", name)
    refresh()
    return {"ok": True}


@app.get("/api/users/{name}/profile")
def profile(name: str, request: Request, _=Depends(require_admin)):
    valid_name(name)
    conf = ssh(f"vpn-user show {name}")
    log(request, "Downloaded profile", name)
    return Response(conf, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}.conf"'})


@app.get("/api/users/{name}/qr")
def qr(name: str, request: Request, _=Depends(require_admin)):
    valid_name(name)
    png = ssh(f"vpn-user qr-png {name}", binary=True)
    log(request, "Viewed QR code", name)
    return Response(png, media_type="image/png")


# ----------------------------------------------------------------- usage ----
RANGES = {"24h": (86400, 3600), "7d": (7 * 86400, 86400), "30d": (30 * 86400, 86400),
          "90d": (90 * 86400, 86400), "365d": (365 * 86400, 7 * 86400)}
usage_cache = {}
usage_lock = threading.Lock()


def usage_report(range_key, tz_minutes):
    """Per-user usage, traffic history and the connection log for a period.
    tz_minutes is the browser's offset from UTC, so days line up with the viewer's clock."""
    if range_key not in RANGES:
        raise HTTPException(400, "Unknown period.")
    tz_minutes = max(-840, min(840, int(tz_minutes)))
    span, bucket = RANGES[range_key]
    offset = -tz_minutes * 60
    if bucket == 7 * 86400:
        offset += 3 * 86400          # the epoch began on a Thursday; this starts weeks on Monday
    key = (range_key, tz_minutes)
    with usage_lock:
        hit = usage_cache.get(key)
        if hit and time.time() - hit[0] < 20:
            return hit[1]
        now = int(time.time())
        since = ((now - span + offset) // bucket + 1) * bucket - offset   # start on a whole hour/day
        data = json.loads(ssh(f"vpn-usage report --since {since} --bucket {bucket} --offset {offset}", timeout=30))
        emails = roster()
        for u in data["users"]:
            u["email"] = emails.get(u["name"], "")
        # Flag a connection from a country or provider this user has not connected from before.
        known = {}
        for name, source in data.get("earlier_sources", []):
            g = geo(source)
            k = known.setdefault(name, {"countries": set(), "orgs": set(), "any": False})
            k["any"] = True
            k["countries"].add(g["country"]); k["orgs"].add(g["org"])
        for s in sorted(data["sessions"], key=lambda s: s["started"]):
            g = geo(s["source"])
            k = known.setdefault(s["name"], {"countries": set(), "orgs": set(), "any": False})
            s.update(country=g["country"], city=g["city"], org=g["org"],
                     new_country=bool(k["any"] and g["country"] and g["country"] not in k["countries"]),
                     new_network=bool(k["any"] and g["org"] and g["org"] not in k["orgs"]))
            k["any"] = True
            k["countries"].add(g["country"]); k["orgs"].add(g["org"])
        usage_cache[key] = (time.time(), data)
        return data


@app.get("/api/usage")
def usage(range: str = "7d", tz: int = 0, _=Depends(require_login)):
    return usage_report(range, tz)


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@app.get("/api/usage/export/{kind}")
def usage_export(kind: str, request: Request, range: str = "7d", tz: int = 0, _=Depends(require_login)):
    data = usage_report(range, tz)
    out = io.StringIO()
    w = csv.writer(out)
    if kind == "users":
        w.writerow(["user", "email", "downloaded_bytes", "uploaded_bytes", "total_bytes",
                    "connections", "seconds_connected", "last_connected_utc", "period_start_utc", "period_end_utc"])
        for u in data["users"]:
            w.writerow([u["name"], u.get("email", ""), u["down"], u["up"], u["down"] + u["up"],
                        u.get("connections", 0), u.get("seconds", 0),
                        iso(u["last"]) if u.get("last") else "", iso(data["since"]), iso(data["now"])])
    elif kind == "connections":
        w.writerow(["user", "connected_from", "city", "country", "provider", "new_country", "new_provider",
                    "started_utc", "ended_utc", "seconds", "downloaded_bytes", "uploaded_bytes", "still_connected"])
        for s in data["sessions"]:
            w.writerow([s["name"], s["source"], s.get("city", ""), s.get("country", ""), s.get("org", ""),
                        "yes" if s.get("new_country") else "no", "yes" if s.get("new_network") else "no",
                        iso(s["started"]), iso(s["ended"]), s["ended"] - s["started"],
                        s["down"], s["up"], "yes" if s["open"] else "no"])
    elif kind == "history":
        w.writerow(["period_start_utc", "user", "downloaded_bytes", "uploaded_bytes"])
        for b, name, down, up in data["series"]:
            w.writerow([iso(b), name, down, up])
    else:
        raise HTTPException(404)
    log(request, "Exported usage", f"{kind}, {range}")
    stamp = datetime.now().strftime("%Y%m%d")
    return Response(out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="vpn-{kind}-{range}-{stamp}.csv"'})


# -------------------------------------------------------------- websites ----
sites_cache = {}


def sites_report(range_key):
    if range_key not in RANGES:
        raise HTTPException(400, "Unknown period.")
    with usage_lock:
        hit = sites_cache.get(range_key)
        if hit and time.time() - hit[0] < 20:
            return hit[1]
        since = int(time.time()) - RANGES[range_key][0]
        data = json.loads(ssh(f"vpn-usage sites --since {since}", timeout=30))
        data["emails"] = roster()
        sites_cache[range_key] = (time.time(), data)
        return data


@app.get("/api/sites")
def sites(range: str = "24h", _=Depends(require_login)):
    return sites_report(range)


@app.get("/api/sites/export")
def sites_export(request: Request, range: str = "24h", user: str = "", _=Depends(require_login)):
    data = sites_report(range)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["user", "email", "site", "full_address", "lookups", "blocked_lookups", "first_seen_utc", "last_seen_utc"])
    for name, site, domain, hits, first, last, blocked in data["rows"]:
        if user and name != user:
            continue
        w.writerow([name, data["emails"].get(name, ""), site, domain, hits, blocked, iso(first), iso(last)])
    log(request, "Exported website log", f"{user or 'all users'}, {range}")
    stamp = datetime.now().strftime("%Y%m%d")
    return Response(out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="vpn-websites-{range}-{stamp}.csv"'})


# -------------------------------------------------------------- blocking ----
@app.get("/api/blocking")
def blocking(_=Depends(require_login)):
    return json.loads(ssh("vpn-block show", timeout=30))


@app.put("/api/blocking")
async def set_blocking(request: Request, _=Depends(require_admin)):
    body = await request.json()
    new = {"enabled": bool(body.get("enabled")),
           "domains": [str(d)[:260] for d in body.get("domains", [])][:5000],
           "categories": [str(c)[:40] for c in body.get("categories", [])][:40]}
    if "allowed" in body:
        new["allowed"] = [str(d)[:260] for d in body["allowed"]][:5000]
    if "custom" in body:
        new["custom"] = [{"key": str(c.get("key", ""))[:40], "label": str(c.get("label", ""))[:60],
                          "url": str(c.get("url", ""))[:500]} for c in body["custom"] if isinstance(c, dict)][:30]
    result = json.loads(ssh("vpn-block set", stdin=json.dumps(new).encode(), timeout=180))
    on = [c["label"] for c in result["categories"] if c["on"]]
    log(request, "Changed website blocking",
        f'{"on" if result["enabled"] else "off"}; {len(result["domains"])} blocked sites; '
        f'{len(result["allowed"])} never blocked; lists in use: {", ".join(on) or "none"}; '
        f'{sum(1 for c in result["categories"] if c["custom"])} added lists')
    sites_cache.clear()
    return result


LIST_KEY_RE = re.compile(r"^[a-z0-9_]{1,40}$")


@app.get("/api/blocking/lists/{key}")
def blocking_list(key: str, q: str = "", offset: int = 0, _=Depends(require_admin)):
    if not LIST_KEY_RE.match(key):
        raise HTTPException(404, "No such list.")
    q = re.sub(r"[^a-z0-9.-]", "", q.lower())[:60]
    cmd = f"vpn-block list {key} --offset {max(0, int(offset))} --limit 50" + (f" --search {q}" if q else "")
    return json.loads(ssh(cmd, timeout=40))


@app.post("/api/blocking/lists/{key}/update")
def blocking_list_update(key: str, request: Request, _=Depends(require_admin)):
    if not LIST_KEY_RE.match(key):
        raise HTTPException(404, "No such list.")
    result = json.loads(ssh(f"vpn-block update {key}", timeout=180))
    label = next((c["label"] for c in result["categories"] if c["key"] == key), key)
    log(request, "Updated block list", label)
    return result


# --------------------------------------------------------- health history ----
HEALTH_RANGES = {"24h": (86400, 300), "7d": (7 * 86400, 1800), "30d": (30 * 86400, 7200)}
health_cache = {}


@app.get("/api/health")
def health(range: str = "24h", _=Depends(require_login)):
    if range not in HEALTH_RANGES:
        raise HTTPException(400, "Unknown period.")
    hit = health_cache.get(range)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    span, bucket = HEALTH_RANGES[range]
    data = json.loads(ssh(f"vpn-usage health --since {int(time.time()) - span} --bucket {bucket}", timeout=30))
    health_cache[range] = (time.time(), data)
    return data


# ---------------------------------------------------------------- server ----
@app.post("/api/vpn/{action}")
def vpn_service(action: str, request: Request, _=Depends(require_admin)):
    if action not in ("start", "stop", "restart"):
        raise HTTPException(404)
    ssh(f"systemctl {action} wg-quick@wg0")
    log(request, {"start": "Started VPN", "stop": "Stopped VPN", "restart": "Restarted VPN"}[action], "")
    refresh()
    return {"ok": True}


@app.post("/api/server/reboot")
def reboot(request: Request, _=Depends(require_admin)):
    ssh("systemd-run --on-active=2 systemctl reboot >/dev/null 2>&1")
    log(request, "Rebooted server", "")
    refresh()
    return {"ok": True}


@app.post("/api/server/power-on")
def power_on(request: Request, _=Depends(require_admin)):
    try:
        do_api(f"/v2/droplets/{state()['DROPLET_ID']}/actions", "POST", {"type": "power_on"})
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"DigitalOcean refused the request ({e.code}).")
    droplet_cache["at"] = 0
    log(request, "Powered server on", "")
    return {"ok": True}


# --------------------------------------------------------------- backups ----
BACKUPS = DATA / "backups"




def create_backup():
    BACKUPS.mkdir(exist_ok=True)
    blob = ssh("tar -C /etc -czf - wireguard", binary=True, timeout=120)
    if len(blob) < 200:
        raise HTTPException(502, "The backup came back empty.")
    name = datetime.now().strftime("wireguard-%Y%m%d-%H%M%S.tar.gz")
    (BACKUPS / name).write_bytes(blob)
    (BACKUPS / name).chmod(0o600)
    return name


backup_failed = {}


def backup_tick(force=False):
    """Take tonight's backup if there is none for today yet, and delete expired ones."""
    done = []
    now = datetime.now()
    BACKUPS.mkdir(exist_ok=True)
    files = [f for f in BACKUPS.iterdir() if BACKUP_RE.match(f.name)]
    today = now.strftime("wireguard-%Y%m%d-")
    if force or (now.hour >= setting("backup_hour") and not any(f.name.startswith(today) for f in files)):
        try:
            name = create_backup()
        except HTTPException as e:
            if backup_failed.get("day") != today:        # one alert a day is enough
                backup_failed["day"] = today
                log(None, "Automatic backup failed", str(e.detail))
                alert("backup", "Bastion: the nightly backup failed",
                      f"Tonight's automatic backup could not be taken: {e.detail}\nThe portal keeps trying every 10 minutes.")
            raise
        backup_failed.pop("day", None)
        log(None, "Automatic backup", name)
        done.append(name)
    for f in files:
        if f.stat().st_mtime < time.time() - setting("backup_keep_days") * 86400:
            f.unlink()
            log(None, "Deleted old backup", f.name)
            done.append("deleted " + f.name)
    return done


def background(fn, every):
    def loop():
        while True:
            try:
                fn()
            except Exception:
                pass
            time.sleep(every)
    threading.Thread(target=loop, daemon=True).start()


@app.get("/api/backups")
def backups(_=Depends(require_login)):
    files = sorted((f for f in BACKUPS.iterdir() if BACKUP_RE.match(f.name)), reverse=True) if BACKUPS.exists() else []
    return {"keep_days": setting("backup_keep_days"), "hour": setting("backup_hour"),
            "files": [{"name": f.name, "size": f.stat().st_size, "time": f.stat().st_mtime} for f in files]}


@app.post("/api/backups")
def make_backup(request: Request, _=Depends(require_admin)):
    name = create_backup()
    log(request, "Created backup", name)
    return {"ok": True, "name": name}


@app.get("/api/backups/{name}")
def get_backup(name: str, request: Request, _=Depends(require_admin)):
    if not BACKUP_RE.match(name) or not (BACKUPS / name).exists():
        raise HTTPException(404, "No such backup.")
    log(request, "Downloaded backup", name)
    return FileResponse(BACKUPS / name, filename=name, media_type="application/gzip")


# -------------------------------------------------------------- settings ----
CONFIG = DATA / "config.env"
SERVER_KEYS = {"usage_days": "USAGE_RETENTION_DAYS", "site_days": "SITE_RETENTION_DAYS"}
LIMITS = {"session_hours": (1, 720), "log_days": (1, 3650), "backup_keep_days": (1, 3650), "backup_hour": (0, 23),
          "usage_days": (1, 3650), "site_days": (1, 3650)}


def config_value(key, default=""):
    m = re.search(rf'^{key}="?([^"\n]*)"?', CONFIG.read_text(), re.M) if CONFIG.exists() else None
    return m.group(1) if m else default


def settings_view():
    out = {k: setting(k) for k in SETTING_DEFAULTS}
    for k, env in SERVER_KEYS.items():
        out[k] = int(config_value(env, "30") or 30)
    out["log_websites"] = config_value("LOG_WEBSITES", "no") == "yes"
    out["limits"] = LIMITS
    return out


@app.get("/api/settings")
def get_settings(_=Depends(require_admin)):
    return settings_view()


@app.put("/api/settings")
async def put_settings(request: Request, _=Depends(require_admin)):
    body = await request.json()
    before = settings_view()
    new = {}
    for k, (lo, hi) in LIMITS.items():
        if k in body:
            try:
                v = int(body[k])
            except (TypeError, ValueError):
                raise HTTPException(400, "Every setting needs a whole number.")
            if not lo <= v <= hi:
                raise HTTPException(400, f"A value is out of range: use {lo} to {hi}.")
            if v != before[k]:
                new[k] = v
    server = {k: v for k, v in new.items() if k in SERVER_KEYS}
    if server:      # the server reads these every minute; config.env keeps ./setup.sh from undoing the change
        ssh("; ".join(f"""sed -i 's/^{SERVER_KEYS[k]}=.*/{SERVER_KEYS[k]}="{v}"/' /etc/wireguard/vpn.env"""
                      for k, v in server.items()))
        text = CONFIG.read_text()
        for k, v in server.items():
            text = re.sub(rf'^({SERVER_KEYS[k]}=)"?[^"\s#]*"?', rf'\g<1>"{v}"', text, flags=re.M)
        CONFIG.write_text(text)
        usage_cache.clear(); sites_cache.clear(); health_cache.clear()
    for k, v in new.items():
        if k in SETTING_DEFAULTS:
            set_setting(k, v)
    if new:
        log(request, "Changed settings", ", ".join(f"{k.replace('_', ' ')} {before[k]} to {v}" for k, v in new.items()))
    return settings_view()


# ---------------------------------------------------- alerts and reports ----
# Off until an administrator fills in where messages go (email, a chat webhook, or both).
ALERT_EVENTS = {
    "down": "The VPN server cannot be reached, or the VPN service has stopped",
    "disk": "The server's disk is more than 90% full",
    "transfer": "More than 80% of the month's included data transfer is used",
    "new_location": "A user connects from a country or provider they have not used before",
    "backup": "The nightly backup fails",
}
ALERT_DEFAULT = {"enabled": False, "webhook": "", "report": "off", "events": {k: True for k in ALERT_EVENTS},
                 "email": {"host": "", "port": 587, "security": "starttls", "user": "", "password": "",
                           "sender": "", "to": ""}}
alert_state = {"misses": 0}


def alert_cfg():
    cfg = json.loads(json.dumps(ALERT_DEFAULT))
    saved = setting("alerts", {}) or {}
    for k, v in saved.items():
        if isinstance(cfg.get(k), dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


def alert_channels(cfg):
    out = []
    if cfg["email"]["host"] and cfg["email"]["to"]:
        out.append("email")
    if cfg["webhook"]:
        out.append("webhook")
    return out


def send_email(e, subject, text):
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, e["sender"] or e["user"], e["to"]
    msg.set_content(text)
    cls = smtplib.SMTP_SSL if e["security"] == "ssl" else smtplib.SMTP
    with cls(e["host"], int(e["port"]), timeout=20) as smtp:
        if e["security"] == "starttls":
            smtp.starttls()
        if e["user"]:
            smtp.login(e["user"], e["password"])
        smtp.send_message(msg)


def send_webhook(url, subject, text):
    body = f"{subject}\n{text}"
    req = urllib.request.Request(url, method="POST", headers={"Content-Type": "application/json", "User-Agent": "curl/8.7.1"},
                                 data=json.dumps({"text": body, "content": body[:1900]}).encode())   # Slack/Teams read "text", Discord "content"
    urllib.request.urlopen(req, timeout=20).close()


def deliver(cfg, subject, text):
    """Send to every configured place. Returns {channel: error or ''}."""
    result = {}
    for ch in alert_channels(cfg):
        try:
            send_email(cfg["email"], subject, text) if ch == "email" else send_webhook(cfg["webhook"], subject, text)
            result[ch] = ""
        except Exception as e:
            result[ch] = str(e)[:300] or type(e).__name__
    return result


def alert(event, subject, text):
    cfg = alert_cfg()
    if not cfg["enabled"] or (event in ALERT_EVENTS and not cfg["events"].get(event, True)):
        return
    for ch, err in deliver(cfg, subject, text).items():
        if err:
            log(None, "Alert not delivered", f"{ch}: {err}")
        else:
            log(None, "Sent alert" if event != "report" else "Sent report", f"{subject} ({ch})")


def flip(key, bad, subject_bad, text_bad, subject_ok, event):
    """Alert once when a problem starts and once when it clears."""
    state = setting("alert_state", {}) or {}
    if bool(state.get(key)) == bool(bad):
        return
    state[key] = bool(bad)
    set_setting("alert_state", state)
    if bad:
        alert(event, subject_bad, text_bad)
    elif subject_ok:
        alert(event, subject_ok, "The earlier problem has cleared.")


def local_tz_minutes():
    return -int(datetime.now().astimezone().utcoffset().total_seconds() // 60)


def size(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" or n >= 100 else f"{n:.1f} {unit}"
        n /= 1000


def report_text(range_key):
    data = usage_report(range_key, local_tz_minutes())
    words = {"24h": "the last 24 hours", "7d": "the last 7 days"}[range_key]
    st = current_status(60)
    lines = [f"Bastion report for {words}", ""]
    lines.append("Server: " + ("running" if st.get("reachable") and st.get("service") == "active" else "NOT running"))
    if st.get("month") and (st.get("droplet") or {}).get("transfer_tb"):
        lines.append(f"Data sent this month: {size(st['month']['bytes'])} of {st['droplet']['transfer_tb']} TB included")
    users = sorted(data["users"], key=lambda u: -(u["down"] + u["up"]))
    lines += ["", f"Users with traffic: {len(users)}"]
    for u in users:
        lines.append(f"  {u['name']}: {size(u['down'])} downloaded, {size(u['up'])} uploaded, "
                     f"{u.get('connections', 0)} connections")
    flagged = [s for s in data["sessions"] if s.get("new_country") or s.get("new_network")]
    lines += ["", f"Connections: {len(data['sessions'])}, of which {len(flagged)} from a new country or provider"]
    for s in flagged[:20]:
        lines.append(f"  {s['name']} from {', '.join(x for x in (s['city'], s['country']) if x)} ({s['org']})")
    return "\n".join(lines)


def alert_tick():
    cfg = alert_cfg()
    if not cfg["enabled"] or not alert_channels(cfg):
        return
    st = current_status(45)
    ok = bool(st.get("reachable")) and st.get("service") == "active"
    alert_state["misses"] = 0 if ok else alert_state["misses"] + 1
    if ok or alert_state["misses"] >= 2:        # one missed check is not an outage
        why = st.get("error", "no answer") if not st.get("reachable") else "the VPN service is stopped"
        flip("down", not ok, "Bastion is DOWN", f"Users cannot connect: {why}.", "Bastion is running again", "down")
    if st.get("reachable"):
        pct = 100 * st["disk_used"] / st["disk_total"]
        flip("disk", pct >= 90, "Bastion: disk nearly full", f"The server's disk is {pct:.0f}% full.",
             "Bastion: disk space is fine again", "disk")
    allowance = ((st.get("droplet") or {}).get("transfer_tb") or 0) * 1e12
    if allowance and st.get("month"):
        used = st["month"]["bytes"]
        flip("transfer:" + st["month"]["month"], used >= 0.8 * allowance, "Bastion: monthly data nearly used up",
             f"{size(used)} of the {st['droplet']['transfer_tb']} TB included this month has been used. "
             "DigitalOcean charges for anything beyond it.", None, "transfer")
    if cfg["events"].get("new_location", True) and st.get("reachable"):
        seen = setting("alert_seen", []) or []
        since = setting("alert_since", time.time())
        fresh = []
        for s in usage_report("24h", 0)["sessions"]:
            key = f"{s['name']}|{s['started']}|{s['source']}"
            if (s.get("new_country") or s.get("new_network")) and s["started"] >= since and key not in seen:
                fresh.append(s); seen.append(key)
        if fresh:
            set_setting("alert_seen", seen[-500:])
            for s in fresh:
                what = "a new country" if s.get("new_country") else "a new provider"
                where = ", ".join(x for x in (s["city"], s["country"]) if x)
                alert("new_location", f"Bastion: {s['name']} connected from {what}",
                      f"{s['name']} connected from {s['source']}: {where} ({s['org']}). "
                      "They have not connected from there before.")
    # Scheduled report: daily, or weekly on Monday, at 08:00 on this machine's clock.
    now = datetime.now()
    if cfg["report"] in ("daily", "weekly") and now.hour >= 8 and (cfg["report"] == "daily" or now.weekday() == 0):
        today = now.strftime("%Y-%m-%d")
        if setting("report_last", "") != today:
            set_setting("report_last", today)
            period = "24h" if cfg["report"] == "daily" else "7d"
            alert("report", f"Bastion {cfg['report']} report", report_text(period))


def alerts_view():
    cfg = alert_cfg()
    cfg["email"]["has_password"] = bool(cfg["email"].pop("password"))
    cfg["channels"] = alert_channels(cfg)
    cfg["event_labels"] = ALERT_EVENTS
    return cfg


@app.get("/api/alerts")
def get_alerts(_=Depends(require_admin)):
    return alerts_view()


@app.put("/api/alerts")
async def put_alerts(request: Request, _=Depends(require_admin)):
    body = await request.json()
    old = alert_cfg()
    e = body.get("email") or {}
    try:
        port = int(e.get("port") or 587)
    except (TypeError, ValueError):
        raise HTTPException(400, "The mail server port must be a number.")
    security = e.get("security", "starttls")
    report = body.get("report", "off")
    webhook = str(body.get("webhook", "")).strip()[:500]
    if security not in ("starttls", "ssl", "none") or report not in ("off", "daily", "weekly") or not 1 <= port <= 65535:
        raise HTTPException(400, "One of the choices is not valid.")
    if webhook and not re.match(r"^https?://[^\s]+$", webhook):
        raise HTTPException(400, "The webhook link must start with https://")
    to = ", ".join(a.strip() for a in str(e.get("to", "")).split(",") if a.strip())
    if any(not EMAIL_RE.match(a) for a in to.split(", ") if a):
        raise HTTPException(400, "One of the email addresses does not look right.")
    new = {"enabled": bool(body.get("enabled")), "webhook": webhook, "report": report,
           "events": {k: bool((body.get("events") or {}).get(k, True)) for k in ALERT_EVENTS},
           "email": {"host": str(e.get("host", "")).strip()[:200], "port": port, "security": security,
                     "user": str(e.get("user", "")).strip()[:200],
                     "password": str(e["password"])[:500] if e.get("password") else old["email"]["password"],
                     "sender": str(e.get("sender", "")).strip()[:200], "to": to[:1000]}}
    if not new["email"]["host"]:
        new["email"]["password"] = ""
    if new["enabled"] and not alert_channels(new):
        raise HTTPException(400, "Fill in an email server and recipient, or a webhook link, before turning alerts on.")
    if new["enabled"] and not old["enabled"]:
        set_setting("alert_since", time.time())
        set_setting("alert_state", {})
    set_setting("alerts", new)
    log(request, "Changed alert settings",
        f'{"on" if new["enabled"] else "off"}; sends to: {", ".join(alert_channels(new)) or "nowhere"}; report: {report}')
    return alerts_view()


@app.post("/api/alerts/test")
def test_alerts(request: Request, sess=Depends(require_admin)):
    cfg = alert_cfg()
    if not alert_channels(cfg):
        raise HTTPException(400, "Save an email server and recipient, or a webhook link, first.")
    result = deliver(cfg, "Bastion: test message",
                     f"This is a test sent from the VPN portal by {sess['user']}. Alerts will arrive like this.")
    log(request, "Sent test alert", "; ".join(f"{ch}: {err or 'delivered'}" for ch, err in result.items()))
    return {"result": result}


@app.get("/api/guide")
def guide(_=Depends(require_login)):
    pdf = DATA / "docs" / "VPN-User-Guide.pdf"
    if not pdf.exists():
        raise HTTPException(404, "The user guide has not been built yet. Run ./build-guide.sh.")
    return FileResponse(pdf, filename="VPN-User-Guide.pdf", media_type="application/pdf")


import_old_log()
bootstrap_accounts()
background(geo_update, 86400)
background(backup_tick, 600)
background(alert_tick, 60)


@app.exception_handler(HTTPException)
async def http_error(request, exc):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


ASSET_VERSION = hashlib.sha256(b"".join((STATIC / f).read_bytes() for f in ("app.js", "app.css"))).hexdigest()[:10]


@app.get("/")
def index():
    # The version in the address makes every browser fetch the new script and styles after an update.
    page = (STATIC / "index.html").read_text().replace('"app.css"', f'"app.css?v={ASSET_VERSION}"') \
                                             .replace('"app.js"', f'"app.js?v={ASSET_VERSION}"')
    return Response(page, media_type="text/html", headers={"Cache-Control": "no-store"})


app.mount("/", StaticFiles(directory=STATIC), name="static")
