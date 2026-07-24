// WebSocket system: live device status pushes + live screenshot streaming.

import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { AndroidBridge } from './android';
import { getDeviceInfo } from './device';
import { captureScreenshot } from './screenshot';
import { handleInput } from './input';
import { VideoStreamer } from './video';

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function setupWebSocket(
  server: http.Server,
  bridge: AndroidBridge,
  video: VideoStreamer,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  // Max allowed frame rate. SCREEN_MAX_FPS = "as fast as screencap can go".
  const MAX_FPS = Math.min(Math.max(Number(process.env.SCREEN_MAX_FPS) || 30, 1), 30);

  wss.on('connection', ws => {
    clients.add(ws);
    const notify = (msg: object) => send(ws, msg);
    let screenTimer: NodeJS.Timeout | null = null;
    let screenLoop = false;

    const stopScreen = () => {
      screenLoop = false;
      if (screenTimer) clearInterval(screenTimer);
      screenTimer = null;
    };

    ws.on('message', raw => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === 'subscribe-screen') {
        const fps = Math.min(Math.max(Number(msg.fps) || 1, 0.2), MAX_FPS);
        stopScreen();

        const capture = async (): Promise<void> => {
          try {
            const buf = await captureScreenshot(bridge);
            send(ws, { type: 'screenshot', data: buf.toString('base64'), at: Date.now() });
          } catch (e: any) {
            send(ws, { type: 'screenshot-error', error: e.message || 'screenshot failed' });
          }
        };

        if (fps >= MAX_FPS) {
          // "max" mode: no delay - send the next frame the moment the
          // previous capture finishes. Self-throttles to hardware speed.
          screenLoop = true;
          (async () => {
            while (screenLoop && ws.readyState === ws.OPEN) {
              await capture();
            }
          })();
        } else {
          let busy = false;
          screenTimer = setInterval(async () => {
            if (busy || ws.readyState !== ws.OPEN) return;
            busy = true;
            await capture();
            busy = false;
          }, Math.round(1000 / fps));
        }
      } else if (msg.type === 'unsubscribe-screen') {
        stopScreen();
      } else if (msg.type === 'subscribe-video') {
        if (typeof msg.preset === 'string') video.setPreset(msg.preset);
        video.addViewer(ws, notify);
        if (video.currentInfo) send(ws, { type: 'video-info', ...video.currentInfo });
      } else if (msg.type === 'unsubscribe-video') {
        video.removeViewer(ws);
      } else if (msg.type === 'input') {
        handleInput(bridge, msg)
          .then(r => send(ws, { type: 'input-result', ok: r.ok, error: r.ok ? undefined : (r.stderr || 'input failed').trim() }))
          .catch(e => send(ws, { type: 'input-result', ok: false, error: e.message }));
      } else if (msg.type === 'rotate') {
        bridge
          .rotateDisplay()
          .then(r => send(ws, { type: 'rotate-result', ok: true, rotation: r.rotation }))
          .catch(e => send(ws, { type: 'rotate-result', ok: false, error: e.message }));
      } else if (msg.type === 'refresh-status') {
        pushStatus().catch(() => undefined);
      } else if (msg.type === 'ping') {
        send(ws, { type: 'pong', at: Date.now() });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      stopScreen();
      video.removeViewer(ws);
    });

    send(ws, { type: 'hello', at: Date.now() });
  });

  // Broadcast fresh device status to all connected clients every 5 seconds.
  let fetching = false;
  async function pushStatus(): Promise<void> {
    if (clients.size === 0 || fetching) return;
    fetching = true;
    try {
      const info = await getDeviceInfo(bridge);
      const payload = JSON.stringify({ type: 'status', data: info, at: Date.now() });
      for (const c of clients) {
        if (c.readyState === c.OPEN) c.send(payload);
      }
    } catch {
      // transport down - clients keep the last known state
    }
    fetching = false;
  }

  setInterval(() => {
    pushStatus().catch(() => undefined);
  }, 5000);

  return wss;
}
