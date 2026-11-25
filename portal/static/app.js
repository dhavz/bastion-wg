"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let S = null;            // latest status from the server
let ME = null;           // the signed-in portal account
const isAdmin = () => !!ME && ME.role === "admin";
let tab = "overview";
let pollTimer = null;
let busy = false;

// ---------------------------------------------------------------- helpers --
function bytes(n) {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function speed(bps) {
  if (!bps || bps < 500) return "0";
  if (bps < 1e6) return `${Math.round(bps / 1e3)} kbps`;
  return `${(bps / 1e6).toFixed(bps < 1e7 ? 1 : 0)} Mbps`;
}
function ago(sec) {
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}
function duration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dateTime = (t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// "Toronto, Canada (Bell Canada)" from a location record; city is approximate.
function place(g) {
  if (!g) return "";
  const where = [g.city, g.country].filter(Boolean).join(", ");
  return where && g.org ? `${where} (${g.org})` : where || g.org || "";
}

function toast(text, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "x-portal": "1", ...(options.body ? { "content-type": "application/json" } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Run an action, show the outcome, refresh.
async function act(fn, done) {
  if (busy) return;
  busy = true;
  try { await fn(); if (done) toast(done); await refresh(); }
  catch (e) { if (e.message !== "Signed out") toast(e.message, true); }
  finally { busy = false; }
}

function confirmDialog(title, text, okLabel) {
  return new Promise((resolve) => {
    const d = $("#dlg-confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    $("#confirm-ok").textContent = okLabel;
    const ok = $("#confirm-ok");
    const finish = (v) => { ok.onclick = null; d.onclose = null; if (d.open) d.close(); resolve(v); };
    ok.onclick = () => finish(true);
    d.onclose = () => finish(false);
    d.showModal();
  });
}

function userState(u) {
  if (!u.enabled) return { cls: "bad", label: "Suspended" };
  if (u.connected) return { cls: "good", label: "Connected" };
  if (!u.handshake) return { cls: "hollow", label: "Never connected" };
  return { cls: "", label: "Offline" };
}
const statusHtml = (st) => `<span class="status"><i class="dot ${st.cls}"></i>${esc(st.label)}</span>`;

function serverState() {
  if (!S) return { cls: "", label: "Loading" };
  if (!S.reachable) return { cls: "bad", label: S.droplet && S.droplet.status === "off" ? "Server is powered off" : "Server unreachable" };
  if (S.service !== "active") return { cls: "bad", label: "VPN is stopped" };
  if (S.reboot_required) return { cls: "warn", label: "Running, restart pending" };
  return { cls: "good", label: "VPN is running" };
}

// ------------------------------------------------------------------ pages --
// Every table shows one page at a time. paginate() returns the rows for the current page
// and draws the controls into #<id>-pager; `again` re-renders the table after a change.
const pageOf = {};
const PAGE_SIZES = [25, 50, 100, 250];
let perPageAll = +localStorage.getItem("perPage") || 50;

function paginate(id, items, again, fixed) {
  const perPage = fixed || perPageAll;     // short lists in side panels use a fixed, smaller page
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const page = Math.min(Math.max(1, pageOf[id] || 1), pages);
  pageOf[id] = page;
  const start = (page - 1) * perPage;
  const el = $(`#${id}-pager`);
  el.hidden = items.length === 0 || (!!fixed && pages === 1);   // a short side list needs no controls
  const html = `
    <span>Showing ${(start + 1).toLocaleString()} to ${Math.min(start + perPage, items.length).toLocaleString()} of ${items.length.toLocaleString()}</span>
    <div class="pager-controls">
      ${fixed ? "" : `<label>Rows per page
        <select data-size aria-label="Rows per page">${PAGE_SIZES.map((n) => `<option ${n === perPage ? "selected" : ""}>${n}</option>`).join("")}</select>
      </label>`}
      <button class="btn small" data-page="-1" ${page === 1 ? "disabled" : ""}>Previous</button>
      <span>Page ${page} of ${pages}</span>
      <button class="btn small" data-page="1" ${page === pages ? "disabled" : ""}>Next</button>
    </div>`;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }   // leave an open menu alone
  el.onclick = (e) => {
    const b = e.target.closest("[data-page]");
    if (!b || b.disabled) return;
    pageOf[id] = page + +b.dataset.page;
    again();
    el.closest(".panel").scrollIntoView({ block: "nearest" });
  };
  el.onchange = (e) => {
    if (!e.target.matches("[data-size]")) return;
    perPageAll = +e.target.value;
    localStorage.setItem("perPage", perPageAll);
    Object.keys(pageOf).forEach((k) => (pageOf[k] = 1));
    again();
  };
  return items.slice(start, start + perPage);
}
const firstPage = (...ids) => ids.forEach((id) => (pageOf[id] = 1));

// ------------------------------------------------------------------ login --
function showLogin() {
  clearInterval(pollTimer);
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#username").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { username: $("#username").value, password: $("#password").value } });
    $("#password").value = "";
    start();
  } catch (err) { $("#login-error").textContent = err.message; }
});

$("#signout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ------------------------------------------------------------------- tabs --
function show(name) {
  tab = name;
  $$(".view").forEach((v) => (v.hidden = v.id !== `tab-${name}`));
  $$(".tab").forEach((t) => t.dataset.tab === name ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current"));
  history.replaceState(null, "", `#${name}`);
  render();
  if (name === "server") { loadBackups(); loadHistory(); }
  if (name === "usage") loadUsage();
  if (name === "websites") loadSites();
  if (name === "activity") loadActivity();
  if (name === "admin") loadAdmin();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.tab)));
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) show(go.dataset.goto);
  const close = e.target.closest("[data-close]");
  if (close) close.closest("dialog").close();
});

// --------------------------------------------------------------- overview --
function renderRoute() {
  const users = S.users || [];
  const online = users.filter((u) => u.connected).length;
  const st = serverState();
  const flowing = S.reachable && (S.down_bps > 2000 || S.up_bps > 2000);
  const wire = (label) => `
    <div class="wire ${flowing ? "on" : ""}">
      <div class="wire-label">${label}</div>
      <svg preserveAspectRatio="none" aria-hidden="true">
        <line class="rail" x1="0" y1="50%" x2="100%" y2="50%"/>
        <line class="flow back" x1="0" y1="38%" x2="100%" y2="38%" stroke="var(--series-down)"/>
        <line class="flow" x1="0" y1="62%" x2="100%" y2="62%" stroke="var(--series-up)"/>
      </svg>
    </div>`;
  $("#route").innerHTML = `
    <div class="stop">
      <div class="what">Your users</div>
      <div class="big">${online} <span style="font-size:18px;font-weight:500;color:var(--ink-2)">of ${users.length} connected</span></div>
      <div class="sub">Encrypted WireGuard tunnel</div>
    </div>
    ${wire(S.reachable ? `${speed(S.down_bps)} down, ${speed(S.up_bps)} up` : "")}
    <div class="stop mid">
      <div class="what">${esc(serverPlace().city ? serverPlace().city + " server" : "VPN server")}</div>
      <div class="big">${esc(S.server_ip || "")}</div>
      ${statusHtml(st)}
    </div>
    ${wire("")}
    <div class="stop end">
      <div class="what">Internet</div>
      <div class="big">${esc(serverPlace().country || "The internet")}</div>
      <div class="sub">${serverPlace().city ? `Websites see the ${esc(serverPlace().city)} address` : "Websites see the server's address"}</div>
    </div>`;
}

// DigitalOcean region slug -> { city, country } for the exit label. Region-agnostic.
const DO_REGIONS = {
  nyc: ["New York", "USA"], sfo: ["San Francisco", "USA"], tor: ["Toronto", "Canada"],
  lon: ["London", "UK"], ams: ["Amsterdam", "Netherlands"], fra: ["Frankfurt", "Germany"],
  sgp: ["Singapore", "Singapore"], blr: ["Bangalore", "India"], syd: ["Sydney", "Australia"],
  atl: ["Atlanta", "USA"],
};
function serverPlace() {
  const slug = ((S.droplet && S.droplet.region) || "").toLowerCase().replace(/[0-9]/g, "");
  const p = DO_REGIONS[slug];
  return p ? { city: p[0], country: p[1] } : { city: "", country: "" };
}

