const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs/promises");
const path = require("node:path");
const tls = require("node:tls");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SNAPSHOT_FILE = path.join(PUBLIC_DIR, "data", "snapshot.json");
const DHM_BASE = "https://dhm.gov.np";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

loadEnv();

function loadEnv() {
  return fs.readFile(path.join(ROOT, ".env"), "utf8")
    .then(content => {
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    })
    .catch(() => {});
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

function publicConfig(config) {
  return {
    adminEmail: config.adminEmail,
    pollMinutes: config.pollMinutes,
    recipients: config.recipients || []
  };
}

async function publishSnapshot(config, state) {
  await writeJson(SNAPSHOT_FILE, {
    config: publicConfig(config),
    lastPoll: state.lastPoll,
    pollError: state.pollError,
    stations: state.stations || {},
    alerts: (state.alerts || []).slice(0, 25)
  });
}

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      method: options.method || "GET",
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      headers: {
        "user-agent": "RiverWatch/1.0",
        "accept": "*/*",
        ...(options.headers || {})
      },
      timeout: options.timeout || 20000
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        else resolve({ body: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

function parseRiverObject(html) {
  const match = html.match(/var\s+river\s*=\s*'([^']+)'/s);
  if (!match) throw new Error("DHM station object not found");
  return JSON.parse(match[1]);
}

function decodeJsHexString(value) {
  return value
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\"/g, "\"");
}

function parseHistoryFromChart(chartHtml) {
  const match = chartHtml.match(/var\s+river\s*=\s*'([^']+)'/s);
  if (!match) return [];
  try {
    return JSON.parse(decodeJsHexString(match[1]))
      .map(point => ({ datetime: point.datetime, value: Number(point.value) }))
      .filter(point => point.datetime && Number.isFinite(point.value) && point.value > -100);
  } catch {
    return [];
  }
}

function todayKathmandu() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const pick = type => parts.find(part => part.type === type).value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function thresholdNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classifyStation(station) {
  const value = station.latest?.value;
  if (!Number.isFinite(value)) return "unknown";
  const danger = thresholdNumber(station.dangerLevel);
  const warning = thresholdNumber(station.warningLevel);
  if (danger !== null && value >= danger) return "danger";
  if (warning !== null && value >= warning) return "warning";
  return "normal";
}

async function fetchStation(configStation) {
  const pageUrl = `${DHM_BASE}/hydrology/hms-Single/${configStation.dhmId}`;
  const page = await request(pageUrl);
  const river = parseRiverObject(page.body);
  const latest = {
    datetime: river.waterLevel?.datetime || null,
    value: Number(river.waterLevel?.value),
    status: river.status || "UNKNOWN",
    trend: river.steady || "",
    dhmWarningLevel: thresholdNumber(river.warning_level),
    dhmDangerLevel: thresholdNumber(river.danger_level)
  };

  let history = [];
  try {
    const csrf = page.body.match(/name="csrf_test_name"\s+value="([^"]+)"/)?.[1] || "";
    const form = new URLSearchParams({
      csrf_test_name: csrf,
      date: todayKathmandu(),
      period: "4",
      seriesid: String(configStation.seriesId || river.series_id)
    });
    const resp = await request(`${DHM_BASE}/site/getRiverWatchBySeriesId_Single`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "referer": pageUrl
      }
    }, form.toString());
    const payload = JSON.parse(resp.body);
    history = parseHistoryFromChart(payload.data?.chart || "");
  } catch {
    history = [];
  }

  const station = {
    ...configStation,
    name: river.name || configStation.name,
    stationNumber: river.stationIndex || configStation.stationNumber,
    seriesId: river.series_id || configStation.seriesId,
    basin: river.basin || "",
    district: river.district || "",
    latitude: river.latitude,
    longitude: river.longitude,
    description: river.description || "",
    sourceUrl: pageUrl,
    latest,
    history: history.slice(-700),
    fetchedAt: new Date().toISOString()
  };
  station.alertLevel = classifyStation(station);
  return station;
}

async function pollAll({ sendAlerts = true } = {}) {
  const config = await readJson(CONFIG_FILE, {});
  const state = await readJson(STATE_FILE, { stations: {}, alerts: [] });
  const stations = {};
  const errors = [];

  for (const stationConfig of config.stations || []) {
    try {
      stations[stationConfig.stationNumber] = await fetchStation(stationConfig);
    } catch (error) {
      errors.push(`${stationConfig.name}: ${error.message}`);
      if (state.stations?.[stationConfig.stationNumber]) {
        stations[stationConfig.stationNumber] = state.stations[stationConfig.stationNumber];
      }
    }
  }

  state.lastPoll = new Date().toISOString();
  state.pollError = errors.length ? errors.join("; ") : null;
  state.stations = stations;
  state.alerts = state.alerts || [];

  if (sendAlerts) await maybeSendAlerts(config, state);
  await writeJson(STATE_FILE, state);
  await publishSnapshot(config, state);
  return state;
}

