/* global Chart */

const $ = (sel) => document.querySelector(sel);

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const fmtTime = (d) =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtStamp = (d) =>
  d.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const SNAPSHOT_KEY = "smartShed.snapshots";
const CAMERA_URL_KEY = "smartShed.cameraUrl";
const DEFAULT_CAMERA_URL = "http://10.144.9.139";

function now() {
  return new Date();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeText(v, fallback = "—") {
  const s = `${v ?? ""}`.trim();
  return s ? s : fallback;
}

// -----------------------------
// ThingSpeak configuration
// -----------------------------
//
// This dashboard uses ThingSpeak ONLY (no simulated data).
// Set your channel + field mapping in the UI (ThingSpeak Settings).
//
const DEFAULT_TS = {
  channelId: "3333656",
  readApiKey: "ABD77S4O63FSBBG5",
  results: 60,
  // Your 4-field ThingSpeak setup:
  // field1=temp, field2=humidity, field3=gas, field4=rfid
  fields: {
    temperatureC: 1,
    humidityPct: 2,
    gasPpm: 3,
    rfidTag: 4,
    // Optional fields (if you later add them to channel)
    airflowPct: null,
    rfidZone: null,
    occupancyPct: null,
    rfidScansToday: null,
  },
};

function loadTsConfig() {
  try {
    const raw = localStorage.getItem("smartShed.ts");
    if (!raw) return { ...DEFAULT_TS, fields: { ...DEFAULT_TS.fields } };
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_TS,
      ...parsed,
      fields: { ...DEFAULT_TS.fields, ...(parsed.fields || {}) },
    };
    if (!merged.channelId) merged.channelId = DEFAULT_TS.channelId;
    if (!merged.readApiKey) merged.readApiKey = DEFAULT_TS.readApiKey;
    return merged;
  } catch {
    return { ...DEFAULT_TS, fields: { ...DEFAULT_TS.fields } };
  }
}

function saveTsConfig(cfg) {
  localStorage.setItem("smartShed.ts", JSON.stringify(cfg));
}

let TS = loadTsConfig();

const state = {
  syncing: true,
  start: Date.now(),
  packets: 0,
  alertsToday: 0,
  scansToday: 0,

  tempC: null,
  humidity: null,
  gasPpm: null,
  co2Proxy: null,
  airflow: null,
  fansOn: null,

  shedHealth: null,
  activeTags: null,

  tempSeries: [],
  humiditySeries: [],
  gasSeries: [],
  timeLabels: [],

  gasLog: [],
  scanHistory: [],
  animals: [],

  heat: new Array(60).fill(0),
  lastFeedAt: null,
  lastTag: null,
  lastZone: null,
};

function ensureEmptyCharts() {
  // Keep charts present even before data arrives.
  state.timeLabels = [];
  state.tempSeries = [];
  state.humiditySeries = [];
  state.gasSeries = [];
}

function chartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.documentElement)
    .getPropertyValue("--fontBody")
    .trim();
  Chart.defaults.color = "rgba(245,249,246,0.72)";
  Chart.defaults.borderColor = "rgba(255,255,255,0.10)";
}

function lineGradient(ctx, top, bottom) {
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, "rgba(115,255,199,0.55)");
  g.addColorStop(0.55, "rgba(115,166,255,0.32)");
  g.addColorStop(1, "rgba(255,191,122,0.22)");
  return g;
}

let tempChart;
let humidityChart;
let gasChart;
let trendChart;
let attendanceChart;
let occupancyChart;

function makeMiniLine(canvasId, series, color) {
  const canvas = $(canvasId);
  const ctx = canvas.getContext("2d");
  const grad = lineGradient(ctx, 0, canvas.height || 120);
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: state.timeLabels.slice(-24),
      datasets: [
        {
          data: series.slice(-24),
          tension: 0.42,
          borderWidth: 2,
          borderColor: color,
          fill: true,
          backgroundColor: grad,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650, easing: "easeOutQuart" },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
    },
  });
}

function setBadge(el, mode) {
  el.classList.remove("badge--ok", "badge--warn", "badge--danger");
  if (mode === "ok") el.classList.add("badge--ok");
  if (mode === "warn") el.classList.add("badge--warn");
  if (mode === "danger") el.classList.add("badge--danger");
}

function tempStatus(t) {
  if (t == null) return { label: "No data", mode: "warn" };
  if (t < 20 || t > 36) return { label: "Critical", mode: "danger" };
  if (t < 23 || t > 33.5) return { label: "Warning", mode: "warn" };
  return { label: "Normal", mode: "ok" };
}

