### Homebridge Eqiva eQ-3 (EQ3) Bluetooth Thermostat Plugin

This plugin allows you to control Eqiva eQ-3 (EQ3) Bluetooth thermostats via Homebridge.

## Homebridge v2.0 Compatibility

This plugin is compatible with both **Homebridge v1.6+** and **Homebridge v2.0**.

As of v2.2.0, the plugin uses the modern `onGet`/`onSet` async API instead of the deprecated callback-based `.on('get/set', ...)` handlers. No configuration changes are required — the update is fully backwards compatible.

**Required versions:**
- Homebridge: `^1.6.0 || ^2.0.0`
- Node.js: `^18.20.4 || ^20.15.1 || ^22 || ^24`

## Prerequisites

Before installing this plugin, ensure you have the `expect` tool installed:

```bash
sudo apt install expect
```

## Installation

### Step 1: Install the Plugin

Install the plugin using:

```bash
sudo npm install -g homebridge-eq3hk
```

### Step 2: Set Up MQTT

1. Install Mosquitto:
   ```bash
   sudo apt update
   sudo apt install mosquitto mosquitto-clients
   sudo systemctl start mosquitto
   sudo systemctl enable mosquitto
   ```

2. Verify Mosquitto is running:
   ```bash
   sudo systemctl status mosquitto
   ```

### Step 3: Pair Your Thermostat

1. Enter Bluetooth control:
   ```bash
   sudo bluetoothctl
   ```

2. Turn on the agent and start scanning:
   ```bash
   agent on
   scan on
   ```

3. Pair with the thermostat using its MAC address:
   ```bash
   pair XX:XX:XX:XX:XX:XX
   ```

4. Enter the pairing code displayed on the thermostat.

### Step 4: Grant Execution Permissions

Grant execution permissions to the `eq3.exp` file:

```bash
sudo chmod +x /path/to/homebridge-eq3hk/eq3.exp
```

Example:

```bash
sudo chmod +x /var/lib/homebridge/node_modules/homebridge-eq3hk/eq3.exp
```

Check the owner of the file and ensure the user running Homebridge has the appropriate permissions:

```bash
ls -l /var/lib/homebridge/node_modules/homebridge-eq3hk/eq3.exp
```

### Step 5: Configuration via Homebridge UI

Configuration is done via the Homebridge UI, allowing you to add and configure multiple thermostats easily.

<img width="813" alt="Screenshot 2024-09-04 at 23 25 18" src="https://github.com/user-attachments/assets/9a600f6a-a12c-4988-9f2e-9b9eef6ba298">

Example configuration via the Homebridge UI:

- **Name:** Living Room Thermostat
- **MAC Address:** XX:XX:XX:XX:XX:XX
- **Cache:** 10

To add multiple thermostats, simply repeat the process with different MAC addresses.

### Step 6: Running `mqtt_handler.js` on Startup

To ensure the `mqtt_handler.js` script runs automatically on Raspberry Pi startup, create a systemd service:

1. Create a service file:
   ```bash
   sudo nano /etc/systemd/system/mqtt_handler.service
   ```

2. Add the following configuration:
   ```ini
   [Unit]
   Description=MQTT Handler
   After=network.target

   [Service]
   ExecStart=/usr/bin/node /path/to/homebridge-eq3hk/mqtt_handler.js
   WorkingDirectory=/path/to/homebridge-eq3hk
   StandardOutput=inherit
   StandardError=inherit
   Restart=always
   User=pi

   [Install]
   WantedBy=multi-user.target
   ```

   Replace `/path/to/homebridge-eq3hk` with the actual path to your plugin installation directory (typically `/var/lib/homebridge/node_modules/homebridge-eq3hk`).

3. Save and close the file, then reload systemd:
   ```bash
   sudo systemctl daemon-reload
   ```

4. Start and enable the service:
   ```bash
   sudo systemctl start mqtt_handler.service
   sudo systemctl enable mqtt_handler.service
   ```

5. Check the status of the service:
   ```bash
   sudo systemctl status mqtt_handler.service
   ```

## Troubleshooting

