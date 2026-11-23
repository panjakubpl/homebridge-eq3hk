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

// Values reach a shell command line, so only accept what eq3.exp understands.
function validTemperature(value) {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= 4.5 && value <= 30 && Number.isInteger(value * 2);
}

const VALID_MODES = ['off', 'on', 'manual', 'auto'];

function validMode(mode) {
  return VALID_MODES.includes(mode);
}

// isCancelled (optional) is checked before each inner retry. When it returns
// true the remaining retries are skipped and callback gets the last error.
function retryCommand(command, retries, callback, isCancelled) {
  const cancelled = () => typeof isCancelled === 'function' && isCancelled();
  exec(command, (error, stdout, stderr) => {
    if (error && retries > 0 && !cancelled()) {
      console.log(`Command failed, retrying in ${RETRY_INTERVAL / 1000} seconds...`, error);
      setTimeout(() => {
        if (cancelled()) {
          callback(error, stdout, stderr);
          return;
        }
        retryCommand(command, retries - 1, callback, isCancelled);
      }, RETRY_INTERVAL);
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

// Monotonic clock for deadlines and wake timers; wall-clock jumps (NTP sync
// after boot) must not shorten or stretch the retry window.
function now() {
  return performance.now();
}

// Serial queue. EQ3 Bluetooth adapter cannot serve concurrent GATT connections.
// Set jobs are keyed (e.g. mac:temp / mac:mode); same key keeps latest only.
// Every set entry gets a sequence number on arrival (a replacement is a new
// user action and gets a new one; a retry keeps its own). An entry runs only
// when no older entry for the same MAC is still pending, so changes for one
// thermostat land in the order they were made. Different MACs are independent.
// Polls are dropped while any set job is pending or in flight.
let inFlight = false;
let inFlightEntry = null;
let pendingHigh = new Map();
let queuedLow = null;
let wakeTimer = null;
let nextSeq = 0;
let droppedPollLogged = false;

function validRetryForMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (ms <= 0 || ms > RETRY_FOR_MS_MAX) return null;
  return ms;
}

function macOfKey(key) {
  const i = key.lastIndexOf(':');
  return i > 0 ? key.slice(0, i) : key;
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
  const t = now();
  let earliest = Infinity;
  for (const entry of pendingHigh.values()) {
    if (entry.superseded) continue;
    if (entry.notBefore > t && entry.notBefore < earliest) {
      earliest = entry.notBefore;
    }
  }
  if (earliest < Infinity) {
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      _processNext();
    }, earliest - t);
  }
}

function _resetQueue() {
  inFlight = false;
  inFlightEntry = null;
  pendingHigh = new Map();
  queuedLow = null;
  nextSeq = 0;
  droppedPollLogged = false;
  _clearWakeTimer();
}

function _highEntryFromJob(job) {
  const receivedAt = now();
  const retryForMs = validRetryForMs(job.retryForMs);
  const key = job.key || 'set';
  return {
    job,
    key,
    mac: macOfKey(key),
    seq: nextSeq++,
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
      const t = now();
      const backoffWouldMissDeadline = t + SET_RETRY_BACKOFF_MS >= entry.deadline;
      if (t >= entry.deadline || backoffWouldMissDeadline) {
        const minutes = ((t - entry.receivedAt) / 60000).toFixed(1);
        const firstLine = String((error && error.message) || error).split('\n')[0];
        console.error(`gave up ${entry.key} (${job.command}) after ${minutes} min: ${firstLine}`);
        const err = error;
        err.gaveUpAfterMs = entry.retryForMs;
        _finishJob(job, err, stdout, stderr);
        return;
      }
      if (typeof job.onCycleFailed === 'function') {
        job.onCycleFailed(error, stdout, stderr);
      }
      entry.notBefore = t + SET_RETRY_BACKOFF_MS;
      pendingHigh.set(entry.key, entry);
      console.log(`retrying ${job.command} in ${SET_RETRY_BACKOFF_MS / 1000} s`);
    } finally {
      inFlight = false;
      inFlightEntry = null;
      purgeSuperseded();
      _processNext();
    }
  }, () => entry.superseded);
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
    pendingHigh.delete(entry.key);
  }
  if (inFlightEntry && inFlightEntry.key === entry.key) {
    inFlightEntry.superseded = true;
  }
  pendingHigh.set(entry.key, entry);
  _processNext();
  return true;
}

// Ready entry with the lowest sequence whose MAC has no older pending entry.
function _nextRunnable(t) {
  const oldestPerMac = new Map();
  for (const entry of pendingHigh.values()) {
    if (entry.superseded) continue;
    const oldest = oldestPerMac.get(entry.mac);
    if (!oldest || entry.seq < oldest.seq) oldestPerMac.set(entry.mac, entry);
  }
  let best = null;
  for (const entry of oldestPerMac.values()) {
    if (entry.notBefore > t) continue;
    if (!best || entry.seq < best.seq) best = entry;
  }
  return best;
}