function humidityStatus(h) {
  if (h == null) return { label: "No data", comfort: "—", mode: "warn" };
  if (h < 40) return { label: "Dry", comfort: "Low", mode: "warn" };
  if (h > 80) return { label: "Humid", comfort: "Low", mode: "warn" };
  if (h >= 50 && h <= 70) return { label: "Optimal", comfort: "High", mode: "ok" };
  return { label: "Okay", comfort: "Medium", mode: "ok" };
}

function gasStatus(ppm) {
  if (ppm == null) return { label: "No data", mode: "warn" };
  if (ppm >= 520) return { label: "Dangerous", mode: "danger" };
  if (ppm >= 360) return { label: "Moderate", mode: "warn" };
  return { label: "Safe", mode: "ok" };
}

function comfortScore() {
  const t = state.tempC;
  const h = state.humidity;
  const g = state.gasPpm;
  const v = state.airflow == null ? 70 : state.airflow;

  if (t == null || h == null || g == null) {
    return { tScore: 0, hScore: 0, gScore: 0, vScore: 0, overall: 0 };
  }

  const tScore = clamp(100 - Math.abs(t - 29) * 9, 0, 100);
  const hScore = clamp(100 - Math.abs(h - 60) * 3.2, 0, 100);
  const gScore = clamp(100 - Math.max(0, g - 150) * 0.22, 0, 100);
  const vScore = clamp(v, 0, 100);
  const overall = Math.round(tScore * 0.32 + hScore * 0.26 + gScore * 0.28 + vScore * 0.14);

  return {
    tScore: Math.round(tScore),
    hScore: Math.round(hScore),
    gScore: Math.round(gScore),
    vScore: Math.round(vScore),
    overall,
  };
}

function shedHealthFromComfort(c) {
  let penalty = 0;
  const ts = tempStatus(state.tempC);
  const gs = gasStatus(state.gasPpm);
  if (ts.mode === "danger") penalty += 18;
  if (gs.mode === "danger") penalty += 28;
  if (gs.mode === "warn") penalty += 10;
  const base = c.overall - penalty * 0.25;
  return clamp(Math.round(base), 0, 100);
}

function setText(id, v) {
  const el = $(id);
  if (el) el.textContent = `${v}`;
}

function addLog(kind, title, meta) {
  const log = $("#eventLog");
  const item = document.createElement("div");
  item.className = "log-item";
  const dot = document.createElement("div");
  dot.className = "log-item__dot";
  if (kind === "warn") dot.classList.add("log-item__dot--warn");
  if (kind === "danger") dot.classList.add("log-item__dot--danger");
  const body = document.createElement("div");
  body.className = "log-item__body";
  const t = document.createElement("div");
  t.className = "log-item__title";
  t.textContent = title;
  const m = document.createElement("div");
  m.className = "log-item__meta";
  m.textContent = `${fmtStamp(now())} • ${meta}`;
  body.appendChild(t);
  body.appendChild(m);
  item.appendChild(dot);
  item.appendChild(body);
  log.prepend(item);

  while (log.children.length > 16) log.removeChild(log.lastChild);
}

function heatmapInit() {
  const box = $("#heatmap");
  box.innerHTML = "";
  for (let i = 0; i < 60; i += 1) {
    const cell = document.createElement("div");
    cell.className = "heat-cell";
    cell.style.setProperty("--heat", state.heat[i].toFixed(2));
    box.appendChild(cell);
  }
}
function heatmapRender() {
  const box = $("#heatmap");
  [...box.children].forEach((cell, idx) => {
    cell.style.setProperty("--heat", clamp(state.heat[idx] ?? 0, 0, 1).toFixed(2));
  });
}

function renderAnimalCards() {
  const grid = $("#animalCards");
  grid.innerHTML = "";
  const empty = document.createElement("article");
  empty.className = "card";
  empty.innerHTML = `
    <div class="card__top">
      <div class="card__title">Awaiting RFID animal data</div>
      <div class="badge">ThingSpeak</div>
    </div>
    <p class="p" style="margin-top:8px;">
      Animal profile cards will populate when your ThingSpeak feed provides RFID tag + metadata mapping.
      This UI does not generate demo animals.
    </p>
    <div class="hint">Tip: store Tag ID in one field and Zone/Location in another field.</div>
  `;
  grid.appendChild(empty);
}

