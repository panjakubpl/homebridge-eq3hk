jest.mock('mqtt', () => ({
  connect: jest.fn(() => ({
    on: jest.fn(),
    subscribe: jest.fn(),
    publish: jest.fn(),
  }))
}));

const mqtt = require('mqtt');

const mockSetCharacteristic = jest.fn().mockReturnThis();
const mockGetCharacteristic = jest.fn().mockReturnValue({
  onGet: jest.fn().mockReturnThis(),
  onSet: jest.fn().mockReturnThis(),
  setProps: jest.fn().mockReturnThis(),
});
const mockUpdateCharacteristic = jest.fn();
const mockThermostatService = {
  setCharacteristic: mockSetCharacteristic,
  getCharacteristic: mockGetCharacteristic,
  updateCharacteristic: mockUpdateCharacteristic,
};
const mockInfoService = { setCharacteristic: mockSetCharacteristic };

const OFF = 0;
const HEAT = 1;
const COOL = 2;
const AUTO = 3;

const Characteristic = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  FirmwareRevision: 'FirmwareRevision',
  CurrentTemperature: 'CurrentTemperature',
  TargetTemperature: 'TargetTemperature',
  CurrentHeatingCoolingState: { OFF, HEAT, COOL },
  TargetHeatingCoolingState: { OFF, HEAT, COOL, AUTO },
};

const Service = {
  Thermostat: jest.fn().mockReturnValue(mockThermostatService),
  AccessoryInformation: jest.fn().mockReturnValue(mockInfoService),
};

let registeredClass;
const homebridge = {
  hap: { Service, Characteristic },
  registerAccessory: jest.fn((_plugin, _name, cls) => { registeredClass = cls; }),
};

require('./index')(homebridge);

function makeAccessory(config) {
  return new registeredClass(jest.fn(), {
    name: 'Test Thermostat',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    mqttUrl: 'mqtt://localhost',
    ...config,
  });
}

