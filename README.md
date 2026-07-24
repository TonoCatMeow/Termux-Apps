# Android Control Panel

A local, web-based "fake emulator" style dashboard that controls your **real**
Android phone. The Node.js backend runs inside a **Debian proot-distro**
environment on Termux and serves a dashboard on `http://PHONE_IP:2010`.

```
Browser
   |
   v
Node.js Web Panel (0.0.0.0:2010)        <- inside Debian proot-distro
   |
   v
Android Bridge layer (android.ts)
   |
   +--> Termux bridge (termux-bridge.js, localhost:17845, token-protected)
   |       +--> Termux:API  (battery, notifications, ...)
   |       +--> am / pm / getprop / monkey (as the Termux app uid)
   |       +--> adb    (android-tools in Termux)
   |       +--> rish   (Shizuku shell)
   |
   +--> ADB (local adb binary in Debian -> Wireless Debugging over TCP)
   |
   +--> Shizuku (rish, via the Termux bridge)
   |
   v
Android Framework -> Installed Apps
```

**Why the bridge?** Debian proot-distro shares the Android kernel but does NOT
see Termux's filesystem or Android binaries. Loopback networking *is* shared,
so a tiny token-protected daemon in Termux (`bridge/termux-bridge.js`) executes
whitelisted Android commands on behalf of the Debian backend. No feature is
silently dropped: if a transport is missing, the API tells you exactly which
one to set up.

## Features

- **Dashboard** – model, manufacturer, Android version, battery %/charging,
  storage, RAM, CPU, local IP, bridge status; auto-updates via WebSocket.
- **App manager** – list installed apps, search, **Launch** button.
  - `GET /api/apps` · `POST /api/apps/:package/launch`
- **Device info** – `GET /api/device`
- **Screen viewer** – `GET /api/screenshot` (PNG) + live streaming over
  WebSocket (0.5–4 FPS).
- **WebSockets** – `/ws` for status pushes, screenshot frames, future controls.
- **File manager** – browse/download/upload user-accessible storage
  (panel data dir, `/sdcard` if bound, Debian home).
- **APK manager** – upload APK, install via adb / Shizuku / system installer.
- **System actions** – launch apps, open URLs (`POST /api/open-url`), battery,
  device info, screenshots.
- **Auth** – password login, HMAC session cookie (12 h). Password via
  `PANEL_PASSWORD` (default: `admin` — change it).

## Limitations (no root)

Without root this system **cannot**: access private app data
(`/data/data/<pkg>`), fully control other apps, inject touches everywhere, or
**silently** install APKs (the system installer will ask for confirmation on
the phone screen unless adb/Shizuku shell access is configured).

It **can**: launch apps, list installed packages, read device/battery/storage
info, take screenshots (with adb or Shizuku), open URLs, manage user-visible
files, and install APKs with on-screen confirmation.

---

# SETUP GUIDE

## 1. Android apps to install

Install from F-Droid / GitHub releases (NOT the Play Store Termux — it is
outdated):