function alertCard(kind, title, desc) {
  const el = document.createElement("article");
  el.className = "card";
  const top = document.createElement("div");
  top.className = "card__top";
  const t = document.createElement("div");
  t.className = "card__title";
  t.textContent = title;
  const b = document.createElement("div");
  b.className = "badge";
  if (kind === "danger") {
    b.textContent = "Critical";
    setBadge(b, "danger");
  } else if (kind === "warn") {
    b.textContent = "Warning";
    setBadge(b, "warn");
  } else {
    b.textContent = "Info";
  }
  top.appendChild(t);
  top.appendChild(b);

  const p = document.createElement("p");
  p.className = "p";
  p.style.marginTop = "8px";
  p.textContent = desc;

  const meta = document.createElement("div");
  meta.className = "hint";
  meta.textContent = `${fmtStamp(now())} • Auto-generated`;

  el.appendChild(top);
  el.appendChild(p);
  el.appendChild(meta);
  el.style.transform = "translateY(0)";
  el.animate(
    [
      { transform: "translateY(6px)", opacity: 0.0 },
      { transform: "translateY(0)", opacity: 1.0 },
    ],
    { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" }
  );
  return el;
}

function renderAlerts() {
  const grid = $("#alertsGrid");
  grid.innerHTML = "";

  const ts = tempStatus(state.tempC);
  const gs = gasStatus(state.gasPpm);

  const alerts = [];
  if (gs.mode !== "ok") {
    alerts.push({
      kind: gs.mode,
      title: "⚠ Gas hazard alert",
      desc:
        gs.mode === "danger"
          ? "Gas level exceeded safe threshold. Activate ventilation and inspect shed immediately."
          : "Gas concentration elevated. Increase airflow and monitor continuously.",
    });
  }
  if (ts.mode !== "ok") {
    alerts.push({
      kind: ts.mode,
      title: "⚠ Abnormal temperature alert",
      desc:
        ts.mode === "danger"
          ? "Temperature is outside safe comfort range. Check cooling/heating systems."
          : "Temperature drifting from optimal. Consider ventilation adjustment.",
    });
  }
  if (state.airflow != null && state.airflow < 45) {
    alerts.push({
      kind: "warn",
      title: "⚠ Low ventilation warning",
      desc: "Ventilation score is below target. Fans may need higher duty cycle.",
    });
  }

  if (!alerts.length) {
    alerts.push({
      kind: "ok",
      title: "No critical alerts",
      desc: "All systems are within safe comfort and safety thresholds.",
    });
    alerts.push({
      kind: "ok",
      title: "RFID coverage stable",
      desc: "Waiting for RFID zone/tag fields from ThingSpeak.",
    });
    alerts.push({
      kind: "ok",
      title: "Ventilation nominal",
      desc: "Airflow is balanced for humidity and gas safety.",
    });
  }

  alerts.slice(0, 6).forEach((a) => grid.appendChild(alertCard(a.kind, a.title, a.desc)));
}

function pushGasLog(ppm) {
  if (ppm == null) return;
  state.gasLog.unshift({ ppm: Math.round(ppm), t: fmtStamp(now()) });
  if (state.gasLog.length > 30) state.gasLog.pop();
}

function renderHistory() {
  const box = $("#scanHistory");
  box.innerHTML = "";
  state.scanHistory.slice(0, 10).forEach((h) => {
    const it = document.createElement("div");
    it.className = "history-item";
    it.innerHTML = `
      <div class="history-item__top">
        <div class="history-item__tag">${h.tag}</div>
        <div class="history-item__time">${h.time}</div>
      </div>
      <div class="history-item__meta">${h.animal} • ${h.location} • ${h.status}</div>
    `;
    box.appendChild(it);
  });
}

function addTimeline(title, meta) {
  const list = $("#activityTimeline");
  const row = document.createElement("div");
  row.className = "tl";
  row.innerHTML = `
    <div class="tl__dot"></div>
    <div class="tl__body">
      <div class="tl__title">${title}</div>
      <div class="tl__meta">${fmtStamp(now())} • ${meta}</div>
    </div>
  `;
  list.prepend(row);
  while (list.children.length > 8) list.removeChild(list.lastChild);
}

function clearSnapshotsUi() {
  const g = $("#snapshotGallery");
  g.innerHTML = "";
  const el = document.createElement("div");
  el.className = "shot";
  el.innerHTML = `<div class="shot__meta"><span>NO DATA</span><span>—</span></div>`;
  g.appendChild(el);
}

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && item.image && item.time).slice(0, 30);
  } catch {
    return [];
  }
}

function saveSnapshots(list) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(list.slice(0, 30)));
}

function loadCameraUrl() {
  try {
    const raw = localStorage.getItem(CAMERA_URL_KEY);
    if (!raw) return DEFAULT_CAMERA_URL;
    const url = raw.trim();
    return url || DEFAULT_CAMERA_URL;
  } catch {
    return DEFAULT_CAMERA_URL;
  }
}

