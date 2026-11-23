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
  SET_RETRY_BACKOFF_MS, handleMessage,
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

  test('does not start a cycle after the deadline', () => {
    const onDone = jest.fn();
    deferExec();

    enqueueRequest({
      command: 'set-cmd',
      priority: 'high',
      retryForMs: 15000,
      onDone,
    });
    failCycle(exec);

    expect(exec).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).not.toBeNull();
    expect(onDone.mock.calls[0][0].gaveUpAfterMs).toBe(15000);

    jest.advanceTimersByTime(60000);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledTimes(1);
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

    exec.mock.calls[0][1](new Error('BLE fail'), '', '');
    jest.runOnlyPendingTimers();

    expect(oldDone).not.toHaveBeenCalled();
    // The replaced job stops its inner retries after the first failed attempt.
    expect(exec.mock.calls.filter((c) => c[0] === 'set-old')).toHaveLength(1);
    expect(exec.mock.calls.filter((c) => c[0] === 'set-new').length).toBeGreaterThanOrEqual(1);
    exec.mock.calls[exec.mock.calls.length - 1][1](null, '', '');
    expect(newDone).toHaveBeenCalled();
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    jest.runOnlyPendingTimers();
    expect(exec.mock.calls.filter((c) => c[0] === 'set-old')).toHaveLength(1);
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

// ─── per-MAC ordering ─────────────────────────────────────────────────────────

describe('per-MAC arrival order', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
    _resetQueue();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const cmds = () => exec.mock.calls.map((c) => c[0]);
  const succeedLast = () => exec.mock.calls[exec.mock.calls.length - 1][1](null, 'ok', '');

  test('newer job of another kind waits while an older job for the same MAC is in backoff', () => {
    deferExec();
    const olderDone = jest.fn();
    const newerDone = jest.fn();

    enqueueRequest({ command: 'mode-manual', priority: 'high', key: 'M:mode', retryForMs: 60000, onDone: olderDone });
    failCycle(exec);
    enqueueRequest({ command: 'temp-21', priority: 'high', key: 'M:temp', retryForMs: 60000, onDone: newerDone });

    expect(cmds()).not.toContain('temp-21');
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS - 1);
    expect(cmds()).not.toContain('temp-21');

    jest.advanceTimersByTime(1);
    expect(cmds()[cmds().length - 1]).toBe('mode-manual');
    succeedLast();
    expect(olderDone).toHaveBeenCalledWith(null, 'ok', '');

    expect(cmds()[cmds().length - 1]).toBe('temp-21');
    succeedLast();
    expect(newerDone).toHaveBeenCalledWith(null, 'ok', '');
    const firstTemp = cmds().indexOf('temp-21');
    expect(cmds().lastIndexOf('mode-manual')).toBeLessThan(firstTemp);
  });

  test('reverse kinds: older temp in backoff blocks newer mode until it lands', () => {
    deferExec();

    enqueueRequest({ command: 'temp-21', priority: 'high', key: 'M:temp', retryForMs: 60000, onDone: () => {} });
    failCycle(exec);
    enqueueRequest({ command: 'mode-auto', priority: 'high', key: 'M:mode', retryForMs: 60000, onDone: () => {} });
    expect(cmds()).not.toContain('mode-auto');

    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    expect(cmds()[cmds().length - 1]).toBe('temp-21');
    succeedLast();
    expect(cmds()[cmds().length - 1]).toBe('mode-auto');
  });

  test('newer job runs once the older one gives up', () => {
    deferExec();
    const olderDone = jest.fn();

    enqueueRequest({ command: 'mode-manual', priority: 'high', key: 'M:mode', retryForMs: 15000, onDone: olderDone });
    enqueueRequest({ command: 'temp-21', priority: 'high', key: 'M:temp', retryForMs: 60000, onDone: () => {} });
    failCycle(exec);

    expect(olderDone).toHaveBeenCalledTimes(1);
    expect(olderDone.mock.calls[0][0]).not.toBeNull();
    expect(cmds()[cmds().length - 1]).toBe('temp-21');
  });

  test('same-key replacement while the old job is in backoff: new runs, old never runs again', () => {
    deferExec();
    const oldDone = jest.fn();

    enqueueRequest({ command: 'temp-19', priority: 'high', key: 'M:temp', retryForMs: 60000, onDone: oldDone });
    failCycle(exec);
    enqueueRequest({ command: 'temp-22', priority: 'high', key: 'M:temp', retryForMs: 60000, onDone: () => {} });

    expect(cmds()[cmds().length - 1]).toBe('temp-22');
    succeedLast();
    jest.advanceTimersByTime(60000);
    expect(cmds().filter((c) => c === 'temp-19')).toHaveLength(3);
    expect(oldDone).not.toHaveBeenCalled();
  });

  test('a retry keeps its place ahead of a newer job for the same MAC queued while it was in flight', () => {
    deferExec();

    enqueueRequest({ command: 'mode-manual', priority: 'high', key: 'M:mode', retryForMs: 60000, onDone: () => {} });
    enqueueRequest({ command: 'temp-21', priority: 'high', key: 'M:temp', retryForMs: 60000, onDone: () => {} });
    failCycle(exec);

    expect(cmds()).not.toContain('temp-21');
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    expect(cmds()[cmds().length - 1]).toBe('mode-manual');
  });
});

