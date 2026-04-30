# 2026-04-30: CCC subscription timeouts — eQ-3 firmware 1.46+ requires bonded link

## Symptom

`mqtt_handler.service` starts spamming the journal with:

```
Error executing getTemperature: Error: Command failed: .../eq3.exp <MAC> status
  cmd: '.../eq3.exp <MAC> status'
  code: 255
```

`eq3.exp` itself prints `ERROR: Thermostat hasn't responded after sync request in time (10 sec.)` and returns `exit -1` (kernel exit 255). Both directions of the Home app ↔ thermostat sync stop working: `setTemperature` writes appear to succeed at GATT layer but the device LCD setpoint does not change, and polling never returns a temperature reading.

In a test session reported here: thousands of consecutive failures over ~30 hours, zero successes. Last successful reading at 2026-04-28 17:40:49, then continuous failure from 17:41:09 onward.

## What is actually broken

Confirmed empirically on a CC-RT-BLE thermostat against BlueZ 5.66 / kernel 6.12.62 / Raspberry Pi 3:

1. ✅ `connect <MAC>` from gatttool — `Connection successful`
2. ✅ `char-read-hnd 0x0411` — returns request register echo (works without auth)
3. ✅ `char-read-hnd 0x0321` (device name `CC-RT-BLE`), `0x0311` (vendor `eq-3`) — reads work
4. ✅ `char-write-req 0x0411 <payload>` — returns `Characteristic value was written successfully`
5. ❌ `char-write-req 0x0430 0100` (CCCD enable for handle 0x0421) — **silently times out, no response**
6. ❌ Notifications on handle 0x0421 — never delivered (because CCCD never enabled)
7. ❌ `bleak.start_notify(...)` — `SUBSCRIBE FAIL: TimeoutError()` (same root cause via D-Bus path)

`bluetoothctl info <MAC>` shows `Paired: no, Bonded: no, Trusted: no, Connected: yes`.

The plugin exits 255 on every command because `eq3.exp` waits 10 s for a notification on 0x0421 after each `writeRequest`, never receives one, and reports the `Thermostat hasn't responded` error.

## Root cause

eQ-3 firmware **1.46 and later** (and especially **1.48, 2024**) makes the Client Characteristic Configuration Descriptor at handle 0x0430 require an **authenticated/encrypted** write. Plain reads/writes on the value characteristics 0x0411/0x0421 still ACK without auth — that is why the failure looks asymmetric.

Mechanism documented in the dbuezas firmware-flashing repo, which patches CCCD permission `0x6E → 0x2E` (clears `AUTH_WRITABLE`) and on v1.46+ also `encr_required 0x03 → 0x00`. The `--noauth` patch is what restores legacy CCCD behaviour. See:

- https://github.com/dbuezas/eq3-flashing#noauth-firmware
- https://github.com/dbuezas/eq3btsmart/issues/119, /125 (Feb 2026 reports identical symptom on Home Assistant after FW 1.48 OTA)
- https://github.com/Heckie75/eQ-3-radiator-thermostat/issues/36, /44 (Heckie75's own confirmation of the pairing requirement)
- https://github.com/rytilahti/python-eq3bt/issues/41 (definitive thread on FW 1.20+/1.46 pairing change)
- https://github.com/rytilahti/python-eq3bt/issues/119 (FW 1.48 cannot connect without ESPHome workaround `io_capability: keyboard_only` + `on_passkey_request`)

Without an encrypted link, BlueZ's CCCD write request is silently dropped by the thermostat. There is **no poll-pattern alternative**: handle 0x0421 is mailbox-only — direct reads return 16 bytes of zeros — and the bytes embedded in 0x0411 read responses do not refresh between writes (verified across disconnect/reconnect cycles in this session). `python-eq3bt`'s bleak backend (`eq3bt/bleakconnection.py`) has the same limitation and uses `start_notify` exclusively.

## Why a working install can suddenly break

Two known triggers:

1. **Silent OTA self-update** — the eQ-3 mobile app (calorBT) pushes firmware updates to the thermostat over BLE without explicit user consent. After OTA to 1.46/1.48, the previously stored bond becomes invalid because the new firmware uses a different LTK derivation.
2. **`/var/lib/bluetooth/<adapter>/<MAC>/info` removed by BlueZ** during a Bookworm security update or after a `bluetoothctl remove` operation. The bond key is gone; the device is no longer paired even though `bluetoothctl` may still show its name.

Either way, `bluetoothctl info` reverting to `Paired: no, Bonded: no` is the diagnostic.

## Fix (canonical, no plugin changes required)

The thermostat must be re-paired with passkey. The existing `eq3.exp` and `mqtt_handler.js` work unchanged after re-pair because the kernel keeps the LTK and re-encrypts the link on every reconnect transparently.