function saveCameraUrl(url) {
  localStorage.setItem(CAMERA_URL_KEY, url);
}

function renderSnapshots() {
  const g = $("#snapshotGallery");
  const shots = loadSnapshots().slice(0, 6);
  g.innerHTML = "";
  if (!shots.length) {
    clearSnapshotsUi();
    return;
  }
  shots.forEach((shot, idx) => {
    const el = document.createElement("div");
    el.className = "shot";
    el.innerHTML = `
      <img src="${shot.image}" alt="Stream snapshot ${idx + 1}" class="camera__stream" />
      <div class="shot__meta"><span>CAPTURED</span><span>${shot.time}</span></div>
    `;
    g.appendChild(el);
  });
}

function saveSnapshot(imageDataUrl) {
  const existing = loadSnapshots();
  const next = [{ image: imageDataUrl, time: fmtStamp(now()) }, ...existing].slice(0, 30);
  saveSnapshots(next);
  renderSnapshots();
}

function captureCurrentFrame() {
  const streamEl = $("#cameraStream");
  if (!streamEl || !streamEl.complete) {
    addLog("warn", "Capture failed", "Stream is not ready yet");
    addTimeline("Snapshot failed", "Stream not ready");
    return;
  }
  const w = streamEl.naturalWidth || streamEl.clientWidth || 640;
  const h = streamEl.naturalHeight || streamEl.clientHeight || 360;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(streamEl, 0, 0, w, h);
  try {
    const shot = canvas.toDataURL("image/jpeg", 0.92);
    saveSnapshot(shot);
    addLog("ok", "Photo captured", "Current stream frame stored locally");
    addTimeline("Snapshot captured", "Saved to dashboard gallery");
  } catch {
    const hint = $("#streamHint");
    if (hint) {
      hint.textContent =
        "Cannot capture due to browser security (CORS). Enable CORS on stream server or use backend proxy.";
    }
    addLog("warn", "Capture blocked", "Enable CORS on camera stream or proxy through backend");
    addTimeline("Snapshot blocked", "CORS restriction from camera stream");
  }
}

function applyCameraStreamUrl() {
  const streamEl = $("#cameraStream");
  const streamBadge = $("#streamBadge");
  const hint = $("#streamHint");
  if (!streamEl) return;

  const cameraUrl = loadCameraUrl();
  streamEl.src = cameraUrl;
  if (hint) hint.textContent = `Stream source: ${cameraUrl}`;
  if (streamBadge) streamBadge.textContent = "Connecting";

  if (window.location.protocol === "https:" && cameraUrl.startsWith("http://")) {
    if (hint) {
      hint.textContent =
        `Mixed content blocked on HTTPS. Set an HTTPS proxy URL in Camera URL settings. Current: ${cameraUrl}`;
    }
  }
}

