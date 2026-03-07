# Changelog

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
