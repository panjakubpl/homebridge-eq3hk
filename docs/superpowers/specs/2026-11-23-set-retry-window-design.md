# Set commands retry until they land (configurable window)

Date: 2026-11-23 · Status: approved in conversation (approach A)

## Why
After moving the office, the EQ3 in the bathroom sits at -79…-93 dBm from rpi3.
First connection attempt fails 10–40% of the time. A set command (temperature or
mode) gets one `retryCommand` cycle (3 tries, 3 s apart) and is then lost silently:
`index.js` ignores the `error` response. A night-time automation can quietly not
happen. The user wants changes to keep retrying until they land.

Found on the way: the handler queue has ONE slot and the latest high-priority job
replaces the queued one. `setMode manual` followed by `setTemperature 29.5`
(automation at 05:00 on 2026-11-23) dropped the mode change.

## Goals
- A set command keeps retrying until it succeeds or a configurable window passes.
- Window is a plugin option in the Homebridge UI: 1 / 5 / 15 / 30 / 60 minutes, default 15.
- Mode and temperature changes no longer evict each other; latest wins only within the same kind.
- Giving up is visible in the Homebridge log.

## Non-goals / anti-goals
- No unbounded retry: a stale "off" landing hours later, after someone turned the knob, is a failure.
- No change to polling cadence (separate topic).
- No change to `eq3.exp`.

## Approaches
- **A (picked):** `index.js` adds `retryForMs` to each set request; `mqtt_handler.js` owns
  retrying until the deadline. Keeps all BLE timing in one process; old handler ignores the
  field, old index.js (no field) gets today's behaviour.
- B: index.js re-publishes on `error` responses. Splits retry logic across two processes and
  an MQTT round-trip; the slot bug still needs a handler fix. Rejected.

## Design
Handler (`mqtt_handler.js`):
- Pending set jobs keyed by `${mac}:${kind}` (`kind` = `temp` | `mode`), kept in arrival order.
  A newer job with the same key replaces the old one (keeps its position); different keys coexist.
- A job runs one `retryCommand` cycle (existing 3×3 s). On failure, if `now < deadline`
  (`deadline = receivedAt + retryForMs`), it is re-armed after `SET_RETRY_BACKOFF_MS` (10 s)
  unless a newer same-key job replaced it. Past deadline: publish `error` and log
  `gave up ... after N min`. Without `retryForMs`: behave as today (single cycle).
- Polls (`getTemperature`, low priority) are dropped while any set job is pending or in flight.

Plugin (`index.js`):
- New option `setRetryMinutes` (allowed 1, 5, 15, 30, 60; anything else → 15).
- `setTemperature` and `setMode` requests carry `retryForMs = setRetryMinutes * 60000`.
- An `error` response is logged (warn) instead of ignored.

UI (`config.schema.json`): dropdown in the Advanced section, default 15.

Docs: README option, CHANGELOG, version 2.7.0.

## Left to the builder
Exact names of internal helpers, timer structure, test layout (fake timers, existing style).
