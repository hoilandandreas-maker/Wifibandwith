'use strict';

/* ============================================================
 * WiFi Survey — bandwidth / latency / signal field logger
 * Static PWA, no build step, no external dependencies.
 * ============================================================ */

const APP_VERSION = '1.0.0';

/* ---------- tiny helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const now = () => performance.now();
// crypto.randomUUID needs a secure context; plain-HTTP LAN serving is supported
const makeId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

function fmtSpeed(mbps) {
  if (mbps == null) return '—';
  if (mbps < 10) return mbps.toFixed(2);
  if (mbps < 100) return mbps.toFixed(1);
  return Math.round(mbps).toString();
}
function fmtDate(t) {
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------- storage: measurements + settings in localStorage ---------- */
const LS_MEAS = 'wifisurvey.measurements';
const LS_SETTINGS = 'wifisurvey.settings';

function loadMeasurements() {
  try { return JSON.parse(localStorage.getItem(LS_MEAS)) || []; }
  catch { return []; }
}
function saveMeasurements(list) {
  localStorage.setItem(LS_MEAS, JSON.stringify(list));
}
let measurements = loadMeasurements();

const DEFAULT_SETTINGS = {
  server: 'cloudflare',
  downUrl: '',
  upUrl: '',
  duration: 8,
  gps: true,
};
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(LS_SETTINGS)) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
let settings = loadSettings();
function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
}

