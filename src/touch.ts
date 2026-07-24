// Raw touchscreen injection via sendevent.
//
// Instead of `input tap` / `input swipe` (atomic, pre-cooked gestures), this
// streams REAL pointer state - down / move / up - directly into the kernel
// input driver (/dev/input/eventX). Android itself decides what is a tap, a
// swipe, a fling, or a long-press. Dragging icons, holding buttons, edge
// gestures: all behave exactly like a physical finger.
//
// Requires ADB: a persistent interactive `adb shell` keeps latency low.
// Works because the shell uid is in the `input` group (write access to
// /dev/input/event*).

import { ChildProcess } from 'child_process';
import { AdbProvider } from './adb';
import { VideoInfo } from './video';

interface TouchDevice {
  path: string;
  name: string;
  maxX: number;
  maxY: number;
  typeB: boolean; // multitouch protocol B (slots/tracking-id) vs A
}

// input event constants
const EV_SYN = 0;
const EV_KEY = 1;
const EV_ABS = 3;
const SYN_REPORT = 0;
const SYN_MT_REPORT = 2;
const BTN_TOUCH = 330;
const ABS_MT_SLOT = 47;
const ABS_MT_TOUCH_MAJOR = 48;
const ABS_MT_POSITION_X = 53;
const ABS_MT_POSITION_Y = 54;
const ABS_MT_TRACKING_ID = 57;
const ABS_MT_PRESSURE = 58;

type Ev = [number, number, number];

function absMax(block: string, label: string, code: string): number | null {
  const re = new RegExp(`(?:${label}|${code})\\s*:.*max (\\d+)`);
  const m = re.exec(block);
  return m ? parseInt(m[1], 10) : null;
}

/** Parse `getevent -pl` output and pick the touchscreen device. */
function parseTouchDevice(out: string): TouchDevice {
  const blocks = out.split(/^add device /m).slice(1);
  const cands: TouchDevice[] = [];

  for (const b of blocks) {
    const path = (/\/dev\/input\/event\d+/.exec(b) || [])[0];
    const name = (/name:\s+"([^"]+)"/.exec(b) || [])[1] || '';
    const maxX = absMax(b, 'ABS_MT_POSITION_X', '0035');
    const maxY = absMax(b, 'ABS_MT_POSITION_Y', '0036');
    if (!path || maxX == null || maxY == null) continue;
    const typeB = /ABS_MT_SLOT|002f\s*:/.test(b);
    cands.push({ path, name, maxX, maxY, typeB });
  }

  if (!cands.length) throw new Error('No touchscreen found in getevent output');
  return (
    cands.find(c => /touch|synap|sec_|goodix|focal|himax|novatek|ntl|fts/i.test(c.name)) || cands[0]
  );
}

export class TouchController {
  private device: TouchDevice | null = null;
  private shell: ChildProcess | null = null;
  private isDown = false;

  constructor(
    private adb: AdbProvider,
    private videoInfo: () => VideoInfo | null,
  ) {}

  /**
   * Handle one pointer event from the browser.
   * nx/ny are normalized (0..1) coordinates over the video frame, which is
   * exactly the current (rotated) display frame.
   */
  async handle(action: string, nx: number, ny: number): Promise<void> {
    const dev = await this.ensureDevice();
    const clamp = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
    const { x, y } = await this.toRaw(clamp(nx), clamp(ny), dev);

    if (action === 'down') {
      this.isDown = true;
      this.write(dev, this.downEvents(dev, x, y));
    } else if (action === 'move') {
      if (!this.isDown) return;
      this.write(dev, this.moveEvents(dev, x, y));
    } else if (action === 'up') {
      if (!this.isDown) return;
      this.isDown = false;
      this.write(dev, this.upEvents(dev));
    }
  }

  /** Lift the finger if a client disconnects mid-gesture. */
  forceUp(): void {
    if (!this.isDown || !this.device) return;
    this.isDown = false;
    this.write(this.device, this.upEvents(this.device));
  }