function _processNext() {
  if (inFlight) return;

  purgeSuperseded();
  const entry = _nextRunnable(now());
  if (entry) {
    _runJob(entry);
    return;
  }

  if (hasActiveHighPending()) {
    _scheduleWake();
    return;
  }

  if (queuedLow) {
    _runLowJob(queuedLow);
    return;
  }

  // Queue is idle: the next busy streak may log a dropped poll again.
  droppedPollLogged = false;
}

function _logDroppedPoll() {
  if (droppedPollLogged) return;
  droppedPollLogged = true;
  console.log('Dropped getTemperature — BLE busy');
}

const RESPONSE_TOPIC = 'homebridge/eq3hk/response';

function _setJob(client, request, requestName, key, command) {
  const label = requestName;
  return {
    command,
    priority: 'high',
    key,
    retryForMs: request.retryForMs,
    debug: request.debug === true,
    onCycleFailed: (error) => logBleFailure(label, error),
    onDone: (error) => {
      if (error) {
        logBleFailure(label, error);
        const payload = {
          macAddress: request.macAddress,
          type: 'error',
          request: requestName,
          error: error.message
        };
        if (error.gaveUpAfterMs) payload.gaveUpAfterMs = error.gaveUpAfterMs;
        client.publish(RESPONSE_TOPIC, JSON.stringify(payload));
      } else {
        noteBleSuccess();
        client.publish(RESPONSE_TOPIC, JSON.stringify({
          macAddress: request.macAddress,
          type: 'set',
          request: requestName
        }));
      }
    }
  };
}

function _rejectSet(client, request, requestName, error, value) {
  console.error(`${error} in ${requestName} for ${request.macAddress}:`, JSON.stringify(value));
  client.publish(RESPONSE_TOPIC, JSON.stringify({
    macAddress: request.macAddress,
    type: 'error',
    request: requestName,
    error
  }));
}

function handleMessage(client, messageString) {
  console.log('Received message:', messageString);
  let request;
  try {
    request = JSON.parse(messageString);
  } catch (e) {
    console.error('Invalid JSON in MQTT message:', e.message);
    return;
  }
  if (!request || typeof request !== 'object') {
    console.error('Invalid MQTT message:', messageString);
    return;
  }

  if (!validateMac(request.macAddress)) {
    console.error('Invalid MAC address:', request.macAddress);
    client.publish(RESPONSE_TOPIC, JSON.stringify({
      macAddress: request.macAddress,
      type: 'error',
      error: 'Invalid MAC address'
    }));
    return;
  }

  const mac = request.macAddress;

  if (request.type === 'getTemperature') {
    const accepted = enqueueRequest({
      command: `${scriptPath} ${mac} status`,
      priority: 'low',
      debug: request.debug === true,
      onDone: (error, stdout) => {
        if (error) {
          logBleFailure('getTemperature', error);
          client.publish(RESPONSE_TOPIC, JSON.stringify({
            macAddress: mac,
            type: 'error',
            error: error.message
          }));
        } else {
          noteBleSuccess();
          const match = stdout.match(/Temperature:\s*([\d\.]+)°C/);
          if (match) {
            const temperature = parseFloat(match[1]);
            console.log(`Current temperature for MAC address ${mac}: ${temperature}°C`);
            client.publish(RESPONSE_TOPIC, JSON.stringify({
              macAddress: mac,
              type: 'temperature',
              value: temperature
            }));
          } else {
            console.error('Temperature match not found in stdout:', stdout);
            client.publish(RESPONSE_TOPIC, JSON.stringify({
              macAddress: mac,
              type: 'error',
              error: 'Temperature match not found'
            }));
          }
        }
      }
    });
    if (!accepted) {
      _logDroppedPoll();
    }
  } else if (request.type === 'setTemperature') {
    if (!validTemperature(request.value)) {
      _rejectSet(client, request, 'setTemperature', 'Invalid value', request.value);
      return;
    }
    enqueueRequest(_setJob(client, request, 'setTemperature', `${mac}:temp`,
      `${scriptPath} ${mac} temp ${request.value}`));
  } else if (request.type === 'setMode') {
    if (!validMode(request.mode)) {
      _rejectSet(client, request, 'setMode', 'Invalid mode', request.mode);
      return;
    }
    // eq3.exp "off"/"on" write 4.5 / 30 °C, so they share the temperature key:
    // OFF and a temperature change replace each other.
    const isTempWrite = request.mode === 'off' || request.mode === 'on';
    const key = `${mac}:${isTempWrite ? 'temp' : 'mode'}`;
    enqueueRequest(_setJob(client, request, 'setMode', key,
      `${scriptPath} ${mac} ${request.mode}`));
  }
}

if (require.main === module) {
  const client = mqtt.connect('mqtt://localhost');

  client.on('connect', () => {
    console.log('MQTT connected and subscribed to homebridge/eq3hk/request');
    client.subscribe('homebridge/eq3hk/request');
  });

  client.on('message', (topic, message) => {
    handleMessage(client, message.toString());
  });
}

module.exports = {
  validateMac, retryCommand, enqueueRequest, _resetQueue,
  checkBluetooth, logBleFailure, noteBleSuccess, BLUETOOTH_HINT,
  SET_RETRY_BACKOFF_MS, handleMessage,
};
