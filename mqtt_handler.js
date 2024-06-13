const mqtt = require('mqtt');
const { exec } = require('child_process');
const client = mqtt.connect('mqtt://localhost');
const path = require('path');
const scriptPath = path.join(__dirname, 'eq3.exp');

const MAX_RETRIES = 3;
const RETRY_INTERVAL = 5000; // 5 seconds

client.on('connect', () => {
  console.log('MQTT connected and subscribed to homebridge/eq3hk/request');
  client.subscribe('homebridge/eq3hk/request');
});

client.on('message', (topic, message) => {
  console.log('Received message:', message.toString());
  const request = JSON.parse(message.toString());

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
    retryCommand(`${scriptPath} ${request.macAddress} temp ${request.value}`, MAX_RETRIES, (error, stdout) => {
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
    retryCommand(`${scriptPath} ${request.macAddress} ${request.mode}`, MAX_RETRIES, (error, stdout) => {
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
