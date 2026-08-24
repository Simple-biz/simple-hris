import test from 'node:test';
import assert from 'node:assert/strict';
import { kpiCalculatorRevealed } from './kpi-calculator-reveal';

test('waits while its data is still loading', () => {
  assert.equal(kpiCalculatorRevealed({ dataSettled: false, weekError: false }), false);
});

test('reveals once its data has settled', () => {
  assert.equal(kpiCalculatorRevealed({ dataSettled: true, weekError: false }), true);
});

test('an unresolvable week is TERMINAL — it reveals even with nothing loaded', () => {
  // The regression this exists for. `loadDept` correctly refuses to run until
  // the week resolves, so `dataSettled` can never become true on this path: a
  // gate that waits for it waits forever, and the alert that explains the wait
  // renders inside the chrome being withheld.
  assert.equal(kpiCalculatorRevealed({ dataSettled: false, weekError: true }), true);
});

test('the error never un-reveals an already-loaded calculator', () => {
  assert.equal(kpiCalculatorRevealed({ dataSettled: true, weekError: true }), true);
});

test('the skeleton is never the terminal state', () => {
  // Exhaustive over the whole input space: the only way to still be hidden is
  // for data to be genuinely pending with no error — i.e. something is actually
  // in flight. Every terminal combination reveals.
  for (const weekError of [true, false]) {
    for (const dataSettled of [true, false]) {
      const hidden = !kpiCalculatorRevealed({ dataSettled, weekError });
      if (hidden) {
        assert.equal(dataSettled, false, 'hidden implies data pending');
        assert.equal(weekError, false, 'hidden implies no terminal error');
      }
    }
  }
});