// ─── cancellation, cycle hooks, logging ──────────────────────────────────────

describe('retryCommand cancellation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('stops before the next inner retry when isCancelled() is true', () => {
    exec.mockImplementation((cmd, cb) => cb(new Error('BLE error'), 'out', 'err'));
    const callback = jest.fn();
    retryCommand('some-cmd', 2, callback, () => true);
    jest.advanceTimersByTime(10000);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].message).toBe('BLE error');
  });

  test('cancellation during the retry wait stops before the next attempt', () => {
    exec.mockImplementation((cmd, cb) => cb(new Error('BLE error'), '', ''));
    let cancelled = false;
    const callback = jest.fn();
    retryCommand('some-cmd', 2, callback, () => cancelled);
    expect(callback).not.toHaveBeenCalled();
    cancelled = true;
    jest.advanceTimersByTime(3000);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).not.toBeNull();
  });
});

describe('set cycle hooks and give-up log', () => {
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
    _resetQueue();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  test('onCycleFailed is called for every failed cycle that is retried', () => {
    deferExec();
    const onCycleFailed = jest.fn();
    const onDone = jest.fn();
    enqueueRequest({ command: 'set-cmd', priority: 'high', key: 'M:temp', retryForMs: 60000, onCycleFailed, onDone });
    failCycle(exec);
    expect(onCycleFailed).toHaveBeenCalledTimes(1);
    expect(onCycleFailed.mock.calls[0][0].message).toBe('BLE fail');
    expect(onDone).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    failCycle(exec);
    expect(onCycleFailed).toHaveBeenCalledTimes(2);
  });

  test('give-up logs key, command and elapsed minutes via console.error', () => {
    deferExec();
    enqueueRequest({ command: 'set-cmd', priority: 'high', key: 'M:temp', retryForMs: 15000, onDone: () => {} });
    failCycle(exec);
    const lines = errorSpy.mock.calls.map((c) => c.join(' '));
    expect(lines).toContain('gave up M:temp (set-cmd) after 0.1 min: BLE fail');
  });

  test('deadline uses a monotonic clock: a wall-clock jump does not end the window', () => {
    deferExec();
    const onDone = jest.fn();
    enqueueRequest({ command: 'set-cmd', priority: 'high', key: 'M:temp', retryForMs: 60000, onDone });
    failCycle(exec);
    jest.setSystemTime(Date.now() + 2 * 3600000);
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    expect(exec).toHaveBeenCalledTimes(4);
    failCycle(exec);
    expect(onDone).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    expect(exec).toHaveBeenCalledTimes(7);
  });
});

// ─── handleMessage ───────────────────────────────────────────────────────────