function renderTiles() {
  const users = S.users || [];
  const online = users.filter((u) => u.connected).length;
  const suspended = users.filter((u) => !u.enabled).length;
  const d = S.droplet || {};
  const allowance = (d.transfer_tb || 0) * 1e12;
  const used = S.month ? S.month.bytes : null;
  const pct = allowance && used != null ? Math.min(100, (used / allowance) * 100) : 0;
  const level = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
  $("#tiles").innerHTML = `
    <div class="glass tile">
      <div class="what">Connected now</div>
      <div class="big">${online}</div>
      <div class="sub">${users.length} users${suspended ? `, ${suspended} suspended` : ""}</div>
    </div>
    <div class="glass tile">
      <div class="what">Speed right now</div>
      <div class="big">${speed(S.down_bps + S.up_bps)}</div>
      <div class="sub">${speed(S.down_bps)} down, ${speed(S.up_bps)} up</div>
    </div>
    <div class="glass tile">
      <div class="what">Data sent in ${esc(S.month ? S.month.month : "this month")}</div>
      <div class="big">${used == null ? "Unknown" : bytes(used)}</div>
      <div class="meter" role="img" aria-label="${pct.toFixed(1)} percent of the monthly allowance"><i class="${level}" style="width:${pct}%"></i></div>
      <div class="sub">${allowance ? `of ${d.transfer_tb} TB included${level === "bad" ? ". Nearly used up" : level === "warn" ? ". Getting high" : ""}` : "Allowance unknown"}. Approximate.</div>
    </div>
    <div class="glass tile">
      <div class="what">Running without a restart for</div>
      <div class="big">${S.reachable ? duration(S.uptime) : "Offline"}</div>
      <div class="sub">${esc(d.size || "")}${d.price_monthly ? `, $${d.price_monthly} a month` : ""}</div>
    </div>`;
}

function meterRow(label, pct, text) {
  const level = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "";
  const note = level === "bad" ? " (very high)" : level === "warn" ? " (high)" : "";
  return `<div class="health-row">
    <div class="top"><b>${label}</b><span>${text}${note}</span></div>
    <div class="meter"><i class="${level}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
  </div>`;
}

function renderHealth() {
  if (!S.reachable) { $("#health").innerHTML = `<p class="muted">No readings while the server cannot be reached.</p>`; return; }
  const mem = (S.mem_used / S.mem_total) * 100, disk = (S.disk_used / S.disk_total) * 100;
  $("#health").innerHTML =
    meterRow("Processor", S.cpu_percent ?? 0, S.cpu_percent == null ? "measuring" : `${S.cpu_percent.toFixed(0)}%`) +
    meterRow("Memory", mem, `${bytes(S.mem_used)} of ${bytes(S.mem_total)}`) +
    meterRow("Disk", disk, `${bytes(S.disk_used)} of ${bytes(S.disk_total)}`) +
    `<div class="facts">
      <div><span class="k">VPN service</span><span class="v">${statusHtml(serverState())}</span></div>
      <div><span class="k">Starts on boot</span><span class="v">${S.boot_enabled ? "Yes" : "No"}</span></div>
      <div><span class="k">Load (1, 5, 15 min)</span><span class="v">${S.load.map((x) => x.toFixed(2)).join(", ")} on ${S.cpus} cores</span></div>
      <div><span class="k">Usage recording</span><span class="v">${S.usage_timer === "active" ? "Recording" : "Stopped"}</span></div>
      <div><span class="k">Website log</span><span class="v">${S.site_logging === "off" ? "Turned off" : S.site_logging === "active" ? "Recording" : "Stopped: users cannot browse"}</span></div>
      <div><span class="k">Security updates</span><span class="v">${S.reboot_required ? "Restart pending, runs itself at 08:30 UTC" : "Up to date"}</span></div>
    </div>`;
}

function renderLive() {
  const on = (S.users || []).filter((u) => u.connected);
  if (!on.length) {
    $("#live").innerHTML = `<p class="empty">Nobody is connected at the moment. Users appear here within a few seconds of activating their tunnel.</p>`;
    return;
  }
  $("#live").innerHTML = `<div class="live-list">${on.map((u) => `
    <div class="live-item">
      <div class="who"><b>${esc(u.name)}</b><span>${esc(u.endpoint_ip || "unknown address")}${place(u.location) ? `, ${esc(place(u.location))}` : ""}</span></div>
      <div class="rate">
        <div><i style="background:var(--series-down)"></i>${speed(u.down_bps)} down</div>
        <div><i style="background:var(--series-up)"></i>${speed(u.up_bps)} up</div>
      </div>
    </div>`).join("")}</div>`;
}

// Line chart: two series over time, one axis (bits per second).
let chartHover = null;
function renderChart() {
  const box = $("#chart");
  const pts = (S.history || []).map(([t, d, u]) => ({ t, d, u }));
  if (pts.length < 2) {
    box.innerHTML = `<div class="chart-empty">Collecting readings. The graph fills in while this page stays open.</div>`;
    return;
  }
  const W = box.clientWidth, H = box.clientHeight;
  const m = { l: 78, r: 14, t: 10, b: 26 };
  const t1 = pts[pts.length - 1].t, t0 = Math.min(pts[0].t, t1 - 120);
  const peak = Math.max(1e6, ...pts.map((p) => Math.max(p.d, p.u)));
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].map((x) => x * 1e6).find((s) => peak / s <= 4) || 1e9;
  const top = Math.ceil(peak / step) * step;
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / top) * (H - m.t - m.b);
  const path = (k) => {
    let out = "";
    pts.forEach((p, i) => {
      const gap = i === 0 || p.t - pts[i - 1].t > 20;   // break the line where the page was closed
      out += `${gap ? "M" : "L"}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`;
    });
    return out;
  };
  let grid = "";
  for (let v = 0; v <= top; v += step) {
    grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>
             <text class="axis" x="${m.l - 10}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? "0" : speed(v)}</text>`;
  }
  const ticks = W < 640 ? 2 : 4;
  // Short spans need seconds, or neighbouring ticks read the same.
  const tickLabel = (t) => t1 - t0 < 600 ? new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : clock(t);
  let xt = "";
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    xt += `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === ticks ? "end" : "middle"}">${tickLabel(t)}</text>`;
  }
  box.innerHTML = `
    <svg role="img" aria-label="Download and upload speed over time">
      ${grid}${xt}
      <path class="line" d="${path("u")}" stroke="var(--series-up)"/>
      <path class="line" d="${path("d")}" stroke="var(--series-down)"/>
      <g id="hover" hidden>
        <line class="cross" y1="${m.t}" y2="${H - m.b}"/>
        <circle class="pt" r="5" fill="var(--series-up)" data-k="u"/>
        <circle class="pt" r="5" fill="var(--series-down)" data-k="d"/>
      </g>
    </svg>
    <div class="tip" hidden></div>`;

  const hover = $("#hover", box), tip = $(".tip", box);
  const place = (px) => {
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    hover.removeAttribute("hidden");
    const cx = x(best.t);
    $(".cross", hover).setAttribute("x1", cx); $(".cross", hover).setAttribute("x2", cx);
    $$("circle", hover).forEach((c) => { c.setAttribute("cx", cx); c.setAttribute("cy", y(best[c.dataset.k])); });
    tip.hidden = false;
    tip.innerHTML = `<div class="t">${new Date(best.t * 1000).toLocaleTimeString()}</div>
      <div><i class="swatch" style="background:var(--series-down)"></i>Download<b>${speed(best.d)}</b></div>
      <div><i class="swatch" style="background:var(--series-up)"></i>Upload<b>${speed(best.u)}</b></div>`;
    const left = cx + 14 + tip.offsetWidth > W ? cx - 14 - tip.offsetWidth : cx + 14;
    tip.style.left = `${left}px`; tip.style.top = `${m.t + 6}px`;
  };
  box.onmousemove = (e) => { chartHover = e.clientX - box.getBoundingClientRect().left; place(chartHover); };
  box.onmouseleave = () => { chartHover = null; hover.setAttribute("hidden", ""); tip.hidden = true; };
  if (chartHover != null) place(chartHover);   // keep the tooltip through live updates
}

// ------------------------------------------------------------------ users --
// Update only the cells that changed, so buttons are not replaced under the pointer.
function patchRows(tbody, rows) {
  const have = new Map($$("tr", tbody).map((tr) => [tr.dataset.key, tr]));
  rows.forEach((r, i) => {
    let tr = have.get(r.key);
    if (!tr) { tr = document.createElement("tr"); tr.dataset.key = r.key; r.cells.forEach(() => tr.append(document.createElement("td"))); }
    have.delete(r.key);
    tr.className = r.cls || "";
    r.cells.forEach((c, j) => {
      const td = tr.children[j];
      if (td.dataset.html !== c.html) { td.innerHTML = c.html; td.dataset.html = c.html; td.className = c.cls || ""; }
    });
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
  });
  have.forEach((tr) => tr.remove());
}

