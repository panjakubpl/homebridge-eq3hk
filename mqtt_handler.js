const mqtt = require('mqtt');
const { exec } = require('child_process');
const path = require('path');

process.chdir(__dirname);

const scriptPath = path.join(__dirname, 'eq3.exp');

const MAX_RETRIES = 2;
const RETRY_INTERVAL = 3000; // 3 seconds
const SET_RETRY_BACKOFF_MS = 10000;
const RETRY_FOR_MS_MAX = 3600000;

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

const BLUETOOTH_HINT = 'bluetooth.service is not running, so the kernel has no bond keys for the thermostat ' +
  'and BLE connections fail after a reboot. Fix: sudo systemctl enable --now bluetooth';

function checkBluetooth(callback) {
  exec('systemctl is-active bluetooth', (error) => callback(!error));
}

// The hint is logged once per failure streak, not on every 10 s poll.
let bluetoothHintShown = false;

function noteBleSuccess() {
  bluetoothHintShown = false;
}

function logBleFailure(label, error) {
  console.error(`Error executing ${label}:`, error);
  if (bluetoothHintShown) return;
  checkBluetooth((active) => {
    if (active || bluetoothHintShown) return;
    bluetoothHintShown = true;
    console.error(BLUETOOTH_HINT);
  });
}

// Serial queue. EQ3 Bluetooth adapter cannot serve concurrent GATT connections.
// Set jobs are keyed (e.g. mac:temp / mac:mode); same key keeps latest only.
// Polls are dropped while any set job is pending or in flight.
let inFlight = false;
let inFlightEntry = null;
let pendingHigh = new Map();
let queuedLow = null;
let wakeTimer = null;

function validRetryForMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (ms <= 0 || ms > RETRY_FOR_MS_MAX) return null;
  return ms;
}

function hasActiveHighPending() {
  for (const entry of pendingHigh.values()) {
    if (!entry.superseded) return true;
  }
  return false;
}

function purgeSuperseded() {
  for (const [key, entry] of pendingHigh) {
    if (entry.superseded) pendingHigh.delete(key);
  }
}

function _clearWakeTimer() {
  if (wakeTimer != null) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}

function _scheduleWake() {
  _clearWakeTimer();
  if (inFlight) return;
  const now = Date.now();
  let earliest = Infinity;
  for (const entry of pendingHigh.values()) {
    if (entry.superseded) continue;
    if (entry.notBefore > now && entry.notBefore < earliest) {
      earliest = entry.notBefore;
    }
  }
  if (earliest < Infinity) {
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      _processNext();
    }, earliest - now);
  }
}

function _resetQueue() {
  inFlight = false;
  inFlightEntry = null;
  pendingHigh = new Map();
  queuedLow = null;
  _clearWakeTimer();
}

function _highEntryFromJob(job) {
  const receivedAt = Date.now();
  const retryForMs = validRetryForMs(job.retryForMs);
  return {
    job,
    key: job.key || 'set',
    receivedAt,
    retryForMs,
    deadline: retryForMs ? receivedAt + retryForMs : null,
    notBefore: 0,
    superseded: false,
  };
}

