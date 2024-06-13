# Homebridge Eqiva eQ-3 (EQ3) Bluetooth Thermostat Plugin

This plugin allows you to control Eqiva eQ-3 (EQ3) Bluetooth thermostats via Homebridge.

## Prerequisites

Before installing this plugin, ensure you have the `expect` tool installed:

```bash
sudo apt install expect
```

## Installation

Install the plugin using:
```bash
npm i homebridge-eq3hk
```

After installing the plugin, you need to grant execution permissions to the eq3.exp file. This can be done using the chmod command in the terminal. Run the following command:

```sudo chmod +x /var/lib/homebridge/node_modules/homebridge-eq3hk/eq3.exp```

You can also check who is the owner of the file, and ensure that the user under which Homebridge operates has the appropriate permissions. To check the owner and group of the file, use:

```ls -l /var/lib/homebridge/node_modules/homebridge-eq3hk/eq3.exp```

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

## Acknowledgements

This plugin utilizes the [eQ-3 radiator thermostat repository](https://github.com/Heckie75/eQ-3-radiator-thermostat/tree/master), specifically the `eq3.exp` file. Many thanks to the author, Heckie75, for their valuable contribution.
