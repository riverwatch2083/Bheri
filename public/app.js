let snapshot = null;

const $ = selector => document.querySelector(selector);
const cards = $("#stationCards");
const warningsList = $("#warningsList");
const signal = $("#overallSignal");
const thresholds = $("#thresholds");
const isStaticPage = location.hostname.endsWith("github.io");

function fmtDate(value) {
  if (!value) return "No timestamp";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kathmandu"
  }).format(new Date(value));
}

function stationArray() {
  return Object.values(snapshot?.stations || {});
}

function renderCards() {
  const stations = stationArray();
  cards.innerHTML = stations.map(station => {
    const latest = station.latest || {};
    const value = Number.isFinite(latest.value) ? latest.value : 0;
    const cap = station.dangerLevel || station.warningLevel || Math.max(value, 1);
    const fill = Math.max(3, Math.min(100, (value / cap) * 100));
    return `
      <article class="station-card">
        <div class="station-top">
          <div>
            <p class="eyebrow">Station ${station.stationNumber}</p>
            <h3>${station.name}</h3>
          </div>
          <span class="badge ${station.alertLevel}">${station.alertLevel}</span>
        </div>
        <div class="level">${Number.isFinite(latest.value) ? latest.value.toFixed(2) : "--"} m</div>
        <p class="meta">${latest.trend || "No trend"} - ${fmtDate(latest.datetime || station.fetchedAt)}</p>
        <p class="meta">Warning ${station.warningLevel ?? "--"} m - Danger ${station.dangerLevel ?? "--"} m</p>
        <div class="gauge" style="--fill:${fill}%"><span></span></div>
      </article>
    `;
  }).join("");
}

function renderSignal() {
  const levels = stationArray().map(station => station.alertLevel);
  const level = levels.includes("danger") ? "danger" : levels.includes("warning") ? "warning" : levels.includes("unknown") ? "unknown" : "normal";
  signal.className = `signal ${level}`;
  signal.innerHTML = `<span>Network status</span><strong>${level.toUpperCase()}</strong><p class="meta">${snapshot?.pollError || `Last poll ${fmtDate(snapshot?.lastPoll)}`}</p>`;
}

function renderWarnings() {
  const rows = stationArray()
    .filter(station => station.alertLevel !== "normal")
    .map(station => `
      <div class="warning-row">
        <span class="badge ${station.alertLevel}">${station.alertLevel}</span>
        <strong>${station.name}: ${station.latest?.value?.toFixed?.(2) || "--"} m</strong>
        <span class="meta">${fmtDate(station.latest?.datetime || station.fetchedAt)}</span>
      </div>
    `);
  warningsList.innerHTML = rows.length ? rows.join("") : `<div class="warning-row"><span class="badge normal">normal</span><strong>All monitored stations are below warning level.</strong><span class="meta">${fmtDate(snapshot?.lastPoll)}</span></div>`;
}