function renderUsers() {
  const all = S.users || [];
  const q = $("#search").value.trim().toLowerCase();
  const list = all.filter((u) => !q || u.name.includes(q) || (u.email || "").toLowerCase().includes(q));
  const online = all.filter((u) => u.connected).length;
  $("#users-summary").textContent = `${all.length} ${all.length === 1 ? "user" : "users"}, ${online} connected`;

  const rows = paginate("users", list, renderUsers).map((u) => {
    const st = userState(u);
    const n = esc(u.name);
    return {
      key: u.name, cls: u.enabled ? "" : "off",
      cells: [
        { html: `<div class="who"><b>${n}</b><span>${esc(u.email || "No email on file")}</span></div>` },
        { html: statusHtml(st) },
        { html: u.device ? esc(u.device) : `<span style="color:var(--ink-3)">Not known yet</span>` },
        { html: esc(u.ip), cls: "fig" },
        { html: u.connected && u.endpoint_ip ? `${esc(u.endpoint_ip)}<span class="place">${esc(place(u.location))}</span>` : "", cls: "fig" },
        { html: !u.enabled ? "" : u.connected ? "Now" : u.handshake ? ago(S.time - u.handshake) : "" },
        { html: bytes(u.downloaded), cls: "num" },
        { html: bytes(u.uploaded), cls: "num" },
        { html: u.connected ? `${speed(u.down_bps)} down, ${speed(u.up_bps)} up` : "", cls: "num" },
        { html: !isAdmin() ? "" : `<div class="row-actions">
            <a class="btn small" href="/api/users/${n}/profile" download="${n}.conf">Download profile</a>
            <button class="btn small" data-act="qr" data-name="${n}">QR code</button>
            <button class="btn small" data-act="${u.enabled ? "suspend" : "resume"}" data-name="${n}">${u.enabled ? "Suspend" : "Resume"}</button>
            <button class="btn small danger" data-act="delete" data-name="${n}">Delete</button>
          </div>` },
      ],
    };
  });
  patchRows($("#users-body"), rows);
  const empty = $("#users-empty");
  empty.hidden = rows.length > 0;
  empty.textContent = all.length ? "No user matches that search." : S.reachable ? "No users yet. Add the first one with the button above." : "The user list is unavailable while the server cannot be reached.";
}

$("#search").addEventListener("input", () => { firstPage("users"); if (S) renderUsers(); });

$("#users-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const name = b.dataset.name;
  if (b.dataset.act === "qr") {
    $("#qr-title").textContent = `Profile for ${name}`;
    $("#qr-img").src = `/api/users/${name}/qr?t=${Date.now()}`;
    $("#qr-download").href = `/api/users/${name}/profile`;
    $("#qr-download").setAttribute("download", `${name}.conf`);
    $("#dlg-qr").showModal();
  } else if (b.dataset.act === "suspend") {
    if (await confirmDialog(`Suspend ${name}?`, "They are disconnected and cannot reconnect until you resume them. Their profile stays valid.", "Suspend"))
      act(() => api(`/api/users/${name}/suspend`, { method: "POST" }), `Suspended ${name}`);
  } else if (b.dataset.act === "resume") {
    act(() => api(`/api/users/${name}/resume`, { method: "POST" }), `Resumed ${name}`);
  } else if (b.dataset.act === "delete") {
    if (await confirmDialog(`Delete ${name}?`, "Their profile stops working immediately and cannot be restored. To let them back in you would create a new profile and send it again.", "Delete user"))
      act(() => api(`/api/users/${name}`, { method: "DELETE" }), `Deleted ${name}`);
  }
});

$("#add-user").addEventListener("click", () => {
  $("#add-form").reset(); $("#add-error").textContent = "";
  $("#dlg-add").showModal(); $("#new-name").focus();
});
$("#new-name").addEventListener("input", (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""); });
$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#add-submit");
  btn.disabled = true; $("#add-error").textContent = "";
  try {
    const name = $("#new-name").value;
    await api("/api/users", { method: "POST", body: { name, email: $("#new-email").value } });
    $("#dlg-add").close();
    toast(`Added ${name}. Download their profile from the list.`);
    await refresh();
  } catch (err) { $("#add-error").textContent = err.message; }
  finally { btn.disabled = false; }
});

// ------------------------------------------------------------------ usage --
let U = null;                 // latest usage report
const RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
// Mark the chosen period and hide periods longer than the data is kept for.
// Returns false when the chosen period is one of the hidden ones.
function fitRange(seg, chosen, keepDays) {
  let ok = true;
  $$(`${seg} button`).forEach((b) => {
    const tooLong = RANGE_DAYS[b.dataset.range] > keepDays && b.dataset.range !== "24h" && b.dataset.range !== "7d";
    b.hidden = tooLong;
    b.setAttribute("aria-pressed", String(b.dataset.range === chosen));
    if (tooLong && b.dataset.range === chosen) ok = false;
  });
  return ok;
}
let usageRange = localStorage.getItem("usageRange") || "7d";
let usageUser = "";           // "" means everyone
const RANGE_WORDS = { "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days", "90d": "the last 90 days", "365d": "the last year" };
const usageQuery = () => `range=${usageRange}&tz=${new Date().getTimezoneOffset()}`;

async function loadUsage() {
  try {
    U = await api(`/api/usage?${usageQuery()}`);
    if (!fitRange("#usage-seg", usageRange, U.retention_days)) { usageRange = "7d"; return loadUsage(); }
    renderUsage();
  }
  catch (e) { if (e.message !== "Signed out") { $("#usage-summary").textContent = `Usage records are unavailable: ${e.message}`; } }
}
$$("#usage-seg button").forEach((b) => b.addEventListener("click", () => {
  usageRange = b.dataset.range; localStorage.setItem("usageRange", usageRange); firstPage("usage-users", "usage-conns"); loadUsage();
}));
$("#usage-user").addEventListener("change", (e) => { usageUser = e.target.value; firstPage("usage-conns"); renderUsage(); });
$("#usage-users").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-name]");
  if (!tr) return;
  usageUser = usageUser === tr.dataset.name ? "" : tr.dataset.name;
  firstPage("usage-conns");
  renderUsage();
});