function _finishJob(job, error, stdout, stderr) {
  if (job.debug) {
    console.log(`[debug] ${job.command} -> ${error ? `FAILED (${error.message})` : 'ok'}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  job.onDone(error, stdout, stderr);
}

function _runJob(entry) {
  inFlight = true;
  inFlightEntry = entry;
  pendingHigh.delete(entry.key);
  const { job } = entry;
  retryCommand(job.command, MAX_RETRIES, (error, stdout, stderr) => {
  try {
    if (entry.superseded) {
      return;
    }
    if (!error) {
      _finishJob(job, null, stdout, stderr);
      return;
    }
    if (!entry.retryForMs) {
      _finishJob(job, error, stdout, stderr);
      return;
    }
    const now = Date.now();
    if (now >= entry.deadline) {
      const minutes = Math.round(entry.retryForMs / 60000);
      console.log(`gave up ${job.command} after ${minutes} min`);
      const err = error;
      err.gaveUpAfterMs = entry.retryForMs;
      _finishJob(job, err, stdout, stderr);
      return;
    }
    entry.notBefore = now + SET_RETRY_BACKOFF_MS;
    pendingHigh.set(entry.key, entry);
    console.log(`retrying ${job.command} in ${SET_RETRY_BACKOFF_MS / 1000} s`);
  } finally {
    inFlight = false;
    inFlightEntry = null;
    purgeSuperseded();
    _processNext();
  }
  });
}

function _runLowJob(job) {
  inFlight = true;
  inFlightEntry = null;
  queuedLow = null;
  retryCommand(job.command, MAX_RETRIES, (error, stdout, stderr) => {
    try {
      _finishJob(job, error, stdout, stderr);
    } finally {
      inFlight = false;
      _processNext();
    }
  });
}

function enqueueRequest(job) {
  if (job.priority === 'low') {
    if (inFlight || hasActiveHighPending() || queuedLow) {
      return false;
    }
    queuedLow = job;
    _processNext();
    return true;
  }

  const entry = _highEntryFromJob(job);
  const prev = pendingHigh.get(entry.key);
  if (prev) {
    prev.superseded = true;
  }
  if (inFlightEntry && inFlightEntry.key === entry.key) {
    inFlightEntry.superseded = true;
  }
  pendingHigh.set(entry.key, entry);
  _processNext();
  return true;
}

function _processNext() {
  if (inFlight) return;

  purgeSuperseded();
  const now = Date.now();
  for (const entry of pendingHigh.values()) {
    if (entry.superseded) continue;
    if (entry.notBefore <= now) {
      _runJob(entry);
      return;
    }
  }

  if (hasActiveHighPending()) {
    _scheduleWake();
    return;
  }

  if (queuedLow) {
    _runLowJob(queuedLow);
  }
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
        debug: request.debug === true,
        onDone: (error, stdout) => {
          if (error) {
            logBleFailure('getTemperature', error);
            client.publish('homebridge/eq3hk/response', JSON.stringify({
              macAddress: request.macAddress,
              type: 'error',
              error: error.message
            }));
          } else {
            noteBleSuccess();
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
      const setKey = `${request.macAddress}:temp`;
      enqueueRequest({
        command: `${scriptPath} ${request.macAddress} temp ${request.value}`,
        priority: 'high',
        key: setKey,
        retryForMs: request.retryForMs,
        debug: request.debug === true,
        onDone: (error) => {
          if (error) {
            logBleFailure('setTemperature', error);
            const payload = {
              macAddress: request.macAddress,
              type: 'error',
              request: 'setTemperature',
              error: error.message
            };
            if (error.gaveUpAfterMs) payload.gaveUpAfterMs = error.gaveUpAfterMs;
            client.publish('homebridge/eq3hk/response', JSON.stringify(payload));
          } else {
            noteBleSuccess();
            client.publish('homebridge/eq3hk/response', JSON.stringify({
              macAddress: request.macAddress,
              type: 'set',
              request: 'setTemperature'
            }));
          }
        }
      });
    } else if (request.type === 'setMode') {
      const setKey = `${request.macAddress}:mode`;
      enqueueRequest({
        command: `${scriptPath} ${request.macAddress} ${request.mode}`,
        priority: 'high',
        key: setKey,
        retryForMs: request.retryForMs,
        debug: request.debug === true,
        onDone: (error) => {
          if (error) {
            logBleFailure('setMode', error);
            const payload = {
              macAddress: request.macAddress,
              type: 'error',
              request: 'setMode',
              error: error.message
            };
            if (error.gaveUpAfterMs) payload.gaveUpAfterMs = error.gaveUpAfterMs;
            client.publish('homebridge/eq3hk/response', JSON.stringify(payload));
          } else {
            noteBleSuccess();
            client.publish('homebridge/eq3hk/response', JSON.stringify({
              macAddress: request.macAddress,
              type: 'set',
              request: 'setMode'
            }));
          }
        }
      });
    }
  });
}

module.exports = {
  validateMac, retryCommand, enqueueRequest, _resetQueue,
  checkBluetooth, logBleFailure, noteBleSuccess, BLUETOOTH_HINT,
  SET_RETRY_BACKOFF_MS,
};
