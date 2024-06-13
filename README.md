### Homebridge Eqiva eQ-3 (EQ3) Bluetooth Thermostat Plugin

This plugin allows you to control Eqiva eQ-3 (EQ3) Bluetooth thermostats via Homebridge.

## Prerequisites

Before installing this plugin, ensure you have the `expect` tool installed:

```bash
sudo apt install expect
```

## Installation

### Install the Plugin

Install the plugin using:
```bash
sudo npm install --prefix /var/lib/homebridge https://github.com/panjakubpl/homebridge-eq3hk.git
```

Next, install dependencies:
```bash
cd /var/lib/homebridge/node_modules/homebridge-eq3hk
npm install
```

Next, install MQTT:
```bash
cd /var/lib/homebridge/node_modules/homebridge-eq3hk
sudo npm install mqtt
```

After installing the plugin, grant execution permissions to the eq3.exp file:
```bash
sudo chmod +x /var/lib/homebridge/node_modules/homebridge-eq3hk/eq3.exp
```

Check the owner of the file and ensure the user running Homebridge has the appropriate permissions:
```bash
ls -l /var/lib/homebridge/node_modules/homebridge-eq3hk/eq3.exp
```

### Install and Configure Mosquitto

1. Add the Mosquitto repository:
   ```sh
   sudo apt-add-repository ppa:mosquitto-dev/mosquitto-ppa
   sudo apt-get update
   ```

2. Install Mosquitto and Mosquitto clients:
   ```sh
   sudo apt-get install mosquitto mosquitto-clients
   ```

3. Start and enable Mosquitto:
   ```sh
   sudo systemctl start mosquitto
   sudo systemctl enable mosquitto
   ```

4. Check the status of Mosquitto to ensure it's running correctly:
   ```sh
   sudo systemctl status mosquitto
   ```

#### Testing MQTT

To test if MQTT is working correctly:

1. **Subscribe to a topic**:
   ```sh
   mosquitto_sub -h localhost -t homebridge/eq3hk/request
   ```

2. **Publish a test message**:
   ```sh
   mosquitto_pub -h localhost -t homebridge/eq3hk/request -m '{"type": "getTemperature", "macAddress": "XX:XX:XX:XX:XX:XX"}'
   ```

   or you can use
   ```sh
   mosquitto_sub -h localhost -t homebridge/eq3hk/response
   ```

In another terminal, you should see the message being received by the `mosquitto_sub` command. This verifies that MQTT is working as expected.

#### Additional Notes on MQTT

- Ensure the MQTT broker is running and accessible.
- Configure your MQTT client in the Homebridge plugin configuration to point to the correct MQTT broker.
- Monitor the MQTT topics for responses and errors to ensure reliable communication with your thermostats.

### Pair Your Thermostat

Next, you need to pair your Eqiva eQ-3 (EQ3) Bluetooth thermostat with your system:

1. Enter the Bluetooth control:
   ```bash
   sudo bluetoothctl
   ```

2. Turn on the agent and start scanning:
   ```bash
   agent on
   scan on
   ```

3. Look for a device in the list with the name `CC-RT-BLE`.

4. Once you've identified your thermostat, pair with it using its MAC address:
   ```bash
   pair XX:XX:XX:XX:XX:XX
   ```

5. On your thermostat device, press and hold the knob. A pairing code will appear on the thermostat's display. Enter this code into the terminal.

6. After successfully pairing, disconnect from the thermostat and exit the Bluetooth control:
   ```bash
   disconnect
   exit
   ```

## Configuration

Add the MAC address of your Bluetooth thermostat to the `config.json` file in your Homebridge setup. Here's an example configuration:

```json
"accessories": [
    {
        "accessory": "EQ3Thermostat",
        "name": "Living Room Thermostat",
        "macAddress": "XX:XX:XX:XX:XX:XX",
        "cacheDuration": 10
    }
]
```

- `"cacheDuration": 10` represents the time (in seconds) the plugin will store the last read value. In this example, the last value is cached for 10 seconds. This parameter is optional. If you skip it, the default is 300 seconds (5 minutes). This information is also visible in the Home app (accessory settings), Firmware section.

## Multiple Thermostats

You can add multiple thermostats to your configuration. However, with an increased number of thermostats, you might experience the "No Response" status more frequently in the Home app. This is due to the nature of Bluetooth connections and the fact that the app tries to refresh multiple devices simultaneously. Thanks to caching and background refreshing, this situation can be less bothersome.

## Running mqtt_handler.js on Startup

To ensure the `mqtt_handler.js` script runs automatically on Raspberry Pi startup, create a systemd service:

1. **Create a service file**:
   ```sh
   sudo nano /etc/systemd/system/mqtt_handler.service
   ```

2. **Add the following configuration**:
   ```ini
   [Unit]
   Description=MQTT Handler
   After=network.target

   [Service]
   ExecStart=/usr/bin/node /var/lib/homebridge/node_modules/homebridge-eq3hk/mqtt_handler.js
   WorkingDirectory=/var/lib/homebridge/node_modules/homebridge-eq3hk
   StandardOutput=inherit
   StandardError=inherit
   Restart=always
   User=pi

   [Install]
   WantedBy=multi-user.target
   ```

   Replace `pi` with the appropriate user if necessary.

3. **Save and close the file**:
   Save the changes and close the editor (Ctrl + X, Y, Enter).

4. **Reload systemd**:
   ```sh
   sudo systemctl daemon-reload
   ```

5. **Start and enable the service**:
   ```sh
   sudo systemctl start mqtt_handler.service
   sudo systemctl enable mqtt_handler.service
   ```

6. **Check the status of the service**:
   ```sh
   sudo systemctl status mqtt_handler.service
   ```

This setup will ensure that `mqtt_handler.js` runs automatically at startup.

## Acknowledgements

This plugin utilizes the [eQ-3 radiator thermostat repository](https://github.com/Heckie75/eQ-3-radiator-thermostat/tree/master), specifically the `eq3.exp` file. Many thanks to the author, Heckie75, for their valuable contribution.