function span(sec) {
  if (sec < 60) return "under a minute";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

function renderUsage() {
  const known = new Set(((S && S.users) || []).map((u) => u.name));
  const names = [...new Set([...U.users.map((u) => u.name), ...known])].sort();
  if (usageUser && !names.includes(usageUser)) usageUser = "";
  $("#usage-user").innerHTML = `<option value="">All users</option>` +
    names.map((n) => `<option value="${esc(n)}" ${n === usageUser ? "selected" : ""}>${esc(n)}</option>`).join("");

  const all = U.users.reduce((a, u) => a + u.down + u.up, 0);
  const shown = usageUser ? U.users.filter((u) => u.name === usageUser) : U.users;
  const down = shown.reduce((a, u) => a + u.down, 0), up = shown.reduce((a, u) => a + u.up, 0);
  $("#usage-summary").textContent = `${usageUser || "All users"} in ${RANGE_WORDS[usageRange]}: ${bytes(down)} downloaded, ${bytes(up)} uploaded`;
  $("#usage-chart-title").textContent = usageUser ? `Data used by ${usageUser}` : "Data used by all users";
  $("#usage-chart-sub").textContent = { 3600: "Per hour", 86400: "Per day", 604800: "Per week" }[U.bucket] || "";

  // Per-user table
  const rows = paginate("usage-users", U.users, renderUsage).map((u) => {
    const total = u.down + u.up, pct = all ? (total / all) * 100 : 0;
    return `<tr class="pick ${u.name === usageUser ? "on" : ""}" data-name="${esc(u.name)}" tabindex="0">
      <td><div class="who"><b>${esc(u.name)}</b><span>${esc(u.email || (known.has(u.name) ? "No email on file" : "Removed user"))}</span></div></td>
      <td class="num">${bytes(u.down)}</td><td class="num">${bytes(u.up)}</td><td class="num"><b>${bytes(total)}</b></td>
      <td><div class="share"><div class="meter"><i style="width:${pct}%"></i></div><span>${pct < 0.05 ? "0" : pct.toFixed(pct < 10 ? 1 : 0)}%</span></div></td>
      <td class="num">${u.connections || 0}</td>
      <td class="num">${u.seconds ? span(u.seconds) : ""}</td>
      <td>${u.last ? (U.now - u.last < 120 ? "Connected now" : dateTime(u.last)) : ""}</td></tr>`;
  });
  $("#usage-users").innerHTML = rows.join("");
  $("#usage-users-empty").hidden = rows.length > 0;
  $("#usage-users-empty").textContent = "No traffic was recorded in this period.";

  // Connection log
  const conns = U.sessions.filter((s) => !usageUser || s.name === usageUser);
  $("#usage-conns").innerHTML = paginate("usage-conns", conns, renderUsage).map((s) => `
    <tr><td><b style="font-weight:600">${esc(s.name)}</b></td><td class="fig">${esc(s.source)}</td>
      <td>${esc(place(s))}${s.new_country ? `<span class="chip flag"><i class="dot warn"></i>New country</span>` : s.new_network ? `<span class="chip flag"><i class="dot warn"></i>New provider</span>` : ""}</td>
      <td>${esc(dateTime(s.started))}</td>
      <td>${s.open ? statusHtml({ cls: "good", label: "Still connected" }) : esc(dateTime(s.ended))}</td>
      <td class="num">${span(s.ended - s.started)}</td>
      <td class="num">${bytes(s.down)}</td><td class="num">${bytes(s.up)}</td></tr>`).join("");
  $("#usage-conns-empty").hidden = conns.length > 0;
  $("#usage-conns-empty").textContent = usageUser ? `${usageUser} did not connect in this period.` : "Nobody connected in this period.";
  $("#conn-sub").textContent = `${conns.length} ${conns.length === 1 ? "connection" : "connections"}. Newest first. A change of network starts a new entry.`;

  $("#export-users").href = `/api/usage/export/users?${usageQuery()}`;
  $("#export-connections").href = `/api/usage/export/connections?${usageQuery()}`;
  $("#export-history").href = `/api/usage/export/history?${usageQuery()}`;
  $("#usage-note").textContent = U.recording_since
    ? `Recording began ${dateTime(U.recording_since)} and is anything older than ${U.retention_days} days is deleted automatically. Readings are taken once a minute on the server, whether or not this portal is open. Site names are on the Websites tab.`
    : "Recording has not started yet.";
  renderUsageChart();
}

// Stacked bars: downloaded and uploaded volume per hour, day or week.
function renderUsageChart() {
  const box = $("#usage-chart");
  const B = U.bucket, m = { l: 78, r: 14, t: 10, b: 26 };
  const W = box.clientWidth, H = box.clientHeight;
  const sums = new Map();
  for (const [b, name, d, u] of U.series) {
    if (usageUser && name !== usageUser) continue;
    const s = sums.get(b) || { d: 0, u: 0 };
    s.d += d; s.u += u; sums.set(b, s);
  }
  const slots = [];
  for (let b = U.since; b <= U.now; b += B) slots.push({ t: b, ...(sums.get(b) || { d: 0, u: 0 }) });
  const peak = Math.max(...slots.map((s) => s.d + s.u));
  if (!peak) { box.innerHTML = `<div class="chart-empty">No traffic was recorded in this period.</div>`; return; }

  const mag = Math.pow(10, Math.floor(Math.log10(peak / 4)));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => peak / s <= 4);
  const top = Math.ceil(peak / step) * step;
  const y = (v) => m.t + (1 - v / top) * (H - m.t - m.b);
  const slotW = (W - m.l - m.r) / slots.length;
  const barW = Math.max(2, Math.min(34, slotW - 4));
  const label = (t) => {
    const d = new Date(t * 1000);
    if (B === 3600) return d.toLocaleTimeString([], { hour: "numeric" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const full = (t) => {
    const d = new Date(t * 1000);
    if (B === 3600) return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric" })}`;
    if (B === 604800) return `Week of ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  };

  let grid = "";
  for (let v = 0; v <= top + step / 2; v += step)
    grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>
             <text class="axis" x="${m.l - 10}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? "0" : bytes(v)}</text>`;
  const every = Math.ceil(slots.length / Math.max(2, Math.floor((W - m.l - m.r) / 90)));
  const base = y(0);
  // A bar with a rounded top and a square foot on the baseline.
  const col = (x, yTop, h, fill, round) => {
    if (h <= 0) return "";
    const r = round ? Math.min(4, barW / 2, h) : 0;
    return `<path fill="${fill}" d="M${x},${yTop + h}V${yTop + r}q0,${-r} ${r},${-r}h${barW - 2 * r}q${r},0 ${r},${r}V${yTop + h}z"/>`;
  };
  let bars = "", xt = "";
  slots.forEach((s, i) => {
    const x0 = m.l + i * slotW, x = x0 + (slotW - barW) / 2;
    const hd = base - y(s.d), hu = base - y(s.u), gap = s.d && s.u && hu > 3 ? 2 : 0;
    bars += col(x, base - hd, hd, "var(--series-down)", !s.u) + col(x, base - hd - hu, hu - gap, "var(--series-up)", true);
    bars += `<rect class="bar-hit" data-i="${i}" x="${x0}" y="${m.t}" width="${slotW}" height="${H - m.t - m.b}"/>`;
    if (i % every === 0) xt += `<text class="axis" x="${x0 + slotW / 2}" y="${H - 6}" text-anchor="middle">${label(s.t)}</text>`;
  });
  box.innerHTML = `<svg role="img" aria-label="Data downloaded and uploaded over time">${grid}${xt}${bars}</svg><div class="tip" hidden></div>`;

  const tip = $(".tip", box);
  box.onmousemove = (e) => {
    const hit = e.target.closest(".bar-hit");
    if (!hit) { tip.hidden = true; return; }
    const s = slots[+hit.dataset.i];
    tip.hidden = false;
    tip.innerHTML = `<div class="t">${esc(full(s.t))}</div>
      <div><i class="swatch block" style="background:var(--series-down)"></i>Downloaded<b>${bytes(s.d)}</b></div>
      <div><i class="swatch block" style="background:var(--series-up)"></i>Uploaded<b>${bytes(s.u)}</b></div>`;
    const cx = m.l + (+hit.dataset.i + 0.5) * slotW;
    tip.style.left = `${cx + 16 + tip.offsetWidth > W ? cx - 16 - tip.offsetWidth : cx + 16}px`;
    tip.style.top = `${m.t + 6}px`;
  };
  box.onmouseleave = () => { tip.hidden = true; };
}

// --------------------------------------------------------------- websites --
let Wd = null;                // latest website log
let siteRange = localStorage.getItem("siteRange") || "24h";
let siteUser = "";
const siteOpen = new Set();

async function loadSites() {
  try {
    api("/api/blocking").then((b) => { BL = b; renderBlocking(); if (Wd) renderSites(); }).catch(() => {});
    Wd = await api(`/api/sites?range=${siteRange}`);
    if (!fitRange("#sites-seg", siteRange, Wd.retention_days)) { siteRange = "24h"; return loadSites(); }
    renderSites();
  } catch (e) { if (e.message !== "Signed out") $("#sites-summary").textContent = `The website log is unavailable: ${e.message}`; }
}
$$("#sites-seg button").forEach((b) => b.addEventListener("click", () => {
  siteRange = b.dataset.range; localStorage.setItem("siteRange", siteRange); firstPage("sites"); loadSites();
}));
$("#sites-user").addEventListener("change", (e) => { siteUser = e.target.value; firstPage("sites"); renderSites(); });
$("#sites-search").addEventListener("input", () => { firstPage("sites"); if (Wd) renderSites(); });
$("#sites-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-block]");
  if (b) {
    const site = b.dataset.block, has = BL.domains.includes(site);
    saveBlocking({ domains: has ? BL.domains.filter((d) => d !== site) : [...BL.domains, site] },
      has ? `Unblocked ${site}` : BL.enabled ? `Blocked ${site}` : `Added ${site} to the block list. Blocking is off, so it has no effect yet.`);
    return;
  }
  const tr = e.target.closest("tr[data-site]");
  if (!tr) return;
  siteOpen.has(tr.dataset.site) ? siteOpen.delete(tr.dataset.site) : siteOpen.add(tr.dataset.site);
  renderSites();
});

function renderSites() {
  const names = [...new Set([...Wd.rows.map((r) => r[0]), ...((S && S.users) || []).map((u) => u.name)])].sort();
  if (siteUser && !names.includes(siteUser)) siteUser = "";
  $("#sites-user").innerHTML = `<option value="">All users</option>` +
    names.map((n) => `<option value="${esc(n)}" ${n === siteUser ? "selected" : ""}>${esc(n)}</option>`).join("");
  const q = $("#sites-search").value.trim().toLowerCase();

  const groups = new Map();
  for (const [name, site, domain, hits, first, last, blocked] of Wd.rows) {
    if (siteUser && name !== siteUser) continue;
    if (q && !domain.includes(q)) continue;
    let g = groups.get(site);
    if (!g) groups.set(site, (g = { site, hits: 0, blocked: 0, first, last, users: new Map(), hosts: new Map() }));
    g.hits += hits; g.blocked += blocked || 0; g.first = Math.min(g.first, first); g.last = Math.max(g.last, last);
    g.users.set(name, (g.users.get(name) || 0) + hits);
    const h = g.hosts.get(domain) || new Map();
    h.set(name, (h.get(name) || 0) + hits); g.hosts.set(domain, h);
  }
  const list = [...groups.values()].sort((a, b) => b.hits - a.hits);
  const byHits = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

  $("#sites-body").innerHTML = paginate("sites", list, renderSites).map((g) => {
    const open = siteOpen.has(g.site);
    const main = `<tr class="pick ${open ? "on" : ""}" data-site="${esc(g.site)}" tabindex="0">
      <td><span class="site-name">${esc(g.site)}</span></td>
      <td><div class="chips">${byHits(g.users).map(([n]) => `<span class="chip">${esc(n)}</span>`).join("")}</div></td>
      <td class="num keep">${g.hits.toLocaleString()}</td>
      <td class="keep">${esc(dateTime(g.first))}</td><td class="keep">${esc(dateTime(g.last))}</td>
      <td class="keep" style="text-align:right">
        ${g.blocked ? `<span class="chip flag bad"><i class="dot bad"></i>Blocked ${g.blocked.toLocaleString()} ${g.blocked === 1 ? "time" : "times"}</span>` : ""}
        ${BL && BL.available && isAdmin() ? `<button class="btn small" data-block="${esc(g.site)}" style="margin:0 10px">${BL.domains.includes(g.site) ? "Unblock" : "Block"}</button>` : ""}
        <span style="color:var(--ink-2)">${open ? "Hide details" : `${g.hosts.size} ${g.hosts.size === 1 ? "address" : "addresses"}`}</span></td></tr>`;
    if (!open) return main;
    const hosts = [...g.hosts.entries()].sort((a, b) => byHits(b[1])[0][1] - byHits(a[1])[0][1]);
    return main + `<tr class="detail"><td colspan="6"><div class="hosts">${hosts.map(([d, users]) =>
      `<div><code>${esc(d)}</code><span>${byHits(users).map(([n, c]) => `${esc(n)} ${c.toLocaleString()}`).join(", ")}</span></div>`).join("")}</div></td></tr>`;
  }).join("");

  const empty = $("#sites-empty");
  empty.hidden = list.length > 0;
  empty.textContent = !Wd.enabled ? "Website logging is turned off. Set LOG_WEBSITES to yes in config.env and run ./setup.sh to turn it on."
    : q ? "No site matches that search." : `${siteUser || "Nobody"} looked up any sites in this period.`.replace("Nobody looked up any", "Nobody looked up any");
  if (list.length === 0 && Wd.enabled && !q) empty.textContent = siteUser ? `${siteUser} did not look up any sites in this period.` : "No sites were looked up in this period.";
  $("#sites-summary").textContent = `${list.length.toLocaleString()} ${list.length === 1 ? "site" : "sites"} looked up by ${siteUser || "all users"} in ${RANGE_WORDS[siteRange]}. Busiest first.`;
  $("#export-sites").href = `/api/sites/export?range=${siteRange}${siteUser ? `&user=${encodeURIComponent(siteUser)}` : ""}`;
  $("#sites-note").textContent = Wd.enabled
    ? `This is the name of each site or service a user's device asked for, for example google.com. It does not show which pages were opened or anything that was typed, and much of it is background activity from apps and the operating system rather than sites the person chose to visit. A lookup count is how many times the name was asked for, not time spent. Recording began ${Wd.recording_since ? dateTime(Wd.recording_since) : "recently"}; entries older than ${Wd.retention_days} days are deleted automatically.`
    : "";
}

// --------------------------------------------------------------- blocking --
let BL = null;   // blocking settings from the server

function renderBlocking() {
  const toggle = $("#block-toggle");
  if (!BL.available) {
    $("#block-sub").textContent = "Blocking needs website logging, which is turned off. Set LOG_WEBSITES to yes in config.env and run ./setup.sh.";
    toggle.hidden = true; $("#block-body").innerHTML = "";
    return;
  }
  const lists = BL.categories.filter((c) => c.on).length;
  $("#block-sub").textContent = BL.enabled
    ? `On for every user: ${BL.domains.length} ${BL.domains.length === 1 ? "site" : "sites"} of your own and ${lists} ready-made ${lists === 1 ? "list" : "lists"}.`
    : "Off. Nothing is blocked. Choices below are saved and take effect when you turn blocking on.";
  if (!isAdmin()) { toggle.hidden = true; $("#block-body").innerHTML = ""; return; }
  toggle.hidden = false;
  toggle.textContent = BL.enabled ? "Turn blocking off" : "Turn blocking on";
  toggle.className = BL.enabled ? "btn" : "btn primary";
  const html = `
    <div class="block-grid">
      <div>
        <h3>Sites you block</h3>
        <form class="block-add" id="block-form">
          <input id="block-input" placeholder="example.com" aria-label="Site to block" autocomplete="off">
          <button class="btn" type="submit">Block site</button>
        </form>
        <div class="chips">${BL.domains.map((d) => `<span class="chip">${esc(d)}<button data-unblock="${esc(d)}" aria-label="Unblock ${esc(d)}">&#215;</button></span>`).join("") || `<span class="muted" style="font-size:13px">None yet. A blocked name also covers everything under it, so example.com includes www.example.com.</span>`}</div>
      </div>
      <div>
        <h3>Ready-made lists</h3>
        ${BL.categories.map((c) => `<label class="check"><input type="checkbox" data-cat="${esc(c.key)}" ${c.on ? "checked" : ""}>
          <div>${esc(c.label)}<span>${c.sites ? `${c.sites.toLocaleString()} sites, updated ${dateTime(c.updated)}` : "Downloaded when first used, then refreshed daily"}</span></div></label>`).join("")}
      </div>
    </div>`;
  const body = $("#block-body");
  if (body.dataset.html !== html && document.activeElement !== $("#block-input")) { body.innerHTML = html; body.dataset.html = html; }
}

async function saveBlocking(change, done) {
  if (busy) return;
  busy = true;
  const next = { enabled: BL.enabled, domains: BL.domains, categories: BL.categories.filter((c) => c.on).map((c) => c.key), ...change };
  let ok = false;
  try {
    BL = await api("/api/blocking", { method: "PUT", body: next });
    toast(done); ok = true;
  } catch (e) { if (e.message !== "Signed out") toast(e.message, true); }
  finally { busy = false; $("#block-body").dataset.html = ""; renderBlocking(); renderLists(); if (Wd) renderSites(); }
  return ok;
}

$("#block-toggle").addEventListener("click", async () => {
  if (!BL.enabled && !(await confirmDialog("Turn blocking on?", "The sites and lists you have chosen stop working for every VPN user within a few seconds. Users see the site fail to load, with no explanation.", "Turn blocking on"))) return;
  saveBlocking({ enabled: !BL.enabled }, BL.enabled ? "Blocking turned off" : "Blocking turned on");
});
$("#block-panel").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#block-input").value.trim().toLowerCase();
  if (!v) return;
  $("#block-input").value = ""; $("#block-input").blur();
  saveBlocking({ domains: [...BL.domains, v] }, BL.enabled ? `Blocked ${v}` : `Added ${v}. Blocking is off, so it has no effect yet.`);
});
$("#block-panel").addEventListener("click", (e) => {
  const x = e.target.closest("[data-unblock]");
  if (x) saveBlocking({ domains: BL.domains.filter((d) => d !== x.dataset.unblock) }, `Unblocked ${x.dataset.unblock}`);
});
$("#block-panel").addEventListener("change", (e) => {
  const box = e.target.closest("[data-cat]");
  if (!box) return;
  const on = new Set(BL.categories.filter((c) => c.on).map((c) => c.key));
  box.checked ? on.add(box.dataset.cat) : on.delete(box.dataset.cat);
  saveBlocking({ categories: [...on] }, box.checked ? "List added" : "List removed");
});

// ---------------------------------------------------------------- history --
let HIST = null;
let histRange = localStorage.getItem("histRange") || "24h";

async function loadHistory() {
  $$("#history-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === histRange)));
  try { HIST = await api(`/api/health?range=${histRange}`); renderHistory(); } catch (e) { /* signed out or unreachable */ }
}
$$("#history-seg button").forEach((b) => b.addEventListener("click", () => {
  histRange = b.dataset.range; localStorage.setItem("histRange", histRange); loadHistory();
}));

function renderHistory() {
  // row: [time, processor %, memory %, disk %, load, bytes in, bytes out, users online, readings]
  const pts = HIST.rows.map((r) => ({
    t: r[0], cpu: r[1], mem: r[2], online: r[7],
    out: r[6] == null ? null : (r[6] * 8) / (r[8] * 60), inn: r[5] == null ? null : (r[5] * 8) / (r[8] * 60),
  }));
  $("#history-sub").textContent = `Recorded once a minute on the server and kept for ${HIST.retention_days} days`;
  const o = { gap: HIST.bucket * 2.5, days: histRange !== "24h" };
  miniChart($("#h-traffic"), pts, [{ k: "inn", color: "var(--series-up)", label: "Received" }, { k: "out", color: "var(--series-down)", label: "Sent" }], speed, o);
  miniChart($("#h-online"), pts, [{ k: "online", color: "var(--ink)", label: "Connected" }], (v) => String(Math.round(v)), { ...o, whole: true });
  miniChart($("#h-cpu"), pts, [{ k: "cpu", color: "var(--ink)", label: "Processor" }], (v) => `${Math.round(v)}%`, { ...o, max: 100 });
  miniChart($("#h-mem"), pts, [{ k: "mem", color: "var(--ink)", label: "Memory" }], (v) => `${Math.round(v)}%`, { ...o, max: 100 });
}

// A small line chart over time with a crosshair and tooltip. One value axis.
function miniChart(box, pts, series, fmt, o = {}) {
  const have = pts.filter((p) => series.some((s) => p[s.k] != null));
  if (have.length < 2) { box.innerHTML = `<div class="chart-empty">Not enough readings yet. This fills in as the server records them.</div>`; return; }
  const W = box.clientWidth, H = box.clientHeight, m = { l: 70, r: 12, t: 8, b: 22 };
  const t0 = have[0].t, t1 = have[have.length - 1].t;
  let top = o.max, step;
  if (!top) {
    const peak = Math.max(o.whole ? 2 : 1e-9, ...have.flatMap((p) => series.map((s) => p[s.k] || 0)));
    const mag = Math.pow(10, Math.floor(Math.log10(peak / 2)));
    step = [1, 2, 5, 10].map((k) => k * mag).find((s) => peak / s <= 3);
    if (o.whole) step = Math.max(1, Math.round(step));
    top = Math.ceil(peak / step) * step;
  } else step = top / 2;
  const x = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / top) * (H - m.t - m.b);
  const path = (k) => {
    let out = "", last = null;
    for (const p of have) {
      if (p[k] == null) { last = null; continue; }
      out += `${last == null || p.t - last > o.gap ? "M" : "L"}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`;
      last = p.t;
    }
    return out;
  };
  const when = (t, long) => {
    const d = new Date(t * 1000);
    const day = d.toLocaleDateString([], { month: "short", day: "numeric" }), time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return long ? `${day}, ${time}` : o.days ? day : time;
  };
  let grid = "";
  for (let v = 0; v <= top + step / 2; v += step)
    grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? "0" : fmt(v)}</text>`;
  const xt = [0, 0.5, 1].map((f, i) => `<text class="axis" x="${x(t0 + (t1 - t0) * f)}" y="${H - 5}" text-anchor="${["start", "middle", "end"][i]}">${when(t0 + (t1 - t0) * f)}</text>`).join("");
  box.innerHTML = `<svg role="img" aria-label="${series.map((s) => s.label).join(" and ")} over time">${grid}${xt}
    ${series.map((s) => `<path class="line" d="${path(s.k)}" stroke="${s.color}"/>`).join("")}
    <g class="hov" hidden><line class="cross" y1="${m.t}" y2="${H - m.b}"/>${series.map((s) => `<circle class="pt" r="4" fill="${s.color}" data-k="${s.k}"/>`).join("")}</g>
    </svg><div class="tip" hidden></div>`;
  const hov = $(".hov", box), tip = $(".tip", box);
  box.onmousemove = (e) => {
    const px = e.clientX - box.getBoundingClientRect().left;
    let best = have[0];
    for (const p of have) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    const cx = x(best.t);
    hov.removeAttribute("hidden");
    $(".cross", hov).setAttribute("x1", cx); $(".cross", hov).setAttribute("x2", cx);
    $$("circle", hov).forEach((c) => { const v = best[c.dataset.k]; c.setAttribute("cx", cx); c.setAttribute("cy", y(v || 0)); c.style.display = v == null ? "none" : ""; });
    tip.hidden = false;
    tip.innerHTML = `<div class="t">${esc(when(best.t, true))}</div>` + series.slice().reverse().map((s) =>
      `<div><i class="swatch" style="background:${s.color}"></i>${esc(s.label)}<b>${best[s.k] == null ? "no reading" : fmt(best[s.k])}</b></div>`).join("");
    tip.style.left = `${cx + 12 + tip.offsetWidth > W ? cx - 12 - tip.offsetWidth : cx + 12}px`; tip.style.top = "0px";
  };
  box.onmouseleave = () => { hov.setAttribute("hidden", ""); tip.hidden = true; };
}

// ----------------------------------------------------------------- server --
function renderServer() {
  const d = S.droplet || {};
  $("#server-summary").textContent = d.name ? `${d.name}, ${d.region || ""}` : "";
  const running = S.reachable && S.service === "active";
  const off = !S.reachable && d.status === "off";
  $("#controls").innerHTML = !isAdmin() ? `<p class="muted">Only an administrator can start, stop or restart the server.</p>` : (off ? `
      <div class="control"><div><b>Power on the server</b><span>The server is shut down. Powering on takes about a minute.</span></div>
        <button class="btn primary" data-ctl="power-on">Power on</button></div>` : "") + `
      <div class="control"><div><b>Restart the VPN</b><span>Users drop for a few seconds and reconnect on their own.</span></div>
        <button class="btn" data-ctl="restart" ${S.reachable ? "" : "disabled"}>Restart VPN</button></div>
      <div class="control"><div><b>${running ? "Stop the VPN" : "Start the VPN"}</b><span>${running ? "Everyone is disconnected until you start it again." : "Lets users connect again."}</span></div>
        <button class="btn ${running ? "danger" : "primary"}" data-ctl="${running ? "stop" : "start"}" ${S.reachable ? "" : "disabled"}>${running ? "Stop VPN" : "Start VPN"}</button></div>
      <div class="control"><div><b>Reboot the server</b><span>About one minute of downtime. The VPN starts again by itself.</span></div>
        <button class="btn danger" data-ctl="reboot" ${S.reachable ? "" : "disabled"}>Reboot server</button></div>`;

  const row = (k, v) => (v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : "");
  $("#details").innerHTML =
    row("Public address", S.server_ip) +
    row("Ports", S.reachable ? `UDP ${S.client_port} (profiles) and UDP ${S.wg_port}` : "") +
    row("Location", d.region ? `DigitalOcean, ${d.region}` : "") +
    row("Size", d.size ? `${d.size}: ${d.vcpus} CPU, ${d.memory_mb / 1024} GB memory, ${d.disk_gb} GB disk` : "") +
    row("Cost", d.price_monthly ? `$${d.price_monthly} a month, ${d.transfer_tb} TB transfer included` : "") +
    row("Created", d.created ? new Date(d.created).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }) : "") +
    row("System", S.os ? `${S.os}, kernel ${S.kernel}` : "") +
    row("DNS given to users", S.dns) +
    row("Traffic since last boot", S.reachable ? `${bytes(S.net_tx)} sent, ${bytes(S.net_rx)} received` : "") +
    row("Server public key", S.public_key);
}