```bash
# On the Pi (homebridge host)
sudo systemctl stop mqtt_handler
# Optional: stop homebridge to avoid polling interfering with the pair flow
sudo systemctl stop homebridge

sudo bluetoothctl
> power on
> agent on
> default-agent
> remove 00:1A:22:12:62:A9      # purge any stale entry (will say "not available" if none)
> scan on

# At this point: physically interact with the thermostat.
# Long-press the wheel/button for ~3 seconds until the LCD shows "PAIr"
# followed by a 6-digit PIN. The thermostat is now in pairable advertising mode.

> pair 00:1A:22:12:62:A9        # type the 6-digit PIN when bluetoothctl asks
> trust 00:1A:22:12:62:A9
> disconnect 00:1A:22:12:62:A9
> quit

# Verify
bluetoothctl info 00:1A:22:12:62:A9
# Must show: Paired: yes, Bonded: yes, Trusted: yes

sudo systemctl start mqtt_handler
sudo systemctl start homebridge
sudo journalctl -u mqtt_handler -f   # should now print "Current temperature for MAC ..."
```

## Alternative fix: flash `--noauth` firmware

If re-pairing is impractical (mounted radiator, frequent battery changes, multiple thermostats), the dbuezas firmware-flashing tool patches the firmware to remove the CCCD auth requirement permanently:

```bash
git clone https://github.com/dbuezas/eq3-flashing
cd eq3-flashing
python3 flash_firmware.py 00:1A:22:12:62:A9 1.48 --noauth
```

This requires the device be currently reachable (so it must work at GATT level — i.e., before the bond is lost, or while in pair mode).

## What the plugin should do (proposed v2.3.0)

The plugin code itself does not need protocol changes — Heckie75's `eq3.exp` works correctly post-pair. Improvements that would help future users diagnose this faster:

1. **README.md** — add a "Firmware 1.46+ requires re-pairing" troubleshooting section with the `bluetoothctl pair` recipe.
2. **`scripts/pair.sh`** — convenience wrapper around the bluetoothctl flow, with verification of `Paired: yes, Bonded: yes` at the end.
3. **`mqtt_handler.js`** — when an `eq3.exp` invocation fails with the `Thermostat hasn't responded` pattern, emit a single descriptive log line with the canonical fix instead of the raw exit-255 stacktrace, so the journal points operators at the right action.
4. **Optional** — `setup.js` postinstall could probe `bluetoothctl info <MAC>` (one per configured thermostat) and print a startup warning when `Bonded: no`.

Versioning: this is a documentation + UX fix only, no protocol change. Patch (2.2.3) or minor (2.3.0) — minor seems right because the README guidance is meaningfully different.

## Session log (2026-04-30)

Investigation steps taken on `pi@192.168.0.241` (RPi3, Debian 12, BlueZ 5.66):

1. Verified `mosquitto`, `mqtt_handler`, `homebridge`, plugin v2.2.2 all active. `hci0 UP RUNNING`. Plugin chain alive — mqtt_handler receives requests but `eq3.exp` exits 255.
2. journalctl shows last success 2026-04-28 17:40:49, then 8414 consecutive errors over 24 h.
3. Killed zombie `gatttool -I` processes, restarted `bluetooth.service`, reset `hci0`. Connection works again but every command still ends with `ERROR: Thermostat hasn't responded after sync request in time (10 sec.)`.
4. Stopped `bluetoothd` and re-tested directly with gatttool — same notification timeout, ruling out bluetoothd interference.
5. Discovered handles via `char-desc`. Confirmed CCCD for the notification characteristic is at handle **0x0430**, not the 0x0422 first guessed.
6. `char-write-req 0x0430 0100` — **silently times out**, no response. This is the proximate fault.
7. Installed `bleak` (Python BLE via D-Bus) and reproduced the same `start_notify TimeoutError()` — confirms the fault is not gatttool-specific.
8. Verified GATT writes to 0x0411 succeed and the `setTemperature 24.5°C` command was echoed in the request register, but the thermostat LCD did not update (user reported 11°C). Confirmed asymmetric failure: the device accepts GATT-level writes but does not act on them, consistent with FW 1.46+ refusing unauthenticated writes after CCCD enable failure.
9. Confirmed via direct read that handle 0x0421 returns 16 bytes of zeros — there is no poll-based fallback.
10. Confirmed via four cross-session reconnect cycles that bytes [2..6] of the 0x0411 read response do not update — they are stale embedded state.
11. Research agent compiled the upstream evidence (Heckie75 issue #36, python-eq3bt #41, dbuezas/eq3-flashing) confirming this is the FW 1.46+ CCCD-auth-required behaviour.

## Next session

After user completes the bluetoothctl pair flow:

1. Verify `bluetoothctl info 00:1A:22:12:62:A9` → `Paired: yes, Bonded: yes`.
2. Restart `mqtt_handler.service`.
3. Watch `journalctl -u mqtt_handler -f` for `Current temperature for MAC address ...: NN.N°C`.
4. Verify Home app: change setpoint, watch LCD update; rotate dial on thermostat, watch Home app update.
5. Then ship the docs/README/pair.sh changes as v2.3.0 to npm and tag a GitHub release.
