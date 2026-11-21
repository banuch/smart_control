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
//   APP_PASSWORD  if set, the page asks for this password (user name: admin)
// A variable already set in the environment takes priority over .env.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

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
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const DEVICE_TIMEOUT_MS = 15000;

const COMMANDS = { on: "ON", off: "OFF", toggle: "TOGGLE", status: "STATUS" };

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"));

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

function isAuthorised(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const [, pass] = Buffer.from(header.slice(6), "base64").toString().split(/:(.*)/s);
  return pass === APP_PASSWORD;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (!isAuthorised(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Relay control"' });
    return res.end("Password required");
  }

  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(INDEX_HTML);
  }

  // GET /api/relay  -> current state
  // POST /api/relay/on | off | toggle
  const match = url.pathname.match(/^\/api\/relay(?:\/(on|off|toggle))?$/);

  if (match && ((req.method === "GET" && !match[1]) || (req.method === "POST" && match[1]))) {
    const command = COMMANDS[match[1] || "status"];
    const started = Date.now();

    try {
      const reply = await sendToDevice(command);
      const state = parseReply(reply);
      console.log(new Date().toISOString(), command, "->", reply);
      return sendJson(res, 200, { ok: true, ...state, ms: Date.now() - started });
    } catch (err) {
      console.log(new Date().toISOString(), command, "FAILED:", err.message);
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(WEB_PORT, "::", () => {
  console.log("Relay web app on port", WEB_PORT);
  console.log("Device:", `[${DEVICE_HOST}]:${DEVICE_PORT}`);
  console.log(APP_PASSWORD ? "Password protection ON (user: admin)" : "WARNING: no APP_PASSWORD set, anyone can use the page");
});