$("#controls").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ctl]");
  if (!b) return;
  const c = b.dataset.ctl;
  const ask = {
    restart: ["Restart the VPN?", "Connected users drop for a few seconds, then reconnect on their own.", "Restart VPN", "/api/vpn/restart", "VPN restarted"],
    stop: ["Stop the VPN?", "Every user is disconnected and nobody can connect until you start it again.", "Stop VPN", "/api/vpn/stop", "VPN stopped"],
    start: [null, null, null, "/api/vpn/start", "VPN started"],
    reboot: ["Reboot the server?", "The VPN is unavailable for about a minute. Users reconnect on their own afterwards.", "Reboot server", "/api/server/reboot", "Reboot started. The server will be back in about a minute."],
    "power-on": [null, null, null, "/api/server/power-on", "Powering on. This takes about a minute."],
  }[c];
  if (ask[0] && !(await confirmDialog(ask[0], ask[1], ask[2]))) return;
  act(() => api(ask[3], { method: "POST" }), ask[4]);
});

let backupList = [];
async function loadBackups() {
  try {
    const res = await api("/api/backups");
    backupList = res.files;
    $("#backups-sub").textContent = `Server keys, every user and the recorded history. Taken automatically every night after ${String(res.hour).padStart(2, "0")}:00 and deleted after ${res.keep_days} days.`;
    renderBackups();
  } catch (e) { /* signed out */ }
}
function renderBackups() {
    const list = backupList;
    $("#backups").innerHTML = list.length ? paginate("backups", list, renderBackups, 10).map((b) => `
      <div class="backup">
        <div>${esc(dateTime(b.time))}<span>${esc(b.name)}, ${bytes(b.size)}</span></div>
        ${isAdmin() ? `<a class="btn small" href="/api/backups/${esc(b.name)}" download>Download</a>` : ""}
      </div>`).join("") : `<p class="empty">No backups yet. Create one before making big changes.</p>`;
    if (!list.length) $("#backups-pager").hidden = true;
}
$("#make-backup").addEventListener("click", () =>
  act(async () => { await api("/api/backups", { method: "POST" }); await loadBackups(); }, "Backup created"));