function updateUI() {
  // header chips
  $("#lastUpdateValue").textContent = state.lastFeedAt ? fmtTime(new Date(state.lastFeedAt)) : "—";
  $("#activeTagsValue").textContent = state.activeTags == null ? "—" : `${state.activeTags}`;

  // metric numbers
  setText("#tempValue", state.tempC == null ? "—" : state.tempC.toFixed(1));
  setText("#humidityValue", state.humidity == null ? "—" : Math.round(state.humidity));
  setText("#gasValue", state.gasPpm == null ? "—" : Math.round(state.gasPpm));
  setText("#gasLogCount", `${state.gasLog.length}`);

  // status badges
  const ts = tempStatus(state.tempC);
  $("#tempBadge").textContent = ts.label;
  setBadge($("#tempBadge"), ts.mode);

  const hs = humidityStatus(state.humidity);
  $("#humidityBadge").textContent = hs.label;
  setBadge($("#humidityBadge"), hs.mode);
  $("#humidityComfort").textContent = hs.comfort;
  $("#humidityWeekly").textContent = "From ThingSpeak";

  const gs = gasStatus(state.gasPpm);
  $("#gasBadge").textContent = gs.label;
  setBadge($("#gasBadge"), gs.mode);
  $("#gasStatus").textContent = gs.label;

  const c = comfortScore();
  $("#comfortValue").textContent = `${c.overall}`;
  $("#tempScore").textContent = `${c.tScore}/100`;
  $("#humScore").textContent = `${c.hScore}/100`;
  $("#gasScore").textContent = `${c.gScore}/100`;
  $("#ventStatus").textContent =
    state.airflow == null ? "No data" : state.airflow < 50 ? "Low airflow" : "Balanced airflow";
  $("#comfortScore").textContent = `${c.overall}/100`;

  // ring stroke
  const circumference = 2 * Math.PI * 46; // must match r=46
  const offset = circumference * (1 - c.overall / 100);
  $("#comfortRing").style.strokeDasharray = `${circumference.toFixed(0)}`;
  $("#comfortRing").style.strokeDashoffset = `${offset.toFixed(0)}`;

  // shed health
  state.shedHealth = c.overall ? shedHealthFromComfort(c) : null;
  $("#shedHealthValue").textContent = state.shedHealth == null ? "—" : `${state.shedHealth}%`;
  $("#shedHealthLarge").textContent = state.shedHealth == null ? "—" : `${state.shedHealth}`;
  $("#shedProgressFill").style.width = state.shedHealth == null ? "0%" : `${state.shedHealth}%`;
  $("#shedBadge").textContent =
    state.shedHealth == null
      ? "No data"
      : state.shedHealth >= 85
        ? "Healthy"
        : state.shedHealth >= 70
          ? "Watch"
          : "Risk";
  setBadge(
    $("#shedBadge"),
    state.shedHealth == null
      ? "warn"
      : state.shedHealth >= 85
        ? "ok"
        : state.shedHealth >= 70
          ? "warn"
          : "danger"
  );

  // daily stats
  $("#dailyScansValue").textContent = `${state.scansToday}`;
  $("#dailyAlertsValue").textContent = `${state.alertsToday}`;
  $("#occupancyValue").textContent =
    state.occupancyPct == null ? "—" : `${Math.round(state.occupancyPct)}`;

  // ventilation card
  $("#airflowValue").textContent = state.airflow == null ? "—" : `${Math.round(state.airflow)}`;
  $("#fansValue").textContent = state.fansOn == null ? "—" : `${state.fansOn}`;
  $("#co2Value").textContent = state.co2Proxy == null ? "—" : `${Math.round(state.co2Proxy)}`;
  $("#ventValue").textContent =
    state.airflow == null ? "—" : state.airflow < 50 ? "Low" : "Good";
  $("#ventBadge").textContent =
    state.airflow == null ? "No data" : state.airflow < 50 ? "Low" : "Balanced";
  setBadge($("#ventBadge"), state.airflow == null ? "warn" : state.airflow < 50 ? "warn" : "ok");

  // system health
  const upMs = Date.now() - state.start;
  const upMin = Math.floor(upMs / 60000);
  const upH = Math.floor(upMin / 60);
  const upM = upMin % 60;
  $("#uptimeValue").textContent = `${upH}h ${upM}m`;
  $("#packetsValue").textContent = `${state.packets}`;
  $("#latencyValue").textContent = "—";

  // temperature daily high/low/avg
  const temps24 = state.tempSeries.slice(-24).filter((x) => x != null);
  if (temps24.length) {
    const avgT = temps24.reduce((a, b) => a + b, 0) / temps24.length;
    $("#tempAvg").textContent = `${avgT.toFixed(1)}°C`;
    $("#tempHigh").textContent = `${Math.max(...temps24).toFixed(1)}°C`;
    $("#tempLow").textContent = `${Math.min(...temps24).toFixed(1)}°C`;
  } else {
    $("#tempAvg").textContent = "—";
    $("#tempHigh").textContent = "—";
    $("#tempLow").textContent = "—";
  }

  renderAlerts();
}

function updateCharts() {
  const labels = state.timeLabels.slice(-24);

  tempChart.data.labels = labels;
  tempChart.data.datasets[0].data = state.tempSeries.slice(-24);
  tempChart.update("none");

  humidityChart.data.labels = labels;
  humidityChart.data.datasets[0].data = state.humiditySeries.slice(-24);
  humidityChart.update("none");

  gasChart.data.labels = labels;
  gasChart.data.datasets[0].data = state.gasSeries.slice(-24);
  gasChart.update("none");

  trendChart.data.labels = labels;
  trendChart.data.datasets[0].data = state.tempSeries.slice(-24);
  trendChart.data.datasets[1].data = state.humiditySeries.slice(-24);
  trendChart.data.datasets[2].data = state.gasSeries.slice(-24);
  trendChart.update("none");

  occupancyChart.update("none");
}

