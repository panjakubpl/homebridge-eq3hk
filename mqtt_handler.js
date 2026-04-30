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

// Single-slot serial queue. EQ3 Bluetooth adapter cannot serve concurrent GATT
// connections — overlapping eq3.exp processes saturate it. Polling jobs are
// dropped while another job is in flight; user-initiated set jobs replace any
// queued slot so the latest input wins.
let inFlight = false;
let queued = null;

function _resetQueue() {
  inFlight = false;
  queued = null;
}

function enqueueRequest(job) {
  if (job.priority === 'low' && (inFlight || queued)) {
    return false;
  }
  queued = job;
  _processNext();
  return true;
}

function _processNext() {
  if (inFlight || !queued) return;
  inFlight = true;
  const job = queued;
  queued = null;
  retryCommand(job.command, MAX_RETRIES, (error, stdout, stderr) => {
    try {
      job.onDone(error, stdout, stderr);
    } finally {
      inFlight = false;
      _processNext();
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
    let request;
    try {
      request = JSON.parse(message.toString());
    } catch (e) {
      console.error('Invalid JSON in MQTT message:', e.message);
      return;
    }

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
      const accepted = enqueueRequest({
        command: `${scriptPath} ${request.macAddress} status`,
        priority: 'low',
        onDone: (error, stdout) => {
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
        }
      });
      if (!accepted) {
        console.log('Dropped getTemperature — BLE busy');
      }
    } else if (request.type === 'setTemperature') {
      enqueueRequest({
        command: `${scriptPath} ${request.macAddress} temp ${request.value}`,
        priority: 'high',
        onDone: (error) => {
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
        }
      });
    } else if (request.type === 'setMode') {
      enqueueRequest({
        command: `${scriptPath} ${request.macAddress} ${request.mode}`,
        priority: 'high',
        onDone: (error) => {
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
        }
      });
    }
  });
}

module.exports = { validateMac, retryCommand, enqueueRequest, _resetQueue };
