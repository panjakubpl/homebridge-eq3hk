# Changelog

## [2.3.0] - 2026-04-30

### Fixed
- **Notifications no longer arrive on eQ-3 firmware 1.46+** — `eq3.exp` now spawns `gatttool` with `--sec-level=medium`, which triggers an encrypted-link upgrade on connect. Without it, gatttool's default `low` security level meant CCC writes (notification subscribe at handle 0x0430) were silently dropped by the thermostat firmware, every command timed out with `Thermostat hasn't responded after sync request in time`, and `mqtt_handler` exited 255 on every poll. Affects all installations after the eQ-3 firmware OTA to 1.46+/1.48 (auto-pushed via the calorBT mobile app since 2024) or after BlueZ wiped the bond store during a Bookworm security update.

### Added
- **`scripts/pair.sh`** — guided re-pair helper for users hitting the FW 1.46+ requirement. Walks through `bluetoothctl pair` with passkey entry, verifies `Bonded: yes`, and restarts `mqtt_handler.service` automatically.
- **`docs/2026-04-30-bluez-firmware-bond-required.md`** — full forensic write-up: symptom, root cause (CCCD requires authenticated link), diagnostic steps, canonical fix, and references to upstream Heckie75 / python-eq3bt / dbuezas threads.

### Changed
- README troubleshooting section reordered to put the **"Notifications dead after firmware update — needs re-pair"** entry first, since it is now the most common failure mode reported by users.

### Required action for existing users
If your plugin was working and suddenly started failing with `Thermostat hasn't responded after sync request in time`:
1. Update plugin to 2.3.0 (`mqtt_handler.service` will auto-restart).
2. Verify bond state: `bluetoothctl info <MAC> | grep -E 'Paired|Bonded'`.
3. If `Bonded: no` — run `sudo /var/lib/homebridge/node_modules/homebridge-eq3hk/scripts/pair.sh <MAC>` (or follow the `bluetoothctl pair` recipe in README).

## [2.2.0] - 2026-04-04

### Changed
- **Homebridge v2.0 compatibility** — migrated from deprecated `.on('get/set', callback)` to `.onGet(async fn)` / `.onSet(async fn)` API required by Homebridge v2
- All getter/setter methods (`getCurrentTemperature`, `getTargetTemperature`, `setTargetTemperature`, `getCurrentHeatingCoolingState`, `getTargetHeatingCoolingState`, `setTargetHeatingCoolingState`) are now `async`, returning Promises instead of using Node-style callbacks
- Updated `engines` to declare support for both Homebridge v1.6+ and v2.0: `"^1.6.0 || ^2.0.0-beta.0"`
- Required Node.js version updated to `^18.20.4 || ^20.15.1 || ^22`

### Fixed
- **`updateCache()` bug** — previously called `getCurrentTemperature()` and incorrectly updated `lastUpdated` with stale cached data, causing the cache to never properly expire. Now correctly sends only the MQTT request; `lastUpdated` is updated exclusively by the MQTT message handler when a real response arrives.
- **JSON.parse safety** — MQTT message handler now wraps `JSON.parse` in try/catch. A malformed or empty broker message no longer crashes the plugin.
- **`setTargetHeatingCoolingState` unrecognized value** — added `default: return` guard in the mode switch to prevent publishing an MQTT message with `undefined` mode when an unexpected value is received from HomeKit.

### Removed
- Unused `exec`, `path` and `scriptPath` imports from `index.js` (leftover from original Bluetooth-direct implementation)

## [2.1.3] - 2026-03-07

### Fixed
- **`postinstall` auto-restarts `mqtt_handler.service`** — no manual restart needed after plugin update via Homebridge UI.

## [2.1.2] - 2026-03-07

### Fixed
- **`process.chdir(__dirname)`** in `mqtt_handler.js` — prevents `getcwd() failed` crash after plugin update via Homebridge UI (when npm replaces the plugin directory, the running process loses its working directory).

### Docs
- README: Bluetooth rfkill troubleshooting (adapter DOWN after reboot)
- README: mqtt_handler restart guide after plugin update

## [2.1.1] - 2026-03-07

### Fixed
- **`postinstall` restored** — automatically runs `chmod +x eq3.exp` after install/update using `__dirname` (safe, no hardcoded paths). No more manual permission fix after updates.

### Added
- **`.npmignore`** — test files excluded from npm package.

## [2.1.0] - 2026-03-07

### Fixed
- **setup.js removed** — caused installation failure (`ENOENT`) on non-standard Homebridge paths (e.g. Docker, `/var/lib/homebridge`). Fixes #2.
- **cacheDuration default corrected** — was 300 seconds in code, now matches UI schema default of 10 seconds.
- **Retry interval reduced** — from 3×5s (15s) to 2×3s (6s) to avoid HomeKit timeout on BLE failures.

### Security
- **MAC address validation** in `mqtt_handler.js` — input is now validated against `/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/` before being passed to shell exec. Prevents command injection via malicious MQTT messages.

### Added
- **13 Jest tests** covering `validateMac` and `retryCommand` behaviour.
- **Troubleshooting section in README** — Mosquitto install on Raspberry Pi Bookworm (no PPA needed), eq3.exp permissions, cache notes.

### Changed
- `mqtt_handler.js` now exports `validateMac` and `retryCommand` for testability; MQTT connection wrapped in `require.main === module` guard.
- README: Mosquitto install simplified (removed deprecated PPA instructions, Debian Bookworm ships Mosquitto 2.x natively).

## [2.0.3] - Previous release

- MQTT-based architecture for EQ3 Bluetooth thermostat control
- Homebridge UI configuration support
