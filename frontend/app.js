/* Android Control Panel - frontend logic (vanilla JS, no frameworks) */
'use strict';

// ----------------------------------------------------------------- state ---
const state = {
  ws: null,
  wsOk: false,
  device: null,
  apps: [],
  screen: { live: false, fallbackTimer: null, lastError: '' },
  files: { roots: [], root: '', path: '' },
};

const $ = sel => document.querySelector(sel);

// ---------------------------------------------------------------- helpers ---
function fmtBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function pct(used, total) {
  if (!used && used !== 0) return 0;
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(path, opts = {}) {
  return fetch(path, { credentials: 'same-origin', ...opts });
}

async function apiJson(path, opts = {}) {
  const res = await api(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.detail || `HTTP ${res.status}`);
  return body;
}

// -------------------------------------------------------------- websocket ---
function setConn(ok, text) {
  $('#conn-dot').className = `dot ${ok ? 'dot-green' : 'dot-red'}`;
  $('#conn-text').textContent = text;
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let ws;
  try {
    ws = new WebSocket(`${proto}${location.host}/ws`);
  } catch {
    setConn(false, 'websocket error');
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.wsOk = true;
    setConn(true, 'connected');
    if (state.screen.live) subscribeScreen();
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'status') {
      state.device = msg.data;
      renderDevice(msg.data);
      renderBridges(msg.data.bridges);
    } else if (msg.type === 'screenshot') {
      const img = $('#screen-img');
      img.src = `data:image/png;base64,${msg.data}`;
      img.style.display = 'block';
      $('#screen-placeholder').style.display = 'none';
      $('#screen-status').textContent = `live · ${new Date(msg.at).toLocaleTimeString()}`;
      state.screen.lastError = '';
    } else if (msg.type === 'screenshot-error') {
      if (state.screen.lastError !== msg.error) {
        state.screen.lastError = msg.error;
        $('#screen-status').textContent = msg.error;
      }
    }
  };

  ws.onclose = () => {
    state.wsOk = false;
    setConn(false, 'reconnecting…');
    setTimeout(connectWs, 3000);
  };

  ws.onerror = () => { /* onclose handles retry */ };
}

// --------------------------------------------------------------- dashboard ---
function renderDevice(d) {
  $('#d-model').textContent = d.model || '—';
  $('#d-manufacturer').textContent = d.manufacturer || '';
  $('#d-android').textContent = d.androidVersion || '—';

  const b = d.battery || {};
  $('#d-battery').textContent = b.level != null ? `${b.level}%` : '—';
  $('#d-battery-bar').style.width = `${b.level || 0}%`;
  $('#d-battery-bar').style.background =
    b.level == null ? 'var(--accent)' : b.level > 20 ? 'var(--accent)' : 'var(--danger)';
  $('#d-charging').textContent =
    b.charging === true ? `⚡ charging${b.temperature != null ? ` · ${b.temperature}°C` : ''}` :
    b.charging === false ? 'on battery' : '';

  const s = d.storage || {};
  $('#d-storage-path').textContent = s.path ? `(${s.path})` : '';
  $('#d-storage').textContent =
    s.usedBytes != null && s.totalBytes != null
      ? `${fmtBytes(s.usedBytes)} / ${fmtBytes(s.totalBytes)}`
      : '—';
  $('#d-storage-bar').style.width = `${pct(s.usedBytes, s.totalBytes)}%`;
  $('#d-storage-free').textContent = s.freeBytes != null ? `${fmtBytes(s.freeBytes)} free` : '';

  const r = d.ram || {};
  $('#d-ram').textContent =
    r.usedBytes != null && r.totalBytes != null
      ? `${fmtBytes(r.usedBytes)} / ${fmtBytes(r.totalBytes)}`
      : '—';
  $('#d-ram-bar').style.width = `${pct(r.usedBytes, r.totalBytes)}%`;
  $('#d-ram-free').textContent = r.freeBytes != null ? `${fmtBytes(r.freeBytes)} available` : '';

  const c = d.cpu || {};
  $('#d-cpu').textContent = c.model || '—';
  $('#d-cores').textContent = c.cores ? `${c.cores} cores` : '';

  $('#d-ip').textContent = d.ip || '—';
}

function renderBridges(b) {
  if (!b) return;
  const chip = (name, ok) => `<span class="chip ${ok ? 'ok' : 'bad'}">${name}: ${ok ? 'up' : 'down'}</span>`;
  $('#d-bridges').innerHTML =
    chip('termux', b.termuxBridge) + chip('adb', b.adb) + chip('shizuku', b.shizuku);
  $('#b-termux').textContent = b.termuxBridge ? '✅ connected' : '❌ unavailable';
  $('#b-adb').textContent = b.adb ? '✅ connected' : '❌ unavailable';
  $('#b-shizuku').textContent = b.shizuku ? '✅ connected' : '❌ unavailable';
}

