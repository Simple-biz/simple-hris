import test from 'node:test';
import assert from 'node:assert/strict';
import {
  predictedProgress,
  foldLoadSample,
  coerceEstimate,
  PREDICTED_CEILING,
  OVERRUN_CEILING,
  STEP_LOAD_MS_DEFAULT,
  STEP_LOAD_MS_MIN,
  STEP_LOAD_MS_MAX,
  STEP_LOAD_EMA_ALPHA,
} from './step-load-prediction';

// ── the invariant ────────────────────────────────────────────────────────────
// The bar exists to tell Accounting when a step's figures are safe to read. If
// prediction alone could fill it, it would say "safe" before the data landed —
// the exact mistake the line was added to prevent.

test('prediction alone NEVER completes the bar, at any elapsed time', () => {
  const estimates = [STEP_LOAD_MS_MIN, 900, STEP_LOAD_MS_DEFAULT, 12_000, STEP_LOAD_MS_MAX];
  for (const est of estimates) {
    for (const mult of [0, 0.01, 0.5, 1, 1.5, 3, 10, 100, 5000]) {
      const p = predictedProgress(est * mult, est);
      assert.ok(p < 1, `est=${est} mult=${mult} produced ${p} — a full bar must be a fact, not a guess`);
      assert.ok(p <= OVERRUN_CEILING + 1e-9, `est=${est} mult=${mult} exceeded the overrun ceiling: ${p}`);
      assert.ok(p >= 0, `est=${est} mult=${mult} produced a negative fill: ${p}`);
    }
  }
});

test('a load that runs forever still stops short of 100%', () => {
  // Ten minutes against a 2.6s prediction — the pathological case (hung fetch
  // that never rejects). It has to keep looking unfinished.
  assert.ok(predictedProgress(600_000, STEP_LOAD_MS_DEFAULT) < 1);
  assert.equal(
    Math.round(predictedProgress(600_000, STEP_LOAD_MS_DEFAULT) * 1000) / 1000,
    OVERRUN_CEILING,
    'an unbounded overrun should asymptote to the overrun ceiling',
  );
});

// ── the ramp ─────────────────────────────────────────────────────────────────

test('the bar tracks the prediction linearly up to the predicted ceiling', () => {
  const est = 2000;
  assert.equal(predictedProgress(0, est), 0);
  assert.equal(predictedProgress(500, est), PREDICTED_CEILING * 0.25);
  assert.equal(predictedProgress(1000, est), PREDICTED_CEILING * 0.5);
  assert.equal(predictedProgress(2000, est), PREDICTED_CEILING);
});

test('progress is monotonic — the bar never runs backwards', () => {
  const est = 3000;
  let last = -1;
  for (let t = 0; t <= 60_000; t += 137) {
    const p = predictedProgress(t, est);
    assert.ok(p >= last, `fill dropped from ${last} to ${p} at t=${t}`);
    last = p;
  }
});

test('a step that loads faster than predicted is simply caught mid-ramp', () => {
  // Not a bug to fix — it is the honest reading. The EMA pulls the prediction
  // down so the next refresh is closer.
  assert.ok(predictedProgress(300, STEP_LOAD_MS_DEFAULT) < 0.2);
});

test('a nonsense estimate falls back rather than dividing by zero', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = predictedProgress(1000, bad);
    assert.ok(Number.isFinite(p), `estimate ${String(bad)} produced ${p}`);
    assert.ok(p >= 0 && p < 1, `estimate ${String(bad)} produced ${p}`);
  }
});

test('a nonsense elapsed time reads as empty, not as complete', () => {
  for (const bad of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(predictedProgress(bad, STEP_LOAD_MS_DEFAULT), 0);
  }
});

// ── the remembered estimate ──────────────────────────────────────────────────

test('the first sample becomes the estimate outright', () => {
  assert.equal(foldLoadSample(undefined, 4000), 4000);
  assert.equal(foldLoadSample(null, 4000), 4000);
});

test('later samples move the estimate by the EMA weight', () => {
  // 2000 → 4000 with alpha 0.35 lands at 2700.
  assert.equal(foldLoadSample(2000, 4000), Math.round(2000 + STEP_LOAD_EMA_ALPHA * 2000));
});

test('one pathological load cannot poison the prediction', () => {
  // A 10-minute stall gets clamped to the max, and even then only moves the
  // estimate by alpha — so the refresh after it is not stuck on a huge bar.
  const poisoned = foldLoadSample(2600, 600_000);
  assert.ok(poisoned <= STEP_LOAD_MS_MAX);
  assert.ok(poisoned < STEP_LOAD_MS_MAX * STEP_LOAD_EMA_ALPHA + 2600);
  // And it decays back: three normal loads bring it most of the way home.
  let est = poisoned;
  for (let i = 0; i < 3; i += 1) est = foldLoadSample(est, 2600);
  assert.ok(est < poisoned / 2, `estimate did not decay: ${poisoned} → ${est}`);
});

test('a stored estimate is clamped into the sane band', () => {
  assert.equal(foldLoadSample(1, 10), STEP_LOAD_MS_MIN);
  assert.equal(coerceEstimate(STEP_LOAD_MS_MAX * 10), STEP_LOAD_MS_MAX);
  assert.equal(coerceEstimate(1), STEP_LOAD_MS_MIN);
});

test('garbage in storage falls back to the default estimate', () => {
  for (const bad of [undefined, null, 'nope', 0, -5, Number.NaN, {}, []]) {
    assert.equal(coerceEstimate(bad), STEP_LOAD_MS_DEFAULT, `coerceEstimate(${JSON.stringify(bad)})`);
  }
});
