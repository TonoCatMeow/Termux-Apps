/* Android Control Panel - frontend logic (vanilla JS, no frameworks) */
'use strict';

// ----------------------------------------------------------------- state ---
const state = {
  ws: null,
  wsOk: false,
  device: null,
  apps: [],
  screen: { live: false, fallbackTimer: null, lastError: '' },
  video: { live: false, info: null },
  files: { roots: [], root: '', path: '' },
};

let jmuxer = null;

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
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  return res;
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

// ------------------------------------------------------------------ auth ---
function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  initApp();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await apiJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    $('#login-password').value = '';
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message || 'Login failed';
  }
});

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

  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    state.wsOk = true;
    setConn(true, 'connected');
    if (state.screen.live) subscribeScreen();
    if (state.video.live) subscribeVideo();
  };

  ws.onmessage = ev => {
    // Binary frames = raw H.264 video chunks.
    if (typeof ev.data !== 'string') {
      if (jmuxer && state.video.live) {
        try { jmuxer.feed({ video: new Uint8Array(ev.data) }); } catch { /* ignore */ }
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'video-info') {
      state.video.info = msg;
      $('#video-status').textContent =
        `${msg.deviceWidth}x${msg.deviceHeight} @${Math.round(msg.fps)}fps · ${msg.preset} · ${(msg.bitRate / 1e6).toFixed(0)} Mbps`;
      const v = $('#video-el');
      v.style.display = 'block';
      $('#video-placeholder').style.display = 'none';
    } else if (msg.type === 'video-reset') {
      if (jmuxer && typeof jmuxer.reset === 'function') {
        try { jmuxer.reset(); } catch { /* ignore */ }
      }
    } else if (msg.type === 'video-error') {
      $('#video-status').textContent = msg.error;
      toast(`Video: ${msg.error}`, 'err');
    } else if (msg.type === 'input-result') {
      if (!msg.ok && msg.error) $('#video-status').textContent = `input: ${msg.error}`;
    } else if (msg.type === 'rotate-result') {
      if (msg.ok) {
        const names = ['Portrait', 'Landscape', 'Upside down', 'Landscape (other)'];
        toast(`Rotated: ${names[msg.rotation] || msg.rotation}`, 'ok');
      } else {
        toast(`Rotate failed: ${msg.error}`, 'err');
      }
    } else if (msg.type === 'status') {
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

  ws.onclose = ev => {
    state.wsOk = false;
    if (ev.code === 4401) { showLogin(); return; }
    setConn(false, 'reconnecting…');
    setTimeout(() => {
      if (!$('#app-view').classList.contains('hidden')) connectWs();
    }, 3000);
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
// ------------------------------------------------------------------ video ---
function subscribeVideo() {
  if (state.ws && state.wsOk) {
    state.ws.send(JSON.stringify({ type: 'subscribe-video', preset: $('#video-quality').value }));
  }
}

function startVideo() {
  if (!state.wsOk) { toast('WebSocket not connected yet', 'err'); return; }
  if (typeof JMuxer === 'undefined') { toast('JMuxer failed to load', 'err'); return; }
  try {
    jmuxer = new JMuxer({
      node: 'video-el',
      mode: 'video',
      flushingTime: 100,   // low latency for interactive control
      fps: 60,
      debug: false,
      onError: () => { try { jmuxer.reset(); } catch { /* ignore */ } },
    });
  } catch (e) {
    toast(`JMuxer: ${e.message}`, 'err');
    return;
  }
  state.video.live = true;
  $('#video-start').disabled = true;
  $('#video-stop').disabled = false;
  $('#video-status').textContent = 'starting stream…';
  subscribeVideo();

  // Live-edge watchdog: MSE plays buffered media at 1x, so any backlog
  // becomes permanent lag. If we fall >0.6s behind, jump to the live edge.
  if (state.video.edgeTimer) clearInterval(state.video.edgeTimer);
  state.video.edgeTimer = setInterval(() => {
    const v = $('#video-el');
    if (!state.video.live || !v.buffered || v.buffered.length === 0) return;
    try {
      const end = v.buffered.end(v.buffered.length - 1);
      if (end - v.currentTime > 0.6) {
        v.currentTime = Math.max(0, end - 0.1);
      }
    } catch { /* ignore */ }
  }, 500);
}

function stopVideo() {
  state.video.live = false;
  if (state.video.edgeTimer) {
    clearInterval(state.video.edgeTimer);
    state.video.edgeTimer = null;
  }
  if (state.ws && state.wsOk) state.ws.send(JSON.stringify({ type: 'unsubscribe-video' }));
  if (jmuxer && typeof jmuxer.destroy === 'function') {
    try { jmuxer.destroy(); } catch { /* ignore */ }
  }
  jmuxer = null;
  const v = $('#video-el');
  v.style.display = 'none';
  v.src = '';
  $('#video-placeholder').style.display = '';
  $('#video-start').disabled = false;
  $('#video-stop').disabled = true;
  $('#video-status').textContent = '';
}

$('#video-start').addEventListener('click', startVideo);
$('#video-stop').addEventListener('click', stopVideo);
$('#video-quality').addEventListener('change', () => {
  if (state.video.live) subscribeVideo();   // server restarts with new preset
});

// ------------------------------------------------------------- input: touch ---
function sendInput(msg) {
  if (!state.wsOk) return;
  state.ws.send(JSON.stringify({ type: 'input', ...msg }));
}

function sendTouch(action, p) {
  if (!state.wsOk) return;
  state.ws.send(JSON.stringify({ type: 'touch', action, nx: p.x, ny: p.y }));
}

// Map a pointer event to normalized coordinates over the ACTUAL video
// picture. In maximize mode the <video> element fills the window and the
// picture is letterboxed inside it (object-fit: contain), so we must use
// the rendered content rect - not the element rect - and ignore clicks
// that land on the black bars.
function relPoint(e, el) {
  const r = el.getBoundingClientRect();
  const vw = el.videoWidth || 0;
  const vh = el.videoHeight || 0;
  const clamp01 = v => Math.min(1, Math.max(0, v));

  if (!vw || !vh) {
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  const elAspect = r.width / r.height;
  const vidAspect = vw / vh;
  let w, h;
  if (elAspect > vidAspect) { h = r.height; w = h * vidAspect; }
  else { w = r.width; h = w / vidAspect; }
  const left = r.left + (r.width - w) / 2;
  const top = r.top + (r.height - h) / 2;

  const x = (e.clientX - left) / w;
  const y = (e.clientY - top) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null; // black bar - not the screen
  return { x, y };
}

// Raw pointer streaming: we send ONLY where the pointer is and whether it
// is down. The phone's own input pipeline decides tap vs swipe vs fling vs
// long-press - exactly like a real finger on the screen.
(function setupVideoPointer() {
  const el = $('#video-el');
  const MOVE_INTERVAL = 33;   // ~30 move events/sec
  let active = false;
  let lastMove = 0;
  let pending = null;         // latest throttled move point
  let lastPoint = null;

  el.addEventListener('pointerdown', e => {
    if (!state.video.live) return;
    e.preventDefault();
    const p = relPoint(e, el);
    if (!p) return;                       // letterbox bar
    active = true;
    lastPoint = p;
    pending = null;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    sendTouch('down', p);
  });

  el.addEventListener('pointermove', e => {
    if (!active) return;
    e.preventDefault();
    const p = relPoint(e, el);
    if (!p) return;
    lastPoint = p;
    const now = performance.now();
    if (now - lastMove < MOVE_INTERVAL) {
      pending = p;
      return;
    }
    lastMove = now;
    pending = null;
    sendTouch('move', p);
  });

  function release(e) {
    if (!active) return;
    if (e) e.preventDefault();
    active = false;
    const p = pending || lastPoint;
    pending = null;
    if (p) sendTouch('up', p);
    else sendTouch('up', { x: 0.5, y: 0.5 });
  }

  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', () => release(null));
  el.addEventListener('contextmenu', e => e.preventDefault());
})();

// ---------------------------------------------------------- input: keyboard ---
// Keyboard is ALWAYS live while the video runs - every keystroke goes
// straight to the phone (except when typing into one of the panel's own
// form fields, e.g. the app search box).
document.addEventListener('keydown', e => {
  if (!state.video.live) return;

  // Esc exits maximize mode instead of sending BACK.
  if (e.key === 'Escape' && isMaximized()) {
    toggleMaximize();
    e.preventDefault();
    return;
  }

  const tag = ((e.target && e.target.tagName) || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  const keyMap = {
    Backspace: 'DEL',
    Enter: 'ENTER',
    Escape: 'BACK',
    ArrowUp: 'DPAD_UP',
    ArrowDown: 'DPAD_DOWN',
    ArrowLeft: 'DPAD_LEFT',
    ArrowRight: 'DPAD_RIGHT',
    Tab: 'TAB',
    ' ': 'SPACE',
  };

  if (keyMap[e.key]) {
    sendInput({ action: 'key', key: keyMap[e.key] });
    e.preventDefault();
  } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    sendInput({ action: 'text', text: e.key });
    e.preventDefault();
  }
});

document.querySelectorAll('.nav-btn[data-key]').forEach(btn => {
  btn.addEventListener('click', () => sendInput({ action: 'key', key: btn.dataset.key }));
});

$('#rotate-btn').addEventListener('click', () => {
  if (!state.wsOk) { toast('WebSocket not connected yet', 'err'); return; }
  state.ws.send(JSON.stringify({ type: 'rotate' }));
});

// ------------------------------------------------------------ maximize/zoom ---
function isMaximized() {
  return document.querySelector('.video-frame').classList.contains('video-max');
}

function toggleMaximize() {
  const frame = document.querySelector('.video-frame');
  frame.classList.toggle('video-max');
  $('#video-max').textContent = frame.classList.contains('video-max') ? '✕' : '⛶';
}

$('#video-max').addEventListener('click', toggleMaximize);

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
let appInitialized = false;
function initApp() {
  if (appInitialized) return;
  appInitialized = true;
  connectWs();
  loadDeviceOnce();
  loadApps(false);
  // Fallback refresh in case websocket pushes are unavailable.
  setInterval(() => { if (!state.wsOk) loadDeviceOnce(); }, 10000);
}

(async function boot() {
  try {
    const me = await apiJson('/api/me');
    if (me.authenticated) showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
