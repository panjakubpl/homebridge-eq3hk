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
const mockThermostatService = {
  setCharacteristic: mockSetCharacteristic,
  getCharacteristic: mockGetCharacteristic,
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
    expect(client.publish).toHaveBeenCalledWith(
      'homebridge/eq3hk/request',
      expect.stringContaining('"type":"setTemperature"')
    );
    expect(client.publish).toHaveBeenCalledWith(
      'homebridge/eq3hk/request',
      expect.stringContaining('"value":21')
    );
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
    expect(payload.type).toBe('setMode');
    expect(payload.mode).toBe('off');
  });

  test('publishes "manual" mode when set to HEAT', async () => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    await acc.setTargetHeatingCoolingState(HEAT);
    const payload = JSON.parse(client.publish.mock.calls[0][1]);
    expect(payload.mode).toBe('manual');
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