  /** Map normalized current-display coords -> raw driver coords (physical panel frame). */
  private async toRaw(nx: number, ny: number, dev: TouchDevice): Promise<{ x: number; y: number }> {
    const o = await this.orientation();
    let px: number, py: number;
    switch (o) {
      case 1: // landscape, UI top facing panel's left edge
        px = ny;
        py = 1 - nx;
        break;
      case 2:
        px = 1 - nx;
        py = 1 - ny;
        break;
      case 3: // landscape, UI top facing panel's right edge
        px = 1 - ny;
        py = nx;
        break;
      default:
        px = nx;
        py = ny;
    }
    return { x: Math.round(px * dev.maxX), y: Math.round(py * dev.maxY) };
  }

  private async orientation(): Promise<number> {
    const info = this.videoInfo();
    if (info && typeof info.orientation === 'number') return info.orientation;
    try {
      const r = await this.adb.shell('dumpsys input', 10000);
      const m = /SurfaceOrientation:\s*(\d)/.exec(r.stdout);
      if (m) return parseInt(m[1], 10);
    } catch {
      // ignore
    }
    return 0;
  }

  private async ensureDevice(): Promise<TouchDevice> {
    if (this.device) return this.device;
    const r = await this.adb.shell('getevent -pl', 20000);
    if (!r.ok) throw new Error(`getevent failed: ${(r.stderr || r.stdout).trim().slice(0, 120)}`);
    this.device = parseTouchDevice(r.stdout);
    return this.device;
  }

  private ensureShell(): ChildProcess {
    if (this.shell && this.shell.exitCode === null && !this.shell.killed) return this.shell;
    this.shell = this.adb.spawnStream(['shell']);
    this.shell.on('exit', () => {
      this.shell = null;
    });
    this.shell.on('error', () => {
      this.shell = null;
    });
    return this.shell;
  }

  private write(dev: TouchDevice, events: Ev[]): void {
    try {
      const sh = this.ensureShell();
      if (!sh.stdin) return;
      const lines = events.map(([t, c, v]) => `sendevent ${dev.path} ${t} ${c} ${v}`);
      sh.stdin.write(lines.join('\n') + '\n');
    } catch {
      // drop the event; next ones will respawn the shell
    }
  }

  private downEvents(dev: TouchDevice, x: number, y: number): Ev[] {
    if (dev.typeB) {
      return [
        [EV_ABS, ABS_MT_SLOT, 0],
        [EV_ABS, ABS_MT_TRACKING_ID, 0],
        [EV_ABS, ABS_MT_POSITION_X, x],
        [EV_ABS, ABS_MT_POSITION_Y, y],
        [EV_ABS, ABS_MT_PRESSURE, 50],
        [EV_ABS, ABS_MT_TOUCH_MAJOR, 5],
        [EV_KEY, BTN_TOUCH, 1],
        [EV_SYN, SYN_REPORT, 0],
      ];
    }
    return [
      [EV_ABS, ABS_MT_POSITION_X, x],
      [EV_ABS, ABS_MT_POSITION_Y, y],
      [EV_ABS, ABS_MT_PRESSURE, 50],
      [EV_ABS, ABS_MT_TOUCH_MAJOR, 5],
      [EV_SYN, SYN_MT_REPORT, 0],
      [EV_SYN, SYN_REPORT, 0],
    ];
  }

  private moveEvents(dev: TouchDevice, x: number, y: number): Ev[] {
    if (dev.typeB) {
      return [
        [EV_ABS, ABS_MT_POSITION_X, x],
        [EV_ABS, ABS_MT_POSITION_Y, y],
        [EV_SYN, SYN_REPORT, 0],
      ];
    }
    return [
      [EV_ABS, ABS_MT_POSITION_X, x],
      [EV_ABS, ABS_MT_POSITION_Y, y],
      [EV_SYN, SYN_MT_REPORT, 0],
      [EV_SYN, SYN_REPORT, 0],
    ];
  }

  private upEvents(dev: TouchDevice): Ev[] {
    if (dev.typeB) {
      return [
        [EV_ABS, ABS_MT_TRACKING_ID, -1],
        [EV_KEY, BTN_TOUCH, 0],
        [EV_SYN, SYN_REPORT, 0],
      ];
    }
    return [
      [EV_ABS, ABS_MT_PRESSURE, 0],
      [EV_SYN, SYN_MT_REPORT, 0],
      [EV_SYN, SYN_REPORT, 0],
    ];
  }
}