function getMqttClient() {
  return mqtt.connect.mock.results[mqtt.connect.mock.results.length - 1].value;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  Service.Thermostat.mockReturnValue(mockThermostatService);
  Service.AccessoryInformation.mockReturnValue(mockInfoService);
  mockGetCharacteristic.mockReturnValue({
    onGet: jest.fn().mockReturnThis(),
    onSet: jest.fn().mockReturnThis(),
    setProps: jest.fn().mockReturnThis(),
  });
  mockSetCharacteristic.mockReturnThis();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── setRetryMinutes ─────────────────────────────────────────────────────────

describe('setRetryMinutes', () => {
  test('defaults to 15', () => {
    const acc = makeAccessory({});
    expect(acc.setRetryMinutes).toBe(15);
  });

  test.each([1, 5, 15, 30, 60])('accepts allowed value %s', (minutes) => {
    const acc = makeAccessory({ setRetryMinutes: minutes });
    expect(acc.setRetryMinutes).toBe(minutes);
  });

  test.each([
    [0, 15],
    [7, 15],
    ['7', 15],
    ['abc', 15],
    ['', 15],
    [true, 15],
    [null, 15],
  ])('falls back to 15 for invalid value %p', (input, expected) => {
    const acc = makeAccessory({ setRetryMinutes: input });
    expect(acc.setRetryMinutes).toBe(expected);
  });

  test.each([
    ['15', 15],
    ['60', 60],
    [' 5 ', 5],
  ])('accepts numeric string %p', (input, expected) => {
    const acc = makeAccessory({ setRetryMinutes: input });
    expect(acc.setRetryMinutes).toBe(expected);
  });

  test('warns via log.warn when a configured value is not allowed', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = new registeredClass(log, {
      name: 'T', macAddress: 'AA:BB:CC:DD:EE:FF', mqttUrl: 'mqtt://localhost', setRetryMinutes: 7,
    });
    expect(acc.setRetryMinutes).toBe(15);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/setRetryMinutes.*7.*15/));
  });

  test('warns via log when log.warn is not available', () => {
    const log = jest.fn();
    new registeredClass(log, {
      name: 'T', macAddress: 'AA:BB:CC:DD:EE:FF', mqttUrl: 'mqtt://localhost', setRetryMinutes: '7',
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/setRetryMinutes.*7.*15/));
  });

  test.each([undefined, 15, '30'])('does not warn for %p', (input) => {
    const log = jest.fn();
    log.warn = jest.fn();
    new registeredClass(log, {
      name: 'T', macAddress: 'AA:BB:CC:DD:EE:FF', mqttUrl: 'mqtt://localhost', setRetryMinutes: input,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ─── cacheDuration ───────────────────────────────────────────────────────────

describe('cacheDuration', () => {
  test('defaults to 10 seconds when not configured', () => {
    const acc = makeAccessory({});
    expect(acc.cacheDuration).toBe(10 * 1000);
  });

  test('uses configured value when provided', () => {
    const acc = makeAccessory({ cacheDuration: 60 });
    expect(acc.cacheDuration).toBe(60 * 1000);
  });
});

// ─── isCacheValid ────────────────────────────────────────────────────────────

describe('isCacheValid', () => {
  test('returns false when cache has never been updated', () => {
    const acc = makeAccessory({});
    expect(acc.isCacheValid()).toBe(false);
  });

  test('returns true immediately after cache is updated', () => {
    const acc = makeAccessory({});
    acc.lastUpdated = Date.now();
    expect(acc.isCacheValid()).toBe(true);
  });

  test('returns false after cacheDuration has elapsed', () => {
    const acc = makeAccessory({ cacheDuration: 10 });
    jest.spyOn(acc, 'updateCache').mockImplementation(() => {});
    acc.lastUpdated = Date.now();
    jest.advanceTimersByTime(10 * 1000 + 1);
    expect(acc.isCacheValid()).toBe(false);
  });
});

// ─── canSendRequest ──────────────────────────────────────────────────────────

describe('canSendRequest', () => {
  test('returns true when no request has been sent yet', () => {
    const acc = makeAccessory({});
    expect(acc.canSendRequest()).toBe(true);
  });

  test('returns false immediately after a request is sent', () => {
    const acc = makeAccessory({});
    acc.lastRequestTime = Date.now();
    expect(acc.canSendRequest()).toBe(false);
  });

  test('returns true after cooldown (5s) has elapsed', () => {
    const acc = makeAccessory({});
    acc.lastRequestTime = Date.now();
    jest.advanceTimersByTime(5000 + 1);
    expect(acc.canSendRequest()).toBe(true);
  });
});

// ─── getCurrentTemperature ───────────────────────────────────────────────────

describe('getCurrentTemperature', () => {
  test('resolves with cached temperature when cache is valid', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 22.5;
    acc.lastUpdated = Date.now();
    const temp = await acc.getCurrentTemperature();
    expect(temp).toBe(22.5);
  });

  test('resolves with cached temperature and does NOT publish when cooldown is active', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 21.0;
    acc.lastRequestTime = Date.now();
    const client = getMqttClient();
    const temp = await acc.getCurrentTemperature();
    expect(temp).toBe(21.0);
    expect(client.publish).not.toHaveBeenCalled();
  });

  test('publishes MQTT request and resolves with cached temp when cache is stale and cooldown is clear', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 19.0;
    const client = getMqttClient();
    const temp = await acc.getCurrentTemperature();
    expect(temp).toBe(19.0);
    expect(client.publish).toHaveBeenCalledWith(
      'homebridge/eq3hk/request',
      expect.stringContaining('"type":"getTemperature"')
    );
  });

  test('updates lastRequestTime after publishing', async () => {
    const acc = makeAccessory({});
    const before = Date.now();
    await acc.getCurrentTemperature();
    expect(acc.lastRequestTime).toBeGreaterThanOrEqual(before);
  });
});

// ─── getTargetTemperature ────────────────────────────────────────────────────

describe('getTargetTemperature', () => {
  test('resolves with same value as getCurrentTemperature', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 18.5;
    acc.lastUpdated = Date.now();
    const temp = await acc.getTargetTemperature();
    expect(temp).toBe(18.5);
  });
});

