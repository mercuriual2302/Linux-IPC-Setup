// src/fleet.js - fleet run orchestration: pure logic, no SSH or Electron.
//
// A fleet run applies one action (a recipe, or a plain bulk op like a system
// upgrade or feed switch) to N target CXs. This module owns the coordination:
// which devices run when, how many at once, what happens when one fails, and
// when to give up on the whole run. The actual per-device work (SSH, apt,
// recipe apply) is injected as a function, so this file stays pure and
// unit-testable the same way recipe.js is.
//
// Failure model:
//   across devices - isolate: one failing never stops the others.
//   within a device - fail-fast: that is the injected worker's job, not ours.
//   circuit breaker - if more than N devices fail, stop starting new ones, so
//     a systemic problem (bad recipe, wrong credentials) does not burn through
//     all 30 devices identically before anyone notices.

const RECOMMENDED_CONCURRENCY = 5;
const MAX_CONCURRENCY = 50; // hard ceiling regardless of what the user types

// Normalise a user-entered concurrency value against the number of targets.
// Returns the clamped value plus flags the UI uses to decide whether to force
// an explicit override dialog (aboveRecommended) or note a clamp (clampedToMax).
function validateConcurrency(raw, targetCount) {
  let n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) n = RECOMMENDED_CONCURRENCY;
  let clampedToMax = false;
  if (n > MAX_CONCURRENCY) { n = MAX_CONCURRENCY; clampedToMax = true; }
  // Never run more workers than there are devices - pointless and confuses the
  // "how many at once" display.
  const effective = typeof targetCount === 'number' && targetCount > 0
    ? Math.min(n, targetCount)
    : n;
  return {
    value: n,
    effective,
    aboveRecommended: n > RECOMMENDED_CONCURRENCY,
    clampedToMax,
    recommended: RECOMMENDED_CONCURRENCY,
    max: MAX_CONCURRENCY
  };
}

// Per-device lifecycle: queued -> connecting -> running -> (done|failed|skipped).
// 'skipped' is terminal, used for devices the circuit breaker or a user stop
// cancels before they ever start.
const DEVICE_STATES = ['queued', 'connecting', 'running', 'done', 'failed', 'skipped'];

function initDevices(targets) {
  return targets.map((t, i) => ({
    index: i,
    host: t.host,
    label: t.label || t.host,
    password: t.password,
    port: t.port || 22,
    state: 'queued',
    message: '',
    stepIndex: null,
    stepTotal: null,
    error: null,
    needsReboot: false
  }));
}

// Shared abort flag for a run. The circuit breaker or a user stop flips it, and
// the worker loop checks it before starting each new device. In-flight devices
// are always allowed to finish - we never kill a device mid-apply, since that
// could leave it half-configured. We only stop starting new ones.
function makeAbortSignal() {
  return { aborted: false, reason: null };
}