function initCharts() {
  chartDefaults();

  tempChart = makeMiniLine("#tempChart", state.tempSeries, "rgba(115,255,199,0.9)");
  humidityChart = makeMiniLine("#humidityChart", state.humiditySeries, "rgba(115,166,255,0.9)");
  gasChart = makeMiniLine("#gasChart", state.gasSeries, "rgba(255,191,122,0.9)");

  // composite trend chart
  const trendCtx = $("#trendChart").getContext("2d");
  trendChart = new Chart(trendCtx, {
    type: "line",
    data: {
      labels: state.timeLabels.slice(-24),
      datasets: [
        {
          label: "Temp (°C)",
          data: state.tempSeries.slice(-24),
          borderColor: "rgba(115,255,199,0.95)",
          backgroundColor: "rgba(115,255,199,0.10)",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.40,
          yAxisID: "y",
        },
        {
          label: "Humidity (%)",
          data: state.humiditySeries.slice(-24),
          borderColor: "rgba(115,166,255,0.95)",
          backgroundColor: "rgba(115,166,255,0.10)",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.40,
          yAxisID: "y",
        },
        {
          label: "Gas (ppm)",
          data: state.gasSeries.slice(-24),
          borderColor: "rgba(255,191,122,0.95)",
          backgroundColor: "rgba(255,191,122,0.08)",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.40,
          yAxisID: "y2",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: "easeOutQuart" },
      plugins: {
        legend: {
          position: "top",
          labels: { boxWidth: 10, boxHeight: 10, color: "rgba(245,249,246,0.70)" },
        },
        tooltip: { mode: "index", intersect: false },
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: { color: "rgba(245,249,246,0.52)" },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.06)" },
          ticks: { color: "rgba(245,249,246,0.52)" },
        },
        y2: {
          position: "right",
          grid: { drawOnChartArea: false },
          ticks: { color: "rgba(245,249,246,0.52)" },
        },
      },
    },
  });

  // attendance chart
  const attCtx = $("#attendanceChart").getContext("2d");
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const att = days.map(() => 0);
  attendanceChart = new Chart(attCtx, {
    type: "bar",
    data: {
      labels: days,
      datasets: [
        {
          label: "RFID scans",
          data: att,
          borderColor: "rgba(115,166,255,0.60)",
          backgroundColor: "rgba(115,166,255,0.22)",
          borderWidth: 1,
          borderRadius: 12,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "rgba(245,249,246,0.52)" } },
        y: { grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "rgba(245,249,246,0.52)" } },
      },
    },
  });

  // occupancy chart
  const occCtx = $("#occupancyChart").getContext("2d");
  const occ = [];
  occupancyChart = new Chart(occCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Occupancy (%)",
          data: [],
          borderColor: "rgba(115,255,199,0.95)",
          backgroundColor: "rgba(115,255,199,0.10)",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.42,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "rgba(245,249,246,0.52)" } },
        y: { grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "rgba(245,249,246,0.52)" }, suggestedMin: 55, suggestedMax: 100 },
      },
    },
  });
}
async function fetchThingSpeak() {
  if (!state.syncing) return;
  if (!TS.channelId) {
    setSystemStatus("System: Configure ThingSpeak", false);
    return;
  }

  try {
    setSystemStatus("System: Syncing…", true);
    const url = new URL(`https://api.thingspeak.com/channels/${TS.channelId}/feeds.json`);
    url.searchParams.set("results", String(TS.results || 60));
    if (TS.readApiKey) url.searchParams.set("api_key", TS.readApiKey);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`ThingSpeak HTTP ${res.status}`);
    const data = await res.json();

    const feeds = Array.isArray(data.feeds) ? data.feeds : [];
    if (!feeds.length) {
      setSystemStatus("System: No feeds yet", true);
      return;
    }

    // Time labels
    state.timeLabels = feeds.map((f) => {
      const t = f.created_at ? new Date(f.created_at) : now();
      return fmtTime(t);
    });

    // Series from mapped fields
    const f = TS.fields || {};
    const tempSeries = feeds.map((x) => toNum(x[`field${f.temperatureC}`]));
    const humSeries = feeds.map((x) => toNum(x[`field${f.humidityPct}`]));
    const gasSeries = feeds.map((x) => toNum(x[`field${f.gasPpm}`]));

    state.tempSeries = tempSeries.filter((x) => x != null);
    state.humiditySeries = humSeries.filter((x) => x != null);
    state.gasSeries = gasSeries.filter((x) => x != null);

    // Current values = last non-null reading
    const lastTemp = [...tempSeries].reverse().find((x) => x != null);
    const lastHum = [...humSeries].reverse().find((x) => x != null);
    const lastGas = [...gasSeries].reverse().find((x) => x != null);
    state.tempC = lastTemp;
    state.humidity = lastHum;
    state.gasPpm = lastGas;

    // Optional fields (if present in channel)
    const airflowSeries =
      f.airflowPct != null ? feeds.map((x) => toNum(x[`field${f.airflowPct}`])) : [];
    const occSeries =
      f.occupancyPct != null ? feeds.map((x) => toNum(x[`field${f.occupancyPct}`])) : [];
    const scansToday =
      f.rfidScansToday != null
        ? [...feeds]
            .reverse()
            .map((x) => toNum(x[`field${f.rfidScansToday}`]))
            .find((x) => x != null)
        : null;

    state.airflow = airflowSeries.length
      ? [...airflowSeries].reverse().find((x) => x != null)
      : null;
    state.occupancyPct = occSeries.length
      ? [...occSeries].reverse().find((x) => x != null)
      : null;
    if (scansToday != null) state.scansToday = Math.round(scansToday);

    // Derived system values (from real fields)
    if (state.airflow == null && state.gasPpm != null) {
      // estimate ventilation score from gas concentration if no direct airflow field
      state.airflow = clamp(100 - Math.max(0, state.gasPpm - 120) * 0.2, 35, 95);
    }
    state.fansOn = state.airflow == null ? null : state.airflow > 70 ? 3 : state.airflow > 52 ? 2 : 1;
    state.co2Proxy = state.gasPpm == null ? null : clamp(520 + (state.gasPpm - 140) * 1.7, 420, 1600);

    // RFID from field4 (+ optional zone field)
    const lastFeed = feeds[feeds.length - 1];
    const rfidSeries = feeds
      .map((x) => ({
        tag: safeText(x[`field${f.rfidTag}`], ""),
        time: x.created_at ? new Date(x.created_at) : now(),
      }))
      .filter((x) => x.tag);
    const tag = rfidSeries.length ? rfidSeries[rfidSeries.length - 1].tag : "";
    const zone =
      f.rfidZone != null ? safeText(lastFeed[`field${f.rfidZone}`], "") : "Inside Shed";
    if (tag) state.lastTag = tag;
    if (zone) state.lastZone = zone;

    // build RFID scan history from recent entries
    state.scanHistory = rfidSeries
      .slice(-20)
      .reverse()
      .map((x) => ({
        tag: x.tag,
        animal: `Tag ${x.tag}`,
        status: "Inside Shed",
        location: state.lastZone || "Inside Shed",
        time: fmtTime(x.time),
      }));
    renderHistory();

    // count RFID entries today when dedicated count field is absent
    if (scansToday == null) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      state.scansToday = rfidSeries.filter((x) => x.time >= today).length;
    }
    state.activeTags = new Set(rfidSeries.map((x) => x.tag)).size || null;

    // Update RFID panel UI from ThingSpeak (read-only)
    setText("#tagIdValue", safeText(state.lastTag));
    setText("#lastScannedValue", safeText(state.lastTag ? `Tag ${state.lastTag}` : "—"));
    setText("#animalLocationValue", safeText(state.lastZone));
    setText("#scanTimestampValue", lastFeed.created_at ? fmtStamp(new Date(lastFeed.created_at)) : "—");

    // Gas log (derived from feed)
    state.gasLog = feeds
      .slice(-30)
      .map((x) => {
        const ppm = toNum(x[`field${f.gasPpm}`]);
        if (ppm == null) return null;
        return { ppm: Math.round(ppm), t: x.created_at ? fmtStamp(new Date(x.created_at)) : fmtStamp(now()) };
      })
      .filter(Boolean);

    state.lastFeedAt = lastFeed.created_at || null;
    state.packets += 1;

    updateUI();
    updateCharts();
    renderAnimalCards();

    // Optional: heatmap from occupancy/activity series if provided.
    // If occupancy is provided, map to heat intensity uniformly (no fake motion).
    if (state.occupancyPct != null) {
      const heat = clamp(state.occupancyPct / 100, 0, 1);
      state.heat = new Array(60).fill(heat);
      heatmapRender();
    }

    setSystemStatus("System: Online", true);
  } catch (err) {
    addLog("warn", "ThingSpeak sync failed", safeText(err?.message || err));
    setSystemStatus("System: Offline", false);
  }
}