- **Termux** (F-Droid)
- **Termux:API** (F-Droid — must match the Termux source)
- **Shizuku** (https://github.com/rikkaapps/shizuku)

## 2. Termux setup

Open Termux:

```sh
pkg update
pkg install nodejs android-tools termux-api openssh curl
termux-setup-storage        # grant storage permission (for /sdcard access)
```

### Install rish (Shizuku shell) in Termux

```sh
cd ~
curl -LO https://github.com/RikkaApps/Shizuku/raw/master/shell/rish
curl -LO https://github.com/RikkaApps/Shizuku/raw/master/shell/rish_shizuku.dex
chmod +x rish
```

### Copy + start the Termux bridge

Copy `bridge/termux-bridge.js` into Termux home (e.g. via `scp`, shared
storage, or paste it). Then:

```sh
# pick ONE secret token and use it on both sides
export BRIDGE_TOKEN='my-secret-token'
nohup node ~/termux-bridge.js > ~/bridge.log 2>&1 &
```

The bridge listens on `127.0.0.1:17845` only — it is not reachable from the
network.

> Optional SSH fallback transport: Termux's `sshd` (port 8022) also works.
> In Debian: `apt install sshpass`, then start the backend with
> `TERMUX_SSH_CMD="sshpass -p <password> ssh -o StrictHostKeyChecking=no -p 8022 <user>@127.0.0.1"`.
> The backend uses SSH automatically if the HTTP bridge is down.

## 3. Debian setup

Enter the Debian environment (bind `/sdcard` so the file manager can browse
shared storage):

```sh
proot-distro login debian --bind /sdcard
# (older proot-distro: use: proot-distro login debian --shared-tmp
#  and add a bind in the distro script, or just use the panel/debian-home roots)
```

Copy the project into Debian (example: from shared storage):

```sh
cp -r /sdcard/path/to/android ~/
cd ~/android        # project root: package.json, src/, frontend/ live here
```

Install, build, start (Node.js/npm already exist inside Debian):

```sh
npm install
npm run build

export PANEL_PASSWORD='choose-a-strong-password'
export TERMUX_BRIDGE_TOKEN='my-secret-token'   # SAME as BRIDGE_TOKEN in Termux
export ADB_SERIAL='127.0.0.1:39001'            # your wireless debugging IP:port (optional but recommended)

PORT=2010 npm start
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2010` | HTTP port (bound to `0.0.0.0`) |
| `PANEL_PASSWORD` | `admin` | Dashboard login password |
| `PANEL_SECRET` | random | Session signing secret (random = logout on restart) |
| `TERMUX_BRIDGE_TOKEN` | `change-me` | Must match `BRIDGE_TOKEN` in Termux |
| `TERMUX_BRIDGE_URL` | `http://127.0.0.1:17845` | Bridge endpoint |
| `TERMUX_SSH_CMD` | – | Optional SSH fallback transport |
| `ADB_SERIAL` | – | e.g. `127.0.0.1:39001` (wireless debugging) |
| `RISH_CMD` | `RISH_APPLICATION_ID=com.termux sh "$HOME/rish"` | rish invocation |
| `PANEL_DATA_DIR` | `./data` | Uploads/APKs/files root |

## 4. Android setup

1. **Enable Developer Options**: Settings → About phone → tap *Build number* 7×.
2. **Enable Wireless Debugging**: Settings → Developer options → *Wireless debugging* → ON.
3. **Connect adb** (one-time pairing; in Termux or Debian):
   ```sh
   # On the phone: Wireless debugging → "Pair device with pairing code"
   adb pair 127.0.0.1:<pair-port>        # enter the 6-digit code
   # Back on the Wireless debugging screen, note the IP:port shown:
   adb connect 127.0.0.1:<port>
   adb devices                           # should show "device"
   ```
   Use that `127.0.0.1:<port>` as `ADB_SERIAL`. Note: the port changes after
   reboots/toggles — re-run `adb connect` or update `ADB_SERIAL`.
4. **Start Shizuku**:
   ```sh
   adb shell sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh
   ```
   (Or open the Shizuku app → *Start via wireless debugging*.) Then verify in
   Termux: `RISH_APPLICATION_ID=com.termux sh ~/rish -c 'id'` → should print
   `uid=2000(shell)`.

### Permissions required

- Termux: **Storage** (`termux-setup-storage`), battery optimisation disabled
  (recommended so the bridge keeps running).
- Termux:API app installed for `termux-battery-status` etc.
- Shizuku running (for shell-level actions without adb).

## 5. Connecting

Find the phone's IP (in Termux or Debian):

```sh
ip addr show wlan0     # or: ifconfig wlan0
```

From any device on the same Wi-Fi, open:

```
http://PHONE_IP:2010
```

Log in with `PANEL_PASSWORD`.

---

# TROUBLESHOOTING

**Termux bridge unavailable (`termux: down` on the Bridges tab)**
- Check it's running in Termux: `ps aux | grep termux-bridge` / read `~/bridge.log`.
- Tokens must match: `BRIDGE_TOKEN` (Termux) == `TERMUX_BRIDGE_TOKEN` (Debian).
- Test from Debian: `curl -H "x-bridge-token: TOKEN" http://127.0.0.1:17845/health`.
- Fallback: set `TERMUX_SSH_CMD` to use Termux's sshd instead.

**ADB unavailable**
- Wireless debugging turns off on reboot/wifi change: re-enable + `adb connect`.
- `ADB_SERIAL` must match the *current* IP:port shown on the Wireless debugging screen.
- Pairing uses a *different* port than connecting — pair first, then connect.
- Debian-side adb: `apt install adb` (optional; Termux-side `android-tools` works too).

**Shizuku unavailable**
- Shizuku stops on reboot — start it again (see step 4 above).
- `~/rish` and `~/rish_shizuku.dex` must both exist in Termux home.
- Test: `RISH_APPLICATION_ID=com.termux sh ~/rish -c 'id'` must print `uid=2000(shell)`.
- Custom location? Set `RISH_CMD`.

**Debian cannot access Android commands**
- Expected — that's the whole reason for the bridge. Do not try to install
  `termux-api` inside Debian; run the bridge in Termux.

**Apps do not launch**
- Launch needs *some* working transport. Termux-only mode works for most apps
  (`am start` as the app uid is allowed); adb/Shizuku adds `monkey` support.
- Package list empty on Android 11+ without adb/Shizuku: package visibility
  rules hide most packages from the Termux uid — enable adb or Shizuku.

**Screenshots fail**
- `screencap` requires shell privileges → configure **adb or Shizuku**.
  There is no rootless screenshot from a terminal without them.

**Port 2010 cannot be reached from another device**
- Verify the backend binds 0.0.0.0: check startup log; try `ss -tlnp | grep 2010`.
- Some Wi-Fi networks enable *client isolation* — test from the phone's own
  browser first (`http://127.0.0.1:2010`).
- On some devices, Android blocks inbound connections to Termux on mobile
  hotspots; use the phone's browser or a different network.
- Make sure Termux/Debian is running in the foreground or with a wakelock
  (`termux-wake-lock`) so Android doesn't kill it.

**Backend cannot communicate with Termux**
- Loopback is shared in proot, so `127.0.0.1:17845` from Debian == Termux.
  If the distro was started with network isolation (rare), disable it.
- Confirm `node` exists in Termux (`pkg install nodejs`).

**Sessions keep logging out**
- `PANEL_SECRET` is random per start; set it to a fixed value to persist
  sessions across restarts.

---

# SECURITY NOTES

- The dashboard is password protected, but traffic is plain HTTP — use only on
  trusted local networks.
- The Termux bridge executes whitelisted shell commands for anyone holding the
  token. It binds localhost only; keep the token secret.
- Change the default password (`PANEL_PASSWORD`) and default bridge token.