// Parallel runner with a capped worker pool. Generic over the work function so
// tests inject a fake. Contract for runOne(device, onProgress):
//   - must resolve {ok:true} or {ok:false, error} for a normal device outcome
//   - a thrown error is caught and treated as that device's failure only
//   - onProgress({state?, message?, stepIndex?, stepTotal?}) streams UI updates
// opts:
//   circuitBreakerThreshold - stop starting new devices once this many fail
//                             (0/undefined disables it)
//   onDeviceUpdate(device)  - called on every device state change
//   signal                  - from makeAbortSignal(); checked before each start
// Resolves once every device is terminal.
async function runFleet(devices, concurrency, runOne, opts = {}) {
  const {
    circuitBreakerThreshold = 0,
    onDeviceUpdate = () => {},
    signal = makeAbortSignal()
  } = opts;

  let failed = 0;
  let nextIndex = 0;

  const update = (dev, patch) => { Object.assign(dev, patch); onDeviceUpdate(dev); };

  async function worker() {
    while (true) {
      if (nextIndex >= devices.length) return;
      const dev = devices[nextIndex++];

      if (signal.aborted) {
        update(dev, { state: 'skipped', message: signal.reason || 'Run stopped' });
        continue;
      }

      update(dev, { state: 'connecting', message: 'Connecting...' });

      try {
        const result = await runOne(dev, (progress) => {
          update(dev, {
            state: progress.state || 'running',
            message: progress.message != null ? progress.message : dev.message,
            stepIndex: progress.stepIndex != null ? progress.stepIndex : dev.stepIndex,
            stepTotal: progress.stepTotal != null ? progress.stepTotal : dev.stepTotal
          });
        });
        if (result && result.ok) {
          update(dev, { state: 'done', message: 'Complete', needsReboot: !!(result && result.needsReboot) });
        } else {
          failed++;
          const e = (result && result.error) || 'Failed';
          update(dev, { state: 'failed', message: e, error: e });
        }
      } catch (err) {
        failed++;
        const msg = (err && err.message) || String(err);
        update(dev, { state: 'failed', message: msg, error: msg });
      }

      // Circuit breaker: flip the shared signal so every worker stops pulling
      // new devices. In-flight devices finish naturally.
      if (circuitBreakerThreshold > 0 && failed >= circuitBreakerThreshold && !signal.aborted) {
        signal.aborted = true;
        signal.reason = `Stopped: ${failed} device(s) failed (circuit breaker at ${circuitBreakerThreshold})`;
      }
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, devices.length));
  const workers = [];
  for (let i = 0; i < poolSize; i++) workers.push(worker());
  await Promise.all(workers);

  return summarise(devices, signal);
}

// Sequential runner for the plug-in-one-at-a-time case. One device at a time;
// between devices (not before the first) it calls onBetween(nextDevice) so the
// UI can prompt "unplug this one, connect the next". onBetween resolves when
// the user is ready, or resolves {stop:true} to end the run.
async function runSequential(devices, runOne, opts = {}) {
  const { onDeviceUpdate = () => {}, onBetween = null, signal = makeAbortSignal() } = opts;
  const update = (dev, patch) => { Object.assign(dev, patch); onDeviceUpdate(dev); };

  for (let i = 0; i < devices.length; i++) {
    const dev = devices[i];
    if (signal.aborted) { update(dev, { state: 'skipped', message: signal.reason || 'Run stopped' }); continue; }

    if (i > 0 && onBetween) {
      const cont = await onBetween(dev);
      if (cont && cont.stop) {
        update(dev, { state: 'skipped', message: 'Run stopped by user' });
        signal.aborted = true; signal.reason = 'Stopped by user';
        continue;
      }
    }

    update(dev, { state: 'connecting', message: 'Connecting...' });
    try {
      const result = await runOne(dev, (progress) => {
        update(dev, {
          state: progress.state || 'running',
          message: progress.message != null ? progress.message : dev.message,
          stepIndex: progress.stepIndex != null ? progress.stepIndex : dev.stepIndex,
          stepTotal: progress.stepTotal != null ? progress.stepTotal : dev.stepTotal
        });
      });
      if (result && result.ok) update(dev, { state: 'done', message: 'Complete', needsReboot: !!(result && result.needsReboot) });
      else { const e = (result && result.error) || 'Failed'; update(dev, { state: 'failed', message: e, error: e }); }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      update(dev, { state: 'failed', message: msg, error: msg });
    }
  }

  return summarise(devices, signal);
}

function summarise(devices, signal) {
  const done = devices.filter(d => d.state === 'done').length;
  const failed = devices.filter(d => d.state === 'failed').length;
  const skipped = devices.filter(d => d.state === 'skipped').length;
  return {
    total: devices.length,
    done, failed, skipped,
    aborted: !!signal.aborted,
    abortReason: signal.reason || null,
    allSucceeded: done === devices.length
  };
}

module.exports = {
  RECOMMENDED_CONCURRENCY,
  MAX_CONCURRENCY,
  DEVICE_STATES,
  validateConcurrency,
  initDevices,
  makeAbortSignal,
  runFleet,
  runSequential,
  summarise
};