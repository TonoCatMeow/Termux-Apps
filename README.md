# Android Control Panel

A local, web-based "fake emulator" style dashboard that controls your **real**
Android phone. The Node.js backend runs **natively inside Termux** and serves
a dashboard on `http://PHONE_IP:2010`.

```
Browser
   |
   v
Node.js Web Panel (0.0.0.0:2010)        <- inside Termux
   |
   v
Android Bridge layer (android.ts)       <- direct local execution, no middlemen
   |
   +--> Termux:API  (battery, notifications, ...)
   +--> am / pm / getprop / monkey (as the Termux app uid)
   +--> adb    (android-tools -> Wireless Debugging over TCP)
   +--> rish   (Shizuku shell)
   |
   v
Android Framework -> Installed Apps
```

Everything the backend needs (`termux-api`, `am`, `pm`, `adb`, `rish`) is
executed directly as the Termux app uid. No proot, no bridge daemon, no
Docker, no cloud.

## Features

- **Dashboard** – model, manufacturer, Android version, battery %/charging,
  storage, RAM, CPU, local IP, transport status; auto-updates via WebSocket.
- **App manager** – list installed apps, search, **Launch** button.
  - `GET /api/apps` · `POST /api/apps/:package/launch`
- **Device info** – `GET /api/device`
- **Screen viewer** – `GET /api/screenshot` (PNG) + live streaming over
  WebSocket (0.5–4 FPS).
- **WebSockets** – `/ws` for status pushes, screenshot frames, future controls.
- **File manager** – browse/download/upload user-accessible storage
  (panel data dir, `/sdcard`, Termux home).
- **APK manager** – upload APK, install via adb / Shizuku / system installer.
- **System actions** – launch apps, open URLs (`POST /api/open-url`), battery,
  device info, screenshots.
- **No auth** – open local dashboard. Anyone on your Wi-Fi can reach it;
  use only on networks you trust.

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

Install from F-Droid / GitHub releases (NOT the Play Store Termux — outdated):