/* ---------- storage: site-plan image in IndexedDB ---------- */
const idb = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const req = indexedDB.open('wifisurvey', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { this._db = req.result; res(this._db); };
      req.onerror = () => rej(req.error);
    });
  },
  async set(key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async del(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
};

let planImage = null; // ImageBitmap (or HTMLImageElement) of the site plan, if any

async function loadPlanImage() {
  try {
    const blob = await idb.get('planImage');
    planImage = blob ? await createImageBitmap(blob) : null;
  } catch {
    planImage = null;
  }
  updatePlanUI();
}

/* ---------- speed test engine ---------- */
function cacheBust(url) {
  return url + (url.includes('?') ? '&' : '?') + 'cb=' + Math.random().toString(36).slice(2);
}

function serverConfig() {
  if (settings.server === 'custom' && settings.downUrl) {
    return {
      name: 'custom',
      pingUrl: () => cacheBust(settings.downUrl),
      preferHead: true, // avoids pulling file data just to measure latency
      downUrl: () => cacheBust(settings.downUrl),
      upUrl: settings.upUrl || null,
      sized: false,
    };
  }
  return {
    name: 'cloudflare',
    pingUrl: () => cacheBust('https://speed.cloudflare.com/__down?bytes=0'),
    downUrl: (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
    upUrl: 'https://speed.cloudflare.com/__up',
    sized: true,
  };
}

/* Latency: time until response headers arrive; body is cancelled. */
async function measurePing(cfg, signal, onSample) {
  let method = 'GET';
  if (cfg.preferHead) {
    try {
      const probe = await fetch(cfg.pingUrl(), { method: 'HEAD', cache: 'no-store', signal });
      if (probe.ok) method = 'HEAD';
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  const samples = [];
  const N = 8;
  for (let i = 0; i < N; i++) {
    const t0 = now();
    const resp = await fetch(cfg.pingUrl(), { method, cache: 'no-store', signal });
    const dt = now() - t0;
    try { await resp.body?.cancel(); } catch { /* body may already be done */ }
    samples.push(dt);
    onSample((i + 1) / N, dt);
  }
  samples.shift(); // first sample pays for connection setup
  let jitter = 0;
  for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i] - samples[i - 1]);
  jitter /= samples.length - 1;
  return {
    ping: Math.round(Math.min(...samples)),
    jitter: Math.round(jitter * 10) / 10,
  };
}

/* Download: stream data for `seconds`, growing request size on fast links. */
async function measureDownload(cfg, seconds, signal, onProgress) {
  const targetMs = seconds * 1000;
  let total = 0;
  let chunk = 512 * 1024;
  const MAX_CHUNK = 64 * 1024 * 1024;

  // warm-up (not counted): opens the connection
  try {
    const warm = await fetch(cfg.sized ? cfg.downUrl(100 * 1024) : cfg.downUrl(), { cache: 'no-store', signal });
    if (cfg.sized) await warm.arrayBuffer();
    else await warm.body?.cancel();
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // warm-up failure will re-surface in the main loop with a clearer error
  }

  const t0 = now();
  while (now() - t0 < targetMs) {
    const resp = await fetch(cfg.downUrl(chunk), { cache: 'no-store', signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const reader = resp.body.getReader();
    const chunkStart = now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      const elapsed = now() - t0;
      onProgress(Math.min(elapsed / targetMs, 1), (total * 8) / (elapsed / 1000) / 1e6);
      if (elapsed >= targetMs) { await reader.cancel(); break; }
    }
    if (cfg.sized && now() - chunkStart < 1500 && chunk < MAX_CHUNK) chunk *= 4;
  }
  const secs = (now() - t0) / 1000;
  if (total === 0) throw new Error('no data received');
  return { mbps: (total * 8) / secs / 1e6, bytes: total, seconds: secs };
}

/* Upload: POST random data for `seconds`, adapting POST size to ~2 s each. */
function randomBlob(bytes) {
  const block = new Uint8Array(65536);
  crypto.getRandomValues(block);
  const parts = [];
  let left = bytes;
  while (left > 0) {
    parts.push(left >= block.length ? block : block.subarray(0, left));
    left -= block.length;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

async function measureUpload(cfg, seconds, signal, onProgress) {
  const targetMs = seconds * 1000;
  let total = 0;
  let size = 256 * 1024;
  const t0 = now();
  while (now() - t0 < targetMs) {
    const postStart = now();
    const resp = await fetch(cfg.upUrl, {
      method: 'POST', body: randomBlob(size), cache: 'no-store', signal,
    });
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    if (!resp.ok && resp.status !== 0) throw new Error('HTTP ' + resp.status);
    const dt = (now() - postStart) / 1000;
    total += size;
    const elapsed = now() - t0;
    onProgress(Math.min(elapsed / targetMs, 1), (total * 8) / (elapsed / 1000) / 1e6);
    const bytesPerSec = size / dt;
    size = Math.min(Math.max(Math.round(bytesPerSec * 2), 128 * 1024), 32 * 1024 * 1024);
  }
  const secs = (now() - t0) / 1000;
  if (total === 0) throw new Error('no data sent');
  return { mbps: (total * 8) / secs / 1e6, bytes: total, seconds: secs };
}

/* ---------- GPS + browser connection info ---------- */
function getGPS(timeoutMs = 20000) {
  return new Promise((res) => {
    if (!settings.gps || !('geolocation' in navigator)) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({
        lat: +p.coords.latitude.toFixed(6),
        lon: +p.coords.longitude.toFixed(6),
        acc: Math.round(p.coords.accuracy),
      }),
      () => res(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}

function connectionInfo() {
  const c = navigator.connection;
  if (!c) return null;
  return {
    type: c.type ?? null,
    effectiveType: c.effectiveType ?? null,
    downlink: c.downlink ?? null,
    rtt: c.rtt ?? null,
  };
}

/* ---------- measure flow ---------- */
let pendingPlanPos = null; // {x, y} fractions on the plan image
let testAbort = null;

// phase → [progress-bar start, span]
const PHASE_SPAN = { ping: [0, 0.15], down: [0.15, 0.45], up: [0.6, 0.4] };

function setLive(phase, label, frac, value, unit) {
  $('#live-phase').textContent = label;
  $('#live-value').textContent = value;
  $('#live-unit').textContent = unit;
  const [base, span] = PHASE_SPAN[phase] || [0, 0];
  $('#live-bar').style.width = ((base + span * frac) * 100).toFixed(1) + '%';
}

async function runTest() {
  const cfg = serverConfig();
  if (settings.server === 'custom' && !settings.downUrl) {
    toast('Set the custom download URL in Settings first');
    return;
  }

  testAbort = new AbortController();
  const signal = testAbort.signal;
  $('#btn-start').disabled = true;
  $('#result').classList.add('hidden');
  $('#live').classList.remove('hidden');

  const gpsPromise = getGPS(); // runs while the test does
  const record = {
    id: makeId(),
    t: Date.now(),
    label: $('#m-label').value.trim(),
    notes: $('#m-notes').value.trim(),
    signalDbm: $('#m-signal').value === '' ? null : Number($('#m-signal').value),
    gps: null,
    plan: pendingPlanPos,
    down: null, up: null, ping: null, jitter: null,
    conn: connectionInfo(),
    server: cfg.name,
    errors: [],
  };

  try {
    // 1. latency
    setLive('ping', 'Measuring latency…', 0, '…', 'ms');
    try {
      const p = await measurePing(cfg, signal, (frac, ms) =>
        setLive('ping', 'Measuring latency…', frac, Math.round(ms), 'ms'));
      record.ping = p.ping;
      record.jitter = p.jitter;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      record.errors.push('ping: ' + e.message);
    }

    // 2. download
    setLive('down', 'Download…', 0, '…', 'Mbit/s');
    try {
      const d = await measureDownload(cfg, settings.duration, signal, (frac, mbps) =>
        setLive('down', 'Download…', frac, fmtSpeed(mbps), 'Mbit/s'));
      record.down = +d.mbps.toFixed(2);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      record.errors.push('download: ' + e.message);
    }

    // 3. upload
    if (cfg.upUrl) {
      setLive('up', 'Upload…', 0, '…', 'Mbit/s');
      try {
        const u = await measureUpload(cfg, settings.duration, signal, (frac, mbps) =>
          setLive('up', 'Upload…', frac, fmtSpeed(mbps), 'Mbit/s'));
        record.up = +u.mbps.toFixed(2);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        record.errors.push('upload: ' + e.message);
      }
    }
  } catch (e) {
    // cancelled by the user
    $('#live').classList.add('hidden');
    $('#btn-start').disabled = false;
    testAbort = null;
    toast('Measurement cancelled');
    return;
  }

  record.gps = await gpsPromise;
  $('#live').classList.add('hidden');
  $('#btn-start').disabled = false;
  testAbort = null;

  const gotAnything = record.ping != null || record.down != null || record.up != null;
  if (!gotAnything && record.signalDbm == null) {
    toast('Test failed — server unreachable (' + (record.errors[0] || 'unknown') + ')');
    return;
  }

  measurements.push(record);
  saveMeasurements(measurements);
  pendingPlanPos = null;
  updatePinState();
  showResult(record);
  renderLog();
  updateLabelHistory();
  if (!gotAnything) toast('Server unreachable — saved signal/position only');
}

function showResult(m) {
  $('#r-down').textContent = fmtSpeed(m.down);
  $('#r-up').textContent = fmtSpeed(m.up);
  $('#r-ping').textContent = m.ping ?? '—';
  $('#r-jitter').textContent = m.jitter ?? '—';
  const bits = [];
  if (m.signalDbm != null) bits.push(`signal ${m.signalDbm} dBm (${signalQuality(m.signalDbm)})`);
  if (m.gps) bits.push(`GPS ±${m.gps.acc} m`);
  if (m.plan) bits.push('pinned on plan');
  if (m.conn?.effectiveType) bits.push(`browser sees: ${m.conn.effectiveType}, ~${m.conn.downlink} Mbit/s, rtt ${m.conn.rtt} ms`);
  if (m.errors.length) bits.push('errors: ' + m.errors.join('; '));
  $('#r-extra').textContent = bits.join(' · ');
  $('#result').classList.remove('hidden');
}

function signalQuality(dbm) {
  if (dbm >= -50) return 'excellent';
  if (dbm >= -60) return 'good';
  if (dbm >= -70) return 'fair';
  if (dbm >= -80) return 'weak';
  return 'very weak';
}

/* ---------- log tab ---------- */
function renderLog() {
  const list = $('#log-list');
  const items = [...measurements].sort((a, b) => b.t - a.t);
  $('#log-count').textContent = items.length
    ? `${items.length} measurement${items.length === 1 ? '' : 's'}`
    : 'No measurements yet — run one from the Measure tab.';
  list.innerHTML = '';
  for (const m of items) {
    const item = document.createElement('div');
    item.className = 'log-item';

    const head = document.createElement('button');
    head.className = 'log-head';
    head.innerHTML =
      `<span class="log-title">${escapeHtml(m.label || '(no label)')}</span>` +
      `<span class="log-time">${fmtDate(m.t)}</span>` +
      `<span class="log-summary">↓${fmtSpeed(m.down)} ↑${fmtSpeed(m.up)} Mbit/s · ${m.ping ?? '—'} ms` +
      (m.signalDbm != null ? ` · ${m.signalDbm} dBm` : '') + `</span>`;

    const details = document.createElement('div');
    details.className = 'log-details hidden';

    head.addEventListener('click', () => {
      if (details.classList.contains('hidden')) {
        details.innerHTML = logDetailsHtml(m);
        details.querySelector('.btn.danger').addEventListener('click', () => {
          if (!confirm('Delete this measurement?')) return;
          measurements = measurements.filter((x) => x.id !== m.id);
          saveMeasurements(measurements);
          renderLog();
        });
        details.classList.remove('hidden');
      } else {
        details.classList.add('hidden');
      }
    });

    item.append(head, details);
    list.appendChild(item);
  }
}

function logDetailsHtml(m) {
  const rows = [
    ['Time', new Date(m.t).toLocaleString()],
    ['Download', m.down != null ? fmtSpeed(m.down) + ' Mbit/s' : '—'],
    ['Upload', m.up != null ? fmtSpeed(m.up) + ' Mbit/s' : '—'],
    ['Ping / jitter', (m.ping ?? '—') + ' / ' + (m.jitter ?? '—') + ' ms'],
    ['Signal', m.signalDbm != null ? `${m.signalDbm} dBm (${signalQuality(m.signalDbm)})` : '—'],
    ['GPS', m.gps ? `${m.gps.lat}, ${m.gps.lon} (±${m.gps.acc} m)` : '—'],
    ['Plan position', m.plan ? `${(m.plan.x * 100).toFixed(1)} %, ${(m.plan.y * 100).toFixed(1)} %` : '—'],
    ['Server', m.server],
    ['Browser estimate', m.conn ? `${m.conn.effectiveType ?? '?'} · ${m.conn.downlink ?? '?'} Mbit/s · rtt ${m.conn.rtt ?? '?'} ms` : '—'],
    ['Notes', m.notes || '—'],
  ];
  if (m.errors?.length) rows.push(['Errors', m.errors.join('; ')]);
  return '<table>' +
    rows.map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(String(v))}</td></tr>`).join('') +
    '</table><div class="row end" style="margin-top:8px"><button class="btn danger" type="button">Delete</button></div>';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- export / import ---------- */
function downloadFile(name, mime, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportCsv() {
  const cols = ['time', 'label', 'download_mbps', 'upload_mbps', 'ping_ms', 'jitter_ms',
    'signal_dbm', 'lat', 'lon', 'gps_accuracy_m', 'plan_x', 'plan_y',
    'server', 'conn_type', 'conn_downlink_mbps', 'conn_rtt_ms', 'notes', 'errors'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const m of [...measurements].sort((a, b) => a.t - b.t)) {
    lines.push([
      new Date(m.t).toISOString(), m.label, m.down, m.up, m.ping, m.jitter,
      m.signalDbm, m.gps?.lat, m.gps?.lon, m.gps?.acc,
      m.plan ? +m.plan.x.toFixed(4) : null, m.plan ? +m.plan.y.toFixed(4) : null,
      m.server, m.conn?.effectiveType, m.conn?.downlink, m.conn?.rtt,
      m.notes, m.errors?.join('; '),
    ].map(esc).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  downloadFile(`wifi-survey-${stamp}.csv`, 'text/csv', '﻿' + lines.join('\r\n'));
}

function exportJson() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  downloadFile(`wifi-survey-${stamp}.json`, 'application/json',
    JSON.stringify({ app: 'wifi-survey', version: APP_VERSION, measurements }, null, 2));
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.measurements;
    if (!Array.isArray(incoming)) throw new Error('no measurement array found');
    const known = new Set(measurements.map((m) => m.id));
    let added = 0;
    for (const m of incoming) {
      if (m && m.id && m.t && !known.has(m.id)) { measurements.push(m); added++; }
    }
    saveMeasurements(measurements);
    renderLog();
    renderMap();
    toast(`Imported ${added} new measurement${added === 1 ? '' : 's'}`);
  } catch (e) {
    toast('Import failed: ' + e.message);
  }
}

/* ---------- map tab ---------- */
// Sequential blue ramps validated for the light/dark surfaces (see repo README).
const RAMP_LIGHT = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
const RAMP_DARK = ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#184f95'];
const darkMode = matchMedia('(prefers-color-scheme: dark)');
const ramp = () => (darkMode.matches ? RAMP_DARK : RAMP_LIGHT);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let mapMode = 'plan'; // 'plan' | 'gps'
let mapHits = []; // [{x, y, m}] in CSS px, for tap lookup

const METRICS = {
  down: { get: (m) => m.down, label: 'Download', unit: 'Mbit/s', hint: 'darker = faster' },
  up: { get: (m) => m.up, label: 'Upload', unit: 'Mbit/s', hint: 'darker = faster' },
  ping: { get: (m) => m.ping, label: 'Ping', unit: 'ms', hint: 'darker = slower' },
  signal: { get: (m) => m.signalDbm, label: 'Signal', unit: 'dBm', hint: 'darker = stronger' },
};

function setupCanvas(canvas, cssHeight) {
  const dpr = devicePixelRatio || 1;
  const cssWidth = canvas.parentElement.clientWidth || 320;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssWidth, h: cssHeight };
}

function metricBins(values) {
  // 5 equal-width bins over the observed range
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { min, max, single: true };
  return { min, max, single: false };
}
function binIndex(v, bins) {
  if (bins.single) return 2; // middle step
  const f = (v - bins.min) / (bins.max - bins.min);
  return Math.min(4, Math.floor(f * 5));
}

function drawDot(ctx, x, y, color, surface) {
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fillStyle = color ?? surface;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color ? surface : cssVar('--muted');
  ctx.stroke();
}

function renderMap() {
  if (!$('#tab-map').classList.contains('active')) return;
  const metricKey = $('#map-metric').value;
  const metric = METRICS[metricKey];
  const canvas = $('#map-canvas');
  const empty = $('#map-empty');
  mapHits = [];
  $('#point-info').classList.add('hidden');

  const pts = mapMode === 'plan'
    ? measurements.filter((m) => m.plan)
    : measurements.filter((m) => m.gps);

  const values = pts.map(metric.get).filter((v) => v != null);
  const bins = values.length ? metricBins(values) : null;
  const surface = cssVar('--surface');

  if (mapMode === 'plan' && !planImage) {
    const { ctx, w, h } = setupCanvas(canvas, 220);
    ctx.clearRect(0, 0, w, h);
    empty.textContent = 'No site plan yet. Upload a deck plan or sketch under Settings → Location, then pin measurements to it from the Measure tab.';
    empty.classList.remove('hidden');
    renderLegend(null, metric);
    return;
  }
  if (pts.length === 0) {
    const { ctx, w, h } = setupCanvas(canvas, mapMode === 'plan' ? planCanvasHeight(canvas) : 300);
    if (mapMode === 'plan' && planImage) drawPlanBase(ctx, w, h);
    else ctx.clearRect(0, 0, w, h);
    empty.textContent = mapMode === 'plan'
      ? 'No measurements pinned on the plan yet. Use “Pin on site plan” before starting a measurement.'
      : 'No measurements with a GPS fix yet. Enable GPS in Settings and allow location access.';
    empty.classList.remove('hidden');
    renderLegend(null, metric);
    return;
  }
  empty.classList.add('hidden');

  if (mapMode === 'plan') {
    const h = planCanvasHeight(canvas);
    const { ctx, w } = setupCanvas(canvas, h);
    const box = drawPlanBase(ctx, w, h);
    for (const m of pts) {
      const x = box.x + m.plan.x * box.w;
      const y = box.y + m.plan.y * box.h;
      const v = metric.get(m);
      drawDot(ctx, x, y, v != null ? ramp()[binIndex(v, bins)] : null, surface);
      mapHits.push({ x, y, m });
    }
  } else {
    const { ctx, w, h } = setupCanvas(canvas, 360);
    ctx.clearRect(0, 0, w, h);
    // equirectangular projection to metres around the mean position
    const lat0 = pts.reduce((s, m) => s + m.gps.lat, 0) / pts.length;
    const lon0 = pts.reduce((s, m) => s + m.gps.lon, 0) / pts.length;
    const mPerLat = 110540;
    const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const xy = pts.map((m) => ({
      m,
      x: (m.gps.lon - lon0) * mPerLon,
      y: -(m.gps.lat - lat0) * mPerLat,
    }));
    const xs = xy.map((p) => p.x), ys = xy.map((p) => p.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const span = Math.max(spanX, spanY, 10); // ≥10 m so a single point doesn't blow up
    const pad = 34;
    const scale = Math.min(w - 2 * pad, h - 2 * pad) / span;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    for (const p of xy) {
      const x = w / 2 + (p.x - cx) * scale;
      const y = h / 2 + (p.y - cy) * scale;
      const v = metric.get(p.m);
      drawDot(ctx, x, y, v != null ? ramp()[binIndex(v, bins)] : null, surface);
      mapHits.push({ x, y, m: p.m });
    }
    drawScaleBar(ctx, w, h, scale);
    drawNorthArrow(ctx, w);
  }
  renderLegend(bins, metric);
}

function planCanvasHeight(canvas) {
  const w = canvas.parentElement.clientWidth || 320;
  const maxH = Math.round(innerHeight * 0.6);
  if (!planImage) return 220;
  return Math.min(maxH, Math.round((w * planImage.height) / planImage.width));
}

/* draws the plan image letterboxed; returns the image box in CSS px */
function drawPlanBase(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  const s = Math.min(w / planImage.width, h / planImage.height);
  const iw = planImage.width * s, ih = planImage.height * s;
  const ix = (w - iw) / 2, iy = (h - ih) / 2;
  ctx.drawImage(planImage, ix, iy, iw, ih);
  return { x: ix, y: iy, w: iw, h: ih };
}

function drawScaleBar(ctx, w, h, pxPerMetre) {
  const targetPx = w / 4;
  const niceMetres = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  let metres = niceMetres[0];
  for (const n of niceMetres) if (n * pxPerMetre <= targetPx) metres = n;
  const px = metres * pxPerMetre;
  const y = h - 16, x = 16;
  ctx.strokeStyle = cssVar('--muted');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
  ctx.moveTo(x + px, y - 5); ctx.lineTo(x + px, y + 5);
  ctx.stroke();
  ctx.fillStyle = cssVar('--ink-2');
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(metres >= 1000 ? metres / 1000 + ' km' : metres + ' m', x + 4, y - 8);
}

function drawNorthArrow(ctx, w) {
  const x = w - 26, y = 30;
  ctx.strokeStyle = cssVar('--muted');
  ctx.fillStyle = cssVar('--ink-2');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + 10); ctx.lineTo(x, y - 8);
  ctx.moveTo(x - 4, y - 3); ctx.lineTo(x, y - 8); ctx.lineTo(x + 4, y - 3);
  ctx.stroke();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('N', x - 3, y + 22);
}

function renderLegend(bins, metric) {
  const el = $('#map-legend');
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'legend-title';
  title.textContent = `${metric.label} (${metric.unit}) — ${metric.hint}`;
  el.appendChild(title);
  if (!bins) return;
  const fmtV = (v) => (metric.unit === 'Mbit/s' ? fmtSpeed(v) : Math.round(v));
  const steps = ramp();
  if (bins.single) {
    el.appendChild(legendItem(steps[2], fmtV(bins.min)));
  } else {
    for (let i = 0; i < 5; i++) {
      const a = bins.min + ((bins.max - bins.min) * i) / 5;
      const b = bins.min + ((bins.max - bins.min) * (i + 1)) / 5;
      el.appendChild(legendItem(steps[i], `${fmtV(a)}–${fmtV(b)}`));
    }
  }
  el.appendChild(legendItem(null, 'no value'));
}

function legendItem(color, label) {
  const item = document.createElement('span');
  item.className = 'legend-item';
  const sw = document.createElement('span');
  sw.className = 'legend-swatch';
  sw.style.background = color ?? 'transparent';
  item.append(sw, document.createTextNode(label));
  return item;
}

function mapTap(ev) {
  const rect = $('#map-canvas').getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  let best = null, bestD = 26;
  for (const hit of mapHits) {
    const d = Math.hypot(hit.x - x, hit.y - y);
    if (d < bestD) { bestD = d; best = hit; }
  }
  const info = $('#point-info');
  if (!best) { info.classList.add('hidden'); return; }
  info.innerHTML = logDetailsHtml(best.m);
  info.querySelector('.btn.danger').addEventListener('click', () => {
    if (!confirm('Delete this measurement?')) return;
    measurements = measurements.filter((x) => x.id !== best.m.id);
    saveMeasurements(measurements);
    renderLog();
    renderMap();
  });
  info.classList.remove('hidden');
}

/* ---------- plan pin modal ---------- */
function openPlanModal() {
  if (!planImage) {
    toast('Upload a site plan in Settings first');
    return;
  }
  $('#plan-modal').classList.remove('hidden');
  drawPlanModal();
}

let planModalBox = null;

function drawPlanModal() {
  const canvas = $('#plan-canvas');
  const w = canvas.parentElement.clientWidth || 320;
  const h = Math.min(Math.round(innerHeight * 0.55), Math.round((w * planImage.height) / planImage.width));
  const { ctx } = setupCanvas(canvas, h);
  planModalBox = drawPlanBase(ctx, w, h);
  const surface = cssVar('--surface');
  // existing points, dimmed
  ctx.globalAlpha = 0.45;
  for (const m of measurements.filter((x) => x.plan)) {
    drawDot(ctx, planModalBox.x + m.plan.x * planModalBox.w,
      planModalBox.y + m.plan.y * planModalBox.h, cssVar('--muted'), surface);
  }
  ctx.globalAlpha = 1;
  // pending pin
  if (pendingPlanPos) {
    const x = planModalBox.x + pendingPlanPos.x * planModalBox.w;
    const y = planModalBox.y + pendingPlanPos.y * planModalBox.h;
    const accent = cssVar('--accent');
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 17, y); ctx.lineTo(x - 6, y);
    ctx.moveTo(x + 6, y); ctx.lineTo(x + 17, y);
    ctx.moveTo(x, y - 17); ctx.lineTo(x, y - 6);
    ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 17);
    ctx.stroke();
  }
}

function planModalTap(ev) {
  if (!planModalBox) return;
  const rect = $('#plan-canvas').getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const x = (px - planModalBox.x) / planModalBox.w;
  const y = (py - planModalBox.y) / planModalBox.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  pendingPlanPos = { x, y };
  drawPlanModal();
}

function updatePinState() {
  $('#pin-state').textContent = pendingPlanPos
    ? `pinned at ${(pendingPlanPos.x * 100).toFixed(0)} %, ${(pendingPlanPos.y * 100).toFixed(0)} %`
    : '';
}

/* ---------- settings tab ---------- */
function bindSettings() {
  const srv = $('#s-server');
  srv.value = settings.server;
  $('#s-down-url').value = settings.downUrl;
  $('#s-up-url').value = settings.upUrl;
  $('#s-duration').value = String(settings.duration);
  $('#s-gps').checked = settings.gps;
  $('#s-custom-fields').classList.toggle('hidden', settings.server !== 'custom');

  srv.addEventListener('change', () => {
    settings.server = srv.value;
    $('#s-custom-fields').classList.toggle('hidden', settings.server !== 'custom');
    saveSettings();
  });
  $('#s-down-url').addEventListener('change', (e) => { settings.downUrl = e.target.value.trim(); saveSettings(); });
  $('#s-up-url').addEventListener('change', (e) => { settings.upUrl = e.target.value.trim(); saveSettings(); });
  $('#s-duration').addEventListener('change', (e) => { settings.duration = Number(e.target.value); saveSettings(); });
  $('#s-gps').addEventListener('change', (e) => { settings.gps = e.target.checked; saveSettings(); updateGpsState(); });

  $('#btn-plan-upload').addEventListener('click', () => $('#s-plan-file').click());
  $('#s-plan-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await idb.set('planImage', file);
      await loadPlanImage();
      toast('Site plan saved');
    } catch (err) {
      toast('Could not store the image: ' + err.message);
    }
    e.target.value = '';
  });
  $('#btn-plan-remove').addEventListener('click', async () => {
    if (!confirm('Remove the site plan image? Pinned positions stay in the log.')) return;
    await idb.del('planImage');
    planImage = null;
    updatePlanUI();
  });

  $('#btn-import').addEventListener('click', () => $('#s-import-file').click());
  $('#s-import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });

  $('#about-version').textContent = `WiFi Survey v${APP_VERSION} — data never leaves this device.`;
}

function updatePlanUI() {
  const thumb = $('#s-plan-thumb');
  if (planImage) {
    // re-read the blob for the thumbnail (small, infrequent)
    idb.get('planImage').then((blob) => {
      if (blob) thumb.src = URL.createObjectURL(blob);
    });
    thumb.classList.remove('hidden');
    $('#btn-plan-remove').classList.remove('hidden');
  } else {
    thumb.classList.add('hidden');
    $('#btn-plan-remove').classList.add('hidden');
  }
  if ($('#tab-map').classList.contains('active')) renderMap();
}

function updateGpsState() {
  $('#gps-state').textContent = settings.gps
    ? 'GPS position will be recorded with the measurement (asks for permission on first use).'
    : 'GPS recording is off (Settings).';
}

/* ---------- label history ---------- */
function updateLabelHistory() {
  const seen = new Set();
  const dl = $('#label-history');
  dl.innerHTML = '';
  for (const m of [...measurements].sort((a, b) => b.t - a.t)) {
    if (m.label && !seen.has(m.label)) {
      seen.add(m.label);
      const opt = document.createElement('option');
      opt.value = m.label;
      dl.appendChild(opt);
      if (seen.size >= 12) break;
    }
  }
}

/* ---------- tabs, chrome, init ---------- */
function switchTab(id) {
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === id));
  $$('.tabbar-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  if (id === 'tab-log') renderLog();
  if (id === 'tab-map') renderMap();
}

function updateNetChip() {
  const chip = $('#net-chip');
  if (navigator.onLine) {
    chip.textContent = 'online';
    chip.className = 'chip good';
  } else {
    chip.textContent = 'offline';
    chip.className = 'chip bad';
  }
}

function init() {
  $$('.tabbar-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('#btn-start').addEventListener('click', runTest);
  $('#btn-cancel').addEventListener('click', () => testAbort?.abort());
  $('#btn-pin').addEventListener('click', openPlanModal);
  $('#btn-pin-done').addEventListener('click', () => {
    $('#plan-modal').classList.add('hidden');
    updatePinState();
  });
  $('#btn-pin-clear').addEventListener('click', () => { pendingPlanPos = null; drawPlanModal(); });
  $('#plan-canvas').addEventListener('click', planModalTap);

  $('#btn-export-csv').addEventListener('click', exportCsv);
  $('#btn-export-json').addEventListener('click', exportJson);
  $('#btn-clear-log').addEventListener('click', () => {
    if (!measurements.length) return;
    if (!confirm(`Delete all ${measurements.length} measurements? Export first if you need them.`)) return;
    measurements = [];
    saveMeasurements(measurements);
    renderLog();
  });

  $('#map-mode-plan').addEventListener('click', () => {
    mapMode = 'plan';
    $('#map-mode-plan').classList.add('active');
    $('#map-mode-gps').classList.remove('active');
    renderMap();
  });
  $('#map-mode-gps').addEventListener('click', () => {
    mapMode = 'gps';
    $('#map-mode-gps').classList.add('active');
    $('#map-mode-plan').classList.remove('active');
    renderMap();
  });
  $('#map-metric').addEventListener('change', renderMap);
  $('#map-canvas').addEventListener('click', mapTap);

  addEventListener('online', updateNetChip);
  addEventListener('offline', updateNetChip);
  addEventListener('resize', () => {
    clearTimeout(init._rs);
    init._rs = setTimeout(renderMap, 150);
  });
  darkMode.addEventListener?.('change', renderMap);

  bindSettings();
  updateNetChip();
  updateGpsState();
  updatePinState();
  updateLabelHistory();
  renderLog();
  loadPlanImage();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* http / unsupported — fine */ });
  }
}

init();
