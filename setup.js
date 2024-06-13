const fs = require('fs');
const path = require('path');

const configPath = path.join(process.env.HOME, '.homebridge', 'config.json');
const defaultConfig = `{
    "accessory": "EQ3Thermostat",
    "name": "Office Thermostat",
    "macAddress": "XX:XX:XX:XX:XX:XX",
	"cacheDuration": 10
}`;

if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, defaultConfig);
    console.log("Default configuration created. Please edit ~/.homebridge/config.json with your settings.");
} else {
    console.log("Configuration file already exists. Please edit ~/.homebridge/config.json with your settings if necessary.");
}