describe('handleMessage', () => {
  const MAC = 'AA:BB:CC:DD:EE:FF';
  let client;
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    exec.mockReset();
    _resetQueue();
    noteBleSuccess();
    client = { publish: jest.fn() };
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  const send = (obj) => handleMessage(client, JSON.stringify(obj));
  const published = () => client.publish.mock.calls.map((c) => {
    expect(c[0]).toBe('homebridge/eq3hk/response');
    return JSON.parse(c[1]);
  });
  const cmds = () => exec.mock.calls.map((c) => c[0]);
  const lastCb = () => exec.mock.calls[exec.mock.calls.length - 1][1];
  const droppedLogs = () => logSpy.mock.calls.filter((c) => /Dropped getTemperature/.test(c.join(' ')));

  test('set success publishes {macAddress, type: set, request}', () => {
    deferExec();
    send({ macAddress: MAC, type: 'setTemperature', value: 21, retryForMs: 60000 });
    expect(cmds()[0]).toMatch(/eq3\.exp AA:BB:CC:DD:EE:FF temp 21$/);
    lastCb()(null, '', '');
    expect(published()).toEqual([{ macAddress: MAC, type: 'set', request: 'setTemperature' }]);
  });

  test('set give-up publishes an error with request and gaveUpAfterMs', () => {
    deferExec();
    send({ macAddress: MAC, type: 'setMode', mode: 'manual', retryForMs: 15000 });
    failCycle(exec);
    expect(published()).toEqual([{
      macAddress: MAC, type: 'error', request: 'setMode', error: 'BLE fail', gaveUpAfterMs: 15000,
    }]);
  });

  test('poll error has no request field', () => {
    deferExec();
    send({ macAddress: MAC, type: 'getTemperature' });
    failCycle(exec);
    const msgs = published();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ macAddress: MAC, type: 'error', error: 'BLE fail' });
    expect(msgs[0]).not.toHaveProperty('request');
  });

  test('poll success publishes the temperature', () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'Temperature: 21.5°C', ''));
    send({ macAddress: MAC, type: 'getTemperature' });
    expect(published()).toEqual([{ macAddress: MAC, type: 'temperature', value: 21.5 }]);
  });

  test('setMode off and a later setTemperature replace each other (keyed as temp)', () => {
    deferExec();
    send({ macAddress: MAC, type: 'getTemperature' });
    send({ macAddress: MAC, type: 'setMode', mode: 'off', retryForMs: 60000 });
    send({ macAddress: MAC, type: 'setTemperature', value: 21, retryForMs: 60000 });
    lastCb()(null, 'Temperature: 20.0°C', '');

    expect(cmds()).toHaveLength(2);
    expect(cmds()[1]).toMatch(/temp 21$/);
    lastCb()(null, '', '');
    jest.advanceTimersByTime(60000);
    expect(cmds().some((c) => / off$/.test(c))).toBe(false);
  });

  test('setMode on also replaces a pending temperature change', () => {
    deferExec();
    send({ macAddress: MAC, type: 'getTemperature' });
    send({ macAddress: MAC, type: 'setTemperature', value: 21, retryForMs: 60000 });
    send({ macAddress: MAC, type: 'setMode', mode: 'on', retryForMs: 60000 });
    lastCb()(null, 'Temperature: 20.0°C', '');
    expect(cmds()).toHaveLength(2);
    expect(cmds()[1]).toMatch(/ on$/);
  });

  test('setMode manual does not replace a pending temperature change', () => {
    deferExec();
    send({ macAddress: MAC, type: 'getTemperature' });
    send({ macAddress: MAC, type: 'setTemperature', value: 21, retryForMs: 60000 });
    send({ macAddress: MAC, type: 'setMode', mode: 'manual', retryForMs: 60000 });
    lastCb()(null, 'Temperature: 20.0°C', '');
    lastCb()(null, '', '');
    expect(cmds()).toHaveLength(3);
    expect(cmds()[1]).toMatch(/temp 21$/);
    expect(cmds()[2]).toMatch(/ manual$/);
  });

  test('every failed set cycle logs the BLE failure before the window ends', () => {
    deferExec();
    send({ macAddress: MAC, type: 'setTemperature', value: 21, retryForMs: 60000 });
    failCycle(exec);
    const failures = errorSpy.mock.calls.filter((c) => c[0] === 'Error executing setTemperature:');
    expect(failures).toHaveLength(1);
    expect(published()).toEqual([]);
  });

  test('logs a dropped poll once per busy streak', () => {
    deferExec();
    send({ macAddress: MAC, type: 'setTemperature', value: 21, retryForMs: 60000 });
    send({ macAddress: MAC, type: 'getTemperature' });
    send({ macAddress: MAC, type: 'getTemperature' });
    failCycle(exec);
    send({ macAddress: MAC, type: 'getTemperature' });
    expect(droppedLogs()).toHaveLength(1);

    jest.advanceTimersByTime(SET_RETRY_BACKOFF_MS);
    lastCb()(null, '', '');
    // queue idle: the next busy streak logs again
    send({ macAddress: MAC, type: 'setTemperature', value: 22, retryForMs: 60000 });
    send({ macAddress: MAC, type: 'getTemperature' });
    expect(droppedLogs()).toHaveLength(2);
  });

  test('invalid MAC publishes an error', () => {
    send({ macAddress: 'nope', type: 'getTemperature' });
    expect(exec).not.toHaveBeenCalled();
    expect(published()).toEqual([{ macAddress: 'nope', type: 'error', error: 'Invalid MAC address' }]);
  });

  test('invalid JSON is ignored', () => {
    handleMessage(client, '{not json');
    expect(client.publish).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
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
