// ADB provider.
//
// adb runs directly inside Termux (pkg install android-tools) and talks to
// the phone's own Wireless Debugging endpoint over TCP (ADB_SERIAL,
// e.g. 192.168.254.87:39001).
//
// Missing adb is handled gracefully: every method reports failure and the
// AndroidBridge falls back to Shizuku / Termux transports.

import { execFile } from 'child_process';
import { ExecResult } from './types';

const MAX_BUFFER = 64 * 1024 * 1024;

export class AdbProvider {
  private serial: string;
  private bin: string;
  private checked = false;
  private adbOk = false;

  constructor() {
    this.serial = (process.env.ADB_SERIAL || '').trim();
    this.bin = process.env.ADB_PATH || 'adb';
  }

  /** "-s <serial> " fragment for raw adb command strings. */
  serialFlag(): string {
    return this.serial ? `-s ${this.serial} ` : '';
  }

  async localAvailable(): Promise<boolean> {
    if (this.checked) return this.adbOk;
    const r = await this.run(['--version'], 5000);
    this.adbOk = r.ok;
    this.checked = true;
    return this.adbOk;
  }

  /** Connect to the Wireless Debugging endpoint if ADB_SERIAL is configured. */
  async ensureConnected(): Promise<void> {
    if (!this.serial) return;
    try {
      await this.run(['connect', this.serial], 15000);
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
    const r = await this.run([...this.baseArgs(), ...args], timeoutMs);
    return { ok: r.ok, stdout: r.stdout as string, stderr: r.stderr, code: r.code, transport: 'adb-local' };
  }

  /** Run `adb shell <cmd>`. */
  async shell(cmd: string, timeoutMs = 30000): Promise<ExecResult> {
    return this.exec(['shell', cmd], timeoutMs);
  }

  /** Run `adb exec-out <cmd>` and return raw binary stdout. */
  async execOutBuffer(cmd: string, timeoutMs = 60000): Promise<Buffer> {
    const r = await this.run([...this.baseArgs(), 'exec-out', cmd], timeoutMs, true);
    if (!r.ok) throw new Error(r.stderr || 'adb exec-out failed');
    return r.stdout as Buffer;
  }

  async install(apkPath: string, timeoutMs = 180000): Promise<ExecResult> {
    return this.exec(['install', '-r', apkPath], timeoutMs);
  }

  private baseArgs(): string[] {
    return this.serial ? ['-s', this.serial] : [];
  }

  private run(
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