// --------------------------------------------------------------- activity --
let activityList = [];
async function loadActivity() {
  try {
    const res = await api("/api/activity");
    activityList = res.entries;
    $("#activity-sub").textContent = `What has been done through this portal, newest first. Entries older than ${res.retention_days} days are deleted automatically.`;
    renderActivity();
  } catch (e) { /* signed out */ }
}
function renderActivity() {
  $("#activity-body").innerHTML = paginate("activity", activityList, renderActivity).map((a) => `
    <tr><td>${esc(dateTime(a.time))}</td><td><b style="font-weight:600">${esc(a.who)}</b></td><td>${esc(a.action)}</td><td style="white-space:normal">${esc(a.detail)}</td><td class="fig">${esc(a.from)}</td></tr>`).join("");
  $("#activity-empty").hidden = activityList.length > 0;
}

// ----------------------------------------------------------------- render --
function render() {
  if (!S) return;
  const st = serverState();
  $("#top-status").innerHTML = `<i class="dot ${st.cls}"></i>${esc(st.label)}`;
  const banner = $("#banner");
  if (!S.reachable) {
    banner.hidden = false;
    banner.textContent = S.droplet && S.droplet.status === "off"
      ? "The server is powered off. Power it on from the Server tab."
      : `The portal cannot reach the VPN server (${S.error || "no answer"}). It may be rebooting; this page keeps trying.`;
  } else if (S.service !== "active") {
    banner.hidden = false;
    banner.textContent = "The VPN service is stopped, so nobody can connect. Start it from the Server tab.";
  } else banner.hidden = true;

  if (tab === "overview") { renderRoute(); renderTiles(); renderHealth(); renderLive(); renderChart(); }
  if (tab === "users") renderUsers();
  if (tab === "server") renderServer();
}

async function refresh() {
  try { S = await api("/api/status"); render(); }
  catch (e) { /* signed out or network blip; the next poll retries */ }
}