async function loadDeviceOnce() {
  try {
    const d = await apiJson('/api/device');
    state.device = d;
    renderDevice(d);
    renderBridges(d.bridges);
  } catch { /* ws pushes will cover updates */ }
}

$('#open-url-btn').addEventListener('click', async () => {
  const url = $('#open-url-input').value.trim();
  if (!url) return;
  try {
    const r = await apiJson('/api/open-url', { method: 'POST', body: JSON.stringify({ url }) });
    toast(`Opened on device${r.transport ? ` (via ${r.transport})` : ''}`, 'ok');
  } catch (e) {
    toast(`Failed: ${e.message}`, 'err');
  }
});

// ------------------------------------------------------------------ tabs ---
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'files' && state.files.roots.length === 0) loadFileRoots();
    if (btn.dataset.tab === 'bridges') loadBridges();
  });
});

// ----------------------------------------------------------------- screen ---
function screenFps() {
  return parseFloat($('#screen-fps').value) || 1;
}

function subscribeScreen() {
  if (state.ws && state.wsOk) {
    state.ws.send(JSON.stringify({ type: 'subscribe-screen', fps: screenFps() }));
  }
}

function unsubscribeScreen() {
  if (state.ws && state.wsOk) {
    state.ws.send(JSON.stringify({ type: 'unsubscribe-screen' }));
  }
}

function startScreen() {
  state.screen.live = true;
  $('#screen-start').disabled = true;
  $('#screen-stop').disabled = false;
  $('#screen-status').textContent = 'starting…';

  if (state.wsOk) {
    subscribeScreen();
  } else {
    // HTTP polling fallback if the websocket is down.
    const tick = async () => {
      try {
        const res = await api('/api/screenshot');
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const img = $('#screen-img');
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
        img.dataset.url = URL.createObjectURL(blob);
        img.src = img.dataset.url;
        img.style.display = 'block';
        $('#screen-placeholder').style.display = 'none';
        $('#screen-status').textContent = 'live (http fallback)';
      } catch (e) {
        $('#screen-status').textContent = e.message;
      }
    };
    tick();
    state.screen.fallbackTimer = setInterval(tick, Math.round(1000 / screenFps()));
  }
}

function stopScreen() {
  state.screen.live = false;
  unsubscribeScreen();
  if (state.screen.fallbackTimer) {
    clearInterval(state.screen.fallbackTimer);
    state.screen.fallbackTimer = null;
  }
  const start = $('#screen-start');
  const stop = $('#screen-stop');
  if (start) start.disabled = false;
  if (stop) stop.disabled = true;
}

$('#screen-start').addEventListener('click', startScreen);
$('#screen-stop').addEventListener('click', stopScreen);
$('#screen-fps').addEventListener('change', () => {
  if (!state.screen.live) return;
  stopScreen();
  startScreen();
});
$('#screen-single').addEventListener('click', async () => {
  $('#screen-status').textContent = 'capturing…';
  try {
    const res = await api('/api/screenshot');
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const img = $('#screen-img');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
    img.style.display = 'block';
    $('#screen-placeholder').style.display = 'none';
    $('#screen-status').textContent = `captured ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $('#screen-status').textContent = e.message;
    toast(`Screenshot failed: ${e.message}`, 'err');
  }
});

// ------------------------------------------------------------------- apps ---
function appIconLetter(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function renderApps() {
  const q = $('#apps-search').value.trim().toLowerCase();
  const showSystem = $('#apps-show-system').checked;
  const list = state.apps.filter(a =>
    (showSystem || !a.system) &&
    (!q || a.name.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q)),
  );
  $('#apps-count').textContent = `${list.length} app${list.length === 1 ? '' : 's'}`;

  const html = list.map(a => `
    <div class="app-item">
      <div class="app-icon">${appIconLetter(a.name)}</div>
      <div class="app-meta">
        <div class="app-name">${escapeHtml(a.name)}${a.system ? '<span class="app-badge">system</span>' : ''}</div>
        <div class="app-pkg">${escapeHtml(a.packageName)}</div>
      </div>
      <button class="btn btn-primary app-launch" data-pkg="${escapeHtml(a.packageName)}">Launch</button>
    </div>`).join('');

  $('#apps-list').innerHTML = html || '<p class="muted">No matching apps.</p>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadApps(refresh) {
  $('#apps-error').classList.add('hidden');
  $('#apps-list').innerHTML = '<p class="muted">Loading installed apps…</p>';
  try {
    state.apps = await apiJson(`/api/apps${refresh ? '?refresh=1' : ''}`);
    renderApps();
  } catch (e) {
    $('#apps-list').innerHTML = '';
    const box = $('#apps-error');
    box.textContent = `Could not list apps: ${e.message}. Check the Bridges tab / README.`;
    box.classList.remove('hidden');
  }
}

$('#apps-search').addEventListener('input', renderApps);
$('#apps-show-system').addEventListener('change', renderApps);
$('#apps-refresh').addEventListener('click', () => loadApps(true));
$('#apps-list').addEventListener('click', async e => {
  const btn = e.target.closest('.app-launch');
  if (!btn) return;
  btn.disabled = true;
  try {
    const r = await apiJson(`/api/apps/${encodeURIComponent(btn.dataset.pkg)}/launch`, { method: 'POST' });
    toast(`Launched ${btn.dataset.pkg}${r.transport ? ` (via ${r.transport})` : ''}`, 'ok');
  } catch (err) {
    toast(`Launch failed: ${err.message}`, 'err');
  }
  btn.disabled = false;
});

// ------------------------------------------------------------------ files ---
async function loadFileRoots() {
  try {
    state.files.roots = await apiJson('/api/files/roots');
    const sel = $('#files-root');
    sel.innerHTML = state.files.roots
      .map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)} (${escapeHtml(r.path)})</option>`)
      .join('');
    if (state.files.roots.length) {
      state.files.root = state.files.roots[0].name;
      state.files.path = '';
      loadFiles();
    }
  } catch (e) {
    toast(`Files: ${e.message}`, 'err');
  }
}