// ─── setTargetTemperature ────────────────────────────────────────────────────

describe('setTargetTemperature', () => {
  test('publishes setTemperature command with correct value', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetTemperature(21.0);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload).toMatchObject({
      type: 'setTemperature',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      value: 21,
      retryForMs: 900000,
    });
  });

  test('publishes retryForMs = 900000 by default', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetTemperature(20);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.retryForMs).toBe(900000);
  });

  test('publishes retryForMs = 300000 when setRetryMinutes is 5', async () => {
    const acc = makeAccessory({ setRetryMinutes: 5 });
    const client = getMqttClient();
    await acc.setTargetTemperature(20);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.retryForMs).toBe(300000);
  });

  test('clamps value below minimum to 4.5', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetTemperature(2.0);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.value).toBe(4.5);
  });

  test('clamps value above maximum to 29.5', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetTemperature(35.0);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.value).toBe(29.5);
  });

  test('optimistically updates cachedTemperature', async () => {
    const acc = makeAccessory({});
    await acc.setTargetTemperature(23.0);
    expect(acc.cachedTemperature).toBe(23.0);
  });

  test.each([
    [21.11, 21],
    [21.3, 21.5],
    [21.25, 21.5],
    [4.6, 4.5],
    [29.4, 29.5],
  ])('rounds %p to the nearest 0.5 (%p) for the payload and the cache', async (input, expected) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetTemperature(input);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.value).toBe(expected);
    expect(acc.cachedTemperature).toBe(expected);
  });
});

// ─── getCurrentHeatingCoolingState ───────────────────────────────────────────

describe('getCurrentHeatingCoolingState', () => {
  test('resolves with OFF when temperature is 4.5 (thermostat off)', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 4.5;
    acc.lastUpdated = Date.now();
    const state = await acc.getCurrentHeatingCoolingState();
    expect(state).toBe(OFF);
  });

  test('resolves with HEAT when temperature is above 4.5', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 21.0;
    acc.lastUpdated = Date.now();
    const state = await acc.getCurrentHeatingCoolingState();
    expect(state).toBe(HEAT);
  });
});

// ─── getTargetHeatingCoolingState ────────────────────────────────────────────

describe('getTargetHeatingCoolingState', () => {
  test('resolves with OFF when temperature is 4.5', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 4.5;
    acc.lastUpdated = Date.now();
    const state = await acc.getTargetHeatingCoolingState();
    expect(state).toBe(OFF);
  });

  test('resolves with HEAT when temperature is above 4.5', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 20.0;
    acc.lastUpdated = Date.now();
    const state = await acc.getTargetHeatingCoolingState();
    expect(state).toBe(HEAT);
  });
});

// ─── setTargetHeatingCoolingState ────────────────────────────────────────────

describe('setTargetHeatingCoolingState', () => {
  test('publishes "off" mode when set to OFF', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(OFF);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload).toMatchObject({
      type: 'setMode',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      mode: 'off',
      retryForMs: 900000,
    });
  });

  test('publishes "manual" mode when set to HEAT', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(HEAT);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload).toMatchObject({
      type: 'setMode',
      mode: 'manual',
      retryForMs: 900000,
    });
  });

  test('publishes "manual" mode when set to COOL', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(COOL);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.mode).toBe('manual');
  });

  test('publishes "auto" mode when set to AUTO', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(AUTO);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.mode).toBe('auto');
  });
});

// ─── updateCache ─────────────────────────────────────────────────────────────

