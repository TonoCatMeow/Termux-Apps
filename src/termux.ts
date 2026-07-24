// Host command executor.
//
// The backend runs directly INSIDE Termux, so Android commands
// (termux-api, am, pm, getprop, monkey, adb, rish, ...) are executed
// directly via child_process - no bridge daemon, no proot, no extra hop.

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ExecResult } from './types';

const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const HOME_DIR = process.env.HOME || '/data/data/com.termux/files/home';
const SHELL = fs.existsSync(`${PREFIX}/bin/bash`) ? `${PREFIX}/bin/bash` : `${PREFIX}/bin/sh`;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Quote a string for safe inclusion in a POSIX shell command. */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export class TermuxBridge {
  // The backend itself runs in Termux, so the "bridge" is always up.
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async health(): Promise<boolean> {
    return true;
  }

  /** Execute a command directly on the Android host (Termux app uid). */
  exec(cmd: string, timeoutMs = 30000): Promise<ExecResult> {
    return new Promise(resolve => {
      exec(cmd, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, shell: SHELL }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout ?? ''),
          stderr:
            String(stderr ?? '') +
            (err && typeof (err as any).code !== 'number' ? ` ${err.message}` : ''),
          code: err ? ((err as any).code ?? 1) : 0,
          transport: 'termux-local',
        });
      });
    });
  }

  /** Execute a command whose stdout is binary; returns the decoded buffer. */
  async execBase64(cmd: string, timeoutMs = 60000): Promise<Buffer> {
    const r = await this.exec(`${cmd} | base64`, timeoutMs);
    if (!r.ok) throw new Error(r.stderr || `Command failed with code ${r.code}`);
    return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64');
  }

  /** Write a file into user-accessible storage (Termux home or /sdcard). */
  async writeFile(remotePath: string, data: Buffer): Promise<{ ok: boolean; stderr: string }> {
    try {
      const allowed = [HOME_DIR, '/sdcard', '/storage/emulated/0'];
      if (!allowed.some(a => remotePath === a || remotePath.startsWith(a + '/'))) {
        return { ok: false, stderr: 'path not allowed' };
      }
      fs.mkdirSync(path.dirname(remotePath), { recursive: true });
      fs.writeFileSync(remotePath, data);
      return { ok: true, stderr: '' };
    } catch (e: any) {
      return { ok: false, stderr: e.message };
    }
  }
}
