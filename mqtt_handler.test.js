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
  SET_RETRY_BACKOFF_MS,
} = require('./mqtt_handler');

/** Defer exec callbacks until failCycle (or test) invokes them. */
function deferExec() {
  exec.mockImplementation(() => {});
}

/** Fail one retryCommand cycle (3 exec attempts, 3 s apart). */
function failCycle(execMock) {
  for (let i = 0; i < 3; i++) {
    const cb = execMock.mock.calls[execMock.mock.calls.length - 1][1];
    cb(new Error('BLE fail'), '', '');
    if (i < 2) jest.advanceTimersByTime(3000);
  }
}

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

  test('mode and temp jobs for the same MAC both run (no eviction)', () => {
    let lowCb;
    exec.mockImplementation((cmd, cb) => {
      if (!lowCb) lowCb = cb;
      else cb(null, '', '');
    });

    enqueueRequest({ command: 'get-cmd', priority: 'low', onDone: () => {} });
    enqueueRequest({ command: 'mode-manual', priority: 'high', key: 'M:mode', onDone: () => {} });
    enqueueRequest({ command: 'temp-29.5', priority: 'high', key: 'M:temp', onDone: () => {} });
    expect(exec).toHaveBeenCalledTimes(1);

    lowCb(null, 'Temperature: 20.0°C', '');
    jest.runOnlyPendingTimers();
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[1][0]).toBe('mode-manual');
    expect(exec.mock.calls[2][0]).toBe('temp-29.5');
  });
});

// ─── set retry window ─────────────────────────────────────────────────────────

describe('set retry window', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
    _resetQueue();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('SET_RETRY_BACKOFF_MS is 10000', () => {
    expect(SET_RETRY_BACKOFF_MS).toBe(10000);
  });

  test('failed cycle re-arms after 10 s while before deadline', () => {
    const onDone = jest.fn();
    deferExec();

    enqueueRequest({
      command: 'set-cmd',
      priority: 'high',
      retryForMs: 60000,
      onDone,
    });
    failCycle(exec);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(onDone).not.toHaveBeenCalled();

    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS - 1);
    expect(exec).toHaveBeenCalledTimes(3);

    jest.advanceTimersByTime(1);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec.mock.calls[3][0]).toBe('set-cmd');
    expect(onDone).not.toHaveBeenCalled();
  });

  test('gives up after deadline and calls onDone with error once', () => {
    const onDone = jest.fn();
    deferExec();

    enqueueRequest({
      command: 'set-cmd',
      priority: 'high',
      retryForMs: 30000,
      onDone,
    });
    let guard = 0;
    while (!onDone.mock.calls.length && guard++ < 20) {
      failCycle(exec);
      jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    }

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).not.toBeNull();
    const callsAfter = exec.mock.calls.length;
    jest.advanceTimersByTime(60000);
    expect(exec.mock.calls.length).toBe(callsAfter);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('succeeds on a later cycle → onDone(null) once', () => {
    const onDone = jest.fn();
    deferExec();

    enqueueRequest({
      command: 'set-cmd',
      priority: 'high',
      retryForMs: 60000,
      onDone,
    });
    failCycle(exec);
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    exec.mock.calls[exec.mock.calls.length - 1][1](null, 'ok', '');

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toBeNull();
  });

  test('without retryForMs runs a single cycle', () => {
    const onDone = jest.fn();
    deferExec();

    enqueueRequest({ command: 'set-cmd', priority: 'high', onDone });
    failCycle(exec);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).not.toBeNull();
    jest.advanceTimersByTime(60000);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  test.each([0, -1, 'x', 3600001])('invalid retryForMs (%p) → single cycle', (retryForMs) => {
    const onDone = jest.fn();
    deferExec();

    enqueueRequest({
      command: 'set-cmd',
      priority: 'high',
      retryForMs,
      onDone,
    });
    failCycle(exec);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60000);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  test('superseded while in flight: old failure neither re-arms nor calls onDone; new job runs', () => {
    const oldDone = jest.fn();
    const newDone = jest.fn();
    deferExec();

    enqueueRequest({ command: 'set-old', priority: 'high', key: 'K', retryForMs: 60000, onDone: oldDone });
    enqueueRequest({ command: 'set-new', priority: 'high', key: 'K', retryForMs: 60000, onDone: newDone });

    failCycle(exec);
    jest.runOnlyPendingTimers();

    expect(oldDone).not.toHaveBeenCalled();
    expect(exec.mock.calls.filter((c) => c[0] === 'set-old')).toHaveLength(3);
    expect(exec.mock.calls.filter((c) => c[0] === 'set-new').length).toBeGreaterThanOrEqual(1);
    exec.mock.calls[exec.mock.calls.length - 1][1](null, '', '');
    expect(newDone).toHaveBeenCalled();
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    jest.runOnlyPendingTimers();
    expect(exec.mock.calls.filter((c) => c[0] === 'set-old')).toHaveLength(3);
  });

  test('deadline passing mid-cycle → no further cycle', () => {
    const onDone = jest.fn();
    deferExec();

    enqueueRequest({
      command: 'set-cmd',
      priority: 'high',
      retryForMs: 5000,
      onDone,
    });
    failCycle(exec);
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    jest.runOnlyPendingTimers();

    expect(onDone).toHaveBeenCalledTimes(1);
    const after = exec.mock.calls.length;
    jest.advanceTimersByTime(60000);
    expect(exec.mock.calls.length).toBe(after);
  });

  test('poll dropped during backoff gap', () => {
    deferExec();

    enqueueRequest({
      command: 'set-cmd',
      priority: 'high',
      retryForMs: 60000,
      onDone: () => {},
    });
    failCycle(exec);
    const callsBefore = exec.mock.calls.length;

    const accepted = enqueueRequest({ command: 'poll', priority: 'low', onDone: () => {} });
    expect(accepted).toBe(false);
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    jest.runOnlyPendingTimers();
    expect(exec.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('jobs of two MACs alternate: failing A in backoff does not block ready B', () => {
    deferExec();

    enqueueRequest({
      command: 'cmd-A',
      priority: 'high',
      key: 'A:temp',
      retryForMs: 60000,
      onDone: () => {},
    });
    failCycle(exec);
    expect(exec.mock.calls.filter((c) => c[0] === 'cmd-A')).toHaveLength(3);

    enqueueRequest({
      command: 'cmd-B',
      priority: 'high',
      key: 'B:temp',
      retryForMs: 60000,
      onDone: () => {},
    });
    const cb = exec.mock.calls[exec.mock.calls.length - 1][1];
    cb(null, 'ok', '');
    expect(exec.mock.calls.some((c) => c[0] === 'cmd-B')).toBe(true);
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