async function start() {
  try { ME = await api("/api/me"); } catch (e) { return; }
  document.body.classList.toggle("viewer", !isAdmin());
  $("#me-btn").textContent = `${ME.name || ME.username}${isAdmin() ? "" : " (viewer)"}`;
  $("#login").hidden = true;
  $("#app").hidden = false;
  const wanted = location.hash.slice(1);
  const tabs = ["overview", "users", "usage", "websites", "server", "activity", ...(isAdmin() ? ["admin"] : [])];
  show(tabs.includes(wanted) ? wanted : "overview");
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) { refresh(); if (tab === "activity") loadActivity(); } }, 3000);
}

window.addEventListener("resize", () => { if (S && tab === "overview") renderChart(); if (U && tab === "usage") renderUsageChart(); if (HIST && tab === "server") renderHistory(); });
setInterval(() => {
  if (document.hidden || $("#app").hidden) return;
  if (tab === "usage") loadUsage();
  if (tab === "websites") loadSites();
  if (tab === "server") { loadHistory(); loadBackups(); }
}, 60000);

// Open the portal if already signed in, otherwise ask for the password.
api("/api/status").then((s) => { S = s; start(); }).catch(() => showLogin());

// --------------------------------------------------------- administration --
let ACC = [];            // portal accounts
let SET = null;          // settings
let AL = null;           // alert settings
let editing = null;      // username being edited in the account dialog, or null when adding

async function loadAdmin() {
  if (!isAdmin()) return;
  try {
    const [a, s, al, bl] = await Promise.all([api("/api/accounts"), api("/api/settings"), api("/api/alerts"), api("/api/blocking")]);
    ACC = a.accounts; SET = s; AL = al; BL = bl;
    renderAccounts(); renderSettings(); renderAlerts(); renderLists();
  } catch (e) { if (e.message !== "Signed out") toast(e.message, true); }
}

function renderAccounts() {
  $("#accounts-body").innerHTML = paginate("accounts", ACC, renderAccounts).map((a) => {
    const u = esc(a.username), mine = a.username === ME.username;
    return `<tr class="${a.disabled ? "off" : ""}">
      <td><div class="who"><b>${u}${mine ? " (you)" : ""}</b><span>${esc(a.name || "No name given")}</span></div></td>
      <td>${a.role === "admin" ? "Administrator" : "Viewer"}</td>
      <td>${statusHtml(a.disabled ? { cls: "bad", label: "Turned off" } : { cls: "good", label: "Can sign in" })}</td>
      <td>${a.last_login ? esc(dateTime(a.last_login)) : "Never"}</td>
      <td>${esc(dateTime(a.created))}</td>
      <td><div class="row-actions">
        <button class="btn small" data-acc="edit" data-name="${u}">Edit</button>
        ${mine ? "" : `<button class="btn small" data-acc="${a.disabled ? "on" : "off"}" data-name="${u}">${a.disabled ? "Turn on" : "Turn off"}</button>
        <button class="btn small danger" data-acc="delete" data-name="${u}">Delete</button>`}
      </div></td></tr>`;
  }).join("");
}

function openAccount(account) {
  editing = account ? account.username : null;
  $("#account-form").reset(); $("#account-error").textContent = "";
  $("#account-title").textContent = account ? `Edit ${account.username}` : "Add portal account";
  $("#account-submit").textContent = account ? "Save" : "Add account";
  $("#acc-username").value = account ? account.username : "";
  $("#acc-username").disabled = !!account;
  $("#acc-name").value = account ? account.name : "";
  $("#acc-role").value = account ? account.role : "viewer";
  $("#acc-role").disabled = !!account && account.username === ME.username;
  $("#acc-password").required = !account;
  $("#acc-password-label").textContent = account ? "New password (leave empty to keep the current one)" : "Password";
  $("#acc-password-hint").textContent = account
    ? "At least 10 characters. Setting a new password signs this person out everywhere."
    : "At least 10 characters. Give it to the person privately; they can change it after signing in.";
  $("#dlg-account").showModal();
  (account ? $("#acc-name") : $("#acc-username")).focus();
}
$("#add-account").addEventListener("click", () => openAccount(null));
$("#acc-username").addEventListener("input", (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""); });
$("#account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#account-error").textContent = "";
  const body = { name: $("#acc-name").value, role: $("#acc-role").value };
  if ($("#acc-password").value) body.password = $("#acc-password").value;
  try {
    if (editing) await api(`/api/accounts/${encodeURIComponent(editing)}`, { method: "PUT", body });
    else await api("/api/accounts", { method: "POST", body: { ...body, username: $("#acc-username").value } });
    $("#dlg-account").close();
    toast(editing ? `Saved ${editing}` : `Added ${$("#acc-username").value}`);
    loadAdmin();
  } catch (err) { $("#account-error").textContent = err.message; }
});
$("#accounts-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-acc]");
  if (!b) return;
  const name = b.dataset.name, what = b.dataset.acc;
  const run = async (fn, done) => { try { await fn(); toast(done); } catch (err) { toast(err.message, true); } loadAdmin(); };
  if (what === "edit") openAccount(ACC.find((a) => a.username === name));
  else if (what === "off") {
    if (await confirmDialog(`Turn off ${name}?`, "They are signed out and cannot sign in until you turn the account back on.", "Turn off"))
      run(() => api(`/api/accounts/${encodeURIComponent(name)}`, { method: "PUT", body: { disabled: true } }), `Turned off ${name}`);
  } else if (what === "on") run(() => api(`/api/accounts/${encodeURIComponent(name)}`, { method: "PUT", body: { disabled: false } }), `Turned on ${name}`);
  else if (what === "delete") {
    if (await confirmDialog(`Delete ${name}?`, "The account is removed and the person is signed out. What they did stays in the Activity log.", "Delete account"))
      run(() => api(`/api/accounts/${encodeURIComponent(name)}`, { method: "DELETE" }), `Deleted ${name}`);
  }
});

// Your own password
$("#me-btn").addEventListener("click", () => {
  $("#me-form").reset(); $("#me-error").textContent = "";
  $("#me-who").textContent = `Signed in as ${ME.username}, ${isAdmin() ? "administrator" : "viewer"}.`;
  $("#dlg-me").showModal(); $("#me-current").focus();
});
$("#me-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#me-error").textContent = "";
  try {
    await api("/api/me/password", { method: "POST", body: { current: $("#me-current").value, new: $("#me-new").value } });
    $("#dlg-me").close(); toast("Password changed");
  } catch (err) { $("#me-error").textContent = err.message; }
});

// Settings
const SETTING_KEYS = ["usage_days", "site_days", "log_days", "backup_hour", "backup_keep_days", "session_hours"];
function renderSettings() {
  for (const k of SETTING_KEYS) {
    const el = $(`#set-${k}`);
    el.value = SET[k]; el.min = SET.limits[k][0]; el.max = SET.limits[k][1];
  }
  $("#settings-note").textContent = `Website logging is ${SET.log_websites ? "on" : "off"}. Turning it on or off changes every user's profile, so it is done with LOG_WEBSITES in config.env and ./setup.sh, not here. Backup times use this machine's clock.`;
}
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(SETTING_KEYS.map((k) => [k, +$(`#set-${k}`).value]));
  const names = { usage_days: "usage and connection log", site_days: "website log", log_days: "portal activity log", backup_keep_days: "backups" };
  const shorter = Object.keys(names).filter((k) => body[k] < SET[k]);
  if (shorter.length && !(await confirmDialog("Delete older records?",
    `You are shortening how long these are kept: ${shorter.map((k) => `${names[k]} (${SET[k]} to ${body[k]} days)`).join(", ")}. Anything older than the new limit is deleted for good, within minutes.`, "Save and delete older records"))) return;
  try { SET = await api("/api/settings", { method: "PUT", body }); renderSettings(); toast("Settings saved"); }
  catch (err) { toast(err.message, true); }
});

// Alerts and reports
function renderAlerts() {
  const where = AL.channels.map((c) => (c === "email" ? "email" : "chat channel")).join(" and ");
  $("#alerts-sub").textContent = !AL.channels.length ? "Not set up. Nothing is sent until you fill in email or a chat channel below."
    : AL.enabled ? `On. Messages go by ${where}.` : `Off. ${where[0].toUpperCase() + where.slice(1)} is filled in but nothing is sent until you turn alerts on.`;
  const e = AL.email;
  $("#al-host").value = e.host; $("#al-port").value = e.port; $("#al-security").value = e.security;
  $("#al-user").value = e.user; $("#al-sender").value = e.sender; $("#al-to").value = e.to;
  $("#al-password").value = ""; $("#al-password").placeholder = e.has_password ? "Saved. Type to replace it." : "";
  $("#al-webhook").value = AL.webhook; $("#al-report").value = AL.report; $("#al-enabled").checked = AL.enabled;
  $("#al-events").innerHTML = Object.entries(AL.event_labels).map(([k, label]) =>
    `<label class="check"><input type="checkbox" data-event="${esc(k)}" ${AL.events[k] ? "checked" : ""}><div>${esc(label)}</div></label>`).join("");
}
async function saveAlerts() {
  const body = {
    enabled: $("#al-enabled").checked, webhook: $("#al-webhook").value, report: $("#al-report").value,
    events: Object.fromEntries($$("#al-events [data-event]").map((b) => [b.dataset.event, b.checked])),
    email: { host: $("#al-host").value, port: $("#al-port").value, security: $("#al-security").value, user: $("#al-user").value,
      password: $("#al-password").value, sender: $("#al-sender").value, to: $("#al-to").value },
  };
  AL = await api("/api/alerts", { method: "PUT", body });
  renderAlerts();
}
$("#alerts-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#alerts-error").textContent = "";
  try { await saveAlerts(); toast("Alert settings saved"); } catch (err) { $("#alerts-error").textContent = err.message; }
});
$("#alerts-test").addEventListener("click", async (e) => {
  $("#alerts-error").textContent = "";
  e.target.disabled = true;
  try {
    await saveAlerts();     // test what is on the screen, not what was saved earlier
    const res = await api("/api/alerts/test", { method: "POST" });
    const bad = Object.entries(res.result).filter(([, err]) => err);
    if (bad.length) $("#alerts-error").textContent = bad.map(([ch, err]) => `${ch === "email" ? "Email" : "Chat channel"} failed: ${err}`).join(" ");
    else toast("Test message sent. Check that it arrived.");
  } catch (err) { $("#alerts-error").textContent = err.message; }
  finally { e.target.disabled = false; }
});