describe('updateCache', () => {
  test('publishes getTemperature MQTT request', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.updateCache();
    expect(client.publish).toHaveBeenCalledWith(
      'homebridge/eq3hk/request',
      expect.stringContaining('"type":"getTemperature"')
    );
  });

  test('does NOT update lastUpdated — only message handler should do that', async () => {
    const acc = makeAccessory({});
    const before = acc.lastUpdated; // 0
    await acc.updateCache();
    expect(acc.lastUpdated).toBe(before);
  });

  test('skips request if cooldown is active', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.lastRequestTime = Date.now();
    await acc.updateCache();
    expect(client.publish).not.toHaveBeenCalled();
  });
});

// ─── MQTT message handler ────────────────────────────────────────────────────

describe('MQTT message handler', () => {
  function getMessageHandler(acc) {
    const client = getMqttClient();
    const call = client.on.mock.calls.find(([event]) => event === 'message');
    return call?.[1];
  }

  test('does not crash when message contains invalid JSON', () => {
    const acc = makeAccessory({});
    const handler = getMessageHandler(acc);
    expect(() => handler('homebridge/eq3hk/response', Buffer.from('not-json'))).not.toThrow();
  });

  test('ignores message with valid JSON but wrong macAddress', () => {
    const acc = makeAccessory({});
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'FF:FF:FF:FF:FF:FF',
      type: 'temperature',
      value: 99.0
    })));
    expect(acc.cachedTemperature).toBe(20.0); // unchanged
  });

  test('updates cachedTemperature and lastUpdated on valid temperature message', () => {
    const acc = makeAccessory({});
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'temperature',
      value: 21.5
    })));
    expect(acc.cachedTemperature).toBe(21.5);
    expect(acc.lastUpdated).toBeGreaterThan(0);
  });

  test('IGNORES temperature message during pending-set grace period (preserves user target)', async () => {
    const acc = makeAccessory({});
    const handler = getMessageHandler(acc);
    await acc.setTargetTemperature(19.0);
    expect(acc.cachedTemperature).toBe(19.0);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'temperature',
      value: 23.5
    })));
    expect(acc.cachedTemperature).toBe(19.0);
  });

  test('accepts temperature message after grace period elapses', async () => {
    const acc = makeAccessory({});
    const handler = getMessageHandler(acc);
    await acc.setTargetTemperature(19.0);
    jest.advanceTimersByTime(30 * 1000 + 1);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'temperature',
      value: 23.5
    })));
    expect(acc.cachedTemperature).toBe(23.5);
  });

  test('logs a warning when a setTemperature error response arrives', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = makeAccessory({});
    acc.log = log;
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      request: 'setTemperature',
      error: 'Connection timed out\nsecond line',
    })));
    expect(log.warn).toHaveBeenCalledWith(
      'Change not applied to thermostat: Connection timed out'
    );
  });

  test('uses gaveUpAfterMs for minutes in the warning when present', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = makeAccessory({ setRetryMinutes: 15 });
    acc.log = log;
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      request: 'setMode',
      error: 'gave up',
      gaveUpAfterMs: 300000,
    })));
    expect(log.warn).toHaveBeenCalledWith(
      'Change not applied to thermostat after 5 min: gave up'
    );
  });

  test('does not claim a retry window for an immediate rejection without gaveUpAfterMs', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = makeAccessory({ setRetryMinutes: 30 });
    acc.log = log;
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      request: 'setTemperature',
      error: 'Invalid value',
    })));
    expect(log.warn).toHaveBeenCalledWith('Change not applied to thermostat: Invalid value');
    expect(log.warn.mock.calls[0][0]).not.toMatch(/min/);
  });

  test('falls back to log when log.warn is not available', () => {
    const log = jest.fn();
    const acc = makeAccessory({});
    acc.log = log;
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      request: 'setTemperature',
      error: 'BLE failed',
    })));
    expect(log).toHaveBeenCalledWith(
      'Change not applied to thermostat: BLE failed'
    );
    expect(log.warn).toBeUndefined();
  });

  test('does NOT log for a getTemperature error response without request', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = makeAccessory({});
    acc.log = log;
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      error: 'Command failed: eq3.exp',
    })));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('does NOT log for error with request getTemperature', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = makeAccessory({});
    acc.log = log;
    const handler = getMessageHandler(acc);
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      request: 'getTemperature',
      error: 'poll failed',
    })));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('setTargetTemperature pending-set grace period', () => {
  test('records pendingSetUntil timestamp', async () => {
    const acc = makeAccessory({});
    const before = Date.now();
    await acc.setTargetTemperature(20.0);
    expect(acc.pendingSetUntil).toBeGreaterThanOrEqual(before + 30 * 1000);
  });
});

