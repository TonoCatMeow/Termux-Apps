// Screenshot capture with a tiny cache so HTTP polling and WebSocket
// streaming do not trigger multiple screencaps for the same frame.

import { AndroidBridge } from './android';

let lastShot: { buf: Buffer; at: number } | null = null;
let pending: Promise<Buffer> | null = null;

export async function captureScreenshot(bridge: AndroidBridge, maxAgeMs = 0): Promise<Buffer> {
  if (maxAgeMs > 0 && lastShot && Date.now() - lastShot.at < maxAgeMs) {
    return lastShot.buf;
  }
  if (pending) return pending;

  pending = (async () => {
    const buf = await bridge.screencap();
    if (!buf || buf.length < 100) throw new Error('Empty screenshot captured');
    lastShot = { buf, at: Date.now() };
    return buf;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}
