import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readinessRingColor } from './readiness-ring-color';

test('0% is exactly orange-500', () => {
  assert.equal(readinessRingColor(0), 'hsl(21.0, 90.6%, 53.1%)');
});

test('100% is exactly emerald-500', () => {
  assert.equal(readinessRingColor(100), 'hsl(160.0, 84.1%, 39.4%)');
});

test('hue climbs monotonically from orange to emerald with no wraparound', () => {
  const hues = [0, 10, 25, 50, 75, 90, 100].map((pct) => {
    const [h] = readinessRingColor(pct).match(/[\d.]+/g)!.map(Number);
    return h;
  });
  for (let i = 1; i < hues.length; i++) {
    assert.ok(hues[i] > hues[i - 1], `hue should climb: ${hues[i - 1]} -> ${hues[i]}`);
  }
  assert.ok(hues[0] >= 21 && hues[hues.length - 1] <= 160);
});

test('out-of-range input is clamped, not extrapolated', () => {
  assert.equal(readinessRingColor(-20), readinessRingColor(0));
  assert.equal(readinessRingColor(150), readinessRingColor(100));
});
