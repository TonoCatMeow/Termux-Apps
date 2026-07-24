#!/usr/bin/env node
/*
 * termux-bridge.js - runs INSIDE TERMUX (not inside Debian).
 *
 * Debian proot-distro cannot see Termux's binaries or Android commands.
 * This tiny daemon bridges the gap: it listens on 127.0.0.1:17845 (loopback
 * is shared between Termux and proot) and executes whitelisted Android /
 * Termux commands on behalf of the Debian backend.
 *
 * Security: localhost-only (not reachable from the network).
 *
 * Setup (in Termux):
 *   pkg install nodejs
 *   node termux-bridge.js
 *   # or in background:
 *   nohup node termux-bridge.js > bridge.log 2>&1 &
 *
 * Endpoints:
 *   GET  /health                         -> { ok: true }
 *   POST /exec        { cmd, timeout? }  -> { code, stdout, stderr }
 *   POST /write-file  { path, dataBase64 } -> { ok: true }
 */

'use strict';

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.BRIDGE_PORT || '17845', 10);
const HOST = '127.0.0.1';
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_BODY = 1024 * 1024 * 1024; // 1 GiB (APK pushes)

const HOME_DIR = process.env.HOME || '/data/data/com.termux/files/home';
const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const SHELL = fs.existsSync(`${PREFIX}/bin/bash`) ? `${PREFIX}/bin/bash` : `${PREFIX}/bin/sh`;

// First-word whitelist. Each pipe/chain segment is validated separately.
const ALLOWED_EXACT = new Set([
  'am', 'pm', 'cmd', 'settings', 'dumpsys', 'input', 'getprop', 'monkey',
  'screencap', 'screenrecord', 'logcat', 'rish', 'adb', 'base64', 'cat',
  'ls', 'df', 'du', 'stat', 'id', 'whoami', 'ip', 'ifconfig', 'uname',
  'echo', 'printf', 'cp', 'mv', 'mkdir', 'rm', 'rmdir', 'chmod', 'chown',
  'touch', 'head', 'tail', 'wc', 'grep', 'sed', 'awk', 'cut', 'tr', 'sort',
  'uniq', 'env', 'which', 'test', '[', 'dirname', 'basename', 'realpath',
  'readlink', 'timeout', 'sh', 'bash', 'nohup', 'kill', 'ps', 'date',
  'uptime', 'free', 'curl', 'wget', 'tar', 'gzip', 'gunzip', 'sha256sum',
  'md5sum', 'true', 'false', 'sleep', 'ping', 'ss', 'netstat', 'xargs',
  'find', 'file', 'dd', 'gunzip', 'amixer', 'wm',
]);
const ALLOWED_PREFIX = ['termux-']; // termux-battery-status, termux-notification, ...
const BLOCKED = new Set(['su', 'sudo', 'tsu', 'magisk']);

function commandAllowed(cmd) {
  const segments = cmd
    .split(/\|\||&&|[|;]/)
    .map(s => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;

  for (let seg of segments) {
    // Strip leading environment assignments (FOO=bar BAR=baz cmd ...)
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(seg)) {
      seg = seg.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, '');
    }
    const m = seg.match(/^[\s(]*([^\s(]+)/);
    if (!m) return false;
    const base = m[1].replace(/^.*\//, ''); // allow full paths like /system/bin/am
    if (BLOCKED.has(base)) return false;
    if (ALLOWED_EXACT.has(base)) continue;
    if (ALLOWED_PREFIX.some(p => base.startsWith(p))) continue;
    return false;
  }
  return true;
}

// write-file targets must stay in user-accessible locations.
function writePathAllowed(p) {
  const allowed = [HOME_DIR, '/sdcard', '/storage/emulated/0'];
  return allowed.some(a => p === a || p.startsWith(a + '/'));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > limit) {
      req.destroy();
      cb(new Error('body too large'));
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', cb);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      user: process.env.USER || '',
      home: HOME_DIR,
      uptime: process.uptime(),
    });
  }

  if (req.method === 'POST' && req.url === '/exec') {
    return readBody(req, MAX_BUFFER, (err, body) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let j;
      try {
        j = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const cmd = String(j.cmd || '');
      const timeout = Math.min(Math.max(parseInt(j.timeout, 10) || 30000, 1000), 300000);
      if (!commandAllowed(cmd)) {
        return sendJson(res, 403, {
          ok: false,
          code: 126,
          stdout: '',
          stderr: `command rejected by bridge whitelist: ${cmd.slice(0, 120)}`,
        });
      }
      exec(cmd, { timeout, maxBuffer: MAX_BUFFER, shell: SHELL }, (error, stdout, stderr) => {
        sendJson(res, 200, {
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (error && typeof error.code !== 'number' ? ` ${error.message}` : ''),
        });
      });
    });
  }

  if (req.method === 'POST' && req.url === '/write-file') {
    return readBody(req, MAX_BODY, (err, body) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let j;
      try {
        j = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const target = String(j.path || '');
      if (!writePathAllowed(target)) {
        return sendJson(res, 403, { ok: false, error: 'path not allowed' });
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(String(j.dataBase64 || ''), 'base64'));
        sendJson(res, 200, { ok: true, path: target });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    });
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[termux-bridge] listening on http://${HOST}:${PORT} (localhost only)`);
  console.log(`[termux-bridge] shell: ${SHELL}`);
});
