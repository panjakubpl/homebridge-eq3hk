# Set-command retry window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set commands (temperature / mode) keep retrying until they land or a configurable window (default 15 min) passes; mode and temperature stop evicting each other.

**Architecture:** `index.js` adds `retryForMs` to set requests; `mqtt_handler.js` keeps pending set jobs keyed per thermostat+kind and re-arms failed ones after a backoff until the deadline. UI option in `config.schema.json`.

**Tech Stack:** Node.js (CommonJS), mqtt 4, Jest 30 with fake timers.

**Spec:** `docs/superpowers/specs/2026-11-23-set-retry-window-design.md`

## Global Constraints
- Allowed window values: 1, 5, 15, 30, 60 minutes. Default 15. Anything else → 15.
- Backoff between retry cycles: `SET_RETRY_BACKOFF_MS = 10000`. One cycle = existing `retryCommand` (MAX_RETRIES 2, RETRY_INTERVAL 3000) — unchanged.
- Handler accepts `retryForMs` only if a finite number with `0 < retryForMs <= 3600000`; otherwise single cycle (today's behaviour).
- Backward compatible both ways: old payloads (no `retryForMs`, no `key`) behave as today.
- Agents do NOT commit; the lead commits after review. Run tests with `npm test` (deps installed with `npm ci --ignore-scripts`).
- UI/README copy in English, no em dashes in new copy.

## Review Focus
1. Same-key job arrives while the old one is **in flight** → old result must not re-arm and must not publish a stale `error`; new job runs next. (Task 1 test)
2. Deadline passes **during** a cycle → after that cycle fails, give up (no extra cycle). (Task 1 test)
3. Polls during the backoff gap must be dropped, not run (they would steal the BLE link). (Task 1 test)
4. Two thermostats (different MACs) — a failing one must not block the other forever; jobs are served in order, ready ones first. (Task 1 test)
5. Poll errors must NOT be logged as "change not applied" in index.js (only set errors). (Task 2 test)

---

### Task 1: Handler — keyed pending sets + retry until deadline

**Files:**
- Modify: `mqtt_handler.js` (queue section ~lines 55–90, message handler set branches ~156–200, exports)
- Test: `mqtt_handler.test.js` (extend `enqueueRequest` describe; new describe `set retry window`)

**Interfaces:**
- Produces: `enqueueRequest(job) -> boolean` where job = `{ command, priority: 'low'|'high', key?: string, retryForMs?: number, debug?, onDone(error, stdout, stderr) }`. `key` defaults to `'set'` for high priority. `onDone` is called exactly once per job that is not superseded: on success, or with the last error when it gives up.
- Produces: export `SET_RETRY_BACKOFF_MS` (10000).
- Produces (MQTT, consumed by Task 2): set error response `{ macAddress, type: 'error', request: 'setTemperature'|'setMode', error, gaveUpAfterMs }`; set success response `{ macAddress, type: 'set', request: 'setTemperature'|'setMode' }`. Key used by the message handler: `` `${mac}:temp` `` / `` `${mac}:mode` ``. `retryForMs` is read from the request.

- [ ] **Step 1: Write failing tests** (fake timers, `exec` mock; helper `failCycle(cb)` = fail the 3 attempts by calling the captured callbacks and advancing 3000 ms between)
  - `mode and temp jobs for the same MAC both run (no eviction)`: low job in flight; enqueue high `key:'M:mode'` cmd `mode-manual`, then high `key:'M:temp'` cmd `temp-29.5`; finish low → `exec` calls 2 and 3 are `mode-manual`, `temp-29.5`.
  - `same key: newer replaces queued older` (existing test keeps passing with default key).
  - `failed cycle re-arms after 10 s while before deadline`: `retryForMs: 60000`, every exec fails → after 3 attempts no 4th call until `advanceTimersByTime(10000)`; then exec called again with same command; `onDone` not yet called.
  - `gives up after deadline and calls onDone with error once`: `retryForMs: 30000`, always fail, advance 120 s → `onDone` called exactly once with error; no exec after that.
  - `succeeds on a later cycle → onDone(null) once`.
  - `without retryForMs runs a single cycle` (3 exec calls, then onDone(error)).
  - `invalid retryForMs (0, -1, 'x', 3600001) → single cycle`.
  - `superseded while in flight: old failure neither re-arms nor calls onDone; new job runs`.
  - `deadline passing mid-cycle → no further cycle`.
  - `poll dropped during backoff gap` (`enqueueRequest(low)` returns false, exec not called).
  - `jobs of two MACs alternate: failing A in backoff does not block ready B`.
  - Message handler level (only if feasible with the mocked mqtt client; otherwise covered by CR): set error response includes `request` and `gaveUpAfterMs`.
- [ ] **Step 2:** `npm test -- mqtt_handler` → new tests FAIL.
- [ ] **Step 3: Implement.** Replace single `queued` slot with an insertion-ordered `Map` key → `{job, deadline, notBefore, superseded}` plus one low-priority slot; `_processNext` picks the first ready high job (notBefore ≤ now), else the low job; if only not-ready jobs remain, schedule one timer for the earliest `notBefore`. Low jobs are dropped when `inFlight` or any high job is pending. Message handler passes `key` and `retryForMs`, and adds `request`/`gaveUpAfterMs` to responses; log `gave up <command> after N min` on give-up and `retrying <command> in 10 s` on re-arm. `_resetQueue` clears everything incl. timers.
- [ ] **Step 4:** `npm test` → all PASS (82 old + new).
- [ ] **Step 5:** hand back to lead (no commit).

### Task 2: Plugin — `setRetryMinutes` option, payload, error log

**Files:**
- Modify: `index.js` (constructor, message handler, `setTargetTemperature`, `setTargetHeatingCoolingState`)
- Test: `index.test.js`

**Interfaces:**
- Consumes: Task 1 MQTT responses (`type:'error'` with `request` field; `type:'set'`).
- Produces: `this.setRetryMinutes` (number); set payloads `{ type, macAddress, value|mode, retryForMs }`.

- [ ] **Step 1: Write failing tests**
  - `setRetryMinutes defaults to 15`; `accepts 1/5/15/30/60`; `falls back to 15 for 0, 7, '15', null`.
  - `setTargetTemperature publishes retryForMs = 900000 by default` and `= 300000 when setRetryMinutes: 5`.
  - `setTargetHeatingCoolingState publishes retryForMs` (OFF and HEAT).
  - `logs a warning when a set error response arrives` (`request:'setTemperature'`, error text appears in the log call; use `log.warn` if present else `log`).
  - `does NOT log for a getTemperature error response` (no `request` field or `request:'getTemperature'`).
  - Update existing exact-payload assertions to include `retryForMs`.
- [ ] **Step 2:** `npm test -- index` → FAIL.
- [ ] **Step 3: Implement** in `index.js`: constant `ALLOWED_RETRY_MINUTES = [1,5,15,30,60]`; constructor validation; `retryForMs: this.setRetryMinutes * 60000` in both set payloads; in the message handler, `data.type === 'error' && /^set/.test(data.request || '')` → warn `Change not applied to thermostat after N min: <error first line>`.
- [ ] **Step 4:** `npm test` → all PASS.
- [ ] **Step 5:** hand back to lead.

### Task 3: UI option + docs + release metadata

**Files:**
- Modify: `config.schema.json`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json` (version only)

**Interfaces:** Consumes config key `setRetryMinutes` (Task 2).

- [ ] **Step 1:** `config.schema.json`: property `setRetryMinutes` — `type: integer`, `default: 15`, `title: "Retry a change for"`, `description` explaining it keeps retrying a temperature/mode change over weak Bluetooth until it lands or this time passes; `oneOf` with `{title:"1 minute",enum:[1]}`, 5, 15 `"15 minutes (default)"`, 30, 60. Add to the Advanced section items before `debug`.
- [ ] **Step 2:** Validate JSON: `node -e "JSON.parse(require('fs').readFileSync('config.schema.json'))"` → no error.
- [ ] **Step 3:** README: document the option in the configuration section (and the troubleshooting note about weak signal). CHANGELOG `## [2.7.0] - 2026-11-23` with Added (option, retry until landed) and Fixed (mode/temperature eviction, set errors were silent). Bump version to 2.7.0 in `package.json` and `package-lock.json`.
- [ ] **Step 4:** hand back to lead.

### Task 4: Lead — review, commit, deploy to rpi3, live test
- [ ] Senior CR of Tasks 1–3 diff; fix rounds via the implementer.
- [ ] `npm test` all green; commit per task.
- [ ] Backup and copy `index.js mqtt_handler.js config.schema.json package.json` to `/var/lib/homebridge/node_modules/homebridge-eq3hk/` on rpi3; set `setRetryMinutes: 15` in config; `sudo systemctl restart mqtt_handler homebridge`.
- [ ] Live: watch `journalctl -u mqtt_handler` + homebridge.log; a real set (with user's OK) lands; observe a retry cycle in the logs.

### Task 5: Release (after rpi3 live test passes, user's go)
- [ ] README reviewed as a release doc (option, behaviour, upgrade note: restart `mqtt_handler` service too).
- [ ] Push to GitHub `main`, tag `v2.7.0`, GitHub release with notes from CHANGELOG.
- [ ] `npm publish` 2.7.0 (user confirms; may need their OTP).