function renderChart() {
  const colors = ["#1e88a8", "#66823d", "#b83b38"];
  const datasets = stationArray().map((station, index) => {
    const data = (station.history || [])
      .map(point => ({ x: new Date(point.datetime).getTime(), y: Number(point.value) }))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    return { label: station.name, color: colors[index], data };
  });

  const canvas = $("#riverChart");
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const all = datasets.flatMap(dataset => dataset.data);
  if (!all.length) {
    ctx.fillStyle = "#667784";
    ctx.font = "16px system-ui";
    ctx.fillText("No chart data available yet.", 24, 42);
    return;
  }

  const pad = { left: 54, right: 24, top: 28, bottom: 62 };
  const width = rect.width - pad.left - pad.right;
  const height = rect.height - pad.top - pad.bottom;
  const minX = Math.min(...all.map(point => point.x));
  const maxX = Math.max(...all.map(point => point.x));
  const minY = Math.min(...all.map(point => point.y), 0);
  const maxY = Math.max(...all.map(point => point.y));
  const yFloor = Math.max(0, Math.floor(minY * 10) / 10);
  const yCeil = Math.ceil((maxY + .2) * 10) / 10;
  const xPos = x => pad.left + ((x - minX) / Math.max(1, maxX - minX)) * width;
  const yPos = y => pad.top + (1 - ((y - yFloor) / Math.max(.1, yCeil - yFloor))) * height;

  ctx.strokeStyle = "rgba(20,33,43,.12)";
  ctx.fillStyle = "#667784";
  ctx.lineWidth = 1;
  ctx.font = "12px system-ui";
  for (let i = 0; i <= 5; i++) {
    const y = yFloor + ((yCeil - yFloor) * i / 5);
    const py = yPos(y);
    ctx.beginPath();
    ctx.moveTo(pad.left, py);
    ctx.lineTo(rect.width - pad.right, py);
    ctx.stroke();
    ctx.fillText(`${y.toFixed(1)} m`, 8, py + 4);
  }

  for (let i = 0; i <= 4; i++) {
    const x = minX + ((maxX - minX) * i / 4);
    const px = xPos(x);
    const label = new Intl.DateTimeFormat("en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      timeZone: "Asia/Kathmandu"
    }).format(new Date(x));
    ctx.fillText(label, Math.min(px, rect.width - 84), rect.height - 34);
  }

  datasets.forEach(dataset => {
    if (!dataset.data.length) return;
    ctx.strokeStyle = dataset.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    dataset.data.forEach((point, pointIndex) => {
      const px = xPos(point.x);
      const py = yPos(point.y);
      if (pointIndex === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  });

  let legendX = pad.left;
  datasets.forEach(dataset => {
    ctx.fillStyle = dataset.color;
    ctx.fillRect(legendX, rect.height - 18, 22, 4);
    ctx.fillStyle = "#14212b";
    ctx.fillText(dataset.label, legendX + 28, rect.height - 12);
    legendX += Math.min(250, 42 + dataset.label.length * 7);
  });
}

function renderAdmin() {
  if (!snapshot?.config) return;
  const adminSection = document.querySelector(".admin");
  if (isStaticPage && adminSection) {
    adminSection.hidden = true;
    return;
  }
  $("#adminEmail").value = snapshot.config.adminEmail || "";
  $("#recipients").value = (snapshot.config.recipients || []).join("\n");
  thresholds.innerHTML = stationArray().map(station => `
    <div class="threshold-card" data-station="${station.stationNumber}">
      <strong>${station.name}</strong>
      <p class="meta">Station ${station.stationNumber}</p>
      <div class="inputs">
        <label>Warning <input class="warning-input" type="number" step="0.01" value="${station.warningLevel ?? ""}"></label>
        <label>Danger <input class="danger-input" type="number" step="0.01" value="${station.dangerLevel ?? ""}"></label>
      </div>
    </div>
  `).join("");
}

async function load() {
  snapshot = await fetchSnapshot();
  renderSignal();
  renderCards();
  renderWarnings();
  renderChart();
  renderAdmin();
}

async function fetchSnapshot() {
  const sources = isStaticPage ? ["./data/snapshot.json"] : ["/api/snapshot", "./data/snapshot.json"];
  let lastError = null;
  for (const source of sources) {
    try {
      const res = await fetch(`${source}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${source} returned ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No River Watch data source responded");
}

function adminHeaders() {
  return {
    "content-type": "application/json",
    "x-admin-token": $("#adminToken").value
  };
}

async function saveConfig() {
  const stations = stationArray().map(station => {
    const card = thresholds.querySelector(`[data-station="${station.stationNumber}"]`);
    return {
      ...station,
      warningLevel: card.querySelector(".warning-input").value || null,
      dangerLevel: card.querySelector(".danger-input").value || null
    };
  });
  const payload = {
    adminEmail: $("#adminEmail").value,
    recipients: $("#recipients").value.split(/\s+/).map(value => value.trim()).filter(Boolean),
    stations
  };
  const res = await fetch("/api/admin/config", {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify(payload)
  });
  $("#adminMessage").textContent = res.ok ? "Settings saved." : "Admin token rejected.";
  if (res.ok) await load();
}

async function pollNow() {
  const res = await fetch("/api/admin/poll", { method: "POST", headers: adminHeaders() });
  $("#adminMessage").textContent = res.ok ? "DHM poll complete." : "Admin token rejected.";
  if (res.ok) await load();
}

$("#refreshBtn").addEventListener("click", load);
$("#saveConfig").addEventListener("click", saveConfig);
$("#pollNow").addEventListener("click", pollNow);

load().catch(error => {
  cards.innerHTML = `<article class="station-card"><h3>Unable to load River Watch</h3><p class="meta">${error.message}</p></article>`;
});
