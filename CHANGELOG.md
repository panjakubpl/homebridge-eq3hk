# Changelog

## [2.5.0] - 2026-05-23

### Added
- **One-shot installer (`scripts/install.sh`)** — collapses the historic six-step manual setup (apt prerequisites, npm install, bluetoothctl pair, hand-written systemd unit) into a single bash command. Idempotent: every step detects existing state and skips when nothing's needed. Flags: `--dry-run` (preview every action without changes), `--mac` (skip interactive prompt), `--skip-pair` (already bonded), `--yes` (unattended), `--help`. Supports `NO_COLOR`, non-tty environments, and is sourced by the test suite via a `BASH_SOURCE` guard so individual functions are unit-testable.
- **README Quick Install section** at the top of the readme — single command for new users; the historic six-step procedure is preserved below under "Manual Install (advanced)" for users on non-Debian hosts or with unusual layouts.
- **42-assertion bash test suite (`tests/install.test.sh`)** — covers `validate_mac` (including shell-injection attempts), `parse_args` (including the H1 regression: `--mac --some-flag` must reject the next flag as a value), `usage`/`--help`/`-h`, unknown-flag handling, dry-run banner and no-`→ sudo` execution guarantee, and `render_systemd_unit` smoke. Zero dependencies (no bats, no jest); plain bash with assert helpers.
- **Senior code-review pass folded in before merge** — HIGH (3), MEDIUM (5) and select LOW findings addressed: parser refuses flag-as-value for `--mac`, existing systemd unit ExecStart is compared and rewritten when stale, cascade failures in apt and systemd halt the run, `User=root` resolution prompts for confirmation, `--dry-run` previews the full systemd unit body, summary loudly warns when MAC is a placeholder, mosquitto unit-file existence is checked before `is-enabled`/`is-active`, and the test suite was extended with regression coverage for the parser edge cases.

### Notes
- Installer is opt-in; existing installations work unchanged. Users on Homebridge UI plugin manager can run the installer from `/var/lib/homebridge/node_modules/homebridge-eq3hk/scripts/install.sh`. Users who installed globally can run from `/usr/lib/node_modules/homebridge-eq3hk/scripts/install.sh`. Both invocations behave identically — the installer auto-detects which path actually exists.

## [2.4.0] - 2026-05-22

### Fixed
- **Thermostat silently turns itself back on after being set OFF** — root cause was the iOS HomeKit hub re-syncing both `TargetHeatingCoolingState` and `TargetTemperature` together a few milliseconds apart whenever it reconciled accessory state (after Homebridge reconnect, scheduled syncs, automations, app foreground, etc.). The hub re-pushes its remembered target temperature (e.g. 23.5°C) right after the user's OFF command. eQ-3 valves treat `TargetTemperature` as the on/off state itself (4.5°C ≡ off), so the second message immediately overrode the OFF state and the valve warmed back up.

### Added
- **OFF-intent window** in `index.js` — `setTargetHeatingCoolingState(OFF)` now also flips `cachedTemperature` to 4.5°C immediately (so HomeKit's heating state characteristic returns OFF without waiting for the next polling response) and opens a 10-second `offIntentUntil` window during which any `setTargetTemperature` push is dropped before reaching MQTT. The window is cleared by an explicit `setTargetHeatingCoolingState(HEAT|COOL|AUTO)`, so user-initiated mode transitions back to ON keep working normally.
- 7 new Jest tests (`OFF-intent window` describe block in `index.test.js`) covering window timing, optimistic cache flip, MQTT suppression, cache invariance, post-window normal behaviour, and HEAT-clears-window transitions.

### Production verification
Live test on a production install across a full overnight cycle (Raspberry Pi 3 reboots daily at 03:29) demonstrated the fix end-to-end.

**Before the fix — 2026-05-21 07:00:03**, `mqtt_handler` received both messages within the same second and the valve flipped back to 23.5°C:
```
07:00:03  Received message: {"type":"setMode","mode":"off"}
07:00:03  Received message: {"type":"setTemperature","value":23.5}   ← bug: overrode OFF
07:00:10  Current temperature: 23.5°C (Heating)
```

**After the fix — 2026-05-22 07:00:02**, the hub still pushed the same pair, but `index.js` dropped the temperature write inside the OFF-intent window and the valve stayed at 4.5°C:
```
07:00:02  [Kaloryfer] Ignoring setTargetTemperature(23.5) — within OFF-intent window (HomeKit hub re-sync push)
07:00:03  [Kaloryfer] Set command acknowledged
07:00:00 → 07:15:00  Current temperature: 4.5°C × 56 polls (stable, no flip)
```

### Required action for existing users
If your Home app shows the thermostat heating again shortly after you've set it to OFF — usually most visible the morning after a Raspberry Pi reboot — update to 2.4.0. No re-pair or config change needed; the postinstall hook restarts `mqtt_handler.service` automatically, and Homebridge picks up the new code on the next restart.

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
