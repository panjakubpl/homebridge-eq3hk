jest.mock('mqtt', () => ({
  connect: jest.fn(() => ({
    on: jest.fn(),
    subscribe: jest.fn(),
    publish: jest.fn(),
  }))
}));

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

const Characteristic = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  FirmwareRevision: 'FirmwareRevision',
  CurrentTemperature: 'CurrentTemperature',
  TargetTemperature: 'TargetTemperature',
  CurrentHeatingCoolingState: { OFF: 0, HEAT: 1 },
  TargetHeatingCoolingState: { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 },
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

beforeEach(() => {
  jest.clearAllMocks();
  Service.Thermostat.mockReturnValue(mockThermostatService);
  Service.AccessoryInformation.mockReturnValue(mockInfoService);
  mockGetCharacteristic.mockReturnValue({
    on: jest.fn().mockReturnThis(),
    setProps: jest.fn().mockReturnThis(),
  });
  mockSetCharacteristic.mockReturnThis();
});

// ─── cacheDuration default ───────────────────────────────────────────────────

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
