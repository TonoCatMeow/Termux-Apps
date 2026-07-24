// Live H.264 video streaming from the device screen.
//
// Uses `adb exec-out screenrecord --output-format=h264 -` which gives us a raw
// H.264 Annex-B stream encoded by the phone's HARDWARE encoder at the
// display's real refresh rate (60fps+). The stream is broadcast to all
// subscribed WebSocket clients as binary frames; the browser decodes it with
// JMuxer + MSE (hardware decode). This is what makes real 60fps possible,
// unlike the screencap PNG path which tops out around 3-10fps.
//
// Requires ADB (binary stdout passthrough). Shizuku/Termux are not usable
// here because they would need base64, which is too slow for video.

import { ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import { AdbProvider } from './adb';

export interface VideoInfo {
  deviceWidth: number;
  deviceHeight: number;
  videoWidth: number;
  videoHeight: number;
  orientation: number;
  fps: number;
  bitRate: number;
  preset: string;
}

type Notify = (msg: object) => void;

const PRESETS = ['low', 'medium', 'high'];

export class VideoStreamer {
  private proc: ChildProcess | null = null;
  private viewers = new Map<WebSocket, Notify>();
  private stopping = false;
  private restarting: NodeJS.Timeout | null = null;
  private rotationWatcher: NodeJS.Timeout | null = null;
  private streamRotation = 0;
  private failCount = 0;
  private preset = 'medium';
  private info: VideoInfo | null = null;

  constructor(private adb: AdbProvider) {}

  get currentInfo(): VideoInfo | null {
    return this.info;
  }

  addViewer(ws: WebSocket, notify: Notify): void {
    this.viewers.set(ws, notify);
    if (!this.proc && !this.restarting) {
      this.start().catch(e => this.broadcastMsg({ type: 'video-error', error: e.message }));
    }
  }

  removeViewer(ws: WebSocket): void {
    this.viewers.delete(ws);
    if (this.viewers.size === 0) this.stop();
  }

  setPreset(p: string): void {
    if (!PRESETS.includes(p)) return;
    if (p === this.preset) return;
    this.preset = p;
    if (this.proc || this.restarting) this.restart();
  }

  private restart(): void {
    this.stop();
    if (this.viewers.size > 0) {
      this.start().catch(e => this.broadcastMsg({ type: 'video-error', error: e.message }));
    }
  }

  private stop(): void {
    this.stopping = true;
    if (this.restarting) {
      clearTimeout(this.restarting);
      this.restarting = null;
    }
    if (this.rotationWatcher) {
      clearInterval(this.rotationWatcher);
      this.rotationWatcher = null;
    }
    // Detach the handle BEFORE killing, so the old process's exit handler
    // (which checks this.proc !== proc) doesn't disturb a fresh stream.
    const p = this.proc;
    this.proc = null;
    if (p) {
      try {
        p.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.info = null;
    this.stopping = false;
  }

  /**
   * screenrecord does NOT exit when the display rotates - it keeps encoding
   * with the original dimensions. Poll the actual rotation and restart the
   * encoder when it changes so the video aspect follows the phone.
   */
  private startRotationWatcher(): void {
    if (this.rotationWatcher) return;
    this.rotationWatcher = setInterval(async () => {
      if (!this.proc || this.viewers.size === 0) return;
      try {
        const rot = await this.currentRotation();
        if (rot !== this.streamRotation) {
          this.streamRotation = rot;
          this.broadcastMsg({ type: 'video-reset' });
          this.restart();
        }
      } catch {
        // ignore - keep watching
      }
    }, 2000);
  }

  private async start(): Promise<void> {
    if (!(await this.adb.isAvailable())) {
      this.broadcastMsg({
        type: 'video-error',
        error: 'Live video requires ADB (screenrecord needs shell access). Screenshots still work via Shizuku.',
      });
      return;
    }

    const dev = await this.displaySize();
    const rot = await this.currentRotation();
    // `wm size` always reports the PHYSICAL (portrait) panel size.
    // In landscape the video must be encoded with swapped dimensions,
    // otherwise screenrecord squishes the picture.
    const oriented = rot === 1 || rot === 3 ? { w: dev.h, h: dev.w } : dev;
    const { w, h, bitRate } = this.videoParams(oriented);
    this.stopping = false;
    this.streamRotation = rot;

    const proc = this.adb.spawnStream([
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--size',
      `${w}x${h}`,
      '--bit-rate',
      String(bitRate),
      '-',
    ]);
    this.proc = proc;
    this.startRotationWatcher();

    const startedAt = Date.now();
    let stderrBuf = '';
    let infoSent = false;

    const sendInfo = (orientation: number, fps: number, dw: number, dh: number) => {
      if (infoSent) return;
      infoSent = true;
      this.info = {
        deviceWidth: dw,
        deviceHeight: dh,
        videoWidth: w,
        videoHeight: h,
        orientation,
        fps,
        bitRate,
        preset: this.preset,
      };
      this.broadcastMsg({ type: 'video-info', ...this.info });
    };

    proc.stderr?.on('data', d => {
      stderrBuf += d.toString();
      // e.g. "Main display is 1080x2400 @60.00fps (orientation=0)"
      const m = /Main display is (\d+)x(\d+) @([\d.]+)fps \(orientation=(\d+)\)/.exec(stderrBuf);
      if (m) sendInfo(parseInt(m[4], 10), parseFloat(m[3]), parseInt(m[1], 10), parseInt(m[2], 10));
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const [ws] of this.viewers) {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      }
    });

    proc.on('error', e => {
      this.broadcastMsg({ type: 'video-error', error: e.message });
    });

    proc.on('exit', code => {
      if (this.proc !== proc) return; // already replaced by a newer stream
      this.proc = null;
      if (this.stopping || this.viewers.size === 0) return;
      if (Date.now() - startedAt < 3000) {
        this.failCount++;
        if (this.failCount >= 3) {
          this.broadcastMsg({
            type: 'video-error',
            error: `screenrecord keeps exiting (code ${code}). Is the screen on? Is ADB connected?`,
          });
          return;
        }
      } else {
        this.failCount = 0;
      }
      // screenrecord stops on its own (time limit / rotation change) - respawn.
      this.broadcastMsg({ type: 'video-reset' });
      this.restarting = setTimeout(() => {
        this.restarting = null;
        this.start().catch(e => this.broadcastMsg({ type: 'video-error', error: e.message }));
      }, 800);
    });

    // Fallback info if the stderr banner never arrives.
    setTimeout(() => {
      if (!infoSent && this.proc === proc) sendInfo(rot, 60, dev.w, dev.h);
    }, 2000);
  }

  private async displaySize(): Promise<{ w: number; h: number }> {
    try {
      const r = await this.adb.shell('wm size', 10000);
      const matches = [...r.stdout.matchAll(/(\d{3,5})x(\d{3,5})/g)];
      if (matches.length) {
        const m = matches[matches.length - 1];
        return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
      }
    } catch {
      // ignore
    }
    return { w: 1080, h: 2400 };
  }

  /** Current display rotation 0-3 (dumpsys = actual state, settings = fallback). */
  private async currentRotation(): Promise<number> {
    try {
      const r = await this.adb.shell('dumpsys input', 10000);
      const m = /SurfaceOrientation:\s*(\d)/.exec(r.stdout);
      if (m) return parseInt(m[1], 10);
    } catch {
      // ignore
    }
    try {
      const r = await this.adb.shell('dumpsys display', 10000);
      const m = /mCurrentOrientation=(\d)/.exec(r.stdout) || /mRotation=(\d)/.exec(r.stdout);
      if (m) return parseInt(m[1], 10);
    } catch {
      // ignore
    }
    try {
      const r = await this.adb.shell('settings get system user_rotation', 8000);
      const n = parseInt(r.stdout.trim(), 10);
      if (n >= 0 && n <= 3) return n;
    } catch {
      // ignore
    }
    return 0;
  }

  private videoParams(dev: { w: number; h: number }): { w: number; h: number; bitRate: number } {
    const scale = this.preset === 'low' ? 0.4 : this.preset === 'high' ? 1 : 0.6;
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const bitRate = this.preset === 'low' ? 4000000 : this.preset === 'high' ? 16000000 : 8000000;
    return { w: even(dev.w * scale), h: even(dev.h * scale), bitRate };
  }

  private broadcastMsg(msg: object): void {
    for (const [, notify] of this.viewers) notify(msg);
  }
}
