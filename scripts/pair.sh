#!/usr/bin/env bash
# pair.sh — guided re-pairing helper for eQ-3 CC-RT-BLE thermostats.
# Required after firmware 1.46+ OTA update or BlueZ bond-store loss.
# See docs/2026-04-30-bluez-firmware-bond-required.md for background.

set -u

MAC="${1:-}"
if [[ -z "$MAC" ]]; then
  echo "Usage: sudo $0 <thermostat-mac>" >&2
  echo "Example: sudo $0 00:1A:22:12:62:A9" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root (uses bluetoothctl, systemctl)." >&2
  exit 1
fi

if ! [[ "$MAC" =~ ^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$ ]]; then
  echo "Invalid MAC: $MAC" >&2
  exit 1
fi

echo
echo "=== eQ-3 CC-RT-BLE re-pairing helper for $MAC ==="
echo

echo "Stopping mqtt_handler so it does not interfere with the pair flow..."
systemctl stop mqtt_handler 2>/dev/null || true

echo "Restarting bluetooth.service for a clean stack..."
systemctl restart bluetooth
sleep 3

echo
echo ">>> ACTION REQUIRED: walk to the thermostat now."
echo ">>> Long-press the wheel/button on the thermostat for ~3 seconds."
echo ">>> Wait for the LCD to show 'PAIr' followed by a 6-digit PIN."
echo ">>> Press <Enter> here only AFTER the PIN is visible on the LCD."
read -r

echo "Triggering scan to discover the thermostat..."
timeout 10 bluetoothctl --timeout 8 scan on >/dev/null 2>&1 || true
sleep 1

echo "Initiating pair (you will be prompted for the PIN shown on the LCD)..."
echo
bluetoothctl <<EOF
power on
agent KeyboardOnly
default-agent
remove $MAC
scan on
pair $MAC
trust $MAC
disconnect $MAC
quit
EOF

echo
echo "=== Verifying bond state ==="
sleep 2
bluetoothctl info "$MAC" | grep -E 'Name|Paired|Bonded|Trusted'

if bluetoothctl info "$MAC" 2>/dev/null | grep -q 'Bonded: yes'; then
  echo
  echo "✅ Bonded successfully. Restarting mqtt_handler..."
  systemctl start mqtt_handler
  sleep 2
  echo
  echo "Tail of mqtt_handler log (Ctrl-C to stop):"
  journalctl -u mqtt_handler -f --since "5 seconds ago"
else
  echo
  echo "❌ Pairing did not complete. Common causes:"
  echo "  - Thermostat was not in pair mode when 'pair' was issued (LCD must show PIN)"
  echo "  - Wrong PIN typed"
  echo "  - Thermostat went back to sleep before pair completed (re-press wheel and retry)"
  echo
  echo "Re-run this script and act faster — the pair window is ~30 s after PIN appears."
  exit 1
fi