// ─── OFF-intent window: HomeKit hub re-sync protection ───────────────────────
//
// iOS HomeKit hub treats TargetHeatingCoolingState and TargetTemperature as
// independent characteristics. After a user presses OFF in Home app, the hub
// may later re-push both at once: setTargetHeatingCoolingState(OFF) +
// setTargetTemperature(<remembered target, e.g. 23.5>). eQ-3 valves have no
// independent on/off — TargetTemperature IS the on/off state (4.5 = off).
// Without protection, the second message overrides the first and the valve
// silently turns back on. The OFF-intent window suppresses setTargetTemperature
// for a short period after explicit OFF so the hub's re-sync cannot wake the
// thermostat.

describe('OFF-intent window', () => {
  test('setTargetHeatingCoolingState(OFF) records offIntentUntil ≥10s in the future', async () => {
    const acc = makeAccessory({});
    const before = Date.now();
    await acc.setTargetHeatingCoolingState(OFF);
    expect(acc.offIntentUntil).toBeGreaterThanOrEqual(before + 10 * 1000);
  });

  test('setTargetHeatingCoolingState(OFF) optimistically sets cachedTemperature to 4.5', async () => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 23.5;
    await acc.setTargetHeatingCoolingState(OFF);
    expect(acc.cachedTemperature).toBe(4.5);
  });

  test('setTargetTemperature within OFF-intent window does NOT publish to MQTT', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(OFF);
    client.publish.mockClear();
    await acc.setTargetTemperature(23.5);
    expect(client.publish).not.toHaveBeenCalled();
  });

  test('setTargetTemperature within OFF-intent window does NOT change cachedTemperature', async () => {
    const acc = makeAccessory({});
    await acc.setTargetHeatingCoolingState(OFF);
    expect(acc.cachedTemperature).toBe(4.5);
    await acc.setTargetTemperature(23.5);
    expect(acc.cachedTemperature).toBe(4.5);
  });

  test('setTargetTemperature after OFF-intent window publishes normally', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(OFF);
    jest.advanceTimersByTime(10 * 1000 + 1);
    client.publish.mockClear();
    await acc.setTargetTemperature(22.0);
    expect(client.publish).toHaveBeenCalledWith(
      'homebridge/eq3hk/request',
      expect.stringContaining('"value":22')
    );
  });

  test('setTargetHeatingCoolingState(HEAT) clears offIntentUntil', async () => {
    const acc = makeAccessory({});
    await acc.setTargetHeatingCoolingState(OFF);
    await acc.setTargetHeatingCoolingState(HEAT);
    expect(acc.offIntentUntil).toBe(0);
  });

  test('setTargetTemperature after HEAT (following OFF) publishes normally', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(OFF);
    await acc.setTargetHeatingCoolingState(HEAT);
    client.publish.mockClear();
    await acc.setTargetTemperature(22.0);
    expect(client.publish).toHaveBeenCalledWith(
      'homebridge/eq3hk/request',
      expect.stringContaining('"type":"setTemperature"')
    );
  });
});

// ─── setTargetHeatingCoolingState — default case ─────────────────────────────

describe('setTargetHeatingCoolingState — unknown value', () => {
  test('does not publish when given an unrecognized mode value', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(99);
    expect(client.publish).not.toHaveBeenCalled();
  });
});

