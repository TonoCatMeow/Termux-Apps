// WebSocket system: live device status pushes + live screenshot streaming.

import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { AndroidBridge } from './android';
import { getDeviceInfo } from './device';
import { captureScreenshot } from './screenshot';

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function setupWebSocket(server: http.Server, bridge: AndroidBridge): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', ws => {
    clients.add(ws);
    let screenTimer: NodeJS.Timeout | null = null;

    ws.on('message', raw => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === 'subscribe-screen') {
        const fps = Math.min(Math.max(Number(msg.fps) || 1, 0.2), 5);
        if (screenTimer) clearInterval(screenTimer);
        let busy = false;
        screenTimer = setInterval(async () => {
          if (busy || ws.readyState !== ws.OPEN) return;
          busy = true;
          try {
            const buf = await captureScreenshot(bridge);
            send(ws, { type: 'screenshot', data: buf.toString('base64'), at: Date.now() });
          } catch (e: any) {
            send(ws, { type: 'screenshot-error', error: e.message || 'screenshot failed' });
          }
          busy = false;
        }, Math.round(1000 / fps));
      } else if (msg.type === 'unsubscribe-screen') {
        if (screenTimer) clearInterval(screenTimer);
        screenTimer = null;
      } else if (msg.type === 'refresh-status') {
        pushStatus().catch(() => undefined);
      } else if (msg.type === 'ping') {
        send(ws, { type: 'pong', at: Date.now() });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (screenTimer) clearInterval(screenTimer);
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
