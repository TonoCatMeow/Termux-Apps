// Android Control Panel - main server.
//
// Runs inside Debian proot-distro, binds 0.0.0.0:2010, serves the frontend
// and the JSON/WebSocket API. All Android actions go through AndroidBridge.

import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import multer from 'multer';

import { AndroidBridge } from './android';
import { TermuxBridge } from './termux';
import { AdbProvider } from './adb';
import { ShizukuProvider } from './shizuku';
import { getDeviceInfo } from './device';
import { getApps, launchApp } from './apps';
import { captureScreenshot } from './screenshot';
import { setupWebSocket } from './websocket';
import { apksDir, dataDir, getRoots, listDir, resolvePath, safeFileName, uploadsTmpDir } from './files';

const PORT = parseInt(process.env.PORT || '2010', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------- bridge ---
const termux = new TermuxBridge();
const adb = new AdbProvider(termux);
const shizuku = new ShizukuProvider(termux);
const bridge = new AndroidBridge(termux, adb, shizuku);

// ------------------------------------------------------------------- app ---
const app = express();
app.use(express.json({ limit: '2mb' }));

const frontendDir = path.resolve(__dirname, '..', 'frontend');

const ah =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// --------------------------------------------------------------- device ----
app.get(
  '/api/device',
  ah(async (_req, res) => {
    res.json(await getDeviceInfo(bridge));
  }),
);

app.get(
  '/api/bridges',
  ah(async (_req, res) => {
    res.json(await bridge.status());
  }),
);

// ----------------------------------------------------------------- apps ----
app.get(
  '/api/apps',
  ah(async (req, res) => {
    try {
      res.json(await getApps(bridge, req.query.refresh === '1'));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  }),
);

app.post(
  '/api/apps/:package/launch',
  ah(async (req, res) => {
    try {
      const r = await launchApp(bridge, req.params.package);
      res.status(r.ok ? 200 : 502).json({ ok: r.ok, transport: r.transport, output: (r.stdout + ' ' + r.stderr).trim() });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }),
);

app.post(
  '/api/open-url',
  ah(async (req, res) => {
    const url = String((req.body && req.body.url) || '');
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(url)) {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }
    const r = await bridge.openUrl(url);
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, transport: r.transport, output: (r.stdout + ' ' + r.stderr).trim() });
  }),
);

// ----------------------------------------------------------- screenshot ----
app.get(
  '/api/screenshot',
  ah(async (_req, res) => {
    try {
      const buf = await captureScreenshot(bridge, 250);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  }),
);

// ---------------------------------------------------------------- files ----
app.get('/api/files/roots', (_req, res) => {
  res.json(getRoots());
});

app.get(
  '/api/files',
  ah(async (req, res) => {
    try {
      const root = String(req.query.root || 'panel');
      const p = String(req.query.path || '');
      res.json({ root, path: p, entries: listDir(root, p) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }),
);

app.get(
  '/api/files/download',
  ah(async (req, res) => {
    try {
      const root = String(req.query.root || 'panel');
      const p = String(req.query.path || '');
      const abs = resolvePath(root, p);
      if (!fs.statSync(abs).isFile()) {
        res.status(400).json({ error: 'Not a file' });
        return;
      }
      res.download(abs);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }),
);

const fileUpload = multer({
  dest: uploadsTmpDir(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GiB
});

app.post(
  '/api/files/upload',
  fileUpload.single('file'),
  ah(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const root = String(req.query.root || 'panel');
      const p = String(req.query.path || '');
      const dir = resolvePath(root, p);
      if (!fs.statSync(dir).isDirectory()) throw new Error('Target is not a directory');
      const dest = path.join(dir, safeFileName(req.file.originalname));
      fs.renameSync(req.file.path, dest);
      res.json({ ok: true, name: path.basename(dest) });
    } catch (e: any) {
      fs.rmSync(req.file.path, { force: true });
      res.status(400).json({ error: e.message });
    }
  }),
);

// ----------------------------------------------------------------- apks ----
const apkUpload = multer({
  dest: apksDir(),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

app.get(
  '/api/apks',
  ah(async (_req, res) => {
    const files = fs
      .readdirSync(apksDir())
      .map(name => {
        try {
          const st = fs.statSync(path.join(apksDir(), name));
          return st.isFile() ? { name, size: st.size, mtime: st.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json(files);
  }),
);

app.post(
  '/api/apks/install',
  apkUpload.single('apk'),
  ah(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No APK uploaded (field name must be "apk")' });
      return;
    }
    const original = safeFileName(req.file.originalname || 'app.apk');
    if (!original.toLowerCase().endsWith('.apk')) {
      fs.rmSync(req.file.path, { force: true });
      res.status(400).json({ error: 'File must be an .apk' });
      return;
    }
    const finalPath = path.join(apksDir(), `${Date.now()}-${original}`);
    fs.renameSync(req.file.path, finalPath);
    const result = await bridge.installApk(finalPath, original);
    res.status(result.ok ? 200 : 502).json(result);
  }),
);

// ------------------------------------------------------------- frontend ----
app.use(express.static(frontendDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// -------------------------------------------------------------- errors -----
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File too large' });
    return;
  }
  res.status(500).json({ error: (err && err.message) || 'Internal error' });
});

// ---------------------------------------------------------------- start ----
dataDir();
const server = http.createServer(app);
setupWebSocket(server, bridge);

adb.ensureConnected().catch(() => undefined);

server.listen(PORT, HOST, () => {
  console.log(`Android Control Panel listening on http://${HOST}:${PORT}`);
  console.log(`Frontend directory: ${frontendDir}`);
  console.log(`Data directory:     ${dataDir()}`);
  if (!process.env.ADB_SERIAL) {
    console.log('Hint: set ADB_SERIAL=127.0.0.1:<wireless-debugging-port> to enable adb.');
  }
});