// ─── onGet / onSet registration ───────────────────────────────────────────────

describe('onGet/onSet registration', () => {
  test('registers onGet for CurrentTemperature', () => {
    const onGetMock = jest.fn().mockReturnThis();
    mockGetCharacteristic.mockImplementation((char) => {
      if (char === Characteristic.CurrentTemperature) return { onGet: onGetMock, setProps: jest.fn().mockReturnThis() };
      return { onGet: jest.fn().mockReturnThis(), onSet: jest.fn().mockReturnThis(), setProps: jest.fn().mockReturnThis() };
    });
    const acc = makeAccessory({});
    acc.getServices();
    expect(onGetMock).toHaveBeenCalledTimes(1);
  });

  test('registers onGet and onSet for TargetTemperature', () => {
    const onGetMock = jest.fn().mockReturnThis();
    const onSetMock = jest.fn().mockReturnThis();
    mockGetCharacteristic.mockImplementation((char) => {
      if (char === Characteristic.TargetTemperature) return { onGet: onGetMock, onSet: onSetMock, setProps: jest.fn().mockReturnThis() };
      return { onGet: jest.fn().mockReturnThis(), onSet: jest.fn().mockReturnThis(), setProps: jest.fn().mockReturnThis() };
    });
    const acc = makeAccessory({});
    acc.getServices();
    expect(onGetMock).toHaveBeenCalledTimes(1);
    expect(onSetMock).toHaveBeenCalledTimes(1);
  });
});

// ─── debug option ────────────────────────────────────────────────────────────