function setSystemStatus(label, ok) {
  const sys = $("#systemStatus");
  if (!sys) return;
  const dot = sys.querySelector(".status-pill__dot");
  const txt = sys.querySelector(".status-pill__label");
  txt.textContent = label;
  dot.style.opacity = ok ? "1" : "0.35";
}

function setupActions() {
  const scanBtn = $("#scanBtn");
  const input = $("#rfidInput");
  const clearBtn = $("#clearHistoryBtn");
  const syncBtn = $("#syncBtn");
  const settingsBtn = $("#tsSettingsBtn");
  const refreshBtn = $("#refreshNowBtn");
  const addSnapshotBtn = $("#addSnapshotBtn");
  const captureBtn = $("#captureStreamBtn");
  const openStreamBtn = $("#openStreamBtn");
  const cameraSettingsBtn = $("#cameraSettingsBtn");
  const streamEl = $("#cameraStream");

  // Disable local scan input (ThingSpeak-only)
  input.setAttribute("disabled", "true");
  input.setAttribute("placeholder", "RFID data comes from ThingSpeak fields");
  scanBtn.setAttribute("disabled", "true");
  $("#rfidBadge").textContent = "ThingSpeak";

  clearBtn.addEventListener("click", () => {
    state.scanHistory = [];
    renderHistory();
    setText("#tagIdValue", "—");
    setText("#lastScannedValue", "—");
    setText("#animalLocationValue", "—");
    setText("#scanTimestampValue", "—");
  });

  syncBtn.addEventListener("click", () => {
    state.syncing = !state.syncing;
    syncBtn.setAttribute("aria-pressed", String(state.syncing));
    syncBtn.textContent = state.syncing ? "Sync: On" : "Sync: Off";
    setSystemStatus(state.syncing ? "System: Online" : "System: Paused", state.syncing);
  });

  refreshBtn.addEventListener("click", () => fetchThingSpeak());
  addSnapshotBtn.addEventListener("click", captureCurrentFrame);
  captureBtn.addEventListener("click", captureCurrentFrame);
  openStreamBtn.addEventListener("click", () =>
    window.open(loadCameraUrl(), "_blank", "noopener,noreferrer")
  );
  cameraSettingsBtn.addEventListener("click", () => {
    const nextUrl = prompt(
      "Camera stream URL (use HTTPS proxy URL when dashboard is hosted on HTTPS):",
      loadCameraUrl()
    );
    if (nextUrl == null) return;
    const cleaned = nextUrl.trim();
    if (!cleaned) return;
    saveCameraUrl(cleaned);
    applyCameraStreamUrl();
    addLog("ok", "Camera URL updated", cleaned);
  });

  if (streamEl) {
    applyCameraStreamUrl();
    streamEl.addEventListener("load", () => {
      const hint = $("#streamHint");
      if (hint) hint.textContent = `Stream connected: ${loadCameraUrl()}`;
      const streamBadge = $("#streamBadge");
      if (streamBadge) streamBadge.textContent = "Connected";
    });
    streamEl.addEventListener("error", () => {
      const hint = $("#streamHint");
      if (hint) hint.textContent = `Unable to display ${loadCameraUrl()}. Check camera network/proxy access.`;
      const streamBadge = $("#streamBadge");
      if (streamBadge) streamBadge.textContent = "Unavailable";
    });
  }

  settingsBtn.addEventListener("click", () => {
    // Simple, dependency-free configuration flow.
    // Channel ID is required; API key is optional for public channels.
    const channelId = prompt("ThingSpeak Channel ID:", TS.channelId || "");
    if (channelId == null) return;
    const readKey = prompt("ThingSpeak Read API Key (optional if public):", TS.readApiKey || "");
    if (readKey == null) return;

    TS = { ...TS, channelId: channelId.trim(), readApiKey: readKey.trim() };
    saveTsConfig(TS);
    addLog("ok", "ThingSpeak settings updated", `Channel: ${safeText(TS.channelId)}`);
    fetchThingSpeak();
  });

  $("#printBtn").addEventListener("click", () => window.print());
  $("#exportBtn").addEventListener("click", exportCsv);
}

function exportCsv() {
  const rows = [
    ["timestamp", "temp_c", "humidity_pct", "gas_ppm"],
    ...state.timeLabels.slice(-24).map((t, i) => {
      const tc = state.tempSeries.slice(-24)[i];
      const hu = state.humiditySeries.slice(-24)[i];
      const ga = state.gasSeries.slice(-24)[i];
      return [t, tc == null ? "" : tc.toFixed(2), hu == null ? "" : hu.toFixed(2), ga == null ? "" : ga.toFixed(2)];
    }),
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `smart-shed-demo-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  addTimeline("Export CSV", "Sensor trend export downloaded");
}

function boot() {
  ensureEmptyCharts();
  heatmapInit();
  clearSnapshotsUi();
  renderSnapshots();

  addLog("ok", "System initialized", "Source: ThingSpeak only");
  addTimeline("Dashboard started", "Waiting for ThingSpeak data");

  initCharts();
  renderAnimalCards();
  renderHistory();

  updateUI();
  setupActions();

  // ThingSpeak rate limits: keep polling conservative (15s+)
  fetchThingSpeak();
  setInterval(fetchThingSpeak, 15000);
}

boot();

