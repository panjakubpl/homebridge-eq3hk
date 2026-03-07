jest.mock('mqtt', () => ({
  connect: jest.fn(() => ({
    on: jest.fn(),
    subscribe: jest.fn(),
    publish: jest.fn(),
  }))
}));

jest.mock('child_process', () => ({ exec: jest.fn() }));

const { exec } = require('child_process');
const { validateMac, retryCommand } = require('./mqtt_handler');

// ─── validateMac ─────────────────────────────────────────────────────────────

describe('validateMac', () => {
  test('accepts valid uppercase MAC', () => {
    expect(validateMac('AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  test('accepts lowercase MAC', () => {
    expect(validateMac('aa:bb:cc:dd:ee:ff')).toBe(true);
  });

  test('accepts mixed case MAC', () => {
    expect(validateMac('aA:bB:cC:dD:eE:fF')).toBe(true);
  });

  test('rejects shell injection attempt', () => {
    expect(validateMac('AA:BB:CC:DD:EE:FF; rm -rf /')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(validateMac('')).toBe(false);
  });

  test('rejects wrong format', () => {
    expect(validateMac('not-a-mac')).toBe(false);
  });

  test('rejects MAC with dashes instead of colons', () => {
    expect(validateMac('AA-BB-CC-DD-EE-FF')).toBe(false);
  });
});

// ─── retryCommand ─────────────────────────────────────────────────────────────

describe('retryCommand', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('calls callback with stdout on success', (done) => {
    exec.mockImplementation((cmd, cb) => cb(null, 'Temperature: 21.5°C', ''));
    retryCommand('some-cmd', 2, (error, stdout) => {
      expect(error).toBeNull();
      expect(stdout).toBe('Temperature: 21.5°C');
      done();
    });
  });

  test('retries on failure and succeeds on second attempt', (done) => {
    exec
      .mockImplementationOnce((cmd, cb) => cb(new Error('BLE error'), '', ''))
      .mockImplementationOnce((cmd, cb) => cb(null, 'Temperature: 21.5°C', ''));

    retryCommand('some-cmd', 2, (error, stdout) => {
      expect(error).toBeNull();
      expect(exec).toHaveBeenCalledTimes(2);
      done();
    });

    jest.advanceTimersByTime(3000);
  });

  test('calls callback with error after all retries exhausted', (done) => {
    exec.mockImplementation((cmd, cb) => cb(new Error('BLE error'), '', ''));

    retryCommand('some-cmd', 2, (error) => {
      expect(error).not.toBeNull();
      expect(exec).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      done();
    });

    jest.advanceTimersByTime(3000);
    jest.advanceTimersByTime(3000);
  });

  test('uses 3 second retry interval', (done) => {
    exec
      .mockImplementationOnce((cmd, cb) => cb(new Error('fail'), '', ''))
      .mockImplementationOnce((cmd, cb) => cb(null, 'ok', ''));

    retryCommand('some-cmd', 1, () => done());

    // Should not retry before 3 seconds
    expect(exec).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3000);
  });
});
