// Termux bridge client.
//
// Debian proot-distro shares the Android kernel with Termux but does NOT see
// Termux's filesystem or Android binaries. A tiny bridge daemon
// (bridge/termux-bridge.js) runs inside Termux and exposes a localhost-only
// HTTP API that executes whitelisted commands on the Android
// host side (termux-api, am, pm, adb, rish, ...).
//
// Because proot does not create a new network namespace, 127.0.0.1 inside
// Debian is the same loopback as 127.0.0.1 inside Termux, so the Debian
// backend can simply POST to http://127.0.0.1:17845.
//
// Optional fallback transport: SSH into Termux's sshd (port 8022) via
// TERMUX_SSH_CMD, e.g.
//   TERMUX_SSH_CMD="sshpass -p pi ssh -o StrictHostKeyChecking=no -p 8022 u0_a303@127.0.0.1"

import { exec } from 'child_process';
import http from 'http';
import { ExecResult } from './types';

/** Quote a string for safe inclusion in a POSIX shell command. */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export class TermuxBridge {
  private url: string;
  private sshCmd: string | null;
  private lastOk = 0;

  constructor() {
    this.url = (process.env.TERMUX_BRIDGE_URL || 'http://127.0.0.1:17845').replace(/\/+$/, '');
    this.sshCmd = process.env.TERMUX_SSH_CMD || null;
  }

  /** True if the bridge answered within the last 60s or answers now. */
  async isAvailable(): Promise<boolean> {
    if (Date.now() - this.lastOk < 60000) return true;
    return this.health();
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.request('GET', '/health', null, 5000);
      if (r && r.ok) {
        this.lastOk = Date.now();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Execute a whitelisted command on the Android host via the Termux bridge. */
  async exec(cmd: string, timeoutMs = 30000): Promise<ExecResult> {
    try {
      const r = await this.request('POST', '/exec', { cmd, timeout: timeoutMs }, timeoutMs + 10000);
      this.lastOk = Date.now();
      return {
        ok: r.code === 0,
        stdout: typeof r.stdout === 'string' ? r.stdout : '',
        stderr: typeof r.stderr === 'string' ? r.stderr : (r.error || ''),
        code: typeof r.code === 'number' ? r.code : 1,
        transport: 'termux-bridge',
      };
    } catch (e: any) {
      if (this.sshCmd) return this.execSsh(cmd, timeoutMs);
      return {
        ok: false,
        stdout: '',
        stderr: `Termux bridge unreachable at ${this.url}: ${e.message}`,
        code: -1,
        transport: 'none',
      };
    }
  }

  /** Execute a command whose stdout is binary; returns the decoded buffer. */
  async execBase64(cmd: string, timeoutMs = 60000): Promise<Buffer> {
    const r = await this.exec(`${cmd} | base64`, timeoutMs);
    if (!r.ok) throw new Error(r.stderr || `Command failed with code ${r.code}`);
    return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64');
  }

  /** Write a file on the Android host (Termux home or shared storage). */
  async writeFile(remotePath: string, data: Buffer): Promise<{ ok: boolean; stderr: string }> {
    try {
      const r = await this.request('POST', '/write-file', { path: remotePath, dataBase64: data.toString('base64') }, 180000);
      return { ok: !!r.ok, stderr: r.error || r.stderr || '' };
    } catch (e: any) {
      return { ok: false, stderr: e.message };
    }
  }

  private execSsh(cmd: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise(resolve => {
      const full = `${this.sshCmd} ${shq(cmd)}`;
      exec(full, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (err ? ` ${err.message}` : ''),
          code: err ? ((err as any).code ?? 1) : 0,
          transport: 'termux-ssh',
        });
      });
    });
  }

  private request(method: string, path: string, body: any, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const u = new URL(this.url + path);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method,
          headers: {
            ...(data
              ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
              : {}),
          },
          timeout: timeoutMs,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error(`Bad bridge response (${res.statusCode}): ${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Bridge request timed out')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
}