### `Thermostat hasn't responded after sync request` — needs re-pair (firmware 1.46+)

**Symptom:** the plugin used to work, then suddenly every command times out with `ERROR: Thermostat hasn't responded after sync request in time (10 sec.)` and `mqtt_handler.service` logs continuous `Command failed ... code: 255`. Home app and the thermostat LCD stop syncing in both directions.

**Cause:** eQ-3 firmware 1.46+ (auto-pushed via the calorBT mobile app since 2024) requires an authenticated/encrypted BLE link before it accepts CCC writes (notification subscribe). The bond stored on the Pi may be lost after a Bookworm BlueZ security update or after the thermostat performs a silent OTA. Without a fresh bond, notifications never arrive and every command fails — even though connect/read/write at GATT level still work.

**Fix:** re-pair the thermostat with passkey. From v2.3.0 onward the plugin spawns `gatttool` with `--sec-level=medium` so it transparently re-encrypts the link on every reconnect once the bond exists.

Quick path — guided helper:

```bash
sudo /var/lib/homebridge/node_modules/homebridge-eq3hk/scripts/pair.sh XX:XX:XX:XX:XX:XX
```

Manual path:

```bash
sudo systemctl stop mqtt_handler
sudo bluetoothctl
power on
agent KeyboardOnly
default-agent
# Now physically long-press the thermostat wheel for ~3 seconds.
# Wait for the LCD to show "PAIr" and a 6-digit PIN.
pair XX:XX:XX:XX:XX:XX
# When prompted "Enter passkey (number in 0-999999):" type the 6 digits
# from the LCD without any dash, e.g. "739527" not "739-527".
trust XX:XX:XX:XX:XX:XX
disconnect XX:XX:XX:XX:XX:XX
quit

bluetoothctl info XX:XX:XX:XX:XX:XX | grep -E 'Paired|Bonded|Trusted'
# Must show: Paired: yes, Bonded: yes, Trusted: yes
sudo systemctl start mqtt_handler
```

The thermostat only stays in pairable advertising mode for ~30 seconds after the PIN appears — work fast, and re-press the wheel if `pair` says `Device not available`. See [`docs/2026-04-30-bluez-firmware-bond-required.md`](docs/2026-04-30-bluez-firmware-bond-required.md) for the full forensic write-up and links to upstream issue threads.

### Mosquitto installation issues (Raspberry Pi / Debian Bookworm)

Mosquitto 2.x is available directly from the default Debian Bookworm repositories — **no PPA required**. Just use:

```bash
sudo apt update && sudo apt install mosquitto mosquitto-clients
```

If you previously tried adding the Mosquitto PPA and encountered errors, you can safely ignore them and use the command above.

### Bluetooth adapter DOWN / `Connection failed` after reboot

If the BT adapter is blocked by rfkill, `eq3.exp` will fail silently. Check:

```bash
hciconfig hci0
```

If it shows `DOWN`, unblock and bring it up:

```bash
sudo bash -c 'echo 0 > /sys/class/rfkill/rfkill0/soft'
sudo hciconfig hci0 up
```

To make this permanent across reboots, add to `/etc/rc.local` (before `exit 0`):

```bash
/bin/bash -c "echo 0 > /sys/class/rfkill/rfkill0/soft" 2>/dev/null
hciconfig hci0 up 2>/dev/null
```

### `mqtt_handler` stops working after plugin update

After updating the plugin via Homebridge UI, restart the `mqtt_handler` service:

```bash
sudo systemctl restart mqtt_handler.service
```

### `eq3.exp` permission denied

Run:
```bash
sudo chmod +x /var/lib/homebridge/node_modules/homebridge-eq3hk/eq3.exp
```

### HomeKit shows wrong temperature

The plugin uses a cache (default: 10 seconds). If temperature seems stale, reduce the **Cache Duration** in plugin settings.

## Acknowledgements

This plugin utilizes the [eQ-3 radiator thermostat repository](https://github.com/Heckie75/eQ-3-radiator-thermostat/tree/master), specifically the `eq3.exp` file. Many thanks to the author, Heckie75, for their valuable contribution.
