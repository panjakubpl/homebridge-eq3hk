const mqtt = require('mqtt');
const { exec } = require('child_process');
const path = require('path');

process.chdir(__dirname);

const scriptPath = path.join(__dirname, 'eq3.exp');

const MAX_RETRIES = 2;
const RETRY_INTERVAL = 3000; // 3 seconds

function validateMac(mac) {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac);
}

function retryCommand(command, retries, callback) {
  exec(command, (error, stdout, stderr) => {
    if (error && retries > 0) {
      console.log(`Command failed, retrying in ${RETRY_INTERVAL / 1000} seconds...`, error);
      setTimeout(() => retryCommand(command, retries - 1, callback), RETRY_INTERVAL);
    } else {
      callback(error, stdout, stderr);
    }
  });
}

if (require.main === module) {
  const client = mqtt.connect('mqtt://localhost');

  client.on('connect', () => {
    console.log('MQTT connected and subscribed to homebridge/eq3hk/request');
    client.subscribe('homebridge/eq3hk/request');
  });

  client.on('message', (topic, message) => {
    console.log('Received message:', message.toString());
    const request = JSON.parse(message.toString());

    if (!validateMac(request.macAddress)) {
      console.error('Invalid MAC address:', request.macAddress);
      client.publish('homebridge/eq3hk/response', JSON.stringify({
        macAddress: request.macAddress,
        type: 'error',
        error: 'Invalid MAC address'
      }));
      return;
    }

    if (request.type === 'getTemperature') {
      retryCommand(`${scriptPath} ${request.macAddress} status`, MAX_RETRIES, (error, stdout) => {
        if (error) {
          console.error('Error executing getTemperature:', error);
          client.publish('homebridge/eq3hk/response', JSON.stringify({
            macAddress: request.macAddress,
            type: 'error',
            error: error.message
          }));
        } else {
          const match = stdout.match(/Temperature:\s*([\d\.]+)°C/);
          if (match) {
            const temperature = parseFloat(match[1]);
            console.log(`Current temperature for MAC address ${request.macAddress}: ${temperature}°C`);
            client.publish('homebridge/eq3hk/response', JSON.stringify({
              macAddress: request.macAddress,
              type: 'temperature',
              value: temperature
            }));
          } else {
            console.error('Temperature match not found in stdout:', stdout);
            client.publish('homebridge/eq3hk/response', JSON.stringify({
              macAddress: request.macAddress,
              type: 'error',
              error: 'Temperature match not found'
            }));
          }
        }
      });
    } else if (request.type === 'setTemperature') {
      retryCommand(`${scriptPath} ${request.macAddress} temp ${request.value}`, MAX_RETRIES, (error) => {
        if (error) {
          console.error('Error executing setTemperature:', error);
          client.publish('homebridge/eq3hk/response', JSON.stringify({
            macAddress: request.macAddress,
            type: 'error',
            error: error.message
          }));
        } else {
          client.publish('homebridge/eq3hk/response', JSON.stringify({
            macAddress: request.macAddress,
            type: 'set'
          }));
        }
      });
    } else if (request.type === 'setMode') {
      retryCommand(`${scriptPath} ${request.macAddress} ${request.mode}`, MAX_RETRIES, (error) => {
        if (error) {
          console.error('Error executing setMode:', error);
          client.publish('homebridge/eq3hk/response', JSON.stringify({
            macAddress: request.macAddress,
            type: 'error',
            error: error.message
          }));
        } else {
          client.publish('homebridge/eq3hk/response', JSON.stringify({
            macAddress: request.macAddress,
            type: 'set'
          }));
        }
      });
    }
  });
}

module.exports = { validateMac, retryCommand };
