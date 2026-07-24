// Android Bridge - the single abstraction layer for every Android action.
//
//   Application Controller (server.ts routes / websocket.ts)
//          |
//          v
//     AndroidBridge  (this file)
//          |
//          +--> AdbProvider      (shell privileges, via Wireless Debugging)
//          +--> ShizukuProvider  (shell privileges, via rish)
//          +--> TermuxBridge     (direct local exec: termux-api, am, getprop, ...)
//
// The backend runs natively inside Termux, so all of these are direct local
// executions. No other file in the project runs Android shell commands.

import { AdbProvider } from './adb';
import { ShizukuProvider } from './shizuku';
import { TermuxBridge, shq } from './termux';
import { BatteryInfo, BridgeStatus, ExecResult, InstallResult } from './types';

export class AndroidBridge {
  constructor(
    public termux: TermuxBridge,
    public adb: AdbProvider,
    public shizuku: ShizukuProvider,
  ) {}

  async status(): Promise<BridgeStatus> {
    const [t, a, s] = await Promise.all([
      this.termux.isAvailable(),
      this.adb.isAvailable().catch(() => false),
      this.shizuku.isAvailable().catch(() => false),
    ]);
    return { termuxBridge: t, adb: a, shizuku: s };
  }

  /**
   * Run a shell command with the best available transport.
   * Priority: adb (shell uid) -> shizuku (shell uid) -> termux (app uid).
   */
  async shell(cmd: string, timeoutMs = 30000): Promise<ExecResult> {
    const errors: string[] = [];
    if (await this.adb.isAvailable()) {
      const r = await this.adb.shell(cmd, timeoutMs);
      if (r.ok) return r;
      errors.push(`adb: ${r.stderr.trim()}`);
    }
    if (await this.shizuku.isAvailable()) {
      const r = await this.shizuku.shell(cmd, timeoutMs);
      if (r.ok) return r;
      errors.push(`shizuku: ${r.stderr.trim()}`);
    }
    const r = await this.termux.exec(cmd, timeoutMs);
    if (r.ok) return r;
    errors.push(`termux: ${r.stderr.trim()}`);
    return {
      ok: false,
      stdout: '',
      stderr: errors.join(' | ') || 'No Android transport available',
      code: -1,
      transport: 'none',
    };
  }

  async getprop(prop: string): Promise<string> {
    if (!/^[a-zA-Z0-9._\[\]-]+$/.test(prop)) return '';
    const r = await this.shell(`getprop ${prop}`, 10000);
    return r.ok ? r.stdout.trim() : '';
  }

  /** List installed packages. includeSystem=false returns only 3rd-party apps. */
  async listPackages(includeSystem = true): Promise<string[]> {
    const parse = (out: string) =>
      out
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('package:'))
        .map(l => l.slice('package:'.length).trim())
        .filter(Boolean);

