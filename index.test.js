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
  on: jest.fn().mockReturnThis(),
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
    on: jest.fn().mockReturnThis(),
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
  test('returns cached temperature when cache is valid', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 22.5;
    acc.lastUpdated = Date.now();
    acc.getCurrentTemperature((err, temp) => {
      expect(err).toBeNull();
      expect(temp).toBe(22.5);
      done();
    });
  });

  test('returns cached temperature and does NOT publish when cooldown is active', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 21.0;
    acc.lastRequestTime = Date.now(); // cooldown active
    const client = getMqttClient();
    acc.getCurrentTemperature((err, temp) => {
      expect(temp).toBe(21.0);
      expect(client.publish).not.toHaveBeenCalled();
      done();
    });
  });

  test('publishes MQTT request and returns cached temp when cache is stale and cooldown is clear', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 19.0;
    // cache stale (lastUpdated = 0), cooldown clear (lastRequestTime = 0)
    const client = getMqttClient();
    acc.getCurrentTemperature((err, temp) => {
      expect(temp).toBe(19.0);
      expect(client.publish).toHaveBeenCalledWith(
        'homebridge/eq3hk/request',
        expect.stringContaining('"type":"getTemperature"')
      );
      done();
    });
  });

  test('updates lastRequestTime after publishing', (done) => {
    const acc = makeAccessory({});
    const before = Date.now();
    acc.getCurrentTemperature(() => {
      expect(acc.lastRequestTime).toBeGreaterThanOrEqual(before);
      done();
    });
  });
});

// ─── getTargetTemperature ────────────────────────────────────────────────────

describe('getTargetTemperature', () => {
  test('returns same value as getCurrentTemperature', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 18.5;
    acc.lastUpdated = Date.now();
    acc.getTargetTemperature((err, temp) => {
      expect(err).toBeNull();
      expect(temp).toBe(18.5);
      done();
    });
  });
});

// ─── setTargetTemperature ────────────────────────────────────────────────────

describe('setTargetTemperature', () => {
  test('publishes setTemperature command with correct value', (done) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.setTargetTemperature(21.0, () => {
      expect(client.publish).toHaveBeenCalledWith(
        'homebridge/eq3hk/request',
        expect.stringContaining('"type":"setTemperature"')
      );
      expect(client.publish).toHaveBeenCalledWith(
        'homebridge/eq3hk/request',
        expect.stringContaining('"value":21')
      );
      done();
    });
  });

  test('clamps value below minimum to 4.5', (done) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.setTargetTemperature(2.0, () => {
      const payload = JSON.parse(client.publish.mock.calls[0][1]);
      expect(payload.value).toBe(4.5);
      done();
    });
  });

  test('clamps value above maximum to 29.5', (done) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.setTargetTemperature(35.0, () => {
      const payload = JSON.parse(client.publish.mock.calls[0][1]);
      expect(payload.value).toBe(29.5);
      done();
    });
  });

  test('optimistically updates cachedTemperature', (done) => {
    const acc = makeAccessory({});
    acc.setTargetTemperature(23.0, () => {
      expect(acc.cachedTemperature).toBe(23.0);
      done();
    });
  });

  test('calls callback with null error', (done) => {
    const acc = makeAccessory({});
    acc.setTargetTemperature(20.0, (err) => {
      expect(err).toBeNull();
      done();
    });
  });
});

// ─── getCurrentHeatingCoolingState ───────────────────────────────────────────

describe('getCurrentHeatingCoolingState', () => {
  test('returns OFF when temperature is 4.5 (thermostat off)', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 4.5;
    acc.lastUpdated = Date.now();
    acc.getCurrentHeatingCoolingState((err, state) => {
      expect(err).toBeNull();
      expect(state).toBe(OFF);
      done();
    });
  });

  test('returns HEAT when temperature is above 4.5', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 21.0;
    acc.lastUpdated = Date.now();
    acc.getCurrentHeatingCoolingState((err, state) => {
      expect(state).toBe(HEAT);
      done();
    });
  });
});

// ─── getTargetHeatingCoolingState ────────────────────────────────────────────

describe('getTargetHeatingCoolingState', () => {
  test('returns OFF when temperature is 4.5', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 4.5;
    acc.lastUpdated = Date.now();
    acc.getTargetHeatingCoolingState((err, state) => {
      expect(state).toBe(OFF);
      done();
    });
  });

  test('returns HEAT when temperature is above 4.5', (done) => {
    const acc = makeAccessory({});
    acc.cachedTemperature = 20.0;
    acc.lastUpdated = Date.now();
    acc.getTargetHeatingCoolingState((err, state) => {
      expect(state).toBe(HEAT);
      done();
    });
  });
});

// ─── setTargetHeatingCoolingState ────────────────────────────────────────────

describe('setTargetHeatingCoolingState', () => {
  test('publishes "off" mode when set to OFF', (done) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.setTargetHeatingCoolingState(OFF, () => {
      const payload = JSON.parse(client.publish.mock.calls[0][1]);
      expect(payload.type).toBe('setMode');
      expect(payload.mode).toBe('off');
      done();
    });
  });

  test('publishes "manual" mode when set to HEAT', (done) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.setTargetHeatingCoolingState(HEAT, () => {
      const payload = JSON.parse(client.publish.mock.calls[0][1]);
      expect(payload.mode).toBe('manual');
      done();
    });
  });

  test('publishes "manual" mode when set to COOL', (done) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.setTargetHeatingCoolingState(COOL, () => {
      const payload = JSON.parse(client.publish.mock.calls[0][1]);
      expect(payload.mode).toBe('manual');
      done();
    });
  });

  test('publishes "auto" mode when set to AUTO', (done) => {
    const acc = makeAccessory({});
    const client = getMqttClient();
    acc.setTargetHeatingCoolingState(AUTO, () => {
      const payload = JSON.parse(client.publish.mock.calls[0][1]);
      expect(payload.mode).toBe('auto');
      done();
    });
  });

  test('calls callback with null error', (done) => {
    const acc = makeAccessory({});
    acc.setTargetHeatingCoolingState(OFF, (err) => {
      expect(err).toBeNull();
      done();
    });
  });
});
