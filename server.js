// =========================================
// WINTEK SOLUTIONS
// Web control for the EC200U GPIO2 relay
// =========================================
//
// Browser --HTTP--> this server --TCP (IPv6)--> relay_server.py on the EC200U
//
// No npm packages needed: uses only Node's built-in modules.
//
// Settings are read from the .env file next to this script
// (copy .env.example to .env and edit it):
//   DEVICE_HOST   device IPv6 address         (default below)
//   DEVICE_PORT   device TCP port             (default 5000)
//   WEB_PORT      port for this web app       (default 8080)
//   APP_USER      login user name             (default admin)
//   APP_PASSWORD  login password; if empty, no login is asked
//   SESSION_HOURS how long a login lasts      (default 168 = 7 days)
//   TRUST_PROXY   set to 1 only when running behind Nginx or another proxy
// A variable already set in the environment takes priority over .env.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnvFile(path.join(__dirname, ".env"));

// Reads KEY=value lines; ignores blank lines and # comments.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) {
    console.log("No .env file found at", file, "- using defaults");
    return;
  }

  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();

    // Strip matching quotes: KEY="value" or KEY='value'
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }

  console.log("Loaded settings from", file);
}

const DEVICE_HOST = process.env.DEVICE_HOST || "2401:4900:9864:A48F::2";
const DEVICE_PORT = parseInt(process.env.DEVICE_PORT || "5000", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "8080", 10);
const APP_USER = process.env.APP_USER || "admin";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_MS = parseFloat(process.env.SESSION_HOURS || "168") * 3600 * 1000;
const DEVICE_TIMEOUT_MS = 15000;

// Login attempt limit per IP address
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const COOKIE_NAME = "relay_session";
const COMMANDS = { on: "ON", off: "OFF", toggle: "TOGGLE", status: "STATUS" };

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"));
const LOGIN_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "login.html"));

// -----------------------------------------
// Device connection
// -----------------------------------------

// The device serves one client at a time, so send commands one after another.
let queue = Promise.resolve();

function sendToDevice(command) {
  const job = queue.then(() => talkToDevice(command));
  queue = job.catch(() => {});
  return job;
}

function talkToDevice(command) {
  return new Promise((resolve, reject) => {
    let reply = "";
    let done = false;

    const socket = net.createConnection({ host: DEVICE_HOST, port: DEVICE_PORT, family: 6 });

    const finish = (err, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      err ? reject(err) : resolve(value);
    };

    socket.setTimeout(DEVICE_TIMEOUT_MS, () => finish(new Error("Device did not answer in time")));
    socket.on("connect", () => socket.write(command + "\n"));
    socket.on("data", (chunk) => {
      reply += chunk.toString();
      const end = reply.indexOf("\n");
      if (end !== -1) finish(null, reply.slice(0, end).trim());
    });
    socket.on("error", (err) => finish(new Error("Cannot reach device: " + err.message)));
    socket.on("close", () => {
      if (reply.trim()) finish(null, reply.trim());
      else finish(new Error("Device closed the connection without answering"));
    });
  });
}

function parseReply(reply) {
  if (reply === "RELAY:ON") return { relay: "on" };
  if (reply === "RELAY:OFF") return { relay: "off" };
  throw new Error(reply || "Unexpected reply from device");
}

// -----------------------------------------
// Login sessions (kept in memory; a restart logs everyone out)
// -----------------------------------------

const sessions = new Map();       // token -> { user, expires }
const failedLogins = new Map();   // ip -> { count, until }