describe('debug option', () => {
  const publishedPayloads = (acc) =>
    getMqttClient().publish.mock.calls.map((c) => JSON.parse(c[1]));

  const sendResponse = (payload) => {
    const handler = getMqttClient().on.mock.calls.find((c) => c[0] === 'message')[1];
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify(payload)));
  };

  test('flags polling requests with debug:true when enabled', async () => {
    const acc = makeAccessory({ debug: true });
    await acc.updateCache();
    expect(publishedPayloads(acc)[0]).toMatchObject({ type: 'getTemperature', debug: true });
  });

  test('flags setTemperature requests with debug:true when enabled', async () => {
    const acc = makeAccessory({ debug: true });
    await acc.setTargetTemperature(21);
    expect(publishedPayloads(acc)[0]).toMatchObject({
      type: 'setTemperature',
      retryForMs: 900000,
      debug: true,
    });
  });

  test('flags setMode requests with debug:true when enabled', async () => {
    const acc = makeAccessory({ debug: true });
    await acc.setTargetHeatingCoolingState(OFF);
    expect(publishedPayloads(acc)[0]).toMatchObject({
      type: 'setMode',
      retryForMs: 900000,
      debug: true,
    });
  });

  test('does not add a debug key when disabled', async () => {
    const acc = makeAccessory({});
    await acc.updateCache();
    await acc.setTargetTemperature(21);
    for (const payload of publishedPayloads(acc)) {
      expect(payload).not.toHaveProperty('debug');
    }
  });

  test('logs set error responses via debug response line when enabled', () => {
    const acc = makeAccessory({ debug: true });
    sendResponse({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      request: 'setTemperature',
      error: 'Command failed: eq3.exp',
    });
    expect(acc.log).toHaveBeenCalledWith(expect.stringContaining('[debug] response:'));
  });

  test('warns on set error even when debug is disabled', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = makeAccessory({});
    acc.log = log;
    const handler = getMqttClient().on.mock.calls.find((c) => c[0] === 'message')[1];
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      request: 'setTemperature',
      error: 'Command failed: eq3.exp',
    })));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Command failed: eq3.exp'));
  });

  test('logs poll error responses via acc.log when debug is enabled', () => {
    const acc = makeAccessory({ debug: true });
    acc.log.mockClear();
    sendResponse({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      error: 'Command failed: eq3.exp',
    });
    expect(acc.log).toHaveBeenCalledWith(expect.stringContaining('Command failed: eq3.exp'));
  });

  test('does not log poll error responses when debug is disabled', () => {
    const log = jest.fn();
    log.warn = jest.fn();
    const acc = makeAccessory({});
    acc.log = log;
    sendResponse({
      macAddress: 'AA:BB:CC:DD:EE:FF',
      type: 'error',
      error: 'Command failed: eq3.exp',
    });
    expect(log).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('config.schema.json', () => {
  const schema = require('./config.schema.json');

  test('declares a boolean debug property defaulting to false', () => {
    expect(schema.schema.properties.debug).toMatchObject({ type: 'boolean', default: false });
  });

  test('declares setRetryMinutes with allowed minute choices defaulting to 15', () => {
    const prop = schema.schema.properties.setRetryMinutes;
    expect(prop).toMatchObject({ type: 'integer', default: 15 });
    const values = prop.oneOf.flatMap((o) => o.enum);
    expect(values).toEqual([1, 5, 15, 30, 60]);
  });

  test('places setRetryMinutes before debug in the Advanced section', () => {
    const advanced = schema.layout.find((l) => l.title === 'Advanced');
    const keys = advanced.items.map((i) => i.key || i);
    expect(keys.indexOf('setRetryMinutes')).toBeLessThan(keys.indexOf('debug'));
    expect(keys).toContain('setRetryMinutes');
  });

  test('places debug in a collapsed Advanced section', () => {
    const advanced = schema.layout.find((l) => l.title === 'Advanced');
    expect(advanced).toMatchObject({ type: 'section', expandable: true, expanded: false });
    expect(advanced.items.map((i) => i.key || i)).toContain('debug');
  });
});

// ─── push updates to HomeKit ─────────────────────────────────────────────────

describe('pushing polled changes to HomeKit', () => {
  const sendTemperature = (value) => {
    const handler = getMqttClient().on.mock.calls.find((c) => c[0] === 'message')[1];
    handler('homebridge/eq3hk/response', Buffer.from(JSON.stringify({
      macAddress: 'AA:BB:CC:DD:EE:FF', type: 'temperature', value,
    })));
  };

  test('pushes target and current temperature when the polled value changed', () => {
    makeAccessory({});
    sendTemperature(23);
    expect(mockUpdateCharacteristic).toHaveBeenCalledWith(Characteristic.TargetTemperature, 23);
    expect(mockUpdateCharacteristic).toHaveBeenCalledWith(Characteristic.CurrentTemperature, 23);
  });

  test('pushes HEAT states for a normal temperature', () => {
    makeAccessory({});
    sendTemperature(23);
    expect(mockUpdateCharacteristic).toHaveBeenCalledWith(Characteristic.TargetHeatingCoolingState, HEAT);
    expect(mockUpdateCharacteristic).toHaveBeenCalledWith(Characteristic.CurrentHeatingCoolingState, HEAT);
  });

  test('pushes OFF states when the thermostat reports 4.5°C', () => {
    makeAccessory({});
    sendTemperature(4.5);
    expect(mockUpdateCharacteristic).toHaveBeenCalledWith(Characteristic.TargetHeatingCoolingState, OFF);
    expect(mockUpdateCharacteristic).toHaveBeenCalledWith(Characteristic.CurrentHeatingCoolingState, OFF);
  });

  test('does not push when the polled value equals the cached one', () => {
    makeAccessory({});
    sendTemperature(23);
    mockUpdateCharacteristic.mockClear();
    sendTemperature(23);
    expect(mockUpdateCharacteristic).not.toHaveBeenCalled();
  });

  test('does not push a polled value that is ignored by the set grace period', async () => {
    const acc = makeAccessory({});
    await acc.setTargetTemperature(21);
    mockUpdateCharacteristic.mockClear();
    sendTemperature(15);
    expect(mockUpdateCharacteristic).not.toHaveBeenCalled();
  });
});
