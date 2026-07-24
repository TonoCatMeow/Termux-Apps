// Input injection: taps, swipes, text, and key events.
//
// Uses the Android `input` command, which requires the shell uid's
// INJECT_EVENTS permission - so it works via ADB or Shizuku, but NOT via the
// bare Termux app uid. The AndroidBridge transport chain handles that and
// surfaces the failure if neither is available.

import { AndroidBridge } from './android';
import { shq } from './termux';
import { ExecResult } from './types';

const KEYCODES: Record<string, number> = {
  BACK: 4,
  HOME: 3,
  RECENTS: 187,
  APP_SWITCH: 187,
  MENU: 82,
  POWER: 26,
  ENTER: 66,
  DEL: 67,
  BACKSPACE: 67,
  TAB: 61,
  SPACE: 62,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  MUTE: 164,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  CAMERA: 27,
  SEARCH: 84,
};

function coord(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error('invalid coordinate');
  return n;
}

function duration(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 300;
  return Math.min(n, 10000);
}

export async function inputTap(bridge: AndroidBridge, x: unknown, y: unknown): Promise<ExecResult> {
  return bridge.shell(`input tap ${coord(x)} ${coord(y)}`, 10000);
}

export async function inputSwipe(
  bridge: AndroidBridge,
  x1: unknown,
  y1: unknown,
  x2: unknown,
  y2: unknown,
  durationMs: unknown,
): Promise<ExecResult> {
  return bridge.shell(
    `input swipe ${coord(x1)} ${coord(y1)} ${coord(x2)} ${coord(y2)} ${duration(durationMs)}`,
    15000,
  );
}

export async function inputText(bridge: AndroidBridge, text: unknown): Promise<ExecResult> {
  const t = String(text ?? '').slice(0, 500);
  if (!t) throw new Error('empty text');
  // `input text` needs %s for spaces; shell-quote the rest.
  return bridge.shell(`input text ${shq(t.replace(/ /g, '%s'))}`, 15000);
}

export async function inputKey(bridge: AndroidBridge, key: unknown): Promise<ExecResult> {
  const k = String(key ?? '').toUpperCase();
  let code = KEYCODES[k];
  if (code == null && /^\d{1,3}$/.test(k)) code = parseInt(k, 10);
  if (code == null || code < 0 || code > 999) throw new Error(`unknown key "${key}"`);
  return bridge.shell(`input keyevent ${code}`, 10000);
}

/**
 * Begin a hold: a zero-distance swipe with a long duration keeps the finger
 * down. Fire-and-forget - it is ended by inputHoldEnd (pkill).
 */
export function inputHoldStart(bridge: AndroidBridge, x: unknown, y: unknown): ExecResult {
  const xi = coord(x);
  const yi = coord(y);
  // Runs in the background for up to 60s; killed on release.
  bridge.shell(`input swipe ${xi} ${yi} ${xi} ${yi} 60000`, 70000).catch(() => undefined);
  return { ok: true, stdout: '', stderr: '', code: 0 };
}

/** End a hold: kill the running hold-swipe so the finger lifts. */
export async function inputHoldEnd(bridge: AndroidBridge): Promise<ExecResult> {
  // pkill returns non-zero when nothing matched - that's fine.
  await bridge.shell(`pkill -f 'input swipe' || true`, 8000);
  return { ok: true, stdout: '', stderr: '', code: 0 };
}

/** Dispatch an {action, ...} message (shared by the WS handler and REST API). */
export async function handleInput(bridge: AndroidBridge, msg: any): Promise<ExecResult> {
  switch (msg && msg.action) {
    case 'tap':
      return inputTap(bridge, msg.x, msg.y);
    case 'swipe':
      return inputSwipe(bridge, msg.x1, msg.y1, msg.x2, msg.y2, msg.duration);
    case 'text':
      return inputText(bridge, msg.text);
    case 'key':
      return inputKey(bridge, msg.key);
    case 'hold-start':
      return inputHoldStart(bridge, msg.x, msg.y);
    case 'hold-end':
      return inputHoldEnd(bridge);
    default:
      throw new Error(`unknown input action "${msg && msg.action}"`);
  }
}
