// Basic file manager over user-accessible storage.
//
// Roots that can be browsed:
//   - "panel"       : the backend's own data directory (always available)
//   - "sdcard"      : /sdcard, if it is bind-mounted into Debian
//                     (proot-distro login debian --bind /sdcard - see README)
//   - "shared"      : /storage/emulated/0, same as above
//   - "debian-home" : the Debian user's home directory
//
// Private Android app data (/data/data/<pkg>) is intentionally NOT touched.

import fs from 'fs';
import path from 'path';
import { FsEntry } from './types';

export interface FsRoot {
  name: string;
  path: string;
}

const DATA_DIR = process.env.PANEL_DATA_DIR || path.join(process.cwd(), 'data');

export function dataDir(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function apksDir(): string {
  const p = path.join(dataDir(), 'apks');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function uploadsTmpDir(): string {
  const p = path.join(dataDir(), 'tmp');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function isReadableDir(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK);
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function getRoots(): FsRoot[] {
  const roots: FsRoot[] = [{ name: 'panel', path: dataDir() }];
  if (isReadableDir('/sdcard')) roots.push({ name: 'sdcard', path: '/sdcard' });
  if (isReadableDir('/storage/emulated/0') && !roots.some(r => r.path === '/storage/emulated/0')) {
    roots.push({ name: 'shared', path: '/storage/emulated/0' });
  }
  const home = process.env.HOME || '/root';
  if (isReadableDir(home)) roots.push({ name: 'debian-home', path: home });
  return roots;
}

/** Resolve a (root, relative path) pair, refusing escapes outside the root. */
export function resolvePath(rootName: string, sub: string): string {
  const root = getRoots().find(r => r.name === rootName);
  if (!root) throw new Error(`Unknown root "${rootName}"`);
  const resolved = path.resolve(root.path, sub || '.');
  if (resolved !== root.path && !resolved.startsWith(root.path + path.sep)) {
    throw new Error('Path escapes the allowed root');
  }
  return resolved;
}

export function listDir(rootName: string, sub: string): FsEntry[] {
  const dir = resolvePath(rootName, sub);
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error('Not a directory');

  const out: FsEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    try {
      const s = fs.statSync(path.join(dir, name));
      out.push({
        name,
        path: path.posix.join((sub || '').replace(/\\/g, '/'), name),
        isDir: s.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
      });
    } catch {
      // unreadable entry - skip
    }
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

export function safeFileName(name: string): string {
  return path.basename(name).replace(/[^A-Za-z0-9._ -]/g, '_') || 'file';
}