async function loadFiles() {
  $('#files-error').classList.add('hidden');
  try {
    const data = await apiJson(
      `/api/files?root=${encodeURIComponent(state.files.root)}&path=${encodeURIComponent(state.files.path)}`,
    );
    $('#files-path').textContent = '/' + (state.files.path || '');
    const rows = data.entries.map(en => `
      <tr>
        <td><span class="file-name ${en.isDir ? 'dir' : ''}" data-dir="${en.isDir}" data-path="${escapeHtml(en.path)}">
          ${en.isDir ? '📁' : '📄'} ${escapeHtml(en.name)}</span></td>
        <td>${en.isDir ? '—' : fmtBytes(en.size)}</td>
        <td class="muted">${en.mtime ? new Date(en.mtime).toLocaleString() : ''}</td>
        <td>${en.isDir ? '' : `<button class="btn file-dl" data-path="${escapeHtml(en.path)}">Download</button>`}</td>
      </tr>`).join('');
    $('#files-list').innerHTML = rows || '<tr><td colspan="4" class="muted">Empty folder</td></tr>';
  } catch (e) {
    const box = $('#files-error');
    box.textContent = e.message;
    box.classList.remove('hidden');
  }
}

$('#files-root').addEventListener('change', e => {
  state.files.root = e.target.value;
  state.files.path = '';
  loadFiles();
});

$('#files-up').addEventListener('click', () => {
  if (!state.files.path) return;
  const parts = state.files.path.split('/').filter(Boolean);
  parts.pop();
  state.files.path = parts.join('/');
  loadFiles();
});

$('#files-list').addEventListener('click', e => {
  const name = e.target.closest('.file-name');
  if (name && name.dataset.dir === 'true') {
    state.files.path = name.dataset.path;
    loadFiles();
    return;
  }
  const dl = e.target.closest('.file-dl');
  if (dl) {
    window.open(
      `/api/files/download?root=${encodeURIComponent(state.files.root)}&path=${encodeURIComponent(dl.dataset.path)}`,
      '_blank',
    );
  }
});

$('#files-upload-btn').addEventListener('click', () => $('#files-upload-input').click());
$('#files-upload-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    await apiJson(
      `/api/files/upload?root=${encodeURIComponent(state.files.root)}&path=${encodeURIComponent(state.files.path)}`,
      { method: 'POST', body: fd, headers: {} },
    );
    toast(`Uploaded ${file.name}`, 'ok');
    loadFiles();
  } catch (err) {
    toast(`Upload failed: ${err.message}`, 'err');
  }
  e.target.value = '';
});

// -------------------------------------------------------------------- apk ---
$('#apk-install').addEventListener('click', async () => {
  const file = $('#apk-input').files[0];
  if (!file) { toast('Choose an .apk file first', 'err'); return; }
  const status = $('#apk-status');
  status.textContent = 'Uploading and installing…';
  const fd = new FormData();
  fd.append('apk', file);
  try {
    const r = await apiJson('/api/apks/install', { method: 'POST', body: fd, headers: {} });
    status.textContent = `✅ ${r.method}: ${r.detail}`;
    toast('APK install: ' + r.method, 'ok');
  } catch (e) {
    status.textContent = `❌ ${e.message}`;
    toast(`Install failed: ${e.message}`, 'err');
  }
});

// ---------------------------------------------------------------- bridges ---
async function loadBridges() {
  try {
    renderBridges(await apiJson('/api/bridges'));
  } catch (e) {
    toast(`Bridges: ${e.message}`, 'err');
  }
}

// ------------------------------------------------------------------- init ---
connectWs();
loadDeviceOnce();
loadApps(false);
// Fallback refresh in case websocket pushes are unavailable.
setInterval(() => { if (!state.wsOk) loadDeviceOnce(); }, 10000);
