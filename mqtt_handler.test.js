jest.mock('mqtt', () => ({
  connect: jest.fn(() => ({
    on: jest.fn(),
    subscribe: jest.fn(),
    publish: jest.fn(),
  }))
}));

jest.mock('child_process', () => ({ exec: jest.fn() }));

const { exec } = require('child_process');
const {
  validateMac, retryCommand, enqueueRequest, _resetQueue,
  checkBluetooth, logBleFailure, noteBleSuccess, BLUETOOTH_HINT,
} = require('./mqtt_handler');

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

// ─── enqueueRequest (mutex / serial queue) ───────────────────────────────────

describe('enqueueRequest', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
    _resetQueue();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('runs single getTemperature request immediately', () => {
    exec.mockImplementation(() => {});
    enqueueRequest({ command: 'cmd1', priority: 'low', onDone: () => {} });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('drops second getTemperature while first is in flight', () => {
    exec.mockImplementation(() => {});
    enqueueRequest({ command: 'cmd1', priority: 'low', onDone: () => {} });
    enqueueRequest({ command: 'cmd2', priority: 'low', onDone: () => {} });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('queues setTemperature while getTemperature is in flight, runs it after', () => {
    let firstCb;
    exec.mockImplementationOnce((cmd, cb) => { firstCb = cb; });
    exec.mockImplementationOnce((cmd, cb) => {});

    enqueueRequest({ command: 'get-cmd', priority: 'low', onDone: () => {} });
    enqueueRequest({ command: 'set-cmd', priority: 'high', onDone: () => {} });
    expect(exec).toHaveBeenCalledTimes(1);

    firstCb(null, 'Temperature: 20.0°C', '');
    jest.runOnlyPendingTimers();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][0]).toBe('set-cmd');
  });

  test('replaces queued high-priority job with newer high-priority (latest user input wins)', () => {
    let firstCb;
    exec.mockImplementation((cmd, cb) => {
      if (!firstCb) firstCb = cb;
    });

    enqueueRequest({ command: 'get-cmd', priority: 'low', onDone: () => {} });
    enqueueRequest({ command: 'set-19', priority: 'high', onDone: () => {} });
    enqueueRequest({ command: 'set-20', priority: 'high', onDone: () => {} });
    expect(exec).toHaveBeenCalledTimes(1);

    firstCb(null, 'Temperature: 20.0°C', '');
    jest.runOnlyPendingTimers();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][0]).toBe('set-20');
  });

  test('high-priority preempts queued low-priority', () => {
    let firstCb;
    exec.mockImplementation((cmd, cb) => {
      if (!firstCb) firstCb = cb;
    });

    enqueueRequest({ command: 'get-1', priority: 'low', onDone: () => {} });
    enqueueRequest({ command: 'get-2', priority: 'low', onDone: () => {} });
    enqueueRequest({ command: 'set-19', priority: 'high', onDone: () => {} });

    firstCb(null, 'Temperature: 20.0°C', '');
    jest.runOnlyPendingTimers();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][0]).toBe('set-19');
  });

  test('onDone callback receives stdout from successful run', (done) => {
    exec.mockImplementation((cmd, cb) => cb(null, 'Temperature: 21.0°C', ''));
    enqueueRequest({
      command: 'cmd',
      priority: 'low',
      onDone: (error, stdout) => {
        expect(error).toBeNull();
        expect(stdout).toBe('Temperature: 21.0°C');
        done();
      }
    });
  });
});

// ─── bluetooth service diagnostics ───────────────────────────────────────────

describe('checkBluetooth', () => {
  beforeEach(() => exec.mockReset());

  test('reports active when systemctl is-active succeeds', (done) => {
    exec.mockImplementation((cmd, cb) => cb(null, 'active\n', ''));
    checkBluetooth((active) => {
      expect(exec.mock.calls[0][0]).toBe('systemctl is-active bluetooth');
      expect(active).toBe(true);
      done();
    });
  });

  test('reports inactive when systemctl is-active exits non-zero', (done) => {
    exec.mockImplementation((cmd, cb) => cb(new Error('exit 3'), 'inactive\n', ''));
    checkBluetooth((active) => {
      expect(active).toBe(false);
      done();
    });
  });
});

describe('logBleFailure', () => {
  let errorSpy;

  beforeEach(() => {
    exec.mockReset();
    noteBleSuccess();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => errorSpy.mockRestore());

  const hintCalls = () => errorSpy.mock.calls.filter((c) => c[0] === BLUETOOTH_HINT);

  test('logs an actionable hint when bluetooth.service is not running', () => {
    exec.mockImplementation((cmd, cb) => cb(new Error('exit 3'), 'inactive\n', ''));
    logBleFailure('getTemperature', new Error('Command failed'));
    expect(hintCalls()).toHaveLength(1);
    expect(BLUETOOTH_HINT).toMatch(/systemctl enable --now bluetooth/);
  });

  test('does not log the hint when bluetooth.service is running', () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'active\n', ''));
    logBleFailure('getTemperature', new Error('Command failed'));
    expect(hintCalls()).toHaveLength(0);
  });

  test('logs the hint only once until a success resets it', () => {
    exec.mockImplementation((cmd, cb) => cb(new Error('exit 3'), 'inactive\n', ''));
    logBleFailure('getTemperature', new Error('x'));
    logBleFailure('getTemperature', new Error('x'));
    expect(hintCalls()).toHaveLength(1);

    noteBleSuccess();
    logBleFailure('getTemperature', new Error('x'));
    expect(hintCalls()).toHaveLength(2);
  });
});

// ─── debug logging ───────────────────────────────────────────────────────────

describe('enqueueRequest debug logging', () => {
  let logSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
    _resetQueue();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  const logged = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  test('logs command, stdout and stderr of a finished job when debug is set', () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'STDOUT-MARKER', 'STDERR-MARKER'));
    enqueueRequest({ command: 'eq3.exp status', priority: 'low', debug: true, onDone: () => {} });
    expect(logged()).toContain('eq3.exp status');
    expect(logged()).toContain('STDOUT-MARKER');
    expect(logged()).toContain('STDERR-MARKER');
  });

  test('logs stdout of a failed job when debug is set', () => {
    exec.mockImplementation((cmd, cb) => cb(new Error('boom'), 'FAIL-OUT', ''));
    enqueueRequest({ command: 'c', priority: 'high', debug: true, onDone: () => {} });
    jest.advanceTimersByTime(3000);
    jest.advanceTimersByTime(3000);
    expect(logged()).toContain('FAIL-OUT');
  });

  test('stays silent about stdout when debug is not set', () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'STDOUT-MARKER', ''));
    enqueueRequest({ command: 'c', priority: 'low', onDone: () => {} });
    expect(logged()).not.toContain('STDOUT-MARKER');
  });
});
