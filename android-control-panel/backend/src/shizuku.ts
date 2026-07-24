// Shizuku provider.
//
// Shizuku (https://github.com/rikkaapps/shizuku) runs a privileged service
// with adb/shell-level permissions on the device. Apps (and shells) can talk
// to it through "rish" - a small launcher that executes commands with
// Shizuku's privileges.
//
// rish lives on the Termux side (it must run as the Termux app uid so Shizuku
// can identify the caller via RISH_APPLICATION_ID), therefore every command
// here is executed through the Termux bridge.
//
// Setup (documented in README):
//   In Termux:
//     curl -LO https://github.com/RikkaApps/Shizuku/releases/.../rish
//     curl -LO .../rish_shizuku.dex
//     chmod +x rish
//   Override the invocation with RISH_CMD if your setup differs.

import { TermuxBridge, shq } from './termux';
import { ExecResult } from './types';

export class ShizukuProvider {
  private rishCmd: string;
  private cached: { ok: boolean; at: number } | null = null;

  constructor(private termux: TermuxBridge) {
    this.rishCmd = process.env.RISH_CMD || 'RISH_APPLICATION_ID=com.termux sh "$HOME/rish"';
  }

  async isAvailable(): Promise<boolean> {
    if (this.cached && Date.now() - this.cached.at < 30000) return this.cached.ok;
    let ok = false;
    try {
      const r = await this.termux.exec(`${this.rishCmd} -c 'echo shizuku-ok'`, 20000);
      ok = r.ok && r.stdout.includes('shizuku-ok');
    } catch {
      ok = false;
    }
    this.cached = { ok, at: Date.now() };
    return ok;
  }

  /** Run a command with Shizuku (shell-level) privileges. */
  async shell(cmd: string, timeoutMs = 30000): Promise<ExecResult> {
    const r = await this.termux.exec(`${this.rishCmd} -c ${shq(cmd)}`, timeoutMs);
    return { ...r, transport: 'shizuku-rish' };
  }

  /** Run a command with Shizuku privileges and return binary stdout. */
  async execOutBase64(cmd: string, timeoutMs = 60000): Promise<Buffer> {
    const r = await this.termux.exec(`${this.rishCmd} -c ${shq(cmd)} | base64`, timeoutMs);
    if (!r.ok) throw new Error(r.stderr || 'rish command failed');
    return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64');
  }
}