// ------------------------------------------------------------ block lists --
function renderLists() {
  if (!BL || !isAdmin()) return;
  const using = BL.categories.filter((c) => c.on).length;
  $("#lists-sub").textContent = !BL.available ? "Blocking needs website logging, which is turned off."
    : `Blocking is ${BL.enabled ? "on" : "off; turn it on from the Websites tab"}. ${using} of ${BL.categories.length} lists chosen for blocking. Lists in use are downloaded again every day.`;
  $("#add-list").hidden = !BL.available;
  $("#lists-body").innerHTML = BL.categories.map((c) => {
    const k = esc(c.key);
    return `<tr>
      <td><div class="who"><b>${esc(c.label)}${c.custom ? ` <span class="chip" style="font-weight:400">Added by you</span>` : ""}</b><span class="src" title="${esc(c.url)}">${esc(c.url)}</span></div></td>
      <td class="num">${c.sites == null ? "" : c.sites.toLocaleString()}</td>
      <td>${c.updated ? esc(dateTime(c.updated)) : "Not downloaded yet"}</td>
      <td>${statusHtml(c.on ? (BL.enabled ? { cls: "good", label: "In use" } : { cls: "hollow", label: "Chosen, blocking is off" }) : { cls: "", label: "Not used" })}</td>
      <td><div class="row-actions">
        <button class="btn small" data-list="view" data-key="${k}">View sites</button>
        <button class="btn small" data-list="update" data-key="${k}">${c.updated ? "Download again" : "Download"}</button>
        <button class="btn small" data-list="${c.on ? "stop" : "use"}" data-key="${k}">${c.on ? "Stop using" : "Use for blocking"}</button>
        ${c.custom ? `<button class="btn small danger" data-list="delete" data-key="${k}">Delete</button>` : ""}
      </div></td></tr>`;
  }).join("");
  $("#allow-chips").innerHTML = BL.allowed.map((d) => `<span class="chip">${esc(d)}<button data-allow-remove="${esc(d)}" aria-label="Remove ${esc(d)}">&#215;</button></span>`).join("")
    || `<span class="muted" style="font-size:13px">None yet.</span>`;
}
const customLists = () => BL.categories.filter((c) => c.custom).map((c) => ({ key: c.key, label: c.label, url: c.url }));

$("#lists-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-list]");
  if (!b) return;
  const key = b.dataset.key, c = BL.categories.find((x) => x.key === key), what = b.dataset.list;
  const on = BL.categories.filter((x) => x.on).map((x) => x.key);
  if (what === "view") openList(c);
  else if (what === "use") saveBlocking({ categories: [...on, key] }, BL.enabled ? `Now blocking with ${c.label}` : `${c.label} chosen. Blocking is off, so it has no effect yet.`);
  else if (what === "stop") saveBlocking({ categories: on.filter((k) => k !== key) }, `Stopped using ${c.label}`);
  else if (what === "update") {
    if (busy) return;
    busy = true; b.disabled = true; b.textContent = "Downloading";
    try { BL = await api(`/api/blocking/lists/${key}/update`, { method: "POST" }); toast(`Downloaded ${c.label}`); }
    catch (err) { toast(err.message, true); }
    finally { busy = false; renderLists(); renderBlocking(); }
  } else if (what === "delete") {
    if (await confirmDialog(`Delete ${c.label}?`, c.on && BL.enabled ? "Sites on this list stop being blocked straight away." : "The list is removed from the portal and the server.", "Delete list"))
      saveBlocking({ custom: customLists().filter((x) => x.key !== key), categories: on.filter((k) => k !== key) }, `Deleted ${c.label}`);
  }
});

$("#add-list").addEventListener("click", () => {
  $("#newlist-form").reset(); $("#newlist-error").textContent = "";
  $("#dlg-newlist").showModal(); $("#nl-label").focus();
});
$("#newlist-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#newlist-submit");
  btn.disabled = true; btn.textContent = "Downloading the list"; $("#newlist-error").textContent = "";
  try {
    BL = await api("/api/blocking", { method: "PUT", body: {
      enabled: BL.enabled, domains: BL.domains, categories: BL.categories.filter((c) => c.on).map((c) => c.key),
      custom: [...customLists(), { label: $("#nl-label").value, url: $("#nl-url").value }] } });
    $("#dlg-newlist").close(); toast("List added. Choose \"Use for blocking\" to start using it.");
    renderLists(); renderBlocking();
  } catch (err) { $("#newlist-error").textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = "Add list"; }
});

// Never-blocked sites
$("#allow-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#allow-input").value.trim().toLowerCase();
  if (!v) return;
  $("#allow-input").value = "";
  saveBlocking({ allowed: [...BL.allowed, v] }, `${v} will never be blocked by a list`);
});
$("#allow-chips").addEventListener("click", (e) => {
  const x = e.target.closest("[data-allow-remove]");
  if (x) saveBlocking({ allowed: BL.allowed.filter((d) => d !== x.dataset.allowRemove) }, `Removed ${x.dataset.allowRemove}`);
});

// What is in a list: searched and paged on the server, since lists run to 100,000+ sites.
const LV = { key: "", offset: 0, q: "", timer: null };
function openList(c) {
  LV.key = c.key; LV.offset = 0; LV.q = "";
  $("#list-title").textContent = c.label;
  $("#list-sub").textContent = "";
  $("#list-search").value = ""; $("#list-rows").innerHTML = ""; $("#list-pager").innerHTML = "";
  $("#dlg-list").showModal();
  loadList();
}
async function loadList() {
  const box = $("#list-rows");
  try {
    const r = await api(`/api/blocking/lists/${LV.key}?offset=${LV.offset}&q=${encodeURIComponent(LV.q)}`);
    if (!r.downloaded) {
      $("#list-sub").textContent = "This list has not been downloaded yet.";
      box.innerHTML = `<p class="empty">Close this and press Download to fetch the list, then view it again.</p>`;
      $("#list-pager").innerHTML = ""; return;
    }
    $("#list-sub").textContent = `${r.total.toLocaleString()} sites` + (LV.q ? `, ${r.matched.toLocaleString()} matching "${LV.q}"` : "");
    box.innerHTML = r.rows.length ? r.rows.map(([d, allowed]) => `<div><code>${esc(d)}</code>${allowed
      ? `<span class="chip">Never blocked</span>` : `<button class="btn small" data-never="${esc(d)}">Never block</button>`}</div>`).join("")
      : `<p class="empty">No site in this list matches that search.</p>`;
    box.scrollTop = 0;
    const end = Math.min(LV.offset + 50, r.matched);
    $("#list-pager").innerHTML = r.matched ? `<span>Showing ${(LV.offset + 1).toLocaleString()} to ${end.toLocaleString()} of ${r.matched.toLocaleString()}</span>
      <div class="pager-controls"><button class="btn small" data-step="-50" ${LV.offset === 0 ? "disabled" : ""}>Previous</button>
      <span>Page ${(LV.offset / 50 + 1).toLocaleString()} of ${Math.ceil(r.matched / 50).toLocaleString()}</span>
      <button class="btn small" data-step="50" ${end >= r.matched ? "disabled" : ""}>Next</button></div>` : "";
  } catch (err) { box.innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
}
$("#list-search").addEventListener("input", (e) => {
  clearTimeout(LV.timer);
  LV.timer = setTimeout(() => { LV.q = e.target.value.trim().toLowerCase().replace(/[^a-z0-9.-]/g, ""); LV.offset = 0; loadList(); }, 300);
});
$("#list-pager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-step]");
  if (b && !b.disabled) { LV.offset = Math.max(0, LV.offset + +b.dataset.step); loadList(); }
});
$("#list-rows").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-never]");
  if (b && await saveBlocking({ allowed: [...BL.allowed, b.dataset.never] }, `${b.dataset.never} will never be blocked by a list`)) loadList();
});
