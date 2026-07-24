// ADB provider.
//
// Two ways to reach adbd from inside Debian proot-distro:
//   1. A local `adb` binary inside Debian (apt install adb) talking over TCP to
//      the phone's Wireless Debugging endpoint (ADB_SERIAL, e.g. 127.0.0.1:38001).
//      Networking is shared with the host, so this works from proot.
//   2. Fallback: `adb` installed inside Termux (pkg install android-tools),
//      executed through the Termux bridge.
//
// Missing adb is handled gracefully: every method reports failure and the
// AndroidBridge falls back to Shizuku / Termux transports.

import { execFile } from 'child_process';
import { TermuxBridge, shq } from './termux';
import { ExecResult } from './types';

const MAX_BUFFER = 64 * 1024 * 1024;

export class AdbProvider {
  private serial: string;
  private bin: string;
  private localChecked = false;
  private localOk = false;

  constructor(private termux: TermuxBridge) {
    this.serial = (process.env.ADB_SERIAL || '').trim();
    this.bin = process.env.ADB_PATH || 'adb';
  }

  /** "-s <serial> " fragment for commands executed through the bridge. */
  serialFlag(): string {
    return this.serial ? `-s ${this.serial} ` : '';
  }

  async localAvailable(): Promise<boolean> {
    if (this.localChecked) return this.localOk;
    const r = await this.runLocal(['--version'], 5000);
    this.localOk = r.ok;
    this.localChecked = true;
    return this.localOk;
  }

  /** Connect to the Wireless Debugging endpoint if ADB_SERIAL is configured. */
  async ensureConnected(): Promise<void> {
    if (!this.serial) return;
    try {
      if (await this.localAvailable()) {
        await this.runLocal(['connect', this.serial], 15000);
      } else {
        await this.termux.exec(`adb connect ${this.serial}`, 15000);
      }
    } catch {
      // ignore - availability checks will report the real state
    }
  }

  async isAvailable(): Promise<boolean> {
    const r = await this.exec(['devices'], 10000);
    if (!r.ok) return false;
    const lines = r.stdout
      .split('\n')
      .slice(1)
      .map(l => l.trim())
      .filter(Boolean);
    return lines.some(l => /(^|\s)device$/.test(l));
  }

  /** Run an adb command (without the leading "adb"). */
  async exec(args: string[], timeoutMs = 30000): Promise<ExecResult> {
    const full = [...this.baseArgs(), ...args];
    if (await this.localAvailable()) {
      const r = await this.runLocal(full, timeoutMs);
      return { ok: r.ok, stdout: r.stdout as string, stderr: r.stderr, code: r.code, transport: 'adb-local' };
    }
    const cmd = ['adb', ...full].map(shq).join(' ');
    const r = await this.termux.exec(cmd, timeoutMs);
    return { ...r, transport: r.transport === 'none' ? 'none' : 'adb-termux' };
  }

  /** Run `adb shell <cmd>`. */
  async shell(cmd: string, timeoutMs = 30000): Promise<ExecResult> {
    return this.exec(['shell', cmd], timeoutMs);
  }

  /** Run `adb exec-out <cmd>` and return raw binary stdout. */
  async execOutBuffer(cmd: string, timeoutMs = 60000): Promise<Buffer> {
    const full = [...this.baseArgs(), 'exec-out', cmd];
    if (await this.localAvailable()) {
      const r = await this.runLocal(full, timeoutMs, true);
      if (!r.ok) throw new Error(r.stderr || 'adb exec-out failed');
      return r.stdout as Buffer;
    }
    const sh = ['adb', ...full].map(shq).join(' ');
    return this.termux.execBase64(sh, timeoutMs);
  }

  async install(apkPath: string, timeoutMs = 180000): Promise<ExecResult> {
    return this.exec(['install', '-r', apkPath], timeoutMs);
  }

  private baseArgs(): string[] {
    return this.serial ? ['-s', this.serial] : [];
  }

  private runLocal(
    args: string[],
    timeoutMs = 30000,
    binary = false,
  ): Promise<{ ok: boolean; stdout: string | Buffer; stderr: string; code: number }> {
    return new Promise(resolve => {
      execFile(
        this.bin,
        args,
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: binary ? 'buffer' : 'utf8' } as any,
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            stdout: (stdout as any) ?? (binary ? Buffer.alloc(0) : ''),
            stderr: String(stderr ?? '') + (err ? ` ${err.message}` : ''),
            code: err ? ((err as any).code ?? 1) : 0,
          });
        },
      );
    });
  }
}