- **Termux** (F-Droid)
- **Termux:API** (F-Droid — must match the Termux source)
- **Termux:Boot** (F-Droid — for autostart, open it once after installing)
- **Shizuku** (https://github.com/rikkaapps/shizuku)

## 2. Termux setup

```sh
pkg update -y
pkg install -y nodejs android-tools termux-api git
termux-setup-storage        # grant storage permission (for /sdcard access)
```

Also: Android Settings → Apps → Termux → Battery → **Unrestricted**.

### Install rish (Shizuku shell)

rish is NOT downloadable from GitHub anymore — export it from the Shizuku app:

1. Open the Shizuku app → **"Use Shizuku in terminal apps"** → **Export files**
   → save to Download (Shizuku must be running first, see step 3)
2. Then in Termux:

```sh
cp /sdcard/Download/rish /sdcard/Download/rish_shizuku.dex ~/
chmod +x ~/rish
head -3 ~/rish    # sanity check: must show shell script, NOT html
```

### Clone + build + run

```sh
cd ~
git clone https://github.com/TonoCatMeow/Termux-Apps.git ~/android
cd ~/android
npm install
npm run build

export ADB_SERIAL='192.168.254.87:39001'   # your wireless debugging IP:port (optional but recommended)
PORT=2010 npm start
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2010` | HTTP port (bound to `0.0.0.0`) |
| `ADB_SERIAL` | – | e.g. `192.168.254.87:39001` (wireless debugging) |
| `ADB_PATH` | `adb` | Custom adb binary path |
| `RISH_CMD` | `RISH_APPLICATION_ID=com.termux sh "$HOME/rish"` | rish invocation |
| `PANEL_DATA_DIR` | `./data` | Uploads/APKs/files root |

## 3. Android setup

1. **Enable Developer Options**: Settings → About phone → tap *Build number* 7×.
2. **Enable Wireless Debugging**: Settings → Developer options → *Wireless debugging* → ON.
3. **Connect adb** (one-time pairing, in Termux):
   ```sh
   # Wireless debugging → "Pair device with pairing code"
   adb pair 127.0.0.1:<pair-port>        # enter the 6-digit code
   # Back on the Wireless debugging screen, note the IP:port shown:
   adb connect 192.168.254.87:<port>
   adb devices                           # should show "device"
   ```
   Use that `IP:port` as `ADB_SERIAL`. The port changes after reboots/toggles.
4. **Start Shizuku**:
   ```sh
   adb shell sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh
   ```
   Then verify: `RISH_APPLICATION_ID=com.termux sh ~/rish -c 'id'`
   → should print `uid=2000(shell)`.
5. In the Shizuku app, enable **"Start on boot"** so it survives reboots.

### Permissions required

- Termux: **Storage** (`termux-setup-storage`); battery optimisation off.
- Termux:API app installed for `termux-battery-status` etc.
- Shizuku running (for shell-level actions without adb).

## 4. Autostart on boot (Termux:Boot)

```sh
mkdir -p ~/.termux/boot
nano ~/.termux/boot/start-panel.sh
```

Paste:

```sh
#!/data/data/com.termux/files/usr/bin/sh
# Android Control Panel autostart

termux-wake-lock
sshd

# Best-effort adb auto-connect (wireless debugging port changes every boot,
# this discovers it via mDNS). Shizuku's own "start on boot" covers the rest.
(
  sleep 20
  for i in 1 2 3 4 5 6; do
    ADDR=$(adb mdns services 2>/dev/null | grep '_adb-tls-connect' \
           | grep -oE '([0-9]+\.){3}[0-9]+:[0-9]+' | head -1)
    if [ -n "$ADDR" ]; then
      adb connect "$ADDR"
      adb shell sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh
      break
    fi
    sleep 10
  done
) &

cd "$HOME/android" && nohup node dist/server.js > "$HOME/panel.log" 2>&1 &
```

Then:

```sh
chmod +x ~/.termux/boot/start-panel.sh
```

## 5. Connecting

```sh
ip addr show wlan0     # find phone IP
```

Open from any device on the same Wi-Fi:

```
http://PHONE_IP:2010
```

No login required — the dashboard opens directly.

## Updating

```sh
cd ~/android
git pull
npm install
npm run build
# restart the server (Ctrl+C / pkill -f "node dist/server.js", then npm start)
```

---

# TROUBLESHOOTING

**ADB unavailable**
- Wireless debugging turns off on reboot/wifi change: re-enable + `adb connect`.
- `ADB_SERIAL` must match the *current* IP:port on the Wireless debugging screen.
- Pairing uses a *different* port than connecting — pair first, then connect.

**Shizuku unavailable**
- Shizuku stops on reboot — enable "Start on boot" in the Shizuku app, or
  start it again (step 3 above).
- `~/rish` and `~/rish_shizuku.dex` must both exist in Termux home.
- Test: `RISH_APPLICATION_ID=com.termux sh ~/rish -c 'id'` must print `uid=2000(shell)`.

**Apps do not launch**
- Termux-only mode works for most apps (`am start` as the app uid is allowed);
  adb/Shizuku adds `monkey` support.
- Package list empty on Android 11+ without adb/Shizuku: package visibility
  rules hide most packages from the Termux uid — enable adb or Shizuku.

**Screenshots fail**
- `screencap` requires shell privileges → configure **adb or Shizuku**.
  There is no rootless screenshot from a terminal without them.

**Port 2010 cannot be reached from another device**
- Verify the backend binds 0.0.0.0: check startup log; try `ss -tlnp | grep 2010`.
- Some Wi-Fi networks enable *client isolation* — test from the phone's own
  browser first (`http://127.0.0.1:2010`).
- Make sure Termux has a wakelock (`termux-wake-lock`) so Android doesn't kill it.

**npm install fails in Termux**
- All dependencies are pure JS, so no compilers are needed. Make sure you have
  the F-Droid Termux and a recent `nodejs` package (`pkg upgrade nodejs`).

---

# SECURITY NOTES

- **There is no authentication.** Anyone on your local network who can reach
  `PHONE_IP:2010` gets full control of the dashboard. Use only on networks
  you trust.
