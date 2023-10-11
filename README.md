# Homebridge EQ3 Bluetooth Thermostat Plugin

This plugin allows you to control EQ3 Bluetooth thermostats via Homebridge.

## Prerequisites

Before installing this plugin, ensure you have the `expect` tool installed:

```bash
sudo apt install expect
```

## Installation

After installing the plugin, you need to pair your EQ3 Bluetooth thermostat with your system:

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

- `"cacheDuration": 10` represents the time (in seconds) the plugin will store the last read value. In this example, the last value is cached for 10 seconds. This parameter is optional. If you skip it, the default is set to 300 seconds (5 minutes).

## Note

Due to the nature of Bluetooth connections, you might occasionally see a "No Response" status for the device in the Home app. However, with background refreshing, this should not occur too frequently.

## Acknowledgements

This plugin utilizes the [eQ-3 radiator thermostat repository](https://github.com/Heckie75/eQ-3-radiator-thermostat/tree/master), specifically the `eq3.exp` file. Many thanks to the author, Heckie75, for their valuable contribution.
