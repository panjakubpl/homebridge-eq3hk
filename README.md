### Homebridge Eqiva eQ-3 (EQ3) Bluetooth Thermostat Plugin

This plugin allows you to control Eqiva eQ-3 (EQ3) Bluetooth thermostats via Homebridge.

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
   sudo apt-add-repository ppa:mosquitto-dev/mosquitto-ppa
   sudo apt-get update
   sudo apt-get install mosquitto mosquitto-clients
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

Check the owner of the file and ensure the user running Homebridge has the appropriate permissions:

```bash
ls -l /path/to/homebridge-eq3hk/eq3.exp
```

### Step 5: Configuration via Homebridge UI

Configuration is now done via the Homebridge UI, allowing you to add and configure multiple thermostats easily.

Example configuration via the Homebridge UI:

- **Name:** Living Room Thermostat
- **MAC Address:** XX:XX:XX:XX:XX:XX

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

   Replace `/path/to/homebridge-eq3hk` with the actual path to your plugin installation directory.

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

## Acknowledgements

This plugin utilizes the [eQ-3 radiator thermostat repository](https://github.com/Heckie75/eQ-3-radiator-thermostat/tree/master), specifically the `eq3.exp` file. Many thanks to the author, Heckie75, for their valuable contribution.
