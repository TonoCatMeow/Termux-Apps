// Device information collection.
//
// Note what works from WHERE inside Debian proot-distro:
//   - /proc/meminfo and /proc/cpuinfo are readable directly (shared kernel)
//   - network interfaces are visible directly (shared network namespace)
//   - Android properties / battery / storage need the AndroidBridge

import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { AndroidBridge } from './android';
import { CpuInfo, DeviceInfo, RamInfo, StorageInfo } from './types';

function readRam(): RamInfo {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = /MemTotal:\s+(\d+)\s*kB/.exec(txt);
    const avail = /MemAvailable:\s+(\d+)\s*kB/.exec(txt);
    const t = total ? parseInt(total[1], 10) * 1024 : null;
    const a = avail ? parseInt(avail[1], 10) * 1024 : null;
    return { totalBytes: t, freeBytes: a, usedBytes: t != null && a != null ? t - a : null };
  } catch {
    return { totalBytes: null, usedBytes: null, freeBytes: null };
  }
}

function readCpu(): CpuInfo {
  const cpus = os.cpus();
  let model = (cpus[0] && cpus[0].model) || '';
  try {
    const txt = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const hw = /Hardware\s*:\s*(.+)/.exec(txt);
    if (!model && hw) model = hw[1].trim();
    else if (hw && /ARM|processor|unknown/i.test(model)) model = `${model} (${hw[1].trim()})`;
  } catch {
    // ignore
  }
  return { model: model || 'Unknown', cores: cpus.length || 0 };
}

function localIp(): string {
  const nets = os.networkInterfaces();
  const names = Object.keys(nets).sort((a, b) => {
    const aw = a.startsWith('wlan') ? 0 : 1;
    const bw = b.startsWith('wlan') ? 0 : 1;
    return aw - bw;
  });
  for (const name of names) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '';
}

function dfLocal(p: string): Promise<StorageInfo | null> {
  return new Promise(resolve => {
    execFile('df', ['-B1', p], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout).trim().split('\n');
      const parts = (lines[lines.length - 1] || '').split(/\s+/);
      if (parts.length < 4 || !/^\d+$/.test(parts[1])) return resolve(null);
      resolve({
        path: p,
        totalBytes: parseInt(parts[1], 10),
        usedBytes: parseInt(parts[2], 10),
        freeBytes: parseInt(parts[3], 10),
      });
    });
  });
}

async function storageInfo(bridge: AndroidBridge): Promise<StorageInfo> {
  // Preferred: Android-side view of shared storage.
  const r = await bridge.shell('df -B1 /sdcard', 10000).catch(() => null);
  if (r && r.ok) {
    const lines = r.stdout.trim().split('\n');
    const parts = (lines[lines.length - 1] || '').split(/\s+/);
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
      return {
        path: '/sdcard',
        totalBytes: parseInt(parts[1], 10),
        usedBytes: parseInt(parts[2], 10),
        freeBytes: parseInt(parts[3], 10),
      };
    }
  }
  // Fallbacks: /sdcard may be bind-mounted into Debian; otherwise the Debian
  // rootfs lives on the phone's /data partition, so df / is still the
  // phone's real internal storage usage.
  const local = (await dfLocal('/sdcard')) || (await dfLocal('/'));
  return local || { path: '/', totalBytes: null, usedBytes: null, freeBytes: null };
}

export async function getDeviceInfo(bridge: AndroidBridge): Promise<DeviceInfo> {
  const [model, manufacturer, androidVersion, sdk, battery, storage, bridges] = await Promise.all([
    bridge.getprop('ro.product.model'),
    bridge.getprop('ro.product.manufacturer'),
    bridge.getprop('ro.build.version.release'),
    bridge.getprop('ro.build.version.sdk'),
    bridge.battery(),
    storageInfo(bridge),
    bridge.status(),
  ]);

  return {
    model: model || 'Unknown',
    manufacturer: manufacturer || 'Unknown',
    androidVersion: androidVersion ? `Android ${androidVersion} (SDK ${sdk || '?'})` : 'Unknown',
    sdk: sdk || '',
    battery,
    storage,
    ram: readRam(),
    cpu: readCpu(),
    ip: localIp(),
    bridges,
  };
}