    if (includeSystem) {
      const r = await this.shell('pm list packages', 30000);
      if (!r.ok) throw new Error(`pm list packages failed: ${r.stderr}`);
      return parse(r.stdout);
    }
    const r = await this.shell('pm list packages -3', 30000);
    if (!r.ok) return [];
    return parse(r.stdout);
  }

  /** Resolve the launcher activity component ("pkg/.MainActivity") for a package. */
  async resolveLauncherActivity(pkg: string): Promise<string | null> {
    const r = await this.shell(
      `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shq(pkg)}`,
      15000,
    );
    if (r.ok) {
      const lines = r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && last.includes('/') && !last.includes(' ')) return last;
    }
    return null;
  }

  /** Launch an application by package name. */
  async launchApp(pkg: string): Promise<ExecResult> {
    // 1) monkey works from a shell-level uid and needs no resolved component.
    let r = await this.shell(`monkey -p ${shq(pkg)} -c android.intent.category.LAUNCHER 1`, 20000);
    if (r.ok && !/No activities found|aborted|SecurityException/i.test(r.stdout + r.stderr)) return r;

    // 2) am start with the resolved launcher component.
    const comp = await this.resolveLauncherActivity(pkg);
    if (comp) {
      r = await this.shell(`am start --user 0 -n ${shq(comp)}`, 15000);
      if (r.ok) return r;
    }

    // 3) Last resort: am start from the Termux app uid (a normal app CAN
    //    start other apps' launcher activities without any privilege).
    if (comp) {
      r = await this.termux.exec(`am start --user 0 -n ${shq(comp)}`, 15000);
      if (r.ok) return r;
    }
    return this.termux.exec(
      `am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${shq(pkg)}`,
      15000,
    );
  }

  /** Open a URL in the device's default browser. */
  async openUrl(url: string): Promise<ExecResult> {
    return this.shell(`am start -a android.intent.action.VIEW -d ${shq(url)}`, 15000);
  }

  /** Capture the current screen as a PNG buffer. Requires shell privileges. */
  async screencap(): Promise<Buffer> {
    if (await this.adb.isAvailable()) {
      try {
        return await this.adb.execOutBuffer('screencap -p', 45000);
      } catch {
        // fall through to shizuku
      }
    }
    if (await this.shizuku.isAvailable()) {
      return this.shizuku.execOutBase64('screencap -p', 45000);
    }
    throw new Error(
      'Screenshot requires ADB or Shizuku (screencap needs shell-level access). See README troubleshooting.',
    );
  }

  /** Battery information: Termux:API first, dumpsys as fallback. */
  async battery(): Promise<BatteryInfo> {
    const r = await this.termux.exec('termux-battery-status', 10000);
    if (r.ok) {
      try {
        const j = JSON.parse(r.stdout);
        const status = String(j.status || '').toUpperCase();
        const plugged = String(j.plugged || '').toUpperCase();
        return {
          level: typeof j.percentage === 'number' ? j.percentage : null,
          charging:
            status === 'CHARGING' || status === 'FULL'
              ? true
              : status === 'DISCHARGING' || status === 'NOT_CHARGING'
                ? false
                : plugged.includes('PLUGGED')
                  ? true
                  : null,
          status: j.status ?? null,
          temperature: typeof j.temperature === 'number' ? j.temperature : null,
        };
      } catch {
        // fall through to dumpsys
      }
    }
    const d = await this.shell('dumpsys battery', 15000);
    if (d.ok) {
      const level = /level:\s*(\d+)/.exec(d.stdout)?.[1];
      const status = /status:\s*(\d+)/.exec(d.stdout)?.[1];
      return {
        level: level ? parseInt(level, 10) : null,
        charging: status ? status === '2' || status === '5' : null,
        status: status ?? null,
        temperature: null,
      };
    }
    return { level: null, charging: null, status: null, temperature: null };
  }

  /**
   * Install an APK that was uploaded to the backend.
   *
   * Chain of attempts:
   *   1. adb install (file is already local to the backend)
   *   2. copy to shared storage + `pm install` via Shizuku (shell uid)
   *   3. open the system package installer on the phone (requires the user
   *      to confirm on screen - there is NO silent install without
   *      shell/root privileges)
   */
  async installApk(localPath: string, originalName: string): Promise<InstallResult> {
    const details: string[] = [];

    // 1. adb install.
    try {
      if (await this.adb.isAvailable()) {
        const r = await this.adb.install(localPath);
        if (r.ok && /Success/i.test(r.stdout + r.stderr)) {
          return { ok: true, method: 'adb', detail: r.stdout.trim() || 'Success' };
        }
        details.push(`adb: ${(r.stderr || r.stdout).trim()}`);
      }
    } catch (e: any) {
      details.push(`adb: ${e.message}`);
    }

    // Steps 2-3 need the APK in shared storage so the shell uid / system
    // installer can read it.
    const safeName = originalName.replace(/[^A-Za-z0-9._-]/g, '_');
    const sharedPath = `/sdcard/Download/panel/${Date.now()}-${safeName}`;
    const cp = await this.termux.exec(
      `mkdir -p /sdcard/Download/panel && cp ${shq(localPath)} ${shq(sharedPath)} && chmod 644 ${shq(sharedPath)}`,
      30000,
    );
    if (!cp.ok) {
      details.push(`copy-to-sdcard: ${cp.stderr.trim()}`);
    } else {
      // 2. Shizuku pm install.
      if (await this.shizuku.isAvailable()) {
        const r = await this.shizuku.shell(`pm install -r ${shq(sharedPath)}`, 180000);
        if (r.ok && /Success/i.test(r.stdout + r.stderr)) {
          return { ok: true, method: 'shizuku-pm', detail: r.stdout.trim() || 'Success' };
        }
        details.push(`shizuku-pm: ${(r.stderr || r.stdout).trim()}`);
      }

      // 3. Open the system installer - user must confirm on the phone screen.
      const r3 = await this.shell(
        `am start -a android.intent.action.VIEW -d file://${sharedPath} -t application/vnd.android.package-archive`,
        15000,
      );
      if (r3.ok) {
        return {
          ok: true,
          method: 'intent-prompt',
          detail: 'System installer opened on the device - confirm the installation on the phone screen.',
        };
      }
      details.push(`intent: ${r3.stderr.trim()}`);
    }

    return {
      ok: false,
      method: 'none',
      detail:
        details.join(' | ') ||
        'No install path available. Configure ADB (ADB_SERIAL) or Shizuku (rish). See README.',
    };
  }
}