function sameText(a, b) {
  // Constant-time compare so the password can't be guessed by timing
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function getSession(req) {
  if (!APP_PASSWORD) return { user: "guest" };

  const token = parseCookies(req)[COOKIE_NAME];
  const session = token && sessions.get(token);

  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(req, token, maxAgeS) {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeS}`,
    isHttps(req) ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

// Only trust X-Forwarded-For behind your own proxy (e.g. Nginx),
// otherwise anyone could fake it to dodge the login attempt limit.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

function clientIp(req) {
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) {
    return req.headers["x-forwarded-for"].split(",")[0].trim();
  }
  return req.socket.remoteAddress;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expires < now) sessions.delete(token);
  for (const [ip, f] of failedLogins) if (f.until && f.until < now) failedLogins.delete(ip);
}, 10 * 60 * 1000).unref();

// -----------------------------------------
// HTTP helpers
// -----------------------------------------

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// -----------------------------------------
// Routes
// -----------------------------------------

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const record = failedLogins.get(ip);

  if (record?.until && record.until > Date.now()) {
    const mins = Math.ceil((record.until - Date.now()) / 60000);
    return sendJson(res, 429, { ok: false, error: `Too many attempts. Try again in ${mins} min.` });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }

  const userOk = sameText(body.user || "", APP_USER);
  const passOk = sameText(body.password || "", APP_PASSWORD);

  if (!userOk || !passOk) {
    const count = (record?.count || 0) + 1;
    failedLogins.set(ip, { count, until: count >= MAX_FAILED_LOGINS ? Date.now() + LOCKOUT_MS : 0 });
    console.log(new Date().toISOString(), "LOGIN FAILED from", ip, `(${count})`);
    return sendJson(res, 401, { ok: false, error: "Wrong user name or password" });
  }

  failedLogins.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { user: APP_USER, expires: Date.now() + SESSION_MS });
  console.log(new Date().toISOString(), "LOGIN OK from", ip);

  sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, token, Math.floor(SESSION_MS / 1000)) });
}

function handleLogout(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) sessions.delete(token);
  res.writeHead(302, { Location: "/login", "Set-Cookie": sessionCookie(req, "", 0), "Cache-Control": "no-store" });
  res.end();
}

async function handleRelay(res, action) {
  const command = COMMANDS[action];
  const started = Date.now();

  try {
    const reply = await sendToDevice(command);
    const state = parseReply(reply);
    console.log(new Date().toISOString(), command, "->", reply);
    sendJson(res, 200, { ok: true, ...state, ms: Date.now() - started });
  } catch (err) {
    console.log(new Date().toISOString(), command, "FAILED:", err.message);
    sendJson(res, 502, { ok: false, error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  // Public routes
  if (p === "/login" && req.method === "GET") {
    if (!APP_PASSWORD || getSession(req)) return redirect(res, "/");
    return sendHtml(res, LOGIN_HTML);
  }
  if (p === "/api/login" && req.method === "POST") return handleLogin(req, res);
  if (p === "/logout") return handleLogout(req, res);

  // Everything below needs a login
  const session = getSession(req);

  if (!session) {
    if (p.startsWith("/api/")) return sendJson(res, 401, { ok: false, error: "Login required" });
    return redirect(res, "/login");
  }

  if (p === "/" && req.method === "GET") return sendHtml(res, INDEX_HTML);

  if (p === "/api/info" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      user: session.user,
      loginEnabled: Boolean(APP_PASSWORD),
      device: `[${DEVICE_HOST}]:${DEVICE_PORT}`,
    });
  }

  // GET /api/relay  -> current state
  // POST /api/relay/on | off | toggle
  const match = p.match(/^\/api\/relay(?:\/(on|off|toggle))?$/);

  if (match && ((req.method === "GET" && !match[1]) || (req.method === "POST" && match[1]))) {
    return handleRelay(res, match[1] || "status");
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(WEB_PORT, "::", () => {
  console.log("Relay web app on port", WEB_PORT);
  console.log("Device:", `[${DEVICE_HOST}]:${DEVICE_PORT}`);
  console.log(APP_PASSWORD
    ? `Login page ON (user: ${APP_USER})`
    : "WARNING: no APP_PASSWORD set, anyone can use the page");
});