async function maybeSendAlerts(config, state) {
  const recipients = [...new Set([...(config.recipients || []), config.adminEmail].filter(Boolean))];
  if (!recipients.length) return;

  for (const station of Object.values(state.stations || {})) {
    if (!["warning", "danger"].includes(station.alertLevel)) continue;
    const key = `${station.stationNumber}:${station.alertLevel}:${station.latest?.datetime}:${station.latest?.value}`;
    if (state.alerts.some(alert => alert.key === key)) continue;

    const subject = `[River Watch ${station.alertLevel.toUpperCase()}] ${station.name}`;
    const text = [
      `${station.name} (${station.stationNumber}) crossed ${station.alertLevel.toUpperCase()} stage.`,
      "",
      `Current stage: ${station.latest.value.toFixed(2)} m`,
      `Observed: ${station.latest?.datetime || station.fetchedAt}`,
      `Warning level: ${station.warningLevel ?? "not set"} m`,
      `Danger level: ${station.dangerLevel ?? "not set"} m`,
      `Trend: ${station.latest?.trend || "unknown"}`,
      `Source: ${station.sourceUrl}`
    ].join("\n");

    let sent = false;
    let error = null;
    try {
      await sendEmail({ to: recipients, subject, text, from: config.adminEmail || env("SMTP_USER") });
      sent = true;
    } catch (err) {
      error = err.message;
    }
    state.alerts.unshift({ key, sent, error, stationNumber: station.stationNumber, level: station.alertLevel, createdAt: new Date().toISOString() });
    state.alerts = state.alerts.slice(0, 100);
  }
}

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (lines.length && /^\d{3} /.test(lines[lines.length - 1])) {
        socket.off("data", onData);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function smtpCommand(socket, command, ok = /^[23]/) {
  if (command) socket.write(`${command}\r\n`);
  const response = await smtpRead(socket);
  if (!ok.test(response)) throw new Error(`SMTP failed: ${response.trim()}`);
  return response;
}

async function sendEmail({ to, subject, text, from }) {
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT", "465"));
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  if (!host || !user || !pass || pass.includes("your-gmail")) {
    throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS are required to send email");
  }

  const socket = tls.connect({ host, port, servername: host });
  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });

  const encode = value => Buffer.from(value).toString("base64");
  const recipients = Array.isArray(to) ? to : [to];
  const body = [
    `From: ${from || user}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
    `Message-ID: <${crypto.randomUUID()}@river-watch.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text
  ].join("\r\n");

  await smtpCommand(socket, null);
  await smtpCommand(socket, "EHLO river-watch.local");
  await smtpCommand(socket, "AUTH LOGIN", /^334/);
  await smtpCommand(socket, encode(user), /^334/);
  await smtpCommand(socket, encode(pass));
  await smtpCommand(socket, `MAIL FROM:<${user}>`);
  for (const rcpt of recipients) await smtpCommand(socket, `RCPT TO:<${rcpt}>`);
  await smtpCommand(socket, "DATA", /^354/);
  await smtpCommand(socket, `${body}\r\n.`);
  await smtpCommand(socket, "QUIT").catch(() => {});
  socket.end();
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function bodyJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function isAdmin(req) {
  return req.headers["x-admin-token"] === env("ADMIN_TOKEN", "river-watch-admin");
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/snapshot" && req.method === "GET") {
    const [config, state] = await Promise.all([readJson(CONFIG_FILE, {}), readJson(STATE_FILE, {})]);
    return json(res, 200, {
      config: publicConfig(config),
      ...state
    });
  }

  if (url.pathname === "/api/admin/config" && req.method === "PUT") {
    if (!isAdmin(req)) return json(res, 401, { error: "Admin token required" });
    const current = await readJson(CONFIG_FILE, {});
    const incoming = await bodyJson(req);
    const next = {
      ...current,
      adminEmail: incoming.adminEmail || current.adminEmail,
      recipients: Array.isArray(incoming.recipients) ? incoming.recipients.filter(Boolean) : current.recipients,
      stations: Array.isArray(incoming.stations) ? incoming.stations.map(station => ({
        dhmId: station.dhmId,
        stationNumber: String(station.stationNumber),
        name: station.name,
        seriesId: station.seriesId,
        warningLevel: thresholdNumber(station.warningLevel),
        dangerLevel: thresholdNumber(station.dangerLevel)
      })) : current.stations
    };
    await writeJson(CONFIG_FILE, next);
    const state = await readJson(STATE_FILE, {});
    await publishSnapshot(next, state);
    return json(res, 200, next);
  }

  if (url.pathname === "/api/admin/poll" && req.method === "POST") {
    if (!isAdmin(req)) return json(res, 401, { error: "Admin token required" });
    return json(res, 200, await pollAll());
  }

  return json(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  const file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const target = path.normalize(path.join(PUBLIC_DIR, file));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, { "content-type": MIME[path.extname(target)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function start() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await loadEnv();
  await pollAll({ sendAlerts: false }).catch(error => console.error("Initial DHM poll failed:", error.message));
  const config = await readJson(CONFIG_FILE, { pollMinutes: 10 });
  setInterval(() => pollAll().catch(error => console.error("DHM poll failed:", error.message)), (config.pollMinutes || 10) * 60 * 1000);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      await serveStatic(req, res, url);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
  const port = Number(env("PORT", "3000"));
  server.listen(port, () => console.log(`River Watch running at http://localhost:${port}`));
}

if (process.argv.includes("--poll-once")) {
  loadEnv().then(() => pollAll()).then(state => {
    console.log(JSON.stringify({ lastPoll: state.lastPoll, pollError: state.pollError }, null, 2));
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
} else {
  start();
}
