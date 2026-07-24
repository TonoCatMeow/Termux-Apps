// Installed application manager.

import { AndroidBridge } from './android';
import { AndroidApp, ExecResult } from './types';

const CACHE_TTL = 60000;
let cache: { apps: AndroidApp[]; at: number } | null = null;

function prettify(pkg: string): string {
  const last = pkg.split('.').pop() || pkg;
  const spaced = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, c => c.toUpperCase()) || pkg;
}

export async function getApps(bridge: AndroidBridge, force = false): Promise<AndroidApp[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache.apps;

  const pkgs = await bridge.listPackages(true);
  let thirdParty = new Set<string>();
  try {
    thirdParty = new Set(await bridge.listPackages(false));
  } catch {
    // transport may not support -3 filtering; mark everything as system
  }

  const apps: AndroidApp[] = pkgs
    .map(p => ({ name: prettify(p), packageName: p, system: !thirdParty.has(p) }))
    .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));

  cache = { apps, at: Date.now() };
  return apps;
}

export async function launchApp(bridge: AndroidBridge, pkg: string): Promise<ExecResult> {
  if (!/^[A-Za-z0-9._]+$/.test(pkg) || pkg.length > 200) {
    throw new Error('Invalid package name');
  }
  return bridge.launchApp(pkg);
}
