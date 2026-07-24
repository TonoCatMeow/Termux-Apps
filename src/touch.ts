// Raw touchscreen injection via a tiny Java agent running under app_process.
//
// sendevent (/dev/input/eventX) is blocked by SELinux on many devices, so
// instead we run a small agent as the shell user. The agent receives
// "d x y" / "m x y" / "u x y" lines on stdin and injects REAL MotionEvents
// (ACTION_DOWN / MOVE / UP) through InputManager.injectInputEvent - the same
// privileged API `input tap` uses, but as a live stream. Android's own input
// pipeline decides tap vs swipe vs fling vs long-press. Exactly like a
// physical finger.
//
// The agent is pure-reflection Java, so it compiles WITHOUT an android.jar.
// The backend (running in Termux) compiles it with ecj + dx and pushes it to
// the device automatically on first use:
//   pkg install ecj dx        <- one-time
//
// Requires ADB (persistent app_process with piped stdin).

import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';
import { AdbProvider } from './adb';
import { TermuxBridge, shq } from './termux';
import { VideoInfo } from './video';
import { dataDir } from './files';

const DEVICE_DEX = '/data/local/tmp/touchpanel.dex';

const AGENT_JAVA = `
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Method;

public class TouchAgent {
  public static void main(String[] args) {
    try {
      Class<?> imClass = Class.forName("android.hardware.input.InputManager");
      Object im = imClass.getDeclaredMethod("getInstance").invoke(null);
      Method inject = imClass.getMethod("injectInputEvent",
          Class.forName("android.view.InputEvent"), int.class);

      Class<?> meClass = Class.forName("android.view.MotionEvent");
      Method obtain = meClass.getMethod("obtain", long.class, long.class,
          int.class, float.class, float.class, int.class);
      Method setSource = meClass.getMethod("setSource", int.class);

      Method uptime = Class.forName("android.os.SystemClock").getMethod("uptimeMillis");

      BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
      long downTime = 0;
      String line;
      while ((line = in.readLine()) != null) {
        line = line.trim();
        if (line.length() == 0) continue;
        String[] p = line.split(" ");
        if (p.length < 3) continue;
        long now = (Long) uptime.invoke(null);
        int action;
        if (p[0].equals("d")) { downTime = now; action = 0; }
        else if (p[0].equals("m")) { if (downTime == 0) continue; action = 2; }
        else if (p[0].equals("u")) { if (downTime == 0) continue; action = 1; }
        else continue;

        float x = Float.parseFloat(p[1]);
        float y = Float.parseFloat(p[2]);
        Object ev = obtain.invoke(null, downTime, now, action, x, y, 0);
        setSource.invoke(ev, 4098); // SOURCE_TOUCHSCREEN
        inject.invoke(im, ev, 0);   // INJECT_INPUT_EVENT_MODE_ASYNC
        if (action == 1) downTime = 0;
      }
    } catch (Throwable t) {
      t.printStackTrace();
      System.exit(1);
    }
  }
}
`;

export class TouchController {
  private proc: ChildProcess | null = null;
  private agentReady = false;
  private isDown = false;

  constructor(
    private adb: AdbProvider,
    private termux: TermuxBridge,
    private videoInfo: () => VideoInfo | null,
  ) {}

  /**
   * Handle one pointer event from the browser.
   * nx/ny are normalized (0..1) coordinates over the video frame, which is
   * exactly the current (rotated) display frame. MotionEvent injection works
   * in logical display coordinates, so this is a simple scale.
   */
  async handle(action: string, nx: number, ny: number): Promise<void> {
    const clamp = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
    const dims = await this.displayDims();
    const x = Math.round(clamp(nx) * dims.w);
    const y = Math.round(clamp(ny) * dims.h);

    if (action === 'down') {
      await this.ensureAgent();
      this.isDown = true;
      this.write(`d ${x} ${y}`);
    } else if (action === 'move') {
      if (!this.isDown) return;
      this.write(`m ${x} ${y}`);
    } else if (action === 'up') {
      if (!this.isDown) return;
      this.isDown = false;
      this.write(`u ${x} ${y}`);
    }
  }

  /** Lift the finger if a client disconnects mid-gesture. */
  forceUp(): void {
    if (!this.isDown) return;
    this.isDown = false;
    const info = this.videoInfo();
    const w = info ? info.deviceWidth : 1080;
    const h = info ? info.deviceHeight : 2400;
    this.write(`u ${Math.round(w / 2)} ${Math.round(h / 2)}`);
  }

  /** Current logical display size (accounts for rotation). */
  private async displayDims(): Promise<{ w: number; h: number }> {
    const info = this.videoInfo();
    if (info) {
      const landscape = info.orientation === 1 || info.orientation === 3;
      return landscape
        ? { w: info.deviceHeight, h: info.deviceWidth }
        : { w: info.deviceWidth, h: info.deviceHeight };
    }
    try {
      const r = await this.adb.shell('wm size', 8000);
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

  // ------------------------------------------------------------ agent -----

  private async ensureAgent(): Promise<void> {
    if (this.agentReady) return;
    const r = await this.adb.shell(`ls ${DEVICE_DEX} 2>/dev/null && echo FOUND`, 10000);
    if (!r.stdout.includes('FOUND')) {
      console.log('[touch] agent not on device - building it (first-time setup)...');
      await this.buildAndPush();
      console.log('[touch] agent deployed');
    }
    this.agentReady = true;
  }

  /** Compile the agent in Termux (ecj + dx) and push it via adb. */
  private async buildAndPush(): Promise<void> {
    const dir = path.join(dataDir(), 'agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'TouchAgent.java'), AGENT_JAVA);

    // Note: no compliance flags - Termux's ecj wrapper already sets its own.
    let r = await this.termux.exec(`cd ${shq(dir)} && ecj -d . TouchAgent.java`, 90000);
    if (!r.ok) {
      throw new Error(
        `Compiling the touch agent failed - run: pkg install ecj dx\n${(r.stderr || r.stdout).slice(0, 300)}`,
      );
    }
    r = await this.termux.exec(`cd ${shq(dir)} && dx --dex --output=touchpanel.dex TouchAgent.class`, 90000);
    if (!r.ok) {
      throw new Error(`dexing the touch agent failed - run: pkg install dx\n${(r.stderr || r.stdout).slice(0, 300)}`);
    }
    r = await this.adb.exec(['push', path.join(dir, 'touchpanel.dex'), DEVICE_DEX], 30000);
    if (!r.ok) {
      throw new Error(`pushing the touch agent failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
    }
  }

  private ensureProc(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    // CLASSPATH tells app_process where the dex is; argv[1] is a work dir.
    this.proc = this.adb.spawnStream(
      ['shell', `CLASSPATH=${DEVICE_DEX} app_process /data/local/tmp TouchAgent`],
      true, // stdin MUST be piped - we stream commands into the agent
    );
    this.proc.stderr?.on('data', d => {
      console.error('[touch-agent]', String(d).trim());
    });
    this.proc.on('exit', () => {
      this.proc = null;
    });
    this.proc.on('error', () => {
      this.proc = null;
    });
    return this.proc;
  }

  private write(cmd: string): void {
    try {
      const p = this.ensureProc();
      if (!p.stdin) return;
      p.stdin.write(cmd + '\n');
    } catch {
      // drop; next event respawns the agent
    }
  }
}
